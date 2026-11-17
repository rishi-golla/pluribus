use anchor_lang::prelude::*;
use anchor_spl::token_interface::{burn, mint_to, Burn, Mint, MintTo, TokenAccount, TokenInterface};

use crate::{constants::*, error::PluribusError, events::*, math::*, state::*, token::*};

fn mint_shares<'info>(
    program: &Interface<'info, TokenInterface>,
    mint: &InterfaceAccount<'info, Mint>,
    to: &InterfaceAccount<'info, TokenAccount>,
    pool: &Account<'info, Pool>,
    amount: u64,
) -> Result<()> {
    let accounts = MintTo { mint: mint.to_account_info(), to: to.to_account_info(), authority: pool.to_account_info() };
    let seeds = pool.signer_seeds();
    mint_to(CpiContext::new_with_signer(program.key(), accounts, &[&seeds]), amount)
}

#[derive(Accounts)]
pub struct ConvertToJunior<'info> {
    pub lender: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump, has_one = share_mint, has_one = junior_mint)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut)]
    pub share_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub junior_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = share_mint, token::authority = lender)]
    pub lender_shares: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = junior_mint)]
    pub lender_junior: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// Turns senior shares into junior shares at both share prices
/// No USDC moves, so it works however much of the pool is lent out
pub fn handle_convert_to_junior(ctx: Context<ConvertToJunior>, shares: u64) -> Result<()> {
    let a = ctx.accounts;
    a.pool.accrue(Clock::get()?.unix_timestamp)?;
    let (value, minted) = a.pool.to_junior(a.share_mint.supply, shares, a.junior_mint.supply)?;
    let accounts = Burn {
        mint: a.share_mint.to_account_info(),
        from: a.lender_shares.to_account_info(),
        authority: a.lender.to_account_info(),
    };
    burn(CpiContext::new(a.token_program.key(), accounts), shares)?;
    mint_shares(&a.token_program, &a.junior_mint, &a.lender_junior, &a.pool, minted)?;
    emit!(TrancheConverted { lender: a.lender.key(), shares, value, minted });
    Ok(())
}

#[derive(Accounts)]
pub struct RequestJuniorExit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump, has_one = junior_mint)]
    pub pool: Box<Account<'info, Pool>>,
    pub junior_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = junior_mint, token::authority = owner)]
    pub owner_junior: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [JUNIOR_ESCROW_SEED], bump)]
    pub junior_escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init, payer = owner, space = 8 + JuniorExit::INIT_SPACE, seeds = [JUNIOR_EXIT_SEED, owner.key().as_ref()], bump)]
    pub exit: Box<Account<'info, JuniorExit>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Queues junior shares for exit: they move to the escrow and wait out a delay that grows with the queue
/// One exit per owner at a time, cancel it to queue a different amount
pub fn handle_request_junior_exit(ctx: Context<RequestJuniorExit>, shares: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = ctx.accounts;
    require!(shares > 0, PluribusError::ZeroAmount);
    require!(!a.pool.junior_exits_paused(now), PluribusError::ExitsPaused);
    a.pool.accrue(now)?;
    // Fixed now: the exit can lose value while it waits but never gains any
    let value = a.pool.value_of(true, a.junior_mint.supply, shares)?;
    let queued = a.pool.junior_queued.checked_add(shares).ok_or(PluribusError::MathOverflow)?;
    let delay = a.pool.params.junior_exit_delay(queued, a.junior_mint.supply);
    pull(&a.token_program, &a.junior_mint, &a.owner_junior, &a.junior_escrow, &a.owner, shares)?;
    a.pool.junior_queued = queued;
    let p = &a.pool.params;
    a.exit.set_inner(JuniorExit {
        owner: a.owner.key(),
        shares,
        value,
        unlock_at: now + delay,
        window_secs: p.junior_exit_window_secs,
        fee_bps: p.junior_exit_fee_bps,
        bump: ctx.bumps.exit,
    });
    let deadline = a.pool.junior_exit_deadline(&a.exit);
    emit!(JuniorExitRequested { owner: a.owner.key(), shares, value, unlock_at: a.exit.unlock_at, deadline });
    Ok(())
}

#[derive(Accounts)]
pub struct ClaimJuniorExit<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        mut,
        seeds = [POOL_SEED],
        bump = pool.bump,
        has_one = usdc_mint,
        has_one = usdc_vault,
        has_one = share_mint,
        has_one = junior_mint,
    )]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, close = owner, seeds = [JUNIOR_EXIT_SEED, owner.key().as_ref()], bump = exit.bump)]
    pub exit: Box<Account<'info, JuniorExit>>,
    #[account(mut)]
    pub junior_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [JUNIOR_ESCROW_SEED], bump)]
    pub junior_escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub share_mint: Box<InterfaceAccount<'info, Mint>>,
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// USDC to be paid in cash, or senior shares to be paid in those
    #[account(mut, constraint = payout.mint == usdc_mint.key() || payout.mint == share_mint.key() @ PluribusError::AccountMismatch)]
    pub payout: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// Pays out a queued exit at the junior share price of the moment, so losses booked while it waited are shared,
/// but never above what it was worth when queued, so yield earned meanwhile stays with the juniors who remain
/// The fee stays with them too
/// Senior shares never need idle cash, while USDC needs it in the pool
pub fn handle_claim_junior_exit(ctx: Context<ClaimJuniorExit>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = ctx.accounts;
    a.pool.accrue(now)?;
    require!(!a.pool.junior_exits_paused(now), PluribusError::ExitsPaused);
    require!(now >= a.exit.unlock_at, PluribusError::ExitNotReady);
    require!(now < a.pool.junior_exit_deadline(&a.exit), PluribusError::ExitLapsed);

    let shares = a.exit.shares;
    let value = a.pool.junior_exit_value(a.junior_mint.supply, &a.exit)?;
    let fee_bps = a.exit.fee_bps.min(a.pool.params.junior_exit_fee_bps);
    let fee = to_u64(mul_div_ceil(value as u128, fee_bps as u128, BPS)?)?;
    let paid = value.saturating_sub(fee);
    require!(paid > 0, PluribusError::ZeroAmount);
    let in_usdc = a.payout.mint == a.pool.usdc_mint;
    // Priced before the junior side shrinks, since the senior tranche grows by exactly what is paid
    let senior_minted = if in_usdc { 0 } else { a.pool.shares_for(false, a.share_mint.supply, paid)? };
    if in_usdc {
        require!(paid <= a.pool.cash, PluribusError::InsufficientLiquidity);
        a.pool.cash -= paid;
    } else {
        require!(senior_minted > 0, PluribusError::ZeroAmount);
    }
    a.pool.junior_assets = a.pool.junior_assets.saturating_sub(paid);
    a.pool.junior_queued = a.pool.junior_queued.saturating_sub(shares);

    let accounts = Burn {
        mint: a.junior_mint.to_account_info(),
        from: a.junior_escrow.to_account_info(),
        authority: a.pool.to_account_info(),
    };
    let seeds = a.pool.signer_seeds();
    burn(CpiContext::new_with_signer(a.token_program.key(), accounts, &[&seeds]), shares)?;
    // With the last junior share gone, what is left belongs to no junior lender, so the insurance reserve takes it
    // Only the part lender assets really back moves, rounding can leave junior assets a few units above them
    if shares == a.junior_mint.supply {
        let left = to_u64(a.pool.tranche_assets(true)?)?;
        a.pool.reserves = a.pool.reserves.saturating_add(left);
        a.pool.junior_assets = 0;
    }
    if in_usdc {
        push(&a.token_program, &a.usdc_mint, &a.usdc_vault, &a.payout, &a.pool, paid)?;
    } else {
        mint_shares(&a.token_program, &a.share_mint, &a.payout, &a.pool, senior_minted)?;
    }
    emit!(JuniorExitClaimed { owner: a.owner.key(), shares, value, fee, paid, in_usdc });
    Ok(())
}

#[derive(Accounts)]
pub struct CancelJuniorExit<'info> {
    pub caller: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump, has_one = junior_mint)]
    pub pool: Box<Account<'info, Pool>>,
    /// CHECK: Only receives the exit's rent, and must be the owner who paid it
    #[account(mut, address = exit.owner)]
    pub owner: UncheckedAccount<'info>,
    #[account(mut, close = owner, seeds = [JUNIOR_EXIT_SEED, exit.owner.as_ref()], bump = exit.bump)]
    pub exit: Box<Account<'info, JuniorExit>>,
    #[account(mut)]
    pub junior_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [JUNIOR_ESCROW_SEED], bump)]
    pub junior_escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = junior_mint, token::authority = exit.owner)]
    pub owner_junior: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// Hands queued shares back to the owner, who can do this at any time, pause or not
/// Anyone can do it once the exit has lapsed, so stale exits stop lengthening the queue for everyone else
/// The owner gets back shares worth what the queued ones were worth when queued, and the yield earned meanwhile
/// is burned into the junior share price, so holding an exit open always costs that yield
pub fn handle_cancel_junior_exit(ctx: Context<CancelJuniorExit>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = ctx.accounts;
    a.pool.accrue(now)?;
    let lapsed = now >= a.pool.junior_exit_deadline(&a.exit);
    require!(a.caller.key() == a.exit.owner || lapsed, PluribusError::ExitNotLapsed);
    let shares = a.exit.shares;
    let current = a.pool.value_of(true, a.junior_mint.supply, shares)?;
    // A lone junior has nobody to leave the yield to, so the insurance reserve takes it and every share goes back
    let alone = shares == a.junior_mint.supply;
    if alone && current > a.exit.value {
        let yielded = current - a.exit.value;
        a.pool.junior_assets = a.pool.junior_assets.saturating_sub(yielded);
        a.pool.reserves = a.pool.reserves.saturating_add(yielded);
    }
    let returned = if current > a.exit.value && !alone {
        // Burning the rest lifts the price of what is handed back too, so this many are worth what was queued afterwards
        let assets = a.pool.tranche_assets(true)? + VIRTUAL_SHARES;
        let others = a.junior_mint.supply as u128 + VIRTUAL_SHARES - shares as u128;
        to_u64(mul_div_wide(a.exit.value as u128, others, assets - a.exit.value as u128)?)?.min(shares)
    } else {
        shares
    };
    a.pool.junior_queued = a.pool.junior_queued.saturating_sub(shares);
    if returned < shares {
        let accounts = Burn {
            mint: a.junior_mint.to_account_info(),
            from: a.junior_escrow.to_account_info(),
            authority: a.pool.to_account_info(),
        };
        let seeds = a.pool.signer_seeds();
        burn(CpiContext::new_with_signer(a.token_program.key(), accounts, &[&seeds]), shares - returned)?;
    }
    if returned > 0 {
        push(&a.token_program, &a.junior_mint, &a.junior_escrow, &a.owner_junior, &a.pool, returned)?;
    }
    emit!(JuniorExitCancelled { owner: a.exit.owner, shares, returned, lapsed });
    Ok(())
}
