use anchor_lang::prelude::*;

use crate::{constants::*, error::PluribusError, events::*, math::*, oracle::*, risk::*, state::*};

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
    let q = read_quote(pool, asset, &ctx.accounts.price)?;
    require!(q.price > 0 && q.price <= u64::MAX as u128, PluribusError::InvalidPriceAccount);
    require!(now.saturating_sub(q.publish_time) <= p.vol_max_age_secs as i64, PluribusError::StalePrice);
    require!(q.conf * BPS <= q.price * p.vol_conf_cap_bps as u128, PluribusError::PriceTooUncertain);
    asset.record_vol(q.price as u64, q.publish_time, p)?;
    emit!(VolUpdated {
        mint: asset.mint,
        price: q.price as u64,
        shock_init_bps: asset.dynamic_shock(p.z_init_x100) as u64,
        shock_maint_bps: asset.dynamic_shock(p.z_maint_x100) as u64,
    });
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
