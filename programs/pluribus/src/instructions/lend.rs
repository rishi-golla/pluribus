use anchor_lang::prelude::*;
use anchor_spl::token_interface::{burn, mint_to, Burn, Mint, MintTo, TokenAccount, TokenInterface};

use crate::{constants::*, error::PluribusError, events::*, math::*, state::*, token::*};

#[derive(Accounts)]
pub struct Lend<'info> {
    pub lender: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump, has_one = usdc_mint, has_one = usdc_vault, has_one = share_mint)]
    pub pool: Box<Account<'info, Pool>>,
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
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
    let supply = a.share_mint.supply as u128;
    let shares = if supply == 0 {
        amount
    } else {
        let assets = a.pool.lender_assets()?;
        require!(assets > 0, PluribusError::PoolInsolvent);
        to_u64(mul_div_floor(amount as u128, supply, assets)?)?
    };
    require!(shares > 0, PluribusError::ZeroAmount);

    pull(&a.token_program, &a.usdc_mint, &a.lender_usdc, &a.usdc_vault, &a.lender, amount)?;
    a.pool.cash = a.pool.cash.checked_add(amount).ok_or(PluribusError::MathOverflow)?;
    let accounts = MintTo {
        mint: a.share_mint.to_account_info(),
        to: a.lender_shares.to_account_info(),
        authority: a.pool.to_account_info(),
    };
    let seeds = a.pool.signer_seeds();
    mint_to(CpiContext::new_with_signer(a.token_program.key(), accounts, &[&seeds]), shares)?;
    emit!(LenderMoved { lender: a.lender.key(), usdc: amount, shares, deposit: true });
    Ok(())
}

pub fn handle_lend_withdraw(ctx: Context<Lend>, shares: u64) -> Result<()> {
    let a = ctx.accounts;
    a.pool.accrue(Clock::get()?.unix_timestamp)?;
    require!(shares > 0 && shares <= a.share_mint.supply, PluribusError::ZeroAmount);
    let amount = to_u64(mul_div_floor(shares as u128, a.pool.lender_assets()?, a.share_mint.supply as u128)?)?;
    // Lent-out USDC cannot leave, and the rate kink is what pulls it back
    require!(amount <= a.pool.cash, PluribusError::InsufficientLiquidity);

    let accounts = Burn {
        mint: a.share_mint.to_account_info(),
        from: a.lender_shares.to_account_info(),
        authority: a.lender.to_account_info(),
    };
    burn(CpiContext::new(a.token_program.key(), accounts), shares)?;
    a.pool.cash -= amount;
    push(&a.token_program, &a.usdc_mint, &a.usdc_vault, &a.lender_usdc, &a.pool, amount)?;
    emit!(LenderMoved { lender: a.lender.key(), usdc: amount, shares, deposit: false });
    Ok(())
}
