use anchor_lang::prelude::*;

use crate::{constants::*, error::PluribusError, events::*, math::*, oracle::*, risk::*, state::*, token2022};

#[derive(Accounts)]
pub struct Accrue<'info> {
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
}

pub fn handle_accrue(ctx: Context<Accrue>) -> Result<()> {
    ctx.accounts.pool.accrue(Clock::get()?.unix_timestamp)
}

#[derive(Accounts)]
pub struct UpdateVol<'info> {
    #[account(seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [ASSET_SEED, asset.mint.as_ref()], bump = asset.bump)]
    pub asset: Box<Account<'info, Asset>>,
    /// CHECK: The asset's own price account, checked by the quote reader against the asset's feed or mint
    pub price: UncheckedAccount<'info>,
}

/// Permissionless: folds the asset's latest price into its volatility, which sets its dynamic shock
/// Only a fresh, certain price that is newer than the last sample by the minimum interval counts,
/// and its own publish time measures the gap, so calling more often changes nothing
pub fn handle_update_vol(ctx: Context<UpdateVol>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let (pool, asset) = (&ctx.accounts.pool, &mut ctx.accounts.asset);
    let p = &pool.params;
    require!(asset.params.oracle != ORACLE_FIXED, PluribusError::InvalidPriceAccount);
    let mut q = read_quote(pool, asset, &ctx.accounts.price)?;
    // The volatility measured is that of the price health checks use, so remaining accounts follow a health check's order:
    // a Token-2022 asset's mint, then for a staking token the SOL price and, for a stake pool backing, the pool
    let mut rem = ctx.remaining_accounts.iter();
    let mut next = || rem.next().ok_or_else(|| error!(PluribusError::MissingAccount));
    let mut restart = false;
    if asset.token_program == anchor_spl::token_2022::ID {
        let acc = next()?;
        require_keys_eq!(acc.key(), asset.mint, PluribusError::AccountMismatch);
        require_keys_eq!(*acc.owner, anchor_spl::token_2022::ID, PluribusError::AccountMismatch);
        if let Some(s) = token2022::read_state(acc)?.scaled.filter(|_| asset.params.ui_multiplier) {
            let (m, near) = s.multiplier_for(q.publish_time);
            q.price = mul_div_floor(q.price, m, token2022::MULTIPLIER_ONE)?;
            q.conf = mul_div_ceil(q.conf, m, token2022::MULTIPLIER_ONE)?;
            // A split moves the share price and the multiplier together, so a sample across a change, or near one where
            // the basis is unclear, measures no volatility and only restarts from the new price
            restart = near || s.multiplier_for(asset.vol_time).1 || s.changes_between(asset.vol_time, q.publish_time);
        }
    }
    // A staking token is priced at the lower of its own price and its SOL backing
    if asset.params.rate_source != RATE_NONE {
        let sol = next()?;
        let stake_pool = if asset.params.rate_source == RATE_STAKE_POOL { Some(next()?) } else { None };
        q.price = q.price.min(backing_price(pool, asset, sol, stake_pool, now)?.price);
    }
    require!(q.price > 0 && q.price <= u64::MAX as u128, PluribusError::InvalidPriceAccount);
    require!(now.saturating_sub(q.publish_time) <= p.vol_max_age_secs as i64, PluribusError::StalePrice);
    require!(q.conf * BPS <= q.price * p.vol_conf_cap_bps as u128, PluribusError::PriceTooUncertain);
    // A publish time from the future would block every honest sample until then
    require!(q.publish_time <= now + 60, PluribusError::InvalidPriceAccount);
    if restart && asset.vol_time != 0 {
        asset.restart_vol(q.price as u64, q.publish_time, p)?;
    } else {
        asset.record_vol(q.price as u64, q.conf as u64, q.publish_time, p)?;
    }
    let (shock_init_bps, shock_maint_bps) = asset.dynamic_shocks(p);
    emit!(VolUpdated { mint: asset.mint, price: q.price as u64, shock_init_bps: shock_init_bps as u64, shock_maint_bps: shock_maint_bps as u64 });
    Ok(())
}

#[derive(Accounts)]
pub struct RefreshTier<'info> {
    #[account(mut, seeds = [CREDIT_SEED, credit.owner.as_ref()], bump = credit.bump)]
    pub credit: Box<Account<'info, CreditAccount>>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
}

/// Permissionless: moves an account up a loyalty tier once it has stayed healthy long enough
/// Drops it to the base tier as soon as its health is under the warning level
// Shortcut: health is only sampled when this runs so a dip between calls goes unseen, run it from the keeper
pub fn handle_refresh_tier(ctx: Context<RefreshTier>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = ctx.accounts;
    a.pool.accrue(now)?;
    let debt = a.pool.debt_of(&a.credit)?;
    let from = a.credit.tier;
    let mut to = from;
    if debt > 0 {
        let limit = evaluate(&a.pool, &a.credit, ctx.remaining_accounts, now, Scope::Liquidation)?.liquidation_limit();
        if limit * BPS < debt * a.pool.params.warn_health_bps as u128 {
            to = 0;
            a.credit.healthy_since = now;
        }
    }
    let healthy_for = now.saturating_sub(a.credit.healthy_since);
    // Tiers are earned by borrowing in good standing, so an idle account never moves up
    while debt > 0 && (to as usize) + 1 < TIERS && healthy_for >= a.pool.params.tier_min_healthy_secs[to as usize + 1] {
        to += 1;
    }
    if to != from {
        a.pool.move_tier(&mut a.credit, to)?;
        emit!(TierChanged { account: a.credit.key(), from, to });
    }
    Ok(())
}

#[derive(Accounts)]
pub struct ViewHealth<'info> {
    #[account(seeds = [CREDIT_SEED, credit.owner.as_ref()], bump = credit.bump)]
    pub credit: Box<Account<'info, CreditAccount>>,
    #[account(seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq)]
pub struct HealthView {
    pub debt: u64,
    pub credit_limit: u64,
    pub liquidation_limit: u64,
    pub collateral_value: u64,
    pub borrow_rate_bps: u16,
    pub tier: u8,
    pub position_value: [u64; MAX_POSITIONS],
    pub position_price: [u64; MAX_POSITIONS],
}

/// Read-only: clients simulate this so the dashboard and keeper use the program's own numbers
pub fn handle_health(ctx: Context<ViewHealth>) -> Result<HealthView> {
    let now = Clock::get()?.unix_timestamp;
    let credit = &ctx.accounts.credit;
    let mut pool = Pool::clone(&ctx.accounts.pool);
    pool.accrue(now)?;
    let h = evaluate(&pool, credit, ctx.remaining_accounts, now, Scope::All)?;
    let mut view = HealthView {
        debt: to_u64(pool.debt_of(credit)?)?,
        credit_limit: to_u64(h.credit_limit())?,
        liquidation_limit: to_u64(h.liquidation_limit())?,
        collateral_value: to_u64(h.market.iter().sum())?,
        borrow_rate_bps: pool.tier_rate_bps(credit.tier as usize)?.min(u16::MAX as u128) as u16,
        tier: credit.tier,
        position_value: [0; MAX_POSITIONS],
        position_price: [0; MAX_POSITIONS],
    };
    for i in 0..MAX_POSITIONS {
        view.position_value[i] = to_u64(h.market[i])?;
        view.position_price[i] = to_u64(h.price[i])?;
    }
    Ok(view)
}
