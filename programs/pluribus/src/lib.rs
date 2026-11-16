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

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("6axStTWfYe5AGyVJHEAyxbtk7axbPu514xvZ1d6NKSgT");

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

    pub fn init_asset(ctx: Context<InitAsset>, params: AssetParams) -> Result<()> {
        admin::handle_init_asset(ctx, params)
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
}
