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
    // For a multiplier token: whether this price's basis is certain
    let mut scaled: Option<bool> = None;
    if asset.token_program == anchor_spl::token_2022::ID {
        let acc = next()?;
        require_keys_eq!(acc.key(), asset.mint, PluribusError::AccountMismatch);
        require_keys_eq!(*acc.owner, anchor_spl::token_2022::ID, PluribusError::AccountMismatch);
        if let Some(s) = token2022::read_state(acc)?.scaled.filter(|_| asset.params.ui_multiplier) {
            // A split moves the share price and the multiplier together, so a new multiplier restarts sampling
            token2022::sync(asset, &s, now);
            let Some((m, sure)) = token2022::multiplier(asset, &s, now, q.publish_time, q.price) else { return Ok(()) };
            q.price = mul_div_floor(q.price, m, token2022::MULTIPLIER_ONE)?;
            q.conf = mul_div_ceil(q.conf, m, token2022::MULTIPLIER_ONE)?;
            scaled = Some(sure);
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
    // A multiplier token's jump far from the last sample might be the feed repricing for a split the mint has yet to
    // apply: it is noted, even while the basis is unsure, and only folded in once it has held with no multiplier change
    if let Some(sure) = scaled {
        let t = q.publish_time;
        if token2022::far(asset, q.price) {
            token2022::note_jump(asset, q.price, t);
            if !sure || t < asset.jump_since + asset.params.jump_hold_secs as i64 {
                return Ok(());
            }
        } else if asset.jump_since != 0 {
            // A price from before the last far one says nothing about whether the jump held
            if t <= asset.jump_seen {
                return Ok(());
            }
            // One back near the last sample ends the jump, and that sticks even when it is too soon to sample
            token2022::clear_jump(asset);
            if !sure || t < asset.vol_time + p.vol_min_interval_secs as i64 {
                return Ok(());
            }
        } else if !sure {
            return Ok(());
        }
        token2022::clear_jump(asset);
    }
    asset.record_vol(q.price as u64, q.conf as u64, q.publish_time, p)?;
    let (shock_init_bps, shock_maint_bps) = asset.dynamic_shocks(p);
    emit!(VolUpdated { mint: asset.mint, price: q.price as u64, shock_init_bps: shock_init_bps as u64, shock_maint_bps: shock_maint_bps as u64 });
    Ok(())
}

#[derive(Accounts)]
pub struct SyncMint<'info> {
    #[account(mut, seeds = [ASSET_SEED, asset.mint.as_ref()], bump = asset.bump)]
    pub asset: Box<Account<'info, Asset>>,
    /// CHECK: The asset's own Token-2022 mint, read by hand for its multiplier
    #[account(address = asset.mint, owner = anchor_spl::token_2022::ID)]
    pub mint: UncheckedAccount<'info>,
}

/// Permissionless: records a Token-2022 asset's new multiplier, so a change applied at once is dated as soon as anyone sees it
pub fn handle_sync_mint(ctx: Context<SyncMint>) -> Result<()> {
    if let Some(s) = token2022::read_state(&ctx.accounts.mint)?.scaled.filter(|_| ctx.accounts.asset.params.ui_multiplier) {
        token2022::sync(&mut ctx.accounts.asset, &s, Clock::get()?.unix_timestamp);
    }
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
/// Also books the risk premium and resets it to the collateral held now, so the keeper keeps both current
// Shortcut: health is only sampled when this runs so a dip between calls goes unseen, run it from the keeper
pub fn handle_refresh_tier(ctx: Context<RefreshTier>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let a = ctx.accounts;
    a.pool.accrue(now)?;
    book_premium(&mut a.pool, &mut a.credit, now)?;
    let debt = a.pool.debt_of(&a.credit)?;
    let from = a.credit.tier;
    let mut to = from;
    if debt > 0 {
        let h = evaluate(&a.pool, &a.credit, ctx.remaining_accounts, now, Scope::All)?;
        a.credit.premium_bps = h.premium_bps();
        let limit = h.liquidation_limit();
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
    /// Positions whose price is unclear around a corporate action, which can't be seized yet
    pub position_unclear: [bool; MAX_POSITIONS],
    /// Part of `borrow_rate_bps` that is the collateral's risk premium after the tier's share
    pub premium_rate_bps: u16,
}

/// Read-only: clients simulate this so the dashboard and keeper use the program's own numbers
pub fn handle_health(ctx: Context<ViewHealth>) -> Result<HealthView> {
    let now = Clock::get()?.unix_timestamp;
    let mut credit = CreditAccount::clone(&ctx.accounts.credit);
    let mut pool = Pool::clone(&ctx.accounts.pool);
    pool.accrue(now)?;
    // The debt as the next instruction will see it, premium owed so far included
    pool.book_premium(&mut credit, now)?;
    let h = evaluate(&pool, &credit, ctx.remaining_accounts, now, Scope::All)?;
    // The premium the collateral held now carries, which the next refresh puts into effect
    credit.premium_bps = h.premium_bps();
    let premium = pool.premium_rate_bps(&credit);
    let mut view = HealthView {
        debt: to_u64(pool.debt_of(&credit)?)?,
        credit_limit: to_u64(h.credit_limit())?,
        liquidation_limit: to_u64(h.liquidation_limit())?,
        collateral_value: to_u64(h.market.iter().sum())?,
        borrow_rate_bps: (pool.tier_rate_bps(credit.tier as usize)? + premium).min(u16::MAX as u128) as u16,
        tier: credit.tier,
        position_value: [0; MAX_POSITIONS],
        position_price: [0; MAX_POSITIONS],
        position_unclear: [false; MAX_POSITIONS],
        premium_rate_bps: premium.min(u16::MAX as u128) as u16,
    };
    for i in 0..MAX_POSITIONS {
        view.position_value[i] = to_u64(h.market[i])?;
        view.position_price[i] = to_u64(h.price[i])?;
        view.position_unclear[i] = h.unclear[i];
    }
    Ok(view)
}
