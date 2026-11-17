use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{close_account, CloseAccount, Mint, TokenAccount, TokenInterface},
};

use crate::{constants::*, error::PluribusError, events::*, math::to_u64, orca::read_position, risk::*, state::*, token::*};

#[derive(Accounts)]
pub struct OpenAccount<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init,
        payer = owner,
        space = 8 + CreditAccount::INIT_SPACE,
        seeds = [CREDIT_SEED, owner.key().as_ref()],
        bump,
    )]
    pub credit: Box<Account<'info, CreditAccount>>,
    pub system_program: Program<'info, System>,
}

pub fn handle_open_account(ctx: Context<OpenAccount>) -> Result<()> {
    ctx.accounts.credit.set_inner(CreditAccount {
        owner: ctx.accounts.owner.key(),
        bump: ctx.bumps.credit,
        tier: 0,
        healthy_since: Clock::get()?.unix_timestamp,
        debt_shares: 0,
        positions: [Position::default(); MAX_POSITIONS],
    });
    emit!(AccountOpened { account: ctx.accounts.credit.key(), owner: ctx.accounts.owner.key() });
    Ok(())
}

/// Deposit or withdraw a whitelisted token
/// The credit PDA is seeded by the signer, so only the owner gets here
#[derive(Accounts)]
pub struct MoveToken<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [CREDIT_SEED, owner.key().as_ref()], bump = credit.bump)]
    pub credit: Box<Account<'info, CreditAccount>>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [ASSET_SEED, mint.key().as_ref()], bump = asset.bump, has_one = vault)]
    pub asset: Box<Account<'info, Asset>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::authority = owner)]
    pub owner_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_deposit_token(ctx: Context<MoveToken>, amount: u64) -> Result<()> {
    let a = ctx.accounts;
    require!(amount > 0, PluribusError::ZeroAmount);
    require!(!a.asset.params.paused, PluribusError::Paused);
    // A new listing takes no deposits until juniors have had their chance to leave, or it could shield debt from liquidation
    require!(Clock::get()?.unix_timestamp >= a.pool.effective_at(a.asset.active_at), PluribusError::NotYetActive);
    let total = a.asset.total_deposited.checked_add(amount).ok_or(PluribusError::MathOverflow)?;
    // A cap of zero means uncapped
    require!(a.asset.params.deposit_cap == 0 || total <= a.asset.params.deposit_cap, PluribusError::DepositCap);

    a.credit.add_token(&a.mint.key(), amount)?;
    a.asset.total_deposited = total;
    pull(&a.token_program, &a.mint, &a.owner_token, &a.vault, &a.owner, amount)?;
    emit!(CollateralChanged { account: a.credit.key(), mint: a.mint.key(), kind: KIND_TOKEN, amount, deposit: true });
    Ok(())
}

pub fn handle_withdraw_token(ctx: Context<MoveToken>, amount: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = ctx.accounts;
    require!(amount > 0, PluribusError::ZeroAmount);
    a.pool.accrue(now)?;
    a.credit.remove_token(&a.mint.key(), amount)?;
    a.asset.total_deposited = a.asset.total_deposited.saturating_sub(amount);
    push(&a.token_program, &a.mint, &a.vault, &a.owner_token, &a.pool, amount)?;
    require_within_limit(&a.pool, &a.credit, ctx.remaining_accounts, now)?;
    emit!(CollateralChanged { account: a.credit.key(), mint: a.mint.key(), kind: KIND_TOKEN, amount, deposit: false });
    Ok(())
}

#[derive(Accounts)]
pub struct DepositLp<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [CREDIT_SEED, owner.key().as_ref()], bump = credit.bump)]
    pub credit: Box<Account<'info, CreditAccount>>,
    #[account(seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(seeds = [LP_MARKET_SEED, lp_market.whirlpool.as_ref()], bump = lp_market.bump)]
    pub lp_market: Box<Account<'info, LpMarket>>,
    /// The LP's priced token, whose own pause and activation delay apply to its LPs too
    #[account(seeds = [ASSET_SEED, lp_market.base_mint.as_ref()], bump = base_asset.bump)]
    pub base_asset: Box<Account<'info, Asset>>,
    /// CHECK: Owner program, discriminator, mint and pool are checked in the handler
    // Orca keeps one position per NFT at this address
    // A bundled position sits elsewhere and shares its mint with its siblings, so it is not accepted
    #[account(seeds = [b"position", position_mint.key().as_ref()], seeds::program = WHIRLPOOL_PROGRAM_ID, bump)]
    pub position: UncheckedAccount<'info>,
    pub position_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = position_mint, token::token_program = token_program)]
    pub owner_nft: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init_if_needed,
        payer = owner,
        associated_token::mint = position_mint,
        associated_token::authority = pool,
        associated_token::token_program = token_program,
    )]
    pub vault_nft: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_deposit_lp(ctx: Context<DepositLp>) -> Result<()> {
    let bump = ctx.bumps.position;
    let a = ctx.accounts;
    require!(!a.lp_market.paused && !a.base_asset.params.paused, PluribusError::Paused);
    let now = Clock::get()?.unix_timestamp;
    let active = now >= a.pool.effective_at(a.lp_market.active_at) && now >= a.pool.effective_at(a.base_asset.active_at);
    require!(active, PluribusError::NotYetActive);
    let orca = read_position(&a.position)?;
    // The NFT being handed over must be the one that controls this position
    require_keys_eq!(orca.position_mint, a.position_mint.key(), PluribusError::AccountMismatch);
    require_keys_eq!(orca.whirlpool, a.lp_market.whirlpool, PluribusError::PoolNotWhitelisted);
    require!(orca.liquidity > 0, PluribusError::InvalidLpPosition);

    a.credit.add_lp(&a.position_mint.key(), bump)?;
    pull(&a.token_program, &a.position_mint, &a.owner_nft, &a.vault_nft, &a.owner, 1)?;
    emit!(CollateralChanged { account: a.credit.key(), mint: a.position_mint.key(), kind: KIND_LP, amount: 1, deposit: true });
    Ok(())
}

#[derive(Accounts)]
pub struct WithdrawLp<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [CREDIT_SEED, owner.key().as_ref()], bump = credit.bump)]
    pub credit: Box<Account<'info, CreditAccount>>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    pub position_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        mut,
        associated_token::mint = position_mint,
        associated_token::authority = pool,
        associated_token::token_program = token_program,
    )]
    pub vault_nft: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = position_mint, token::token_program = token_program)]
    pub owner_nft: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_withdraw_lp(ctx: Context<WithdrawLp>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = ctx.accounts;
    a.pool.accrue(now)?;
    a.credit.remove_lp(&a.position_mint.key())?;
    release_nft(&a.token_program, &a.position_mint, &a.vault_nft, &a.owner_nft, &a.pool, a.owner.to_account_info())?;
    require_within_limit(&a.pool, &a.credit, ctx.remaining_accounts, now)?;
    emit!(CollateralChanged { account: a.credit.key(), mint: a.position_mint.key(), kind: KIND_LP, amount: 1, deposit: false });
    Ok(())
}

/// Sends a position NFT out of its vault and closes the vault, returning rent to `rent_to`
pub fn release_nft<'info>(
    program: &Interface<'info, TokenInterface>,
    mint: &InterfaceAccount<'info, Mint>,
    vault: &InterfaceAccount<'info, TokenAccount>,
    to: &InterfaceAccount<'info, TokenAccount>,
    pool: &Account<'info, Pool>,
    rent_to: AccountInfo<'info>,
) -> Result<()> {
    push(program, mint, vault, to, pool, 1)?;
    let accounts = CloseAccount { account: vault.to_account_info(), destination: rent_to, authority: pool.to_account_info() };
    let seeds = pool.signer_seeds();
    close_account(CpiContext::new_with_signer(program.key(), accounts, &[&seeds]))
}

#[derive(Accounts)]
pub struct Draw<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [CREDIT_SEED, owner.key().as_ref()], bump = credit.bump)]
    pub credit: Box<Account<'info, CreditAccount>>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump, has_one = usdc_mint, has_one = usdc_vault)]
    pub pool: Box<Account<'info, Pool>>,
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = usdc_mint, token::authority = owner)]
    pub owner_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_draw(ctx: Context<Draw>, amount: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = ctx.accounts;
    require!(amount > 0, PluribusError::ZeroAmount);
    require!(!a.pool.paused, PluribusError::Paused);
    a.pool.accrue(now)?;
    // The loyalty clock only runs while something is owed
    if a.credit.debt_shares == 0 {
        a.credit.healthy_since = now;
    }
    a.pool.borrow(&mut a.credit, amount)?;
    push(&a.token_program, &a.usdc_mint, &a.usdc_vault, &a.owner_usdc, &a.pool, amount)?;
    require_within_limit(&a.pool, &a.credit, ctx.remaining_accounts, now)?;
    emit!(Drawn { account: a.credit.key(), amount, debt: to_u64(a.pool.debt_of(&a.credit)?)? });
    Ok(())
}

/// Anyone may repay any account, and repayments never need a price
#[derive(Accounts)]
pub struct Repay<'info> {
    pub payer: Signer<'info>,
    #[account(mut, seeds = [CREDIT_SEED, credit.owner.as_ref()], bump = credit.bump)]
    pub credit: Box<Account<'info, CreditAccount>>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump, has_one = usdc_mint, has_one = usdc_vault)]
    pub pool: Box<Account<'info, Pool>>,
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = usdc_mint)]
    pub payer_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_repay(ctx: Context<Repay>, amount: u64) -> Result<()> {
    let a = ctx.accounts;
    require!(amount > 0, PluribusError::ZeroAmount);
    a.pool.accrue(Clock::get()?.unix_timestamp)?;
    require!(a.pool.retires_debt(&a.credit, amount)?, PluribusError::ZeroAmount);
    let paid = a.pool.repay(&mut a.credit, amount)?;
    pull(&a.token_program, &a.usdc_mint, &a.payer_usdc, &a.usdc_vault, &a.payer, paid)?;
    emit!(Repaid {
        account: a.credit.key(),
        payer: a.payer.key(),
        amount: paid,
        debt: to_u64(a.pool.debt_of(&a.credit)?)?,
        source: 0,
    });
    Ok(())
}
