mod common;

use {common::*, solana_signer::Signer};

/// A transaction gets 200k compute units per instruction unless it asks for more
const DEFAULT_BUDGET: u64 = 200_000;

fn draw_cost(lp_positions: usize, tokens: usize) -> u64 {
    let mut env = Env::new();
    env.lender(1_000_000 * USDC);
    let user = env.user();
    let (sol, stock) = (env.sol, env.stock);
    for mint in [sol, stock].iter().take(tokens) {
        env.deposit(&user, mint, 10 * SOL);
    }
    for _ in 0..lp_positions {
        env.deposit_lp(&user, 120.0, 180.0, liquidity_for(10_000, 120.0, 180.0, 150));
    }
    let meta = expect_ok(env.draw(&user, 100 * USDC));
    println!("draw with {lp_positions} lp and {tokens} token positions: {} compute units", meta.compute_units_consumed);
    meta.compute_units_consumed
}

#[test]
fn health_check_fits_the_default_compute_budget() {
    let one_lp = draw_cost(1, 0);
    let full = draw_cost(5, 0);
    let mixed = draw_cost(3, 2);
    assert!(one_lp < DEFAULT_BUDGET);
    assert!(full < DEFAULT_BUDGET, "five lp positions used {full}");
    assert!(mixed < DEFAULT_BUDGET);
}

#[test]
fn liquidation_fits_the_default_compute_budget() {
    let mut env = Env::new();
    env.lender(1_000_000 * USDC);
    let user = env.user();
    let liquidator = env.wallet();
    let (sol, usdc) = (env.sol, env.usdc);
    env.deposit(&user, &sol, 10 * SOL);
    for _ in 0..4 {
        env.deposit_lp(&user, 120.0, 180.0, liquidity_for(10_000, 120.0, 180.0, 150));
    }
    let limit = env.health(&user.pubkey()).credit_limit;
    expect_ok(env.draw(&user, limit));
    env.set_price(&sol, 100 * USDC);
    env.fund(&usdc, &liquidator.pubkey(), 1_000_000 * USDC);
    env.fund(&sol, &liquidator.pubkey(), 0);
    let meta = expect_ok(env.send(&[env.liquidate_ix(&liquidator.pubkey(), &user.pubkey(), &sol, 100 * USDC)], &[&liquidator]));
    println!("liquidate with 4 lp and 1 token position: {} compute units", meta.compute_units_consumed);
    assert!(meta.compute_units_consumed < DEFAULT_BUDGET);
}
