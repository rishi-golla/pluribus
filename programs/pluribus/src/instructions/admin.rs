use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{constants::*, error::PluribusError, events::*, orca::read_whirlpool_mints, state::*};

#[derive(Accounts)]
pub struct Initialize<'info> {
    // Shortcut: the first caller becomes admin, tie this to the upgrade authority before mainnet
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init, payer = admin, space = 8 + Pool::INIT_SPACE, seeds = [POOL_SEED], bump)]
    pub pool: Account<'info, Pool>,
    #[account(constraint = usdc_mint.decimals == USDC_DECIMALS @ PluribusError::UnsupportedMint)]
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = admin,
        seeds = [USDC_VAULT_SEED],
        bump,
        token::mint = usdc_mint,
        token::authority = pool,
        token::token_program = token_program,
    )]
    pub usdc_vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init,
        payer = admin,
        seeds = [SHARE_MINT_SEED],
        bump,
        mint::decimals = USDC_DECIMALS,
        mint::authority = pool,
        mint::token_program = token_program,
    )]
    pub share_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize(ctx: Context<Initialize>, params: PoolParams, demo_mode: bool) -> Result<()> {
    params.validate()?;
    ctx.accounts.pool.set_inner(Pool {
        admin: ctx.accounts.admin.key(),
        usdc_mint: ctx.accounts.usdc_mint.key(),
        usdc_vault: ctx.accounts.usdc_vault.key(),
        share_mint: ctx.accounts.share_mint.key(),
        bump: ctx.bumps.pool,
        demo_mode,
        paused: false,
        params,
        cash: 0,
        reserves: 0,
        bad_debt: 0,
        last_accrual: Clock::get()?.unix_timestamp,
        borrow_index: [INDEX_ONE; TIERS],
        debt_shares: [0; TIERS],
    });
    Ok(())
}

#[derive(Accounts)]
pub struct AdminPool<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump, has_one = admin)]
    pub pool: Account<'info, Pool>,
}

pub fn handle_set_params(ctx: Context<AdminPool>, params: PoolParams) -> Result<()> {
    params.validate()?;
    let pool = &mut ctx.accounts.pool;
    // Settle interest at the old rates first
    pool.accrue(Clock::get()?.unix_timestamp)?;
    pool.params = params;
    Ok(())
}

pub fn handle_set_flags(ctx: Context<AdminPool>, paused: bool, demo_mode: bool) -> Result<()> {
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
    #[account(seeds = [POOL_SEED], bump = pool.bump, has_one = admin)]
    pub pool: Account<'info, Pool>,
    // Token-2022 mints can carry transfer fees and hooks, which would break vault accounting
    #[account(constraint = *mint.to_account_info().owner == anchor_spl::token::ID @ PluribusError::UnsupportedMint)]
    pub mint: InterfaceAccount<'info, Mint>,
    #[account(init, payer = admin, space = 8 + Asset::INIT_SPACE, seeds = [ASSET_SEED, mint.key().as_ref()], bump)]
    pub asset: Account<'info, Asset>,
    #[account(
        init,
        payer = admin,
        seeds = [VAULT_SEED, mint.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = pool,
        token::token_program = token_program,
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

fn check_asset(pool: &Pool, mint: &Pubkey, params: &AssetParams) -> Result<()> {
    params.validate()?;
    // Only USDC is priced at a fixed $1, and it has to count at par for liquidation maths to hold
    require!(
        params.oracle != ORACLE_FIXED
            || (*mint == pool.usdc_mint && params.liq_cost_bps == 0 && params.group as usize >= MAX_GROUPS),
        PluribusError::InvalidParams
    );
    Ok(())
}

pub fn handle_init_asset(ctx: Context<InitAsset>, params: AssetParams) -> Result<()> {
    check_asset(&ctx.accounts.pool, &ctx.accounts.mint.key(), &params)?;
    ctx.accounts.asset.set_inner(Asset {
        mint: ctx.accounts.mint.key(),
        vault: ctx.accounts.vault.key(),
        bump: ctx.bumps.asset,
        decimals: ctx.accounts.mint.decimals,
        total_deposited: 0,
        params,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SetAsset<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [POOL_SEED], bump = pool.bump, has_one = admin)]
    pub pool: Account<'info, Pool>,
    #[account(mut, seeds = [ASSET_SEED, asset.mint.as_ref()], bump = asset.bump)]
    pub asset: Account<'info, Asset>,
}

pub fn handle_set_asset(ctx: Context<SetAsset>, params: AssetParams) -> Result<()> {
    check_asset(&ctx.accounts.pool, &ctx.accounts.asset.mint, &params)?;
    ctx.accounts.asset.params = params;
    Ok(())
}

#[derive(Accounts)]
pub struct InitLpMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [POOL_SEED], bump = pool.bump, has_one = admin)]
    pub pool: Account<'info, Pool>,
    /// CHECK: Owner, discriminator and mints are checked in the handler
    pub whirlpool: UncheckedAccount<'info>,
    #[account(seeds = [ASSET_SEED, base_asset.mint.as_ref()], bump = base_asset.bump)]
    pub base_asset: Account<'info, Asset>,
    #[account(
        init,
        payer = admin,
        space = 8 + LpMarket::INIT_SPACE,
        seeds = [LP_MARKET_SEED, whirlpool.key().as_ref()],
        bump,
    )]
    pub lp_market: Account<'info, LpMarket>,
    pub system_program: Program<'info, System>,
}

pub fn handle_init_lp_market(ctx: Context<InitLpMarket>, liq_cost_bps: u16) -> Result<()> {
    require!((liq_cost_bps as u128) < BPS, PluribusError::InvalidParams);
    let (mint_a, mint_b) = read_whirlpool_mints(&ctx.accounts.whirlpool)?;
    let base = &ctx.accounts.base_asset;
    // The valuer assumes token A is the priced asset and token B is USDC
    require!(
        mint_a == base.mint && mint_b == ctx.accounts.pool.usdc_mint && base.params.oracle != ORACLE_FIXED,
        PluribusError::PoolNotWhitelisted
    );
    ctx.accounts.lp_market.set_inner(LpMarket {
        whirlpool: ctx.accounts.whirlpool.key(),
        base_mint: base.mint,
        bump: ctx.bumps.lp_market,
        liq_cost_bps,
        paused: false,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SetLpMarket<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [POOL_SEED], bump = pool.bump, has_one = admin)]
    pub pool: Account<'info, Pool>,
    #[account(mut, seeds = [LP_MARKET_SEED, lp_market.whirlpool.as_ref()], bump = lp_market.bump)]
    pub lp_market: Account<'info, LpMarket>,
}

pub fn handle_set_lp_market(ctx: Context<SetLpMarket>, liq_cost_bps: u16, paused: bool) -> Result<()> {
    require!((liq_cost_bps as u128) < BPS, PluribusError::InvalidParams);
    ctx.accounts.lp_market.liq_cost_bps = liq_cost_bps;
    ctx.accounts.lp_market.paused = paused;
    Ok(())
}

#[derive(Accounts)]
pub struct SetDemoPrice<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(seeds = [POOL_SEED], bump = pool.bump, has_one = admin, constraint = pool.demo_mode @ PluribusError::DemoDisabled)]
    pub pool: Account<'info, Pool>,
    #[account(seeds = [ASSET_SEED, asset.mint.as_ref()], bump = asset.bump)]
    pub asset: Account<'info, Asset>,
    #[account(
        init_if_needed,
        payer = admin,
        space = 8 + DemoPrice::INIT_SPACE,
        seeds = [DEMO_PRICE_SEED, asset.mint.as_ref()],
        bump,
    )]
    pub demo_price: Account<'info, DemoPrice>,
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
