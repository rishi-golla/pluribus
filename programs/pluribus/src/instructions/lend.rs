use anchor_lang::prelude::*;
use anchor_spl::token_interface::{burn, mint_to, Burn, Mint, MintTo, TokenAccount, TokenInterface};

use crate::{constants::*, error::PluribusError, events::*, state::*, token::*};

/// Lending into either tranche: the share mint passed in decides which one
#[derive(Accounts)]
pub struct Lend<'info> {
    pub lender: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump, has_one = usdc_mint, has_one = usdc_vault)]
    pub pool: Box<Account<'info, Pool>>,
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// The senior or junior share mint, checked against the pool in the handler
    #[account(mut)]
    pub share_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = usdc_mint)]
    pub lender_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = share_mint)]
    pub lender_shares: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

pub fn handle_lend_deposit(ctx: Context<Lend>, amount: u64) -> Result<()> {
    let a = ctx.accounts;
    a.pool.accrue(Clock::get()?.unix_timestamp)?;
    let junior = a.pool.is_junior(&a.share_mint.key())?;
    let shares = a.pool.lend(junior, a.share_mint.supply, amount)?;

    pull(&a.token_program, &a.usdc_mint, &a.lender_usdc, &a.usdc_vault, &a.lender, amount)?;
    let accounts = MintTo {
        mint: a.share_mint.to_account_info(),
        to: a.lender_shares.to_account_info(),
        authority: a.pool.to_account_info(),
    };
    let seeds = a.pool.signer_seeds();
    mint_to(CpiContext::new_with_signer(a.token_program.key(), accounts, &[&seeds]), shares)?;
    emit!(LenderMoved { lender: a.lender.key(), usdc: amount, shares, deposit: true, junior });
    Ok(())
}

pub fn handle_lend_withdraw(ctx: Context<Lend>, shares: u64) -> Result<()> {
    let a = ctx.accounts;
    a.pool.accrue(Clock::get()?.unix_timestamp)?;
    let junior = a.pool.is_junior(&a.share_mint.key())?;
    // Junior money waits out the exit queue, so it cannot step aside when a loss is coming
    require!(!junior, PluribusError::JuniorExitQueue);
    let amount = a.pool.redeem(junior, a.share_mint.supply, shares)?;

    let accounts = Burn {
        mint: a.share_mint.to_account_info(),
        from: a.lender_shares.to_account_info(),
        authority: a.lender.to_account_info(),
    };
    burn(CpiContext::new(a.token_program.key(), accounts), shares)?;
    push(&a.token_program, &a.usdc_mint, &a.usdc_vault, &a.lender_usdc, &a.pool, amount)?;
    emit!(LenderMoved { lender: a.lender.key(), usdc: amount, shares, deposit: false, junior });
    Ok(())
}
