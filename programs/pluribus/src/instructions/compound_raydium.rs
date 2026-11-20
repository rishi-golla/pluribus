use anchor_lang::prelude::*;
use anchor_spl::{
    token::ID as TOKEN_PROGRAM_ID,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use super::{
    autopay_raydium::{collect_raydium_fees, increase_raydium_liquidity, RaydiumPosition},
    compound::{require_fair_price, Compounder},
};
use crate::{
    clmm::{read_position, read_sqrt_price},
    constants::*,
    error::PluribusError,
    math::{liquidity_for_amounts, under_payout},
    state::*,
};

#[derive(Accounts)]
pub struct CompoundRaydium<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [CREDIT_SEED, credit.owner.as_ref()], bump = credit.bump)]
    pub credit: Box<Account<'info, CreditAccount>>,
    #[account(seeds = [POOL_SEED], bump = pool.bump, has_one = usdc_mint)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(
        seeds = [LP_MARKET_SEED, clmm_pool.key().as_ref()],
        bump = lp_market.bump,
        constraint = RAYDIUM_CLMM_PROGRAMS.contains(&lp_market.dex_program) @ PluribusError::NotRaydiumMarket,
    )]
    pub lp_market: Box<Account<'info, LpMarket>>,
    /// CHECK: The market seeds above pin this to a whitelisted Raydium pool
    #[account(mut)]
    pub clmm_pool: UncheckedAccount<'info>,
    /// CHECK: Owner program, discriminator, mint and pool are checked in the handler
    #[account(mut, seeds = [b"position", position_mint.key().as_ref()], seeds::program = lp_market.dex_program, bump)]
    pub position: UncheckedAccount<'info>,
    pub position_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(token::mint = position_mint, token::authority = pool)]
    pub vault_nft: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: Raydium's own PDA for the position's range, which newer versions no longer read
    #[account(mut)]
    pub protocol_position: UncheckedAccount<'info>,
    /// CHECK: Raydium checks this is the pool's own token 0 vault
    #[account(mut)]
    pub clmm_vault_0: UncheckedAccount<'info>,
    /// CHECK: Raydium checks this is the pool's own token 1 vault
    #[account(mut)]
    pub clmm_vault_1: UncheckedAccount<'info>,
    /// CHECK: Raydium checks the tick arrays against the position and the pool
    #[account(mut)]
    pub tick_array_lower: UncheckedAccount<'info>,
    /// CHECK: Raydium checks the tick arrays against the position and the pool
    #[account(mut)]
    pub tick_array_upper: UncheckedAccount<'info>,
    #[account(mut, seeds = [ASSET_SEED, lp_market.base_mint.as_ref()], bump = base_asset.bump)]
    pub base_asset: Box<Account<'info, Asset>>,
    #[account(address = base_asset.mint)]
    pub base_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, address = base_asset.vault)]
    pub base_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: The base token's price account, checked against the asset's feed or mint when read
    pub base_price: UncheckedAccount<'info>,
    #[account(mut, seeds = [ASSET_SEED, usdc_mint.key().as_ref()], bump = usdc_asset.bump)]
    pub usdc_asset: Box<Account<'info, Asset>>,
    #[account(mut, address = usdc_asset.vault)]
    pub usdc_collateral_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    /// The caller's bounty in the base token, to any account it names, never one of the protocol's vaults
    #[account(mut, token::mint = base_mint, constraint = bounty_base.key() != base_vault.key() @ PluribusError::AccountMismatch)]
    pub bounty_base: Box<InterfaceAccount<'info, TokenAccount>>,
    /// The caller's bounty in USDC
    #[account(mut, token::mint = usdc_mint, constraint = bounty_usdc.key() != usdc_collateral_vault.key() @ PluribusError::AccountMismatch)]
    pub bounty_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    /// USDC is a classic token, and Raydium takes the classic program in this slot whatever the pool trades
    #[account(address = TOKEN_PROGRAM_ID)]
    pub token_program: Interface<'info, TokenInterface>,
    #[account(address = anchor_spl::token_2022::ID)]
    pub token_program_2022: Interface<'info, TokenInterface>,
    /// CHECK: Pinned to the memo program
    #[account(address = MEMO_PROGRAM_ID)]
    pub memo_program: UncheckedAccount<'info>,
    /// CHECK: Pinned to the market's Raydium program
    #[account(address = lp_market.dex_program)]
    pub dex_program: UncheckedAccount<'info>,
}

impl<'info> CompoundRaydium<'info> {
    fn raydium(&self) -> RaydiumPosition<'info> {
        RaydiumPosition {
            base_first: self.lp_market.base_first,
            clmm_pool: self.clmm_pool.to_account_info(),
            position: self.position.to_account_info(),
            vault_nft: self.vault_nft.to_account_info(),
            protocol_position: self.protocol_position.to_account_info(),
            clmm_vault_0: self.clmm_vault_0.to_account_info(),
            clmm_vault_1: self.clmm_vault_1.to_account_info(),
            tick_array_lower: self.tick_array_lower.to_account_info(),
            tick_array_upper: self.tick_array_upper.to_account_info(),
            base_vault: self.base_vault.to_account_info(),
            base_mint: self.base_mint.to_account_info(),
            usdc_vault: self.usdc_collateral_vault.to_account_info(),
            usdc_mint: self.usdc_mint.to_account_info(),
            token_program: self.token_program.to_account_info(),
            token_program_2022: self.token_program_2022.to_account_info(),
            memo_program: self.memo_program.to_account_info(),
            dex_program: self.dex_program.to_account_info(),
        }
    }

    fn compounder(&mut self) -> Compounder<'_, 'info> {
        // A stock Raydium trades through Token-2022 pays its bounty through that program, and USDC through the classic one
        let base_token_program = if *self.base_mint.to_account_info().owner == anchor_spl::token_2022::ID { &self.token_program_2022 } else { &self.token_program };
        Compounder {
            pool: &self.pool,
            credit: &mut self.credit,
            base_asset: &mut self.base_asset,
            base_mint: &self.base_mint,
            base_vault: &mut self.base_vault,
            usdc_asset: &mut self.usdc_asset,
            usdc_mint: &self.usdc_mint,
            usdc_collateral_vault: &mut self.usdc_collateral_vault,
            bounty_base: &self.bounty_base,
            bounty_usdc: &self.bounty_usdc,
            token_program: &self.token_program,
            base_token_program,
        }
    }
}

/// Permissionless: collects a held Raydium position's fees, pays the caller's recipient its share, and adds the rest back
/// into the position at the pool's price, which must sit within the owner's tolerance of the oracle's
/// Whatever the range cannot take stays in the account as collateral; no health check is needed, since fees never counted
/// Remaining accounts are what Raydium wants besides the fees, as for `autopay_raydium`: the tick array bitmap extension
/// when the position needs it, and a group of reward vault, recipient and reward mint for each reward the pool runs
pub fn handle_compound_raydium<'info>(ctx: Context<'info, CompoundRaydium<'info>>) -> Result<()> {
    let rem = ctx.remaining_accounts;
    let a = ctx.accounts;
    let mint = a.position_mint.key();
    a.credit.find(KIND_LP, &mint)?;
    let position = read_position(&a.lp_market, &a.position)?;
    require_keys_eq!(position.mint, mint, PluribusError::AccountMismatch);
    // The pool quotes its second token in its first, so the guard needs to know which of the two is the base token
    let base_first = a.lp_market.base_first;
    let sqrt_price = read_sqrt_price(&a.lp_market, &a.clmm_pool)?;
    require_fair_price(&a.pool, &a.credit, &mint, &a.base_asset, &a.base_price, sqrt_price, base_first)?;

    let raydium = a.raydium();
    let before = (a.base_vault.amount, a.usdc_collateral_vault.amount);
    collect_raydium_fees(&raydium, &a.pool, &a.credit.owner, rem)?;
    let fees = a.compounder().take_bounty(before)?;

    // Raydium takes its ticks and its tokens in the pool's own order, so the range and what is left are turned the same way
    let (left_base, left_usdc) = fees.left();
    let (left_0, left_1) = if base_first { (left_base, left_usdc) } else { (left_usdc, left_base) };
    let (lower, upper) = position.pool_ticks(base_first);
    // Raydium rounds with its own tick table, which can ask a unit more than the one liquidity is sized with here, so the
    // liquidity is sized to a hair under what is left and the full amounts stay the limit Raydium may take
    let sized = |left: u64| under_payout(left as u128) as u64;
    let (liquidity, _, _) = liquidity_for_amounts(sqrt_price, lower, upper, sized(left_0), sized(left_1))?;
    if liquidity > 0 {
        increase_raydium_liquidity(&raydium, &a.pool, rem, liquidity, left_0, left_1)?;
    }

    a.compounder().finish(before, fees, mint)
}
