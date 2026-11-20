mod common;

use {common::*, pluribus::constants::MAX_POSITIONS, solana_signer::Signer};

/// A transaction gets 200k compute units per instruction unless it asks for more
const DEFAULT_BUDGET: u64 = 200_000;
/// What the SDK asks for on every instruction that checks health, the most one transaction can have, as `budget()` does
const SDK_BUDGET: u64 = 1_400_000;
/// A full account keeps a quarter of that spare, for live price accounts and dearer positions than these
const FULL_ACCOUNT_CEILING: u64 = SDK_BUDGET * 3 / 4;

fn draw_cost(lp_positions: usize, tokens: usize) -> u64 {
    let mut env = Env::new();
    env.lender(1_000_000 * USDC);
    let user = env.user();
    let (sol, stock, usdc) = (env.sol, env.stock, env.usdc);
    for mint in [sol, stock].iter().take(tokens) {
        env.deposit(&user, mint, 10 * SOL);
    }
    for _ in 0..lp_positions {
        env.deposit_lp(&user, 120.0, 180.0, liquidity_for(10_000, 120.0, 180.0, 150));
    }
    env.fund(&usdc, &user.pubkey(), 0);
    let meta = expect_ok(env.send(&[budget(), env.draw_ix(&user.pubkey(), 100 * USDC)], &[&user]));
    println!("draw with {lp_positions} lp and {tokens} token positions: {} compute units", meta.compute_units_consumed);
    meta.compute_units_consumed
}

#[test]
fn a_few_positions_fit_the_default_compute_budget() {
    // A wallet that asks for no budget still works for a small account
    let one_lp = draw_cost(1, 0);
    let mixed = draw_cost(3, 2);
    assert!(one_lp < DEFAULT_BUDGET);
    assert!(mixed < DEFAULT_BUDGET, "three lp and two token positions used {mixed}");
}

#[test]
fn a_draw_against_a_full_account_fits_the_budget_the_sdk_asks_for() {
    let full = draw_cost(MAX_POSITIONS, 0);
    assert!(full < FULL_ACCOUNT_CEILING, "{MAX_POSITIONS} lp positions used {full}");
}

#[test]
fn liquidating_a_full_account_fits_the_budget_the_sdk_asks_for() {
    let mut env = Env::new();
    env.lender(10_000_000 * USDC);
    let user = env.user();
    let me = user.pubkey();
    let liquidator = env.wallet();
    let (sol, usdc) = (env.sol, env.usdc);
    env.deposit(&user, &sol, 10 * SOL);
    for _ in 1..MAX_POSITIONS {
        env.deposit_lp(&user, 120.0, 180.0, liquidity_for(10_000, 120.0, 180.0, 150));
    }
    let limit = env.health(&me).credit_limit;
    env.fund(&usdc, &me, 0);
    expect_ok(env.send(&[budget(), env.draw_ix(&me, limit)], &[&user]));
    env.set_price(&sol, 100 * USDC);
    env.fund(&usdc, &liquidator.pubkey(), 1_000_000 * USDC);
    env.fund(&sol, &liquidator.pubkey(), 0);
    let meta = expect_ok(env.send(&[budget(), env.liquidate_ix(&liquidator.pubkey(), &me, &sol, 100 * USDC)], &[&liquidator]));
    let lps = MAX_POSITIONS - 1;
    println!("liquidate with {lps} lp and 1 token position: {} compute units", meta.compute_units_consumed);
    assert!(meta.compute_units_consumed < FULL_ACCOUNT_CEILING);
}
