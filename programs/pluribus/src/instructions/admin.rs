use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

use crate::{constants::*, error::PluribusError, events::*, orca::read_whirlpool_mints, state::*, token::push};

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
    });
    Ok(())
}

#[derive(Accounts)]
pub struct AdminPool<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump, has_one = admin)]
    pub pool: Box<Account<'info, Pool>>,
}

pub fn handle_set_params(ctx: Context<AdminPool>, params: PoolParams) -> Result<()> {
    params.validate()?;
    let pool = &mut ctx.accounts.pool;
    // Settle interest at the old rates first
    pool.accrue(Clock::get()?.unix_timestamp)?;
    // A bonus above the smallest haircut already granted would make that collateral impossible to liquidate
    require!(params.bonus_fits(pool.min_liq_cost_bps), PluribusError::InvalidParams);
    pool.params = params;
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
    // Token-2022 mints can carry transfer fees and hooks, which would break vault accounting
    #[account(constraint = *mint.to_account_info().owner == anchor_spl::token::ID @ PluribusError::UnsupportedMint)]
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

fn check_asset(pool: &mut Pool, mint: &Pubkey, params: &AssetParams) -> Result<()> {
    params.validate()?;
    // USDC, and only USDC, is priced at a fixed $1
    // Giving it a shock group of its own puts a gap between its draw limit and its liquidation line
    let is_usdc = *mint == pool.usdc_mint;
    require!(
        if params.oracle == ORACLE_FIXED { is_usdc } else { !is_usdc && pool.params.bonus_fits(params.liq_cost_bps) },
        PluribusError::InvalidParams
    );
    if params.oracle != ORACLE_FIXED {
        pool.min_liq_cost_bps = pool.min_liq_cost_bps.min(params.liq_cost_bps);
    } else {
        pool.usdc_group = params.group;
    }
    Ok(())
}

pub fn handle_init_asset(ctx: Context<InitAsset>, params: AssetParams) -> Result<()> {
    check_asset(&mut ctx.accounts.pool, &ctx.accounts.mint.key(), &params)?;
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
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump, has_one = admin)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [ASSET_SEED, asset.mint.as_ref()], bump = asset.bump)]
    pub asset: Box<Account<'info, Asset>>,
}

pub fn handle_set_asset(ctx: Context<SetAsset>, params: AssetParams) -> Result<()> {
    let mint = ctx.accounts.asset.mint;
    check_asset(&mut ctx.accounts.pool, &mint, &params)?;
    ctx.accounts.asset.params = params;
    Ok(())
}

#[derive(Accounts)]
pub struct InitLpMarket<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump, has_one = admin)]
    pub pool: Box<Account<'info, Pool>>,
    /// CHECK: Owner, discriminator and mints are checked in the handler
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

fn check_lp_cost(pool: &mut Pool, liq_cost_bps: u16) -> Result<()> {
    require!((liq_cost_bps as u128) < BPS && pool.params.bonus_fits(liq_cost_bps), PluribusError::InvalidParams);
    pool.min_liq_cost_bps = pool.min_liq_cost_bps.min(liq_cost_bps);
    Ok(())
}

pub fn handle_init_lp_market(ctx: Context<InitLpMarket>, liq_cost_bps: u16) -> Result<()> {
    check_lp_cost(&mut ctx.accounts.pool, liq_cost_bps)?;
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
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump, has_one = admin)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(mut, seeds = [LP_MARKET_SEED, lp_market.whirlpool.as_ref()], bump = lp_market.bump)]
    pub lp_market: Box<Account<'info, LpMarket>>,
}

pub fn handle_set_lp_market(ctx: Context<SetLpMarket>, liq_cost_bps: u16, paused: bool) -> Result<()> {
    check_lp_cost(&mut ctx.accounts.pool, liq_cost_bps)?;
    ctx.accounts.lp_market.liq_cost_bps = liq_cost_bps;
    ctx.accounts.lp_market.paused = paused;
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

/// Pays out accrued protocol revenue, up to what is idle in the pool
/// The insurance reserve is never touched here
pub fn handle_collect_protocol_fees(ctx: Context<CollectProtocolFees>, amount: u64) -> Result<()> {
    let a = ctx.accounts;
    a.pool.accrue(Clock::get()?.unix_timestamp)?;
    let amount = amount.min(a.pool.protocol_fees).min(a.pool.cash);
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
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// Opens the junior tranche: its lenders earn part of the senior interest and absorb losses first
pub fn handle_init_junior(ctx: Context<InitJunior>) -> Result<()> {
    ctx.accounts.pool.junior_mint = ctx.accounts.junior_mint.key();
    Ok(())
}
