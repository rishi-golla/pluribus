use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{
    constants::*, error::PluribusError, events::*, instructions::borrow::release_nft, math::*, risk::*, state::*, token::*,
};

/// Health is the margin between the liquidation limit and the debt, and a liquidation must not shrink it
/// The ratio cannot be the test because any bonus lowers it once it is under (1 + bonus) * weight
/// That would block liquidations on the accounts furthest under water
fn require_not_worse(debt: u128, limit: u128, debt_after: u128, limit_after: u128) -> Result<()> {
    require!(debt_after + limit <= debt + limit_after, PluribusError::HealthNotImproved);
    Ok(())
}

/// After any liquidation: back to the base rate tier, and write off debt nothing backs any more
fn settle(pool: &mut Pool, credit: &mut Account<CreditAccount>, now: i64) -> Result<()> {
    credit.healthy_since = now;
    if credit.tier != 0 {
        let from = credit.tier;
        pool.move_tier(credit, 0)?;
        emit!(TierChanged { account: credit.key(), from, to: 0 });
    }
    write_off_if_unbacked(pool, credit)
}

/// Debt with no collateral left behind it can never be repaid by a liquidation, so it is booked as a loss at once
fn write_off_if_unbacked(pool: &mut Pool, credit: &mut Account<CreditAccount>) -> Result<()> {
    if !credit.has_collateral() && credit.debt_shares > 0 {
        let (loss, covered_by_reserves, covered_by_protocol_fees, covered_by_junior) = pool.write_off(credit)?;
        emit!(BadDebt { account: credit.key(), loss, covered_by_reserves, covered_by_protocol_fees, covered_by_junior });
    }
    Ok(())
}

#[derive(Accounts)]
pub struct Liquidate<'info> {
    pub liquidator: Signer<'info>,
    #[account(mut, seeds = [CREDIT_SEED, credit.owner.as_ref()], bump = credit.bump)]
    pub credit: Box<Account<'info, CreditAccount>>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump, has_one = usdc_mint, has_one = usdc_vault)]
    pub pool: Box<Account<'info, Pool>>,
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = usdc_mint)]
    pub liquidator_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [ASSET_SEED, collateral_mint.key().as_ref()], bump = asset.bump, has_one = vault)]
    pub asset: Box<Account<'info, Asset>>,
    pub collateral_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = collateral_mint)]
    pub liquidator_collateral: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// The liquidator repays USDC and takes token collateral worth that plus the bonus
pub fn handle_liquidate(ctx: Context<Liquidate>, repay_amount: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = ctx.accounts;
    a.pool.accrue(now)?;
    let mint = a.collateral_mint.key();
    // USDC collateral is netted against debt with repay_from_collateral, at no bonus
    require_keys_neq!(mint, a.pool.usdc_mint, PluribusError::InvalidParams);
    let i = a.credit.find(KIND_TOKEN, &mint)?;
    let h = evaluate(&a.pool, &a.credit, ctx.remaining_accounts, now, Scope::Liquidation)?;
    let (debt, limit) = (a.pool.debt_of(&a.credit)?, h.liquidation_limit());
    require!(debt > limit, PluribusError::NotLiquidatable);

    let held = a.credit.positions[i].amount as u128;
    let bonus = BPS + a.pool.params.liq_bonus_bps as u128;
    let unit = pow10(a.asset.decimals)?;
    let max_repay = mul_div_floor(debt, a.pool.params.close_factor_bps as u128, BPS)?;
    let mut repay = (repay_amount as u128).min(max_repay);
    let mut seize = mul_div_floor(repay * bonus, unit, h.price[i] * BPS)?;
    if seize > held {
        // Not enough of this collateral: take all of it and charge only what it is worth
        seize = held;
        repay = mul_div_ceil(seize, h.price[i] * BPS, unit * bonus)?.min(max_repay);
    }
    require!(repay > 0 && seize > 0, PluribusError::ZeroAmount);

    let mut after = h.maint;
    for s in 0..h.scenarios() {
        after[s] -= h.pos_maint[i][s] - mul_div_floor(h.pos_maint[i][s], held - seize, held)?;
    }
    require_not_worse(debt, limit, debt - repay, worst(&after, h.scenarios()))?;

    let (repay, seize) = (to_u64(repay)?, to_u64(seize)?);
    a.pool.repay(&mut a.credit, repay)?;
    a.credit.remove_token(&mint, seize)?;
    a.asset.total_deposited = a.asset.total_deposited.saturating_sub(seize);
    pull(&a.token_program, &a.usdc_mint, &a.liquidator_usdc, &a.usdc_vault, &a.liquidator, repay)?;
    push(&a.token_program, &a.collateral_mint, &a.vault, &a.liquidator_collateral, &a.pool, seize)?;
    emit!(Liquidated {
        account: a.credit.key(),
        liquidator: a.liquidator.key(),
        mint,
        kind: KIND_TOKEN,
        repaid: repay,
        seized: seize,
        debt: to_u64(a.pool.debt_of(&a.credit)?)?,
    });
    settle(&mut a.pool, &mut a.credit, now)
}

#[derive(Accounts)]
pub struct LiquidateLp<'info> {
    pub liquidator: Signer<'info>,
    #[account(mut, seeds = [CREDIT_SEED, credit.owner.as_ref()], bump = credit.bump)]
    pub credit: Box<Account<'info, CreditAccount>>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump, has_one = usdc_mint, has_one = usdc_vault)]
    pub pool: Box<Account<'info, Pool>>,
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = usdc_mint)]
    pub liquidator_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [ASSET_SEED, usdc_mint.key().as_ref()], bump = usdc_asset.bump)]
    pub usdc_asset: Box<Account<'info, Asset>>,
    #[account(mut, address = usdc_asset.vault)]
    pub usdc_collateral_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub position_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        associated_token::mint = position_mint,
        associated_token::authority = pool,
        associated_token::token_program = nft_token_program,
    )]
    pub vault_nft: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = position_mint, token::token_program = nft_token_program)]
    pub liquidator_nft: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: Only receives the NFT vault's rent, and must be the account owner who paid it
    #[account(mut, address = credit.owner)]
    pub owner: UncheckedAccount<'info>,
    pub token_program: Interface<'info, TokenInterface>,
    pub nft_token_program: Interface<'info, TokenInterface>,
}

/// The liquidator buys the whole position NFT at the bonus discount
/// An NFT cannot be split, so any payment above the per-call repay cap stays in the account as USDC collateral
pub fn handle_liquidate_lp(ctx: Context<LiquidateLp>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = ctx.accounts;
    a.pool.accrue(now)?;
    let mint = a.position_mint.key();
    let i = a.credit.find(KIND_LP, &mint)?;
    let h = evaluate(&a.pool, &a.credit, ctx.remaining_accounts, now, Scope::Liquidation)?;
    let (debt, limit) = (a.pool.debt_of(&a.credit)?, h.liquidation_limit());
    require!(debt > limit, PluribusError::NotLiquidatable);

    let payment = mul_div_ceil(h.market[i], BPS, BPS + a.pool.params.liq_bonus_bps as u128)?;
    let repay = payment.min(mul_div_floor(debt, a.pool.params.close_factor_bps as u128, BPS)?);
    let excess = payment - repay;

    let mut after = h.maint;
    for s in 0..h.scenarios() {
        // While the account stays liquidatable anyone can net the USDC left behind against the debt one for one, so it counts in full
        // Valuing it under the USDC shock instead would block this sale in any scenario that shocks USDC harder than the LP
        after[s] = after[s] - h.pos_maint[i][s] + excess;
    }
    require_not_worse(debt, limit, debt - repay, worst(&after, h.scenarios()))?;

    let (repay, excess) = (to_u64(repay)?, to_u64(excess)?);
    a.credit.remove_lp(&mint)?;
    if repay > 0 {
        a.pool.repay(&mut a.credit, repay)?;
        pull(&a.token_program, &a.usdc_mint, &a.liquidator_usdc, &a.usdc_vault, &a.liquidator, repay)?;
    }
    if excess > 0 {
        a.credit.add_token(&a.usdc_mint.key(), excess)?;
        a.usdc_asset.total_deposited = a.usdc_asset.total_deposited.saturating_add(excess);
        pull(&a.token_program, &a.usdc_mint, &a.liquidator_usdc, &a.usdc_collateral_vault, &a.liquidator, excess)?;
        // Without this the rest of the sale price would be invisible to anyone following events
        emit!(CollateralChanged { account: a.credit.key(), mint: a.usdc_mint.key(), kind: KIND_TOKEN, amount: excess, deposit: true });
    }
    release_nft(&a.nft_token_program, &a.position_mint, &a.vault_nft, &a.liquidator_nft, &a.pool, a.owner.to_account_info())?;
    emit!(Liquidated {
        account: a.credit.key(),
        liquidator: a.liquidator.key(),
        mint,
        kind: KIND_LP,
        repaid: repay,
        seized: 1,
        debt: to_u64(a.pool.debt_of(&a.credit)?)?,
    });
    settle(&mut a.pool, &mut a.credit, now)
}

#[derive(Accounts)]
pub struct RepayFromCollateral<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [CREDIT_SEED, credit.owner.as_ref()], bump = credit.bump)]
    pub credit: Box<Account<'info, CreditAccount>>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump, has_one = usdc_mint, has_one = usdc_vault)]
    pub pool: Box<Account<'info, Pool>>,
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [ASSET_SEED, usdc_mint.key().as_ref()], bump = usdc_asset.bump)]
    pub usdc_asset: Box<Account<'info, Asset>>,
    #[account(mut, address = usdc_asset.vault)]
    pub usdc_collateral_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// Pays debt down with the account's own USDC collateral
/// The owner may do it any time
/// Anyone else may do it only while the account is liquidatable, within the same per-call cap
pub fn handle_repay_from_collateral(ctx: Context<RepayFromCollateral>, amount: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = ctx.accounts;
    a.pool.accrue(now)?;
    let usdc = a.usdc_mint.key();
    let held = a.credit.positions[a.credit.find(KIND_TOKEN, &usdc)?].amount;
    let debt = a.pool.debt_of(&a.credit)?;
    let by_owner = a.caller.key() == a.credit.owner;
    let mut amount = (amount.min(held) as u128).min(debt);
    if !by_owner {
        let h = evaluate(&a.pool, &a.credit, ctx.remaining_accounts, now, Scope::Liquidation)?;
        require!(debt > h.liquidation_limit(), PluribusError::NotLiquidatable);
        amount = amount.min(mul_div_floor(debt, a.pool.params.close_factor_bps as u128, BPS)?);
    }
    require!(amount > 0, PluribusError::ZeroAmount);

    let paid = a.pool.repay(&mut a.credit, to_u64(amount)?)?;
    a.credit.remove_token(&usdc, paid)?;
    a.usdc_asset.total_deposited = a.usdc_asset.total_deposited.saturating_sub(paid);
    push(&a.token_program, &a.usdc_mint, &a.usdc_collateral_vault, &a.usdc_vault, &a.pool, paid)?;
    emit!(Repaid {
        account: a.credit.key(),
        payer: a.caller.key(),
        amount: paid,
        debt: to_u64(a.pool.debt_of(&a.credit)?)?,
        source: 2,
    });
    if by_owner {
        write_off_if_unbacked(&mut a.pool, &mut a.credit)
    } else {
        settle(&mut a.pool, &mut a.credit, now)
    }
}
