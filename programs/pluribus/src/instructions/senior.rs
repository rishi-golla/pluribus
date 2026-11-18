use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{burn, Burn, Mint, TokenAccount, TokenInterface},
};

use crate::{constants::*, error::PluribusError, events::*, math::*, state::*, token::*};

fn burn_escrowed<'info>(
    program: &Interface<'info, TokenInterface>,
    mint: &InterfaceAccount<'info, Mint>,
    escrow: &InterfaceAccount<'info, TokenAccount>,
    pool: &Account<'info, Pool>,
    amount: u64,
) -> Result<()> {
    let accounts = Burn { mint: mint.to_account_info(), from: escrow.to_account_info(), authority: pool.to_account_info() };
    let seeds = pool.signer_seeds();
    burn(CpiContext::new_with_signer(program.key(), accounts, &[&seeds]), amount)
}

#[derive(Accounts)]
pub struct RequestSeniorExit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump, has_one = share_mint)]
    pub pool: Box<Account<'info, Pool>>,
    pub share_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = share_mint, token::authority = owner)]
    pub owner_shares: Box<InterfaceAccount<'info, TokenAccount>>,
    /// Holds senior shares while they wait in the withdrawal queue, made by the first exit
    #[account(
        init_if_needed,
        payer = owner,
        seeds = [SENIOR_ESCROW_SEED],
        bump,
        token::mint = share_mint,
        token::authority = pool,
        token::token_program = token_program,
    )]
    pub senior_escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init,
        payer = owner,
        space = 8 + SeniorExit::INIT_SPACE,
        seeds = [SENIOR_EXIT_SEED, &pool.senior_next_ticket.to_le_bytes()],
        bump,
    )]
    pub exit: Box<Account<'info, SeniorExit>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Queues senior shares for withdrawal at the back of the line
/// Their value is fixed now, and idle cash up to that value is held back from draws and other withdrawals until the queue pays it
pub fn handle_request_senior_exit(ctx: Context<RequestSeniorExit>, shares: u64) -> Result<()> {
    let a = ctx.accounts;
    require!(shares > 0, PluribusError::ZeroAmount);
    a.pool.accrue(Clock::get()?.unix_timestamp)?;
    // Fixed now: the exit can lose value while it waits but never gains any
    let value = a.pool.value_of(false, a.share_mint.supply, shares)?;
    require!(value > 0, PluribusError::ZeroAmount);
    pull(&a.token_program, &a.share_mint, &a.owner_shares, &a.senior_escrow, &a.owner, shares)?;
    let ticket = a.pool.senior_next_ticket;
    a.pool.senior_next_ticket = ticket.checked_add(1).ok_or(PluribusError::MathOverflow)?;
    a.pool.senior_queued = a.pool.senior_queued.checked_add(shares).ok_or(PluribusError::MathOverflow)?;
    a.pool.senior_reserved = a.pool.senior_reserved.checked_add(value).ok_or(PluribusError::MathOverflow)?;
    a.exit.set_inner(SeniorExit { owner: a.owner.key(), ticket, shares, value, cancelled: false, bump: ctx.bumps.exit });
    emit!(SeniorExitRequested { owner: a.owner.key(), ticket, shares, value });
    Ok(())
}

#[derive(Accounts)]
pub struct SettleSeniorExit<'info> {
    /// Anyone, usually the keeper, who also pays for the owner's USDC account if it is missing
    #[account(mut)]
    pub caller: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump, has_one = usdc_mint, has_one = usdc_vault, has_one = share_mint)]
    pub pool: Box<Account<'info, Pool>>,
    /// Only the exit at the head of the queue can be settled
    #[account(mut, close = owner, seeds = [SENIOR_EXIT_SEED, &pool.senior_head.to_le_bytes()], bump = exit.bump)]
    pub exit: Box<Account<'info, SeniorExit>>,
    /// CHECK: Receives the exit's rent and owns the payout account, and must be the owner who queued it
    #[account(mut, address = exit.owner)]
    pub owner: UncheckedAccount<'info>,
    #[account(mut)]
    pub share_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [SENIOR_ESCROW_SEED], bump)]
    pub senior_escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// The owner's associated USDC account, made here if it is missing, so no owner can stall the queue by closing it
    #[account(
        init_if_needed,
        payer = caller,
        associated_token::mint = usdc_mint,
        associated_token::authority = owner,
        associated_token::token_program = token_program,
    )]
    pub owner_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/// Permissionless: pays the exit at the head of the queue in full once the pool's cash covers it, then moves the head on
/// A cancelled exit is skipped, and nothing behind the head can be paid before it
pub fn handle_settle_senior_exit(ctx: Context<SettleSeniorExit>) -> Result<()> {
    let a = ctx.accounts;
    a.pool.accrue(Clock::get()?.unix_timestamp)?;
    let (ticket, shares, value) = (a.exit.ticket, a.exit.shares, a.exit.value);
    let cancelled = a.exit.cancelled;
    let mut paid = 0;
    if !cancelled {
        // At the share price of the moment, so losses booked while it waited are shared, but never above its queued value,
        // so yield earned meanwhile stays with the seniors who remain
        paid = a.pool.value_of(false, a.share_mint.supply, shares)?.min(value);
        // The reservation guarantees the cash once it has come back to the pool
        require!(paid <= a.pool.cash, PluribusError::InsufficientLiquidity);
        a.pool.cash -= paid;
        a.pool.senior_queued = a.pool.senior_queued.saturating_sub(shares);
        a.pool.senior_reserved = a.pool.senior_reserved.saturating_sub(value);
        burn_escrowed(&a.token_program, &a.share_mint, &a.senior_escrow, &a.pool, shares)?;
        if paid > 0 {
            push(&a.token_program, &a.usdc_mint, &a.usdc_vault, &a.owner_usdc, &a.pool, paid)?;
        }
    }
    a.pool.senior_head = ticket.checked_add(1).ok_or(PluribusError::MathOverflow)?;
    emit!(SeniorExitSettled { owner: a.exit.owner, ticket, shares, value, paid, cancelled });
    Ok(())
}

#[derive(Accounts)]
pub struct CancelSeniorExit<'info> {
    pub owner: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump, has_one = share_mint)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [SENIOR_EXIT_SEED, &exit.ticket.to_le_bytes()], bump = exit.bump, has_one = owner)]
    pub exit: Box<Account<'info, SeniorExit>>,
    #[account(mut)]
    pub share_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [SENIOR_ESCROW_SEED], bump)]
    pub senior_escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = share_mint, token::authority = owner)]
    pub owner_shares: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// Hands queued shares back and frees the cash held for them, at any time
/// The owner gets back shares worth what the queued ones were worth when queued, and the yield earned meanwhile
/// is burned into the senior share price, so holding cash back from borrowers always costs that yield
/// The ticket stays in the queue, empty, until the queue reaches it and skips it
pub fn handle_cancel_senior_exit(ctx: Context<CancelSeniorExit>) -> Result<()> {
    let a = ctx.accounts;
    require!(!a.exit.cancelled, PluribusError::ExitCancelled);
    a.pool.accrue(Clock::get()?.unix_timestamp)?;
    let (shares, value, supply) = (a.exit.shares, a.exit.value, a.share_mint.supply);
    let current = a.pool.value_of(false, supply, shares)?;
    // A lone senior has nobody to leave the yield to, so the insurance reserve takes it and every share goes back
    let alone = shares == supply;
    if alone && current > value {
        a.pool.reserves = a.pool.reserves.saturating_add(current - value);
    }
    let returned = if current > value && !alone {
        // Burning the rest lifts the price of what is handed back too, so this many are worth what was queued afterwards
        let assets = a.pool.tranche_assets(false)? + VIRTUAL_SHARES;
        let others = supply as u128 + VIRTUAL_SHARES - shares as u128;
        to_u64(mul_div_wide(value as u128, others, assets - value as u128)?)?.min(shares)
    } else {
        shares
    };
    a.pool.senior_queued = a.pool.senior_queued.saturating_sub(shares);
    a.pool.senior_reserved = a.pool.senior_reserved.saturating_sub(value);
    if returned < shares {
        burn_escrowed(&a.token_program, &a.share_mint, &a.senior_escrow, &a.pool, shares - returned)?;
    }
    if returned > 0 {
        push(&a.token_program, &a.share_mint, &a.senior_escrow, &a.owner_shares, &a.pool, returned)?;
    }
    a.exit.cancelled = true;
    a.exit.shares = 0;
    a.exit.value = 0;
    emit!(SeniorExitCancelled { owner: a.owner.key(), ticket: a.exit.ticket, shares, returned });
    Ok(())
}
