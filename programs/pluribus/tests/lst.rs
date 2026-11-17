mod common;

use {
    anchor_lang::{prelude::Pubkey, solana_program::clock::Clock},
    common::*,
    pluribus::{constants::*, error::PluribusError, state::*},
    solana_signer::Signer,
};

const GROUP_LST: u8 = 3;
/// The Jito stake pool and JitoSOL mint, with the pool account copied from mainnet at epoch 1089
const JITO_POOL: Pubkey = anchor_lang::prelude::pubkey!("Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb");
const JITOSOL: Pubkey = anchor_lang::prelude::pubkey!("J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn");
const JITO_POOL_DATA: &[u8] = include_bytes!("fixtures/lst/jito_stake_pool.bin");
/// Total lamports over pool token supply in that copy
const JITO_RATE: f64 = 10_131_442_221_202_033.0 / 7_721_879_544_134_644.0;

/// Default params with an LST column: the SOL group's shocks plus a 5% depeg for draws and 3% for liquidations
fn lst_params() -> PoolParams {
    let mut p = default_params();
    for s in 0..p.num_scenarios as usize {
        p.init_shock_bps[s * MAX_GROUPS + GROUP_LST as usize] = p.init_shock_bps[s * MAX_GROUPS] + 500;
        p.maint_shock_bps[s * MAX_GROUPS + GROUP_LST as usize] = p.maint_shock_bps[s * MAX_GROUPS] + 300;
    }
    p
}

fn lst_asset(env: &Env, source: u8, rate_account: Pubkey, fixed_rate: u64) -> AssetParams {
    AssetParams {
        rate_source: source,
        rate_account,
        fixed_rate,
        rate_base_mint: env.sol,
        rate_feed_id: SOL_FEED,
        ..asset_params(GROUP_LST, ORACLE_PYTH, SOL_FEED, 600)
    }
}

/// An environment with JitoSOL listed against the copied Jito stake pool, its own price at `market` dollars
fn jito(market: u64) -> Env {
    let mut env = Env::with(lst_params(), true);
    env.mint_at(&JITOSOL, 9, &TOKEN);
    env.set_raw(JITO_POOL, STAKE_POOL_PROGRAMS[0], JITO_POOL_DATA.to_vec());
    let admin = env.admin.insecure_clone();
    let params = lst_asset(&env, RATE_STAKE_POOL, JITO_POOL, 0);
    expect_ok(env.send(&[env.init_asset_ix(&JITOSOL, params)], &[&admin]));
    env.set_price(&JITOSOL, market * USDC);
    env
}

/// Dollar value the health check gives `amount` whole tokens of `mint`, unshocked
fn valued(env: &mut Env, mint: &Pubkey, amount: u64) -> f64 {
    let user = env.user();
    env.deposit(&user, mint, amount * SOL);
    env.health(&user.pubkey()).position_value[0] as f64 / USDC as f64
}

#[test]
fn a_staking_token_is_worth_the_lower_of_its_market_price_and_its_sol_backing() {
    // Its market says $210, but 1.312 SOL at $150 is only about $196.81
    let mut env = jito(210);
    let backing = 150.0 * JITO_RATE;
    assert!((valued(&mut env, &JITOSOL, 10) / (10.0 * backing) - 1.0).abs() < 1e-6);
    // A depeg below the backing shows in the market price, which then wins
    env.set_price(&JITOSOL, 180 * USDC);
    assert!((valued(&mut env, &JITOSOL, 10) / 1_800.0 - 1.0).abs() < 1e-6);
    // The backing follows SOL
    let sol = env.sol;
    env.set_price(&sol, 100 * USDC);
    assert!((valued(&mut env, &JITOSOL, 10) / (1_000.0 * JITO_RATE) - 1.0).abs() < 1e-6);
}

#[test]
fn a_staking_token_falls_further_than_sol_in_every_scenario() {
    let mut env = jito(250);
    env.lender(100_000 * USDC);
    let sol = env.sol;
    // $1000 of SOL against about $1000 of JitoSOL: the LST column adds 5% to each SOL shock and costs 1% more to sell
    let user = env.user();
    env.deposit(&user, &sol, 10 * SOL);
    let sol_limit = env.health(&user.pubkey()).credit_limit as f64;
    let staker = env.user();
    let tokens = (10.0 / JITO_RATE * SOL as f64) as u64;
    env.deposit(&staker, &JITOSOL, tokens);
    let lst_limit = env.health(&staker.pubkey()).credit_limit as f64;
    let want = sol_limit * (1.0 - 0.35) * 0.94 / ((1.0 - 0.30) * 0.95);
    assert!((lst_limit / want - 1.0).abs() < 1e-3, "LST limit {lst_limit}, want {want}");
}

#[test]
fn only_the_listed_stake_pool_from_a_known_program_and_up_to_date_counts() {
    let mut env = jito(210);
    env.lender(10_000 * USDC);
    let user = env.user();
    env.deposit(&user, &JITOSOL, 10 * SOL);
    expect_ok(env.draw(&user, USDC));
    // A pool account owned by another program
    env.set_raw(JITO_POOL, Pubkey::new_unique(), JITO_POOL_DATA.to_vec());
    expect_err(env.draw(&user, USDC), PluribusError::InvalidPriceAccount);
    // The right program but a pool for another mint
    let mut other = JITO_POOL_DATA.to_vec();
    other[162..194].copy_from_slice(Pubkey::new_unique().as_ref());
    env.set_raw(JITO_POOL, STAKE_POOL_PROGRAMS[0], other);
    expect_err(env.draw(&user, USDC), PluribusError::InvalidPriceAccount);
    // The real pool, but two epochs behind
    env.set_raw(JITO_POOL, STAKE_POOL_PROGRAMS[0], JITO_POOL_DATA.to_vec());
    let mut clock: Clock = env.svm.get_sysvar();
    clock.epoch = 1_091;
    env.svm.set_sysvar(&clock);
    expect_err(env.draw(&user, USDC), PluribusError::StalePrice);
    clock.epoch = 1_090;
    env.svm.set_sysvar(&clock);
    expect_ok(env.draw(&user, USDC));
}

#[test]
fn a_staking_tokens_volatility_follows_its_sol_backing_when_that_sets_its_price() {
    let mut env = Env::with(lst_params(), true);
    let admin = env.admin.insecure_clone();
    let mint = env.new_mint(9, &TOKEN);
    let params = AssetParams { vol_horizon_secs: DAY as u32, ..lst_asset(&env, RATE_FIXED, Pubkey::default(), 1_000_000_000) };
    expect_ok(env.send(&[env.init_asset_ix(&mint, params)], &[&admin]));
    let sol = env.sol;
    let keeper = env.wallet();
    env.set_price(&mint, 160 * USDC);
    expect_ok(env.send(&[env.update_vol_ix(&mint)], &[&keeper]));
    // SOL falls 40% while the token's own feed sits still: its price follows SOL down, and so does its volatility
    env.warp(3_600);
    env.set_price(&sol, 90 * USDC);
    env.set_price(&mint, 160 * USDC);
    expect_ok(env.send(&[env.update_vol_ix(&mint)], &[&keeper]));
    let asset: Asset = env.load(&env.asset_pda(&mint));
    assert_eq!(asset.vol_price, 90 * USDC);
    assert!(asset.dynamic_shocks(&env.pool_state().params).0 > 4_000);
}

#[test]
fn a_devnet_stand_in_uses_a_fixed_rate() {
    let mut env = Env::with(lst_params(), true);
    let admin = env.admin.insecure_clone();
    let mint = env.new_mint(9, &TOKEN);
    let params = lst_asset(&env, RATE_FIXED, Pubkey::default(), 1_080_000_000);
    expect_ok(env.send(&[env.init_asset_ix(&mint, params)], &[&admin]));
    env.set_price(&mint, 170 * USDC);
    assert!((valued(&mut env, &mint, 10) / 1_620.0 - 1.0).abs() < 1e-6);
}

#[test]
fn staking_token_settings_that_make_no_sense_are_rejected() {
    let mut env = Env::with(lst_params(), true);
    let admin = env.admin.insecure_clone();
    let mint = env.new_mint(9, &TOKEN);
    let bad = [
        ("a fixed rate of zero", lst_asset(&env, RATE_FIXED, Pubkey::default(), 0)),
        ("an unknown rate source", lst_asset(&env, 3, Pubkey::default(), 1)),
        ("a backing without a market price", AssetParams { oracle: ORACLE_FIXED, ..lst_asset(&env, RATE_FIXED, Pubkey::default(), 1) }),
    ];
    for (name, params) in bad {
        assert!(failed_with(&env.send(&[env.init_asset_ix(&mint, params)], &[&admin]), PluribusError::InvalidParams), "{name}");
    }
}

#[test]
fn a_staking_token_is_never_an_lp_base_and_no_token_becomes_a_staking_token_after_listing() {
    let mut env = jito(210);
    let admin = env.admin.insecure_clone();
    // An LP is valued at its base's own price, which would skip the backing cap
    let pool = Pubkey::new_unique();
    let usdc = env.usdc;
    env.set_whirlpool(&pool, &JITOSOL, &usdc);
    expect_err(env.send(&[env.init_lp_market_ix(&pool, &JITOSOL, 600)], &[&admin]), PluribusError::PoolNotWhitelisted);
    // SOL backs an LP market already, so it can't take on a backing cap the LP would never see
    let sol = env.sol;
    let base: Asset = env.load(&env.asset_pda(&sol));
    let capped = AssetParams { rate_source: RATE_FIXED, fixed_rate: 1_000_000_000, rate_base_mint: sol, ..base.params };
    expect_err(env.send(&[env.set_asset_ix(&admin.pubkey(), &sol, capped)], &[&admin]), PluribusError::InvalidParams);
    // A backing with nowhere to read the SOL price from is refused at listing
    let mint = env.new_mint(9, &TOKEN);
    let blind = AssetParams { rate_base_mint: Pubkey::default(), ..lst_asset(&env, RATE_FIXED, Pubkey::default(), 1_000_000_000) };
    expect_err(env.send(&[env.init_asset_ix(&mint, blind)], &[&admin]), PluribusError::InvalidParams);
    let nowhere = lst_asset(&env, RATE_STAKE_POOL, Pubkey::default(), 0);
    expect_err(env.send(&[env.init_asset_ix(&mint, nowhere)], &[&admin]), PluribusError::InvalidParams);
}
