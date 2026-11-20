use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{clmm::read_pool, constants::*, error::PluribusError, events::*, state::*, token::push};

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: Address, owner and upgrade authority are checked in the handler
    pub program_data: UncheckedAccount<'info>,
    #[account(init, payer = admin, space = 8 + Pool::INIT_SPACE, seeds = [POOL_SEED], bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(
        constraint = usdc_mint.decimals == USDC_DECIMALS && *usdc_mint.to_account_info().owner == anchor_spl::token::ID
            @ PluribusError::UnsupportedMint
    )]
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(
        init,
        payer = admin,
        seeds = [USDC_VAULT_SEED],
        bump,
        token::mint = usdc_mint,
        token::authority = pool,
        token::token_program = token_program,
    )]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(
        init,
        payer = admin,
        seeds = [SHARE_MINT_SEED],
        bump,
        mint::decimals = USDC_DECIMALS,
        mint::authority = pool,
        mint::token_program = token_program,
    )]
    pub share_mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Only whoever can upgrade the program may set it up, so nobody can front-run the deployer
/// Read by hand because the loader's account type would add tens of kilobytes to the program
fn require_upgrade_authority(program_data: &AccountInfo, admin: &Pubkey) -> Result<()> {
    let loader = anchor_lang::solana_program::bpf_loader_upgradeable::ID;
    let expected = Pubkey::find_program_address(&[crate::ID.as_ref()], &loader).0;
    let d = program_data.try_borrow_data()?;
    // Layout: state tag u32, 3 for program data | slot u64 | authority option tag | authority
    let ok = program_data.key() == expected
        && *program_data.owner == loader
        && d.len() >= 45
        && d[..4] == [3, 0, 0, 0]
        && d[12] == 1
        && d[13..45] == admin.to_bytes();
    require!(ok, PluribusError::NotUpgradeAuthority);
    Ok(())
}

pub fn handle_initialize(ctx: Context<Initialize>, params: PoolParams, demo_mode: bool) -> Result<()> {
    require_upgrade_authority(&ctx.accounts.program_data, &ctx.accounts.admin.key())?;
    params.validate()?;
    ctx.accounts.pool.set_inner(Pool {
        admin: ctx.accounts.admin.key(),
        usdc_mint: ctx.accounts.usdc_mint.key(),
        usdc_vault: ctx.accounts.usdc_vault.key(),
        share_mint: ctx.accounts.share_mint.key(),
        junior_mint: Pubkey::default(),
        guardian: Pubkey::default(),
        bump: ctx.bumps.pool,
        demo_mode,
        paused: false,
        params,
        cash: 0,
        reserves: 0,
        protocol_fees: 0,
        bad_debt: 0,
        last_accrual: Clock::get()?.unix_timestamp,
        min_liq_cost_bps: u16::MAX,
        usdc_group: u8::MAX,
        junior_assets: 0,
        dust: [0; 3],
        borrow_index: [INDEX_ONE; TIERS],
        debt_shares: [0; TIERS],
        junior_queued: 0,
        junior_pause_start: 0,
        junior_pause_end: 0,
        junior_next_pause_at: 0,
        pending_params: params,
        pending_at: 0,
        // The first accrual opens the first epoch, with nothing in the buffer to pay yet
        yield_buffer: 0,
        epoch_start: Clock::get()?.unix_timestamp,
        epoch_end: Clock::get()?.unix_timestamp,
        epoch_budget: 0,
        epoch_paid: 0,
        senior_queued: 0,
        senior_reserved: 0,
        senior_next_ticket: 0,
        senior_head: 0,
        premium_tier_bps: [0; TIERS],
        pending_premium_tier_bps: [0; TIERS],
        premium_tier_pending_at: 0,
        premium_booked: 0,
        compound_bounty_bps: 0,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct MigratePool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: Read raw, since a pool from before the last layout change cannot be deserialized; owner, address and admin are checked in the handler
    #[account(mut, seeds = [POOL_SEED], bump)]
    pub pool: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Grows a pool created before fields were appended to `Pool` to the current size, the admin paying the extra rent
/// The new bytes start at zero, which every appended field takes as its starting value, and a pool already at size is left alone
pub fn handle_migrate_pool(ctx: Context<MigratePool>) -> Result<()> {
    let a = ctx.accounts;
    let pool = a.pool.to_account_info();
    require_keys_eq!(*pool.owner, crate::ID, PluribusError::WrongOwner);
    let size = 8 + Pool::INIT_SPACE;
    {
        let data = pool.try_borrow_data()?;
        // Layout: discriminator, then the admin key
        require!(data.len() >= 40 && data[..8] == *Pool::DISCRIMINATOR, PluribusError::AccountMismatch);
        require!(data[8..40] == a.admin.key().to_bytes(), PluribusError::AccountMismatch);
        if data.len() >= size {
            return Ok(());
        }
    }
    let rent = Rent::get()?.minimum_balance(size).saturating_sub(pool.lamports());
    if rent > 0 {
        let accounts = anchor_lang::system_program::Transfer { from: a.admin.to_account_info(), to: pool.clone() };
        anchor_lang::system_program::transfer(CpiContext::new(a.system_program.key(), accounts), rent)?;
    }
    pool.resize(size)?;
    Ok(())
}

#[derive(Accounts)]
pub struct MigrateAccount<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    /// CHECK: Read raw, since an account from before the last layout change cannot be deserialized; owner and discriminator are checked in the handler
    #[account(mut)]
    pub account: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

/// Permissionless: grows an asset or credit account created before fields were appended to it, the payer covering the extra rent
/// The new bytes start at zero, which every appended field takes as its starting value, so growing one changes nothing it holds,
/// and one already at size is left alone
pub fn handle_migrate_account(ctx: Context<MigrateAccount>) -> Result<()> {
    let a = ctx.accounts;
    let account = a.account.to_account_info();
    require_keys_eq!(*account.owner, crate::ID, PluribusError::WrongOwner);
    let size = {
        let data = account.try_borrow_data()?;
        require!(data.len() >= 8, PluribusError::AccountMismatch);
        if data[..8] == *Asset::DISCRIMINATOR {
            8 + Asset::INIT_SPACE
        } else if data[..8] == *CreditAccount::DISCRIMINATOR {
            8 + CreditAccount::INIT_SPACE
        } else {
            return err!(PluribusError::AccountMismatch);
        }
    };
    if account.data_len() >= size {
        return Ok(());
    }
    let rent = Rent::get()?.minimum_balance(size).saturating_sub(account.lamports());
    if rent > 0 {
        let accounts = anchor_lang::system_program::Transfer { from: a.payer.to_account_info(), to: account.clone() };
        anchor_lang::system_program::transfer(CpiContext::new(a.system_program.key(), accounts), rent)?;
    }
    account.resize(size)?;
    Ok(())
}

#[derive(Accounts)]
pub struct SetAssetPremium<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [POOL_SEED], bump = pool.bump, has_one = admin)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [ASSET_SEED, asset.mint.as_ref()], bump = asset.bump)]
    pub asset: Box<Account<'info, Asset>>,
}

/// A lower premium applies at once and drops a waiting raise; a higher one waits out the activation delay,
/// so borrowers have time to repay or move collateral before they pay more
/// Accounts pay a new premium from their next refresh, which the keeper runs
pub fn handle_set_asset_premium(ctx: Context<SetAssetPremium>, premium_bps: u16) -> Result<()> {
    require!(premium_bps <= MAX_RISK_PREMIUM_BPS, PluribusError::InvalidParams);
    let now = Clock::get()?.unix_timestamp;
    let delay = ctx.accounts.pool.params.activation_delay_secs as i64;
    let asset = &mut ctx.accounts.asset;
    if premium_bps <= asset.premium_bps || delay == 0 {
        asset.premium_bps = premium_bps;
        asset.premium_pending_at = 0;
        emit!(ChangeApplied { target: asset.key() });
    } else {
        asset.pending_premium_bps = premium_bps;
        asset.premium_pending_at = now + delay;
        emit!(ChangeQueued { target: asset.key(), effective_at: asset.premium_pending_at });
    }
    Ok(())
}

/// Sets the liquidator's bonus on an asset and on liquidity positions in it, where 0 takes the pool's
/// It applies at once either way: the pool's bonus is the most any collateral pays, and a change to that waits out the activation delay
pub fn handle_set_asset_liq_bonus(ctx: Context<SetAssetPremium>, liq_bonus_bps: u16, lp_liq_bonus_bps: u16) -> Result<()> {
    let max = ctx.accounts.pool.params.liq_bonus_bps;
    require!(liq_bonus_bps <= max && lp_liq_bonus_bps <= max, PluribusError::InvalidParams);
    let asset = &mut ctx.accounts.asset;
    asset.liq_bonus_bps = liq_bonus_bps;
    asset.lp_liq_bonus_bps = lp_liq_bonus_bps;
    emit!(ChangeApplied { target: asset.key() });
    Ok(())
}

#[derive(Accounts)]
pub struct ApplyAssetPremium<'info> {
    #[account(mut, seeds = [ASSET_SEED, asset.mint.as_ref()], bump = asset.bump)]
    pub asset: Box<Account<'info, Asset>>,
}

/// Permissionless: puts a waiting premium raise into effect once its delay has passed
pub fn handle_apply_asset_premium(ctx: Context<ApplyAssetPremium>) -> Result<()> {
    let asset = &mut ctx.accounts.asset;
    require!(asset.premium_pending_at != 0, PluribusError::NoPendingChange);
    require!(Clock::get()?.unix_timestamp >= asset.premium_pending_at, PluribusError::ChangeNotDue);
    asset.premium_bps = asset.pending_premium_bps;
    asset.premium_pending_at = 0;
    emit!(ChangeApplied { target: asset.key() });
    Ok(())
}

/// Sets the share of each asset's premium charged in each loyalty tier: the full premium at most, never rising with loyalty
/// Cuts apply at once and drop a waiting raise, a raise waits out the activation delay
pub fn handle_set_premium_tiers(ctx: Context<AdminPool>, tier_bps: [u16; TIERS]) -> Result<()> {
    require!(
        tier_bps.iter().all(|b| *b as u128 <= BPS) && tier_bps.windows(2).all(|w| w[0] >= w[1]),
        PluribusError::InvalidParams
    );
    let now = Clock::get()?.unix_timestamp;
    let pool = &mut ctx.accounts.pool;
    let delay = pool.params.activation_delay_secs as i64;
    if tier_bps.iter().zip(pool.premium_tier_bps).all(|(new, old)| *new <= old) || delay == 0 {
        pool.premium_tier_bps = tier_bps;
        pool.premium_tier_pending_at = 0;
        emit!(ChangeApplied { target: pool.key() });
    } else {
        pool.pending_premium_tier_bps = tier_bps;
        pool.premium_tier_pending_at = now + delay;
        emit!(ChangeQueued { target: pool.key(), effective_at: pool.premium_tier_pending_at });
    }
    Ok(())
}

/// Permissionless: puts waiting tier shares into effect once their delay has passed
pub fn handle_apply_premium_tiers(ctx: Context<ApplyParams>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    require!(pool.premium_tier_pending_at != 0, PluribusError::NoPendingChange);
    require!(Clock::get()?.unix_timestamp >= pool.premium_tier_pending_at, PluribusError::ChangeNotDue);
    pool.premium_tier_bps = pool.pending_premium_tier_bps;
    pool.premium_tier_pending_at = 0;
    emit!(ChangeApplied { target: pool.key() });
    Ok(())
}

#[derive(Accounts)]
pub struct SetPriceExponent<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [POOL_SEED], bump = pool.bump, has_one = admin)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [ASSET_SEED, asset.mint.as_ref()], bump = asset.bump)]
    pub asset: Box<Account<'info, Asset>>,
}

/// Quotes the asset's price per 10^exponent whole tokens, for a token worth so little that six decimals per token
/// would round its price to nothing
/// Only while nothing is deposited and before the listing backs debt, or in demo mode, since every price on the old unit
/// would be off by the same factor; a staking or multiplier token is priced through SOL or per share and keeps exponent 0
pub fn handle_set_price_exponent(ctx: Context<SetPriceExponent>, exponent: u8) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let (pool, asset) = (&ctx.accounts.pool, &mut ctx.accounts.asset);
    let p = &asset.params;
    require!(
        exponent <= MAX_PRICE_EXPONENT && p.oracle == ORACLE_PYTH && p.rate_source == RATE_NONE && !p.ui_multiplier,
        PluribusError::InvalidParams
    );
    require!(asset.total_deposited == 0 && (pool.demo_mode || now < pool.effective_at(asset.active_at)), PluribusError::InvalidParams);
    asset.price_exponent = exponent;
    // The last volatility sample is on the old unit, and comparing across units would read as a crash or a spike
    asset.vol_price = 0;
    asset.vol_time = 0;
    emit!(ChangeApplied { target: asset.key() });
    Ok(())
}

#[derive(Accounts)]
pub struct DemoAsset<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [POOL_SEED], bump = pool.bump, has_one = admin, constraint = pool.demo_mode @ PluribusError::DemoDisabled)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [ASSET_SEED, asset.mint.as_ref()], bump = asset.bump)]
    pub asset: Box<Account<'info, Asset>>,
}

/// Demo mode only: prices this asset from its Pyth feed instead of the admin's demo account, or back again
/// An admin who writes prices already decides every value, so switching sources needs no delay
pub fn handle_demo_set_live_price(ctx: Context<DemoAsset>, live: bool) -> Result<()> {
    let asset = &mut ctx.accounts.asset;
    // A fixed-price asset has no feed, and a live one needs a feed to read
    require!(!live || (asset.params.oracle == ORACLE_PYTH && asset.params.pyth_feed_id != [0; 32]), PluribusError::InvalidParams);
    if asset.live_price != live {
        // The last sample is on the other source, and the gap between a demo price and the market would read as a crash or
        // a spike, so sampling starts again from the new source's first price
        asset.vol_price = 0;
        asset.vol_time = 0;
        crate::token2022::clear_jump(asset);
    }
    asset.live_price = live;
    emit!(ChangeApplied { target: asset.key() });
    Ok(())
}

/// Demo mode only: sets both of the asset's variance averages to `sigma_bps` of annual volatility, as a listing seeds them,
/// and starts sampling again from the next price
/// For a demo whose volatility a test or a price-source switch has thrown off; an admin who writes the prices already
/// decides every shock, so this adds no power, and with demo mode off it is gone for good
pub fn handle_demo_reset_vol(ctx: Context<DemoAsset>, sigma_bps: u32) -> Result<()> {
    require!(sigma_bps <= 100_000, PluribusError::InvalidParams);
    let asset = &mut ctx.accounts.asset;
    let seed = Asset::seed_variance(sigma_bps);
    asset.var_fast = seed;
    asset.var_slow = seed;
    asset.vol_price = 0;
    asset.vol_time = 0;
    crate::token2022::clear_jump(asset);
    emit!(ChangeApplied { target: asset.key() });
    Ok(())
}

#[derive(Accounts)]
pub struct DemoActivate<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump, has_one = admin, constraint = pool.demo_mode @ PluribusError::DemoDisabled)]
    pub pool: Box<Account<'info, Pool>>,
}

/// Demo mode only: puts every waiting change into effect now, for the pool and for the assets and LP markets passed as
/// writable remaining accounts, and ends their listings' activation delay
/// The delays give juniors time to leave before risk changes, but an admin who writes prices can already move every account
/// wherever it likes, so in demo mode they protect nobody and only stall a demo; with demo mode off this is unavailable for good
pub fn handle_demo_activate(ctx: Context<DemoActivate>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let pool = &mut ctx.accounts.pool;
    if pool.pending_at != 0 {
        let params = pool.pending_params;
        require!(params.bonus_fits(pool.min_liq_cost_bps), PluribusError::InvalidParams);
        apply_params(pool, params, now)?;
    }
    if pool.premium_tier_pending_at != 0 {
        pool.premium_tier_bps = pool.pending_premium_tier_bps;
        pool.premium_tier_pending_at = 0;
    }
    for acc in ctx.remaining_accounts {
        require!(acc.is_writable, PluribusError::AccountMismatch);
        require_keys_eq!(*acc.owner, crate::ID, PluribusError::WrongOwner);
        let is_asset = acc.try_borrow_data()?.get(..8) == Some(Asset::DISCRIMINATOR);
        if is_asset {
            let mut asset: Asset = crate::oracle::load(acc)?;
            if asset.pending_at != 0 {
                record_asset(pool, &asset.mint, &asset.pending)?;
                asset.params = asset.pending;
                asset.pending_at = 0;
            }
            if asset.premium_pending_at != 0 {
                asset.premium_bps = asset.pending_premium_bps;
                asset.premium_pending_at = 0;
            }
            asset.active_at = asset.active_at.min(now);
            asset.try_serialize(&mut &mut acc.try_borrow_mut_data()?[..])?;
        } else {
            let mut market: LpMarket = crate::oracle::load(acc)?;
            if market.pending_at != 0 {
                record_lp_cost(pool, market.pending_liq_cost_bps)?;
                market.liq_cost_bps = market.pending_liq_cost_bps;
                market.paused = market.pending_paused;
                market.pending_at = 0;
            }
            market.active_at = market.active_at.min(now);
            market.try_serialize(&mut &mut acc.try_borrow_mut_data()?[..])?;
        }
        emit!(ChangeApplied { target: acc.key() });
    }
    Ok(())
}

#[derive(Accounts)]
pub struct AdminPool<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump, has_one = admin)]
    pub pool: Box<Account<'info, Pool>>,
}

/// Raising shocks or adding scenarios applies at once
/// Any other change waits out the activation delay, so juniors who disagree have time to leave
/// An immediate change drops whatever was waiting
pub fn handle_set_params(ctx: Context<AdminPool>, params: PoolParams) -> Result<()> {
    params.validate()?;
    let now = Clock::get()?.unix_timestamp;
    let pool = &mut ctx.accounts.pool;
    // A bonus above the smallest haircut already granted would make that collateral impossible to liquidate
    require!(params.bonus_fits(pool.min_liq_cost_bps), PluribusError::InvalidParams);
    let delay = pool.params.activation_delay_secs as i64;
    // Even with no delay nothing loosens while juniors are paused, it waits for the pause to end
    if pool.params.only_tightens(&params) || (delay == 0 && !pool.junior_exits_paused(now)) {
        apply_params(pool, params, now)?;
    } else {
        pool.pending_params = params;
        pool.pending_at = now + delay;
        emit!(ChangeQueued { target: pool.key(), effective_at: pool.pending_at });
    }
    Ok(())
}

fn apply_params(pool: &mut Account<Pool>, params: PoolParams, now: i64) -> Result<()> {
    // Settle interest at the old rates first
    pool.accrue(now)?;
    // A buffer filled over long epochs would otherwise be paid out over a short one, in a burst anyone can time
    // Turning epochs off is always fine, since the buffer then keeps paying out on its own schedule
    let (old, new) = (pool.params.epoch_secs, params.epoch_secs);
    let span = pool.epoch_end - pool.epoch_start;
    // Turning epochs back on at the length the buffer is already draining on, from a boundary of that grid
    let same_schedule = new == old || (new as i64 == span && (pool.epoch_end - EPOCH_ANCHOR).rem_euclid(span.max(1)) == 0);
    require!(same_schedule || new == 0 || pool.yield_buffer == 0, PluribusError::EpochChangeNotAllowed);
    // A new length starts now: the old epoch, with nothing left to pay, ends here so it cannot keep filling the buffer
    // for a short epoch to pay out later
    if new != 0 && !same_schedule {
        pool.epoch_budget = pool.epoch_paid;
        pool.epoch_end = pool.epoch_end.min(now);
    }
    // A shorter gap never brings the next pause closer than the gap that was in force until now
    if pool.junior_pause_end != 0 {
        let old_gap = pool.params.junior_pause_gap_secs as i64;
        pool.junior_next_pause_at = pool.junior_next_pause_at.max(pool.junior_pause_end.saturating_add(old_gap));
    }
    pool.params = params;
    pool.pending_at = 0;
    emit!(ChangeApplied { target: pool.key() });
    Ok(())
}

#[derive(Accounts)]
pub struct ApplyParams<'info> {
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
}

/// Permissionless: puts waiting parameters into effect once their delay has passed
/// A pause of junior exits during the wait adds a full delay after it, see `Pool::effective_at`
pub fn handle_apply_params(ctx: Context<ApplyParams>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let pool = &mut ctx.accounts.pool;
    require!(pool.pending_at != 0, PluribusError::NoPendingChange);
    require!(now >= pool.effective_at(pool.pending_at), PluribusError::ChangeNotDue);
    let params = pool.pending_params;
    // Collateral listed while the change waited may have a smaller haircut
    require!(params.bonus_fits(pool.min_liq_cost_bps), PluribusError::InvalidParams);
    apply_params(pool, params, now)
}

pub fn handle_set_guardian(ctx: Context<AdminPool>, guardian: Pubkey) -> Result<()> {
    ctx.accounts.pool.guardian = guardian;
    Ok(())
}

/// Freezes junior exit requests and claims for up to the capped length
/// A new pause has to wait out the gap after the last one, in which any junior can queue, wait and claim
pub fn handle_pause_junior_exits(ctx: Context<AdminPool>, duration_secs: u32) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let pool = &mut ctx.accounts.pool;
    let (max_pause, gap) = (pool.params.junior_max_pause_secs, pool.params.junior_pause_gap_secs as i64);
    // The gap fixed when the last pause began, or the one in force now if a change has since made it longer
    let next = pool.junior_next_pause_at.max(pool.junior_pause_end.saturating_add(gap));
    require!(
        duration_secs > 0 && duration_secs <= max_pause && !pool.junior_exits_paused(now) && (pool.junior_pause_end == 0 || now >= next),
        PluribusError::PauseNotAllowed
    );
    pool.junior_pause_start = now;
    pool.junior_pause_end = now + duration_secs as i64;
    pool.junior_next_pause_at = pool.junior_pause_end + gap;
    emit!(JuniorExitsPaused { until: pool.junior_pause_end });
    Ok(())
}

pub fn handle_unpause_junior_exits(ctx: Context<AdminPool>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let pool = &mut ctx.accounts.pool;
    require!(pool.junior_exits_paused(now), PluribusError::PauseNotAllowed);
    pool.junior_pause_end = now;
    pool.junior_next_pause_at = now + pool.params.junior_pause_gap_secs as i64;
    emit!(JuniorExitsPaused { until: now });
    Ok(())
}

pub fn handle_set_flags(ctx: Context<AdminPool>, paused: bool, demo_mode: bool) -> Result<()> {
    // Demo mode hands pricing to the admin, so it can be switched off but never back on
    require!(!demo_mode || ctx.accounts.pool.demo_mode, PluribusError::DemoDisabled);
    ctx.accounts.pool.paused = paused;
    ctx.accounts.pool.demo_mode = demo_mode;
    Ok(())
}

pub fn handle_set_admin(ctx: Context<AdminPool>, new_admin: Pubkey) -> Result<()> {
    ctx.accounts.pool.admin = new_admin;
    Ok(())
}

#[derive(Accounts)]
pub struct InitAsset<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump, has_one = admin)]
    pub pool: Box<Account<'info, Pool>>,
    // Classic tokens, or Token-2022 mints whose extensions pass the allow-list in `token2022::check_listable`
    // Share tokens would let lenders borrow against the very pool their deposit backs, and juniors could step out of losses
    #[account(
        constraint = *mint.to_account_info().owner == token_program.key() @ PluribusError::UnsupportedMint,
        constraint = mint.key() != pool.share_mint && mint.key() != pool.junior_mint @ PluribusError::ShareMintNotCollateral,
    )]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(init, payer = admin, space = 8 + Asset::INIT_SPACE, seeds = [ASSET_SEED, mint.key().as_ref()], bump)]
    pub asset: Box<Account<'info, Asset>>,
    #[account(
        init,
        payer = admin,
        seeds = [VAULT_SEED, mint.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = pool,
        token::token_program = token_program,
    )]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

fn check_asset(pool: &Pool, mint: &Pubkey, params: &AssetParams) -> Result<()> {
    params.validate()?;
    // USDC, and only USDC, is priced at a fixed $1
    // Giving it a shock group of its own puts a gap between its draw limit and its liquidation line
    let is_usdc = *mint == pool.usdc_mint;
    require!(
        if params.oracle == ORACLE_FIXED { is_usdc } else { !is_usdc && pool.params.bonus_fits(params.liq_cost_bps) },
        PluribusError::InvalidParams
    );
    // A dynamic shock is laid over its group's columns, so it needs a group whose columns shock something
    let worst = |init: bool| (0..pool.params.num_scenarios as usize).map(|s| pool.params.shock(init, s, params.group)).max().unwrap_or(0);
    require!(params.vol_horizon_secs == 0 || (worst(true) > 0 && worst(false) > 0), PluribusError::InvalidParams);
    // The volatility crank's samples are what tell a split from a crash, so a multiplier token needs them
    require!(!params.ui_multiplier || params.vol_horizon_secs > 0, PluribusError::InvalidParams);
    let hold = params.jump_hold_secs as i64;
    require!(!params.ui_multiplier || (crate::token2022::MULTIPLIER_GUARD_SECS..=7 * 86_400).contains(&hold), PluribusError::InvalidParams);
    Ok(())
}

fn record_asset(pool: &mut Pool, mint: &Pubkey, params: &AssetParams) -> Result<()> {
    check_asset(pool, mint, params)?;
    if params.oracle != ORACLE_FIXED {
        pool.min_liq_cost_bps = pool.min_liq_cost_bps.min(params.liq_cost_bps);
    } else {
        pool.usdc_group = params.group;
    }
    Ok(())
}

/// `sigma_seed_bps` is the annual volatility the dynamic shock starts from, until the volatility crank has prices of its own
pub fn handle_init_asset(ctx: Context<InitAsset>, params: AssetParams, sigma_seed_bps: u32) -> Result<()> {
    record_asset(&mut ctx.accounts.pool, &ctx.accounts.mint.key(), &params)?;
    require!(sigma_seed_bps <= 100_000, PluribusError::InvalidParams);
    let token_program = ctx.accounts.token_program.key();
    let now = Clock::get()?.unix_timestamp;
    let mut mult = crate::token2022::MULTIPLIER_ONE;
    if token_program == anchor_spl::token_2022::ID {
        crate::token2022::check_listable(&ctx.accounts.mint.to_account_info())?;
        mult = crate::token2022::listing_multiplier(&ctx.accounts.mint.to_account_info(), now)?;
    } else {
        require_keys_eq!(token_program, anchor_spl::token::ID, PluribusError::UnsupportedMint);
    }
    // USDC is moved with the classic program everywhere
    require!(ctx.accounts.mint.key() != ctx.accounts.pool.usdc_mint || token_program == anchor_spl::token::ID, PluribusError::UnsupportedMint);
    let seed = Asset::seed_variance(sigma_seed_bps);
    ctx.accounts.asset.set_inner(Asset {
        mint: ctx.accounts.mint.key(),
        vault: ctx.accounts.vault.key(),
        bump: ctx.bumps.asset,
        decimals: ctx.accounts.mint.decimals,
        total_deposited: 0,
        params,
        active_at: now + ctx.accounts.pool.params.activation_delay_secs as i64,
        pending: params,
        pending_at: 0,
        var_fast: seed,
        var_slow: seed,
        vol_price: 0,
        vol_time: 0,
        token_program,
        mult: mult as u64,
        mult_prev: mult as u64,
        mult_since: 0,
        mult_exact: false,
        mult_prev_since: 0,
        jump_since: 0,
        jump_price: 0,
        jump_seen: 0,
        live_price: false,
        price_exponent: 0,
        liq_bonus_bps: 0,
        lp_liq_bonus_bps: 0,
        reserved: [0; 1],
        premium_bps: 0,
        pending_premium_bps: 0,
        premium_pending_at: 0,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SetAsset<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump, has_one = admin)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [ASSET_SEED, asset.mint.as_ref()], bump = asset.bump)]
    pub asset: Box<Account<'info, Asset>>,
}

/// A pure tightening applies at once and drops whatever was waiting, any other change waits out the activation delay
pub fn handle_set_asset(ctx: Context<SetAsset>, params: AssetParams) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let (pool, asset) = (&mut ctx.accounts.pool, &mut ctx.accounts.asset);
    let delay = pool.params.activation_delay_secs as i64;
    // A token can't become a staking token after listing, since an LP market may already value it at its own price alone
    require!(asset.params.rate_source != RATE_NONE || params.rate_source == RATE_NONE, PluribusError::InvalidParams);
    if asset.params.only_tightens(&params) || (delay == 0 && !pool.junior_exits_paused(now)) {
        record_asset(pool, &asset.mint, &params)?;
        asset.params = params;
        asset.pending_at = 0;
    } else {
        check_asset(pool, &asset.mint, &params)?;
        asset.pending = params;
        asset.pending_at = now + delay;
        emit!(ChangeQueued { target: asset.key(), effective_at: asset.pending_at });
    }
    Ok(())
}

#[derive(Accounts)]
pub struct ApplyAsset<'info> {
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [ASSET_SEED, asset.mint.as_ref()], bump = asset.bump)]
    pub asset: Box<Account<'info, Asset>>,
}

/// Permissionless: puts an asset's waiting parameters into effect once their delay has passed
pub fn handle_apply_asset(ctx: Context<ApplyAsset>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let (pool, asset) = (&mut ctx.accounts.pool, &mut ctx.accounts.asset);
    require!(asset.pending_at != 0, PluribusError::NoPendingChange);
    require!(now >= pool.effective_at(asset.pending_at), PluribusError::ChangeNotDue);
    let params = asset.pending;
    // The pool's bonus may have changed while this waited
    record_asset(pool, &asset.mint, &params)?;
    asset.params = params;
    asset.pending_at = 0;
    emit!(ChangeApplied { target: asset.key() });
    Ok(())
}

#[derive(Accounts)]
pub struct InitLpMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump, has_one = admin)]
    pub pool: Box<Account<'info, Pool>>,
    /// CHECK: An Orca Whirlpool, Raydium CLMM pool or Meteora DLMM pair, whose owner, discriminator and mints are checked in the handler
    pub whirlpool: UncheckedAccount<'info>,
    #[account(seeds = [ASSET_SEED, base_asset.mint.as_ref()], bump = base_asset.bump)]
    pub base_asset: Box<Account<'info, Asset>>,
    #[account(
        init,
        payer = admin,
        space = 8 + LpMarket::INIT_SPACE,
        seeds = [LP_MARKET_SEED, whirlpool.key().as_ref()],
        bump,
    )]
    pub lp_market: Box<Account<'info, LpMarket>>,
    pub system_program: Program<'info, System>,
}

fn check_lp_cost(pool: &Pool, liq_cost_bps: u16) -> Result<()> {
    require!((liq_cost_bps as u128) < BPS && pool.params.bonus_fits(liq_cost_bps), PluribusError::InvalidParams);
    Ok(())
}

fn record_lp_cost(pool: &mut Pool, liq_cost_bps: u16) -> Result<()> {
    check_lp_cost(pool, liq_cost_bps)?;
    pool.min_liq_cost_bps = pool.min_liq_cost_bps.min(liq_cost_bps);
    Ok(())
}

pub fn handle_init_lp_market(ctx: Context<InitLpMarket>, liq_cost_bps: u16) -> Result<()> {
    record_lp_cost(&mut ctx.accounts.pool, liq_cost_bps)?;
    let (dex_program, mint_a, mint_b) = read_pool(&ctx.accounts.whirlpool)?;
    let base = &ctx.accounts.base_asset;
    // The pool pairs the base token with USDC, in either order
    let usdc = ctx.accounts.pool.usdc_mint;
    let base_first = mint_a == base.mint && mint_b == usdc;
    require!(
        (base_first || (mint_a == usdc && mint_b == base.mint)) && base.params.oracle != ORACLE_FIXED,
        PluribusError::PoolNotWhitelisted
    );
    // An LP is valued at its base token's own price alone, so a base whose price needs more is left out:
    // a staking token's backing cap and a Token-2022 token's multiplier would both be skipped
    require!(
        base.params.rate_source == RATE_NONE && base.token_program == anchor_spl::token::ID,
        PluribusError::PoolNotWhitelisted
    );
    ctx.accounts.lp_market.set_inner(LpMarket {
        whirlpool: ctx.accounts.whirlpool.key(),
        base_mint: base.mint,
        bump: ctx.bumps.lp_market,
        liq_cost_bps,
        paused: false,
        // Never ahead of its base token, so an LP cannot bring in a token still in its own delay
        active_at: (Clock::get()?.unix_timestamp + ctx.accounts.pool.params.activation_delay_secs as i64).max(base.active_at),
        pending_liq_cost_bps: liq_cost_bps,
        pending_paused: false,
        pending_at: 0,
        dex_program,
        base_first,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SetLpMarket<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump, has_one = admin)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [LP_MARKET_SEED, lp_market.whirlpool.as_ref()], bump = lp_market.bump)]
    pub lp_market: Box<Account<'info, LpMarket>>,
}

/// A higher cost or a pause applies at once and drops whatever was waiting, anything looser waits out the activation delay
pub fn handle_set_lp_market(ctx: Context<SetLpMarket>, liq_cost_bps: u16, paused: bool) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let (pool, market) = (&mut ctx.accounts.pool, &mut ctx.accounts.lp_market);
    let delay = pool.params.activation_delay_secs as i64;
    let tightens = liq_cost_bps >= market.liq_cost_bps && (paused || !market.paused);
    if tightens || (delay == 0 && !pool.junior_exits_paused(now)) {
        record_lp_cost(pool, liq_cost_bps)?;
        market.liq_cost_bps = liq_cost_bps;
        market.paused = paused;
        market.pending_at = 0;
    } else {
        check_lp_cost(pool, liq_cost_bps)?;
        market.pending_liq_cost_bps = liq_cost_bps;
        market.pending_paused = paused;
        market.pending_at = now + delay;
        emit!(ChangeQueued { target: market.key(), effective_at: market.pending_at });
    }
    Ok(())
}

#[derive(Accounts)]
pub struct ApplyLpMarket<'info> {
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [LP_MARKET_SEED, lp_market.whirlpool.as_ref()], bump = lp_market.bump)]
    pub lp_market: Box<Account<'info, LpMarket>>,
}

/// Permissionless: puts an LP market's waiting settings into effect once their delay has passed
pub fn handle_apply_lp_market(ctx: Context<ApplyLpMarket>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let (pool, market) = (&mut ctx.accounts.pool, &mut ctx.accounts.lp_market);
    require!(market.pending_at != 0, PluribusError::NoPendingChange);
    require!(now >= pool.effective_at(market.pending_at), PluribusError::ChangeNotDue);
    record_lp_cost(pool, market.pending_liq_cost_bps)?;
    market.liq_cost_bps = market.pending_liq_cost_bps;
    market.paused = market.pending_paused;
    market.pending_at = 0;
    emit!(ChangeApplied { target: market.key() });
    Ok(())
}

/// The admin, or the guardian, whose powers only ever reduce risk
#[derive(Accounts)]
pub struct Guard<'info> {
    #[account(constraint = guard.key() == pool.admin || guard.key() == pool.guardian @ PluribusError::NotGuardian)]
    pub guard: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
}

pub fn handle_cancel_pending_params(ctx: Context<Guard>) -> Result<()> {
    let pool = &mut ctx.accounts.pool;
    require!(pool.pending_at != 0, PluribusError::NoPendingChange);
    pool.pending_at = 0;
    emit!(ChangeCancelled { target: pool.key() });
    Ok(())
}

#[derive(Accounts)]
pub struct GuardAsset<'info> {
    #[account(constraint = guard.key() == pool.admin || guard.key() == pool.guardian @ PluribusError::NotGuardian)]
    pub guard: Signer<'info>,
    #[account(seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [ASSET_SEED, asset.mint.as_ref()], bump = asset.bump)]
    pub asset: Box<Account<'info, Asset>>,
}

/// Stops an asset backing new debt and drops any change waiting on it, which also cancels a listing still in its delay
pub fn handle_guard_asset(ctx: Context<GuardAsset>) -> Result<()> {
    let asset = &mut ctx.accounts.asset;
    asset.params.paused = true;
    asset.pending_at = 0;
    emit!(ChangeCancelled { target: asset.key() });
    Ok(())
}

#[derive(Accounts)]
pub struct GuardLpMarket<'info> {
    #[account(constraint = guard.key() == pool.admin || guard.key() == pool.guardian @ PluribusError::NotGuardian)]
    pub guard: Signer<'info>,
    #[account(seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [LP_MARKET_SEED, lp_market.whirlpool.as_ref()], bump = lp_market.bump)]
    pub lp_market: Box<Account<'info, LpMarket>>,
}

pub fn handle_guard_lp_market(ctx: Context<GuardLpMarket>) -> Result<()> {
    let market = &mut ctx.accounts.lp_market;
    market.paused = true;
    market.pending_at = 0;
    emit!(ChangeCancelled { target: market.key() });
    Ok(())
}

#[derive(Accounts)]
pub struct SetDemoPrice<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [POOL_SEED], bump = pool.bump, has_one = admin, constraint = pool.demo_mode @ PluribusError::DemoDisabled)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(seeds = [ASSET_SEED, asset.mint.as_ref()], bump = asset.bump)]
    pub asset: Box<Account<'info, Asset>>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + DemoPrice::INIT_SPACE,
        seeds = [DEMO_PRICE_SEED, asset.mint.as_ref()],
        bump,
    )]
    pub demo_price: Box<Account<'info, DemoPrice>>,
    pub system_program: Program<'info, System>,
}

pub fn handle_set_demo_price(ctx: Context<SetDemoPrice>, price: u64, conf: u64) -> Result<()> {
    ctx.accounts.demo_price.set_inner(DemoPrice {
        mint: ctx.accounts.asset.mint,
        price,
        conf,
        publish_time: Clock::get()?.unix_timestamp,
        bump: ctx.bumps.demo_price,
    });
    emit!(DemoPriceSet { mint: ctx.accounts.asset.mint, price });
    Ok(())
}

#[derive(Accounts)]
pub struct CollectProtocolFees<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump, has_one = admin, has_one = usdc_mint, has_one = usdc_vault)]
    pub pool: Box<Account<'info, Pool>>,
    pub usdc_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut)]
    pub usdc_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = usdc_mint)]
    pub treasury_usdc: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

/// Pays out accrued protocol revenue, up to what is idle in the pool and not held for queued senior exits
/// The insurance reserve is never touched here
pub fn handle_collect_protocol_fees(ctx: Context<CollectProtocolFees>, amount: u64) -> Result<()> {
    let a = ctx.accounts;
    a.pool.accrue(Clock::get()?.unix_timestamp)?;
    let amount = amount.min(a.pool.protocol_fees).min(a.pool.available_cash());
    require!(amount > 0, PluribusError::ZeroAmount);
    a.pool.protocol_fees -= amount;
    a.pool.cash -= amount;
    push(&a.token_program, &a.usdc_mint, &a.usdc_vault, &a.treasury_usdc, &a.pool, amount)?;
    emit!(ProtocolFeesCollected { amount });
    Ok(())
}

#[derive(Accounts)]
pub struct InitJunior<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump, has_one = admin)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(
        init,
        payer = admin,
        seeds = [JUNIOR_MINT_SEED],
        bump,
        mint::decimals = USDC_DECIMALS,
        mint::authority = pool,
        mint::token_program = token_program,
    )]
    pub junior_mint: Box<InterfaceAccount<'info, Mint>>,
    /// Holds junior shares while they wait in the exit queue
    #[account(
        init,
        payer = admin,
        seeds = [JUNIOR_ESCROW_SEED],
        bump,
        token::mint = junior_mint,
        token::authority = pool,
        token::token_program = token_program,
    )]
    pub junior_escrow: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Opens the junior tranche: its lenders earn part of the senior interest and absorb losses first
pub fn handle_init_junior(ctx: Context<InitJunior>) -> Result<()> {
    ctx.accounts.pool.junior_mint = ctx.accounts.junior_mint.key();
    Ok(())
}
