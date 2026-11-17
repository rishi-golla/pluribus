mod common;

use {
    anchor_lang::prelude::Pubkey,
    common::*,
    pluribus::{constants::*, error::PluribusError, state::*},
    solana_signer::Signer,
};

const YEAR: f64 = 31_536_000.0;

/// A fresh token in the SOL group, listed with a one-day horizon and `sigma_bps` of annual volatility to start from
fn volatile(env: &mut Env, sigma_bps: u32) -> Pubkey {
    let admin = env.admin.insecure_clone();
    let mint = env.new_mint(9, &TOKEN);
    let params = AssetParams { vol_horizon_secs: DAY as u32, ..asset_params(GROUP_SOL, ORACLE_PYTH, SOL_FEED, 500) };
    expect_ok(env.send(&[env.init_asset_seeded_ix(&mint, params, sigma_bps)], &[&admin]));
    env.set_price(&mint, 100 * USDC);
    mint
}

fn asset(env: &Env, mint: &Pubkey) -> Asset {
    env.load(&env.asset_pda(mint))
}

/// z x sigma x sqrt(T) in bps for an annual volatility, the way the program computes it from a seed
fn expected_shock(sigma_bps: f64, z: f64, horizon: f64) -> f64 {
    z * sigma_bps * (horizon / YEAR).sqrt()
}

/// Credit limit of a fresh borrower holding `amount` whole tokens of `mint`
fn limit_for(env: &mut Env, mint: &Pubkey, amount: u64) -> u64 {
    let user = env.user();
    env.deposit(&user, mint, amount * SOL);
    env.health(&user.pubkey()).credit_limit
}

#[test]
fn a_calm_asset_keeps_the_table_and_a_volatile_one_falls_further_in_every_scenario() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    // 80% a year over a day at z = 3 is about 12.6%, under the table's 30% crypto crash
    let calm = volatile(&mut env, 8_000);
    let d = asset(&env, &calm).dynamic_shock(300) as f64;
    assert!((d / expected_shock(8_000.0, 3.0, DAY as f64) - 1.0).abs() < 0.01, "shock {d}");
    let table = limit_for(&mut env, &calm, 10);
    // 300% a year is about 47% over a day: the crypto crash deepens to that, and the others keep their share of it
    let wild = volatile(&mut env, 30_000);
    let d = asset(&env, &wild).dynamic_shock(300) as f64;
    assert!(d > 4_500.0 && d < 4_800.0, "shock {d}");
    let shocked = limit_for(&mut env, &wild, 10);
    // $1000 of tokens less the 5% cost: the worst scenario now keeps 1 - d instead of 70%
    let want = 1_000.0 * (1.0 - d / 10_000.0) * 0.95;
    assert!(((shocked as f64 / USDC as f64) / want - 1.0).abs() < 0.01, "limit {shocked}, want {want}");
    assert!(shocked < table);
    assert!(((table as f64 / USDC as f64) / (1_000.0 * 0.7 * 0.95) - 1.0).abs() < 0.01, "calm limit {table}");
}

#[test]
fn the_dynamic_shock_never_passes_the_cap_and_never_puts_the_liquidation_line_above_the_draw_limit() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    // 3000% a year would be a shock over 100%
    let mint = volatile(&mut env, 100_000);
    let user = env.user();
    env.deposit(&user, &mint, 10 * SOL);
    let health = env.health(&user.pubkey());
    // The cap keeps 5% of the value in the worst scenario, less the 5% cost
    let floor = (1_000.0 * 0.05 * 0.95 * USDC as f64) as u64;
    assert!(health.credit_limit + 2 >= floor && health.credit_limit <= floor + 2, "limit {}", health.credit_limit);
    assert!(health.liquidation_limit >= health.credit_limit);
}

#[test]
fn the_crank_learns_volatility_from_fresh_prices_and_refuses_samples_it_cannot_trust() {
    let mut env = Env::new();
    let mint = volatile(&mut env, 0);
    let keeper = env.wallet();
    // The first sample only records the price
    expect_ok(env.send(&[env.update_vol_ix(&mint)], &[&keeper]));
    let a = asset(&env, &mint);
    assert_eq!((a.vol_price, a.var_fast, a.var_slow), (100 * USDC, 0, 0));
    // A newer price is needed, by at least the minimum interval
    expect_err(env.send(&[env.update_vol_ix(&mint)], &[&keeper]), PluribusError::VolTooSoon);
    env.warp(60);
    env.set_price(&mint, 110 * USDC);
    expect_ok(env.send(&[env.update_vol_ix(&mint)], &[&keeper]));
    // A 10% move over a minute: squared return per second, a sixtieth of an hour into the fast average
    let a = asset(&env, &mint);
    let sample = 0.01 / 60.0 * VOL_SCALE as f64;
    assert!((a.var_fast as f64 / (sample / 60.0) - 1.0).abs() < 0.01, "fast {}", a.var_fast);
    assert!((a.var_slow as f64 / (sample * 60.0 / (7.0 * DAY as f64)) - 1.0).abs() < 0.01, "slow {}", a.var_slow);
    // Too old or too uncertain a price is refused
    env.warp(61);
    expect_err(env.send(&[env.update_vol_ix(&mint)], &[&keeper]), PluribusError::StalePrice);
    expect_ok(env.set_price_conf(&mint, 110 * USDC, 3 * USDC));
    expect_err(env.send(&[env.update_vol_ix(&mint)], &[&keeper]), PluribusError::PriceTooUncertain);
    // USDC has no volatility to learn
    let usdc = env.usdc;
    assert!(env.send(&[env.update_vol_ix(&usdc)], &[&keeper]).is_err());
}

#[test]
fn volatility_rises_fast_and_fades_slowly() {
    let mut env = Env::new();
    let mint = volatile(&mut env, 0);
    let keeper = env.wallet();
    expect_ok(env.send(&[env.update_vol_ix(&mint)], &[&keeper]));
    // A crash: 30% down in an hour
    env.warp(3_600);
    env.set_price(&mint, 70 * USDC);
    expect_ok(env.send(&[env.update_vol_ix(&mint)], &[&keeper]));
    let crash = asset(&env, &mint).dynamic_shock(300);
    // The fast average takes the whole hour: 0.09 per hour of variance over a day at z = 3 is a 441% shock before the cap
    assert!(crash > 4_000, "shock after the crash {crash}");
    // The slow average spreads the same hour over a week: 0.09 over 7 days, a day of it at z = 3 is about 34%
    let slow_now = {
        let a = asset(&env, &mint);
        Asset { var_fast: 0, ..a }.dynamic_shock(300)
    };
    assert!((slow_now as f64 / 3_402.0 - 1.0).abs() < 0.02, "slow shock {slow_now}");
    // A calm day of hourly samples: the fast average drops away and the slow one fades by a day's weight of seven
    for _ in 0..24 {
        env.warp(3_600);
        env.set_price(&mint, 70 * USDC);
        expect_ok(env.send(&[env.update_vol_ix(&mint)], &[&keeper]));
    }
    let a = asset(&env, &mint);
    assert!(a.var_fast < a.var_slow / 100, "fast {} slow {}", a.var_fast, a.var_slow);
    let after_a_day = a.dynamic_shock(300);
    let fade = (1.0f64 - 1.0 / 168.0).powi(24).sqrt();
    assert!((after_a_day as f64 / (slow_now as f64 * fade) - 1.0).abs() < 0.01, "a day later the shock is {after_a_day}");
    // Still deeper than the table's 30% crypto crash a day after the move
    assert!(after_a_day > 3_000);
}

#[test]
fn a_longer_horizon_applies_at_once_and_a_shorter_one_waits() {
    let mut env = Env::timed();
    let admin = env.admin.insecure_clone();
    let sol = env.sol;
    let base = asset(&env, &sol).params;
    expect_ok(env.send(&[env.set_asset_ix(&admin.pubkey(), &sol, AssetParams { vol_horizon_secs: DAY as u32, ..base })], &[&admin]));
    assert_eq!(asset(&env, &sol).params.vol_horizon_secs, DAY as u32);
    expect_ok(env.send(&[env.set_asset_ix(&admin.pubkey(), &sol, AssetParams { vol_horizon_secs: 60, ..base })], &[&admin]));
    let a = asset(&env, &sol);
    assert_eq!((a.params.vol_horizon_secs, a.pending.vol_horizon_secs), (DAY as u32, 60));
}

#[test]
fn volatility_settings_that_make_no_sense_are_rejected() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let p = default_params();
    let bad = [
        ("liquidation z above draw z", PoolParams { z_maint_x100: 301, ..p }),
        ("fast average slower than the slow one", PoolParams { vol_tau_fast_secs: 8 * DAY as u32, ..p }),
        ("no minimum interval", PoolParams { vol_min_interval_secs: 0, ..p }),
        ("cap at 100%", PoolParams { max_shock_bps: 10_000, ..p }),
        ("cap under a table shock", PoolParams { max_shock_bps: 2_999, ..p }),
    ];
    for (name, params) in bad {
        assert!(failed_with(&env.send(&[env.set_params_ix(&admin.pubkey(), params)], &[&admin]), PluribusError::InvalidParams), "{name}");
    }
    let usdc = env.usdc;
    let fixed = AssetParams { vol_horizon_secs: DAY as u32, ..asset_params(u8::MAX, ORACLE_FIXED, [0; 32], 0) };
    assert!(failed_with(&env.send(&[env.set_asset_ix(&admin.pubkey(), &usdc, fixed)], &[&admin]), PluribusError::InvalidParams));
}
