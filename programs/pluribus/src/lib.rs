pub mod clmm;
pub mod constants;
pub mod error;
pub mod events;
pub mod instructions;
pub mod math;
pub mod oracle;
pub mod orca;
pub mod risk;
pub mod state;
pub mod token;
pub mod token2022;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("A4UnuBwwBLbvxj3AnUtCDzkj11kp1wdPh8CydUn5quc7");

#[program]
pub mod pluribus {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>, params: PoolParams, demo_mode: bool) -> Result<()> {
        admin::handle_initialize(ctx, params, demo_mode)
    }

    pub fn set_params(ctx: Context<AdminPool>, params: PoolParams) -> Result<()> {
        admin::handle_set_params(ctx, params)
    }

    pub fn set_flags(ctx: Context<AdminPool>, paused: bool, demo_mode: bool) -> Result<()> {
        admin::handle_set_flags(ctx, paused, demo_mode)
    }

    pub fn set_admin(ctx: Context<AdminPool>, new_admin: Pubkey) -> Result<()> {
        admin::handle_set_admin(ctx, new_admin)
    }

    pub fn init_asset(ctx: Context<InitAsset>, params: AssetParams, sigma_seed_bps: u32) -> Result<()> {
        admin::handle_init_asset(ctx, params, sigma_seed_bps)
    }

    pub fn set_asset(ctx: Context<SetAsset>, params: AssetParams) -> Result<()> {
        admin::handle_set_asset(ctx, params)
    }

    pub fn init_lp_market(ctx: Context<InitLpMarket>, liq_cost_bps: u16) -> Result<()> {
        admin::handle_init_lp_market(ctx, liq_cost_bps)
    }

    pub fn set_lp_market(ctx: Context<SetLpMarket>, liq_cost_bps: u16, paused: bool) -> Result<()> {
        admin::handle_set_lp_market(ctx, liq_cost_bps, paused)
    }

    pub fn set_demo_price(ctx: Context<SetDemoPrice>, price: u64, conf: u64) -> Result<()> {
        admin::handle_set_demo_price(ctx, price, conf)
    }

    pub fn init_junior(ctx: Context<InitJunior>) -> Result<()> {
        admin::handle_init_junior(ctx)
    }

    pub fn collect_protocol_fees(ctx: Context<CollectProtocolFees>, amount: u64) -> Result<()> {
        admin::handle_collect_protocol_fees(ctx, amount)
    }

    pub fn lend_deposit(ctx: Context<Lend>, amount: u64) -> Result<()> {
        lend::handle_lend_deposit(ctx, amount)
    }

    pub fn lend_withdraw(ctx: Context<Lend>, shares: u64) -> Result<()> {
        lend::handle_lend_withdraw(ctx, shares)
    }

    pub fn open_account(ctx: Context<OpenAccount>) -> Result<()> {
        borrow::handle_open_account(ctx)
    }

    pub fn deposit_token(ctx: Context<MoveToken>, amount: u64) -> Result<()> {
        borrow::handle_deposit_token(ctx, amount)
    }

    pub fn withdraw_token(ctx: Context<MoveToken>, amount: u64) -> Result<()> {
        borrow::handle_withdraw_token(ctx, amount)
    }

    pub fn deposit_lp(ctx: Context<DepositLp>) -> Result<()> {
        borrow::handle_deposit_lp(ctx)
    }

    pub fn withdraw_lp(ctx: Context<WithdrawLp>) -> Result<()> {
        borrow::handle_withdraw_lp(ctx)
    }

    pub fn draw(ctx: Context<Draw>, amount: u64) -> Result<()> {
        borrow::handle_draw(ctx, amount)
    }

    pub fn repay(ctx: Context<Repay>, amount: u64) -> Result<()> {
        borrow::handle_repay(ctx, amount)
    }

    pub fn repay_from_collateral(ctx: Context<RepayFromCollateral>, amount: u64) -> Result<()> {
        liquidate::handle_repay_from_collateral(ctx, amount)
    }

    pub fn liquidate(ctx: Context<Liquidate>, repay_amount: u64) -> Result<()> {
        liquidate::handle_liquidate(ctx, repay_amount)
    }

    pub fn liquidate_lp(ctx: Context<LiquidateLp>) -> Result<()> {
        liquidate::handle_liquidate_lp(ctx)
    }

    pub fn autopay(ctx: Context<Autopay>) -> Result<()> {
        autopay::handle_autopay(ctx)
    }

    pub fn accrue(ctx: Context<Accrue>) -> Result<()> {
        keeper::handle_accrue(ctx)
    }

    pub fn refresh_tier(ctx: Context<RefreshTier>) -> Result<()> {
        keeper::handle_refresh_tier(ctx)
    }

    pub fn health(ctx: Context<ViewHealth>) -> Result<HealthView> {
        keeper::handle_health(ctx)
    }

    pub fn update_vol(ctx: Context<UpdateVol>) -> Result<()> {
        keeper::handle_update_vol(ctx)
    }

    pub fn sync_mint(ctx: Context<SyncMint>) -> Result<()> {
        keeper::handle_sync_mint(ctx)
    }

    pub fn convert_to_junior(ctx: Context<ConvertToJunior>, shares: u64) -> Result<()> {
        junior::handle_convert_to_junior(ctx, shares)
    }

    pub fn request_junior_exit(ctx: Context<RequestJuniorExit>, shares: u64) -> Result<()> {
        junior::handle_request_junior_exit(ctx, shares)
    }

    pub fn claim_junior_exit(ctx: Context<ClaimJuniorExit>) -> Result<()> {
        junior::handle_claim_junior_exit(ctx)
    }

    pub fn cancel_junior_exit(ctx: Context<CancelJuniorExit>) -> Result<()> {
        junior::handle_cancel_junior_exit(ctx)
    }

    pub fn pause_junior_exits(ctx: Context<AdminPool>, duration_secs: u32) -> Result<()> {
        admin::handle_pause_junior_exits(ctx, duration_secs)
    }

    pub fn unpause_junior_exits(ctx: Context<AdminPool>) -> Result<()> {
        admin::handle_unpause_junior_exits(ctx)
    }

    pub fn apply_params(ctx: Context<ApplyParams>) -> Result<()> {
        admin::handle_apply_params(ctx)
    }

    pub fn apply_asset(ctx: Context<ApplyAsset>) -> Result<()> {
        admin::handle_apply_asset(ctx)
    }

    pub fn apply_lp_market(ctx: Context<ApplyLpMarket>) -> Result<()> {
        admin::handle_apply_lp_market(ctx)
    }

    pub fn set_guardian(ctx: Context<AdminPool>, guardian: Pubkey) -> Result<()> {
        admin::handle_set_guardian(ctx, guardian)
    }

    pub fn cancel_pending_params(ctx: Context<Guard>) -> Result<()> {
        admin::handle_cancel_pending_params(ctx)
    }

    pub fn guard_asset(ctx: Context<GuardAsset>) -> Result<()> {
        admin::handle_guard_asset(ctx)
    }

    pub fn guard_lp_market(ctx: Context<GuardLpMarket>) -> Result<()> {
        admin::handle_guard_lp_market(ctx)
    }

    pub fn migrate_pool(ctx: Context<MigratePool>) -> Result<()> {
        admin::handle_migrate_pool(ctx)
    }

    pub fn close_account(ctx: Context<CloseCredit>) -> Result<()> {
        borrow::handle_close_account(ctx)
    }

    pub fn request_senior_exit(ctx: Context<RequestSeniorExit>, shares: u64) -> Result<()> {
        senior::handle_request_senior_exit(ctx, shares)
    }

    pub fn settle_senior_exit(ctx: Context<SettleSeniorExit>) -> Result<()> {
        senior::handle_settle_senior_exit(ctx)
    }

    pub fn cancel_senior_exit(ctx: Context<CancelSeniorExit>) -> Result<()> {
        senior::handle_cancel_senior_exit(ctx)
    }

    pub fn migrate_account(ctx: Context<MigrateAccount>) -> Result<()> {
        admin::handle_migrate_account(ctx)
    }

    pub fn set_asset_premium(ctx: Context<SetAssetPremium>, premium_bps: u16) -> Result<()> {
        admin::handle_set_asset_premium(ctx, premium_bps)
    }

    pub fn apply_asset_premium(ctx: Context<ApplyAssetPremium>) -> Result<()> {
        admin::handle_apply_asset_premium(ctx)
    }

    pub fn set_premium_tiers(ctx: Context<AdminPool>, tier_bps: [u16; TIERS]) -> Result<()> {
        admin::handle_set_premium_tiers(ctx, tier_bps)
    }

    pub fn apply_premium_tiers(ctx: Context<ApplyParams>) -> Result<()> {
        admin::handle_apply_premium_tiers(ctx)
    }

    pub fn demo_set_live_price(ctx: Context<DemoAsset>, live: bool) -> Result<()> {
        admin::handle_demo_set_live_price(ctx, live)
    }

    pub fn demo_activate(ctx: Context<DemoActivate>) -> Result<()> {
        admin::handle_demo_activate(ctx)
    }
}
