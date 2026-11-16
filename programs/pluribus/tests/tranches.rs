mod common;

use {
    anchor_lang::error::ErrorCode,
    common::*,
    pluribus::error::PluribusError,
    solana_keypair::Keypair,
    solana_signer::Signer,
};

fn near(got: u128, want: f64) -> bool {
    (got as f64 / want - 1.0).abs() < 1e-6
}

/// A pool with the junior tranche open, 9,000 USDC of senior money and 1,000 of junior
fn pool_with_both_tranches() -> (Env, Keypair, Keypair) {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    expect_ok(env.send(&[env.init_junior_ix(&admin.pubkey())], &[&admin]));
    let senior = env.lender(9_000 * USDC);
    let junior = junior_lender(&mut env, 1_000 * USDC);
    (env, senior, junior)
}

fn junior_lender(env: &mut Env, amount: u64) -> Keypair {
    let lender = env.wallet();
    let (usdc, mint) = (env.usdc, env.junior_mint());
    env.fund(&usdc, &lender.pubkey(), amount);
    env.fund(&mint, &lender.pubkey(), 0);
    expect_ok(env.send(&[env.tranche_ix(&lender.pubkey(), &mint, amount, true)], &[&lender]));
    lender
}

/// A borrower drawn to the limit on SOL whose collateral is then worth a tenth of the debt
/// One liquidation takes all of it, and the rest of the debt is written off
fn default_on(env: &mut Env, sol_amount: u64) -> u64 {
    let (sol, usdc) = (env.sol, env.usdc);
    let user = env.user();
    env.deposit(&user, &sol, sol_amount);
    let limit = env.health(&user.pubkey()).credit_limit;
    expect_ok(env.draw(&user, limit));
    env.set_price(&sol, 10 * USDC);
    let liquidator = env.wallet();
    env.fund(&usdc, &liquidator.pubkey(), 1_000_000 * USDC);
    env.fund(&sol, &liquidator.pubkey(), 0);
    let before = env.pool_state().bad_debt;
    expect_ok(env.send(&[env.liquidate_ix(&liquidator.pubkey(), &user.pubkey(), &sol, u64::MAX)], &[&liquidator]));
    assert_eq!(env.debt(&user.pubkey()), 0);
    env.set_price(&sol, 150 * USDC);
    env.pool_state().bad_debt - before
}

#[test]
fn junior_lenders_earn_more_and_senior_lenders_pay_for_the_cover() {
    let (mut env, senior, _junior) = pool_with_both_tranches();
    let sol = env.sol;
    let user = env.user();
    env.deposit(&user, &sol, 1000 * SOL);
    expect_ok(env.draw(&user, 5_000 * USDC));
    // Half the pool is lent: 2% + 8% * 50 / 90
    let rate = env.pool_state().base_rate_bps().unwrap() as f64 / 10_000.0;
    env.warp(365 * DAY);
    expect_ok(env.send(&[env.accrue_ix()], &[&senior]));

    // Lenders share 80% of the interest, and seniors hand a fifth of theirs to juniors
    let base_yield = 5_000.0 * rate * 0.8 / 10_000.0;
    let pool = env.pool_state();
    let unit = USDC as f64;
    assert!(near(pool.tranche_assets(false).unwrap(), 9_000.0 * (1.0 + base_yield * 0.8) * unit));
    assert!(near(pool.tranche_assets(true).unwrap(), 1_000.0 * (1.0 + base_yield * (1.0 + 0.2 * 9.0)) * unit));
    assert_eq!(pool.tranche_assets(false).unwrap() + pool.tranche_assets(true).unwrap(), pool.lender_assets().unwrap());
}

#[test]
fn losses_fall_on_junior_lenders_before_senior_ones() {
    let (mut env, senior, junior) = pool_with_both_tranches();
    let (usdc, senior_mint, junior_mint) = (env.usdc, env.share_mint, env.junior_mint());

    // A small default: no interest has accrued, so reserves and fees are empty and juniors take all of it
    let small = default_on(&mut env, 10 * SOL);
    let pool = env.pool_state();
    assert!(small > 0 && small < 1_000 * USDC);
    assert_eq!(pool.junior_assets, 1_000 * USDC - small);
    assert_eq!(pool.tranche_assets(false).unwrap(), 9_000 * USDC as u128);

    // A large default wipes the juniors out and seniors take only what is left over
    let left = pool.junior_assets;
    let large = default_on(&mut env, 60 * SOL);
    let pool = env.pool_state();
    assert!(large > left);
    assert_eq!(pool.junior_assets, 0);
    assert_eq!(pool.tranche_assets(false).unwrap(), (9_000 * USDC - (large - left)) as u128);
    assert_eq!(pool.cash, env.token_amount(&env.usdc_vault));

    // Junior shares are now worth nothing, and nobody can buy into an empty tranche at a made-up price
    let held = env.balance(&junior_mint, &junior.pubkey());
    expect_err(env.send(&[env.tranche_ix(&junior.pubkey(), &junior_mint, held, false)], &[&junior]), PluribusError::ZeroAmount);
    env.fund(&usdc, &junior.pubkey(), 100 * USDC);
    expect_err(env.send(&[env.tranche_ix(&junior.pubkey(), &junior_mint, 100 * USDC, true)], &[&junior]), PluribusError::PoolInsolvent);

    // Seniors leave with exactly their tranche
    let held = env.balance(&senior_mint, &senior.pubkey());
    expect_ok(env.send(&[env.lend_withdraw_ix(&senior.pubkey(), held)], &[&senior]));
    assert_eq!(env.balance(&usdc, &senior.pubkey()), 9_000 * USDC - (large - left));
}

#[test]
fn junior_lenders_leave_with_their_own_share_price() {
    let (mut env, senior, junior) = pool_with_both_tranches();
    let (sol, usdc, junior_mint) = (env.sol, env.usdc, env.junior_mint());
    let user = env.user();
    env.deposit(&user, &sol, 1000 * SOL);
    expect_ok(env.draw(&user, 5_000 * USDC));
    env.warp(365 * DAY);
    expect_ok(env.send(&[env.accrue_ix()], &[&senior]));

    let worth = env.pool_state().junior_assets;
    let held = env.balance(&junior_mint, &junior.pubkey());
    expect_ok(env.send(&[env.tranche_ix(&junior.pubkey(), &junior_mint, held, false)], &[&junior]));
    assert_eq!(env.balance(&usdc, &junior.pubkey()), worth);
    assert!(worth > 1_000 * USDC);
    let pool = env.pool_state();
    assert_eq!(pool.junior_assets, 0);
    assert_eq!(pool.cash, env.token_amount(&env.usdc_vault));
}

#[test]
fn only_the_admin_opens_the_junior_tranche_and_only_the_pools_own_mints_are_shares() {
    let mut env = Env::new();
    let senior = env.lender(1_000 * USDC);
    let stranger = env.wallet();
    let (usdc, junior_mint) = (env.usdc, env.junior_mint());

    let opened_by_stranger = env.send(&[env.init_junior_ix(&stranger.pubkey())], &[&stranger]);
    assert!(failed_with_code(&opened_by_stranger, ErrorCode::ConstraintHasOne.into()));
    // Before the tranche is open its mint does not exist
    env.fund(&usdc, &stranger.pubkey(), 100 * USDC);
    assert!(env.send(&[env.tranche_ix(&stranger.pubkey(), &junior_mint, 100 * USDC, true)], &[&stranger]).is_err());

    // A mint the pool never made cannot stand in for shares
    let fake = env.new_mint(6, &TOKEN);
    env.fund(&fake, &senior.pubkey(), 1_000 * USDC);
    let redeem_fake = env.tranche_ix(&senior.pubkey(), &fake, 1_000 * USDC, false);
    expect_err(env.send(&[redeem_fake], &[&senior]), PluribusError::AccountMismatch);

    let admin = env.admin.insecure_clone();
    expect_ok(env.send(&[env.init_junior_ix(&admin.pubkey())], &[&admin]));
    assert!(env.send(&[env.init_junior_ix(&admin.pubkey())], &[&admin]).is_err());
}

#[test]
fn a_thin_junior_tranche_earns_only_a_matching_slice_of_the_protection_fee() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    expect_ok(env.send(&[env.init_junior_ix(&admin.pubkey())], &[&admin]));
    let senior = env.lender(10_000 * USDC);
    // One dollar of junior money next to ten thousand senior: a hundredth of a percent of the pool
    junior_lender(&mut env, USDC);
    let sol = env.sol;
    let user = env.user();
    env.deposit(&user, &sol, 1000 * SOL);
    expect_ok(env.draw(&user, 5_000 * USDC));
    let rate = env.pool_state().base_rate_bps().unwrap() as f64 / 10_000.0;
    env.warp(365 * DAY);
    expect_ok(env.send(&[env.accrue_ix()], &[&senior]));

    let pool = env.pool_state();
    let base_yield = 5_000.0 * rate * 0.8 / 10_001.0;
    let junior_yield = pool.junior_assets as f64 / USDC as f64 - 1.0;
    // At the 10% target a junior dollar would earn the base yield plus twice it again from the 20% fee
    // This thin it earns the base yield and a fee capped at that same multiple, never the whole fee
    assert!(junior_yield < base_yield * 3.01, "junior yield {junior_yield} against base {base_yield}");
    assert!(junior_yield > base_yield * 2.9);
    // Senior lenders give up next to nothing to it
    let senior_yield = pool.tranche_assets(false).unwrap() as f64 / (10_000.0 * USDC as f64) - 1.0;
    assert!(senior_yield > base_yield * 0.999, "senior yield {senior_yield} against base {base_yield}");
}
