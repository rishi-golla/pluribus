mod common;

use {
    common::*,
    pluribus::{constants::*, state::*},
    solana_keypair::Keypair,
    solana_signer::Signer,
};

const WEEK: i64 = 7 * DAY;

/// Weekly epochs holding back `margin_bps` of the buffer each Friday
fn weekly(margin_bps: u16) -> Env {
    Env::with(PoolParams { epoch_secs: WEEK as u32, yield_margin_bps: margin_bps, ..default_params() }, true)
}

fn open_junior(env: &mut Env) {
    let admin = env.admin.insecure_clone();
    expect_ok(env.send(&[env.init_junior_ix(&admin.pubkey())], &[&admin]));
}

fn lend(env: &mut Env, amount: u64, junior: bool) -> Keypair {
    let wallet = env.wallet();
    let (usdc, senior, junior_mint) = (env.usdc, env.share_mint, env.junior_mint());
    env.fund(&usdc, &wallet.pubkey(), amount);
    env.fund(&senior, &wallet.pubkey(), 0);
    env.fund(&junior_mint, &wallet.pubkey(), 0);
    let mint = if junior { junior_mint } else { senior };
    expect_ok(env.send(&[env.tranche_ix(&wallet.pubkey(), &mint, amount, true)], &[&wallet]));
    wallet
}

fn borrow(env: &mut Env, sol_amount: u64, usdc: Option<u64>) -> Keypair {
    let sol = env.sol;
    let user = env.user();
    env.deposit(&user, &sol, sol_amount);
    let amount = usdc.unwrap_or_else(|| env.health(&user.pubkey()).credit_limit - 2);
    expect_ok(env.draw(&user, amount));
    user
}

/// Moves the clock to `at`, renews the prices and accrues
fn until(env: &mut Env, at: i64) {
    env.warp(at - env.now());
    let (sol, stock) = (env.sol, env.stock);
    env.set_price(&sol, 150 * USDC);
    env.set_price(&stock, 200 * USDC);
    let admin = env.admin.insecure_clone();
    expect_ok(env.send(&[env.accrue_ix()], &[&admin]));
}

/// The next Friday at 00:00 UTC, when the next epoch opens
fn next_friday(env: &Env) -> i64 {
    EPOCH_ANCHOR + ((env.now() - EPOCH_ANCHOR).div_euclid(WEEK) + 1) * WEEK
}

fn tranches(env: &Env) -> (u128, u128) {
    let pool = env.pool_state();
    (pool.tranche_assets(false).unwrap(), pool.tranche_assets(true).unwrap())
}

#[track_caller]
fn close(got: u128, want: u128, slack: u128) {
    assert!(got + slack >= want && got <= want + slack, "got {got}, want {want}");
}

/// A pool of 9000 senior and 1000 junior USDC with 5000 drawn
fn pool_with_both_tranches(margin_bps: u16) -> Env {
    let mut env = weekly(margin_bps);
    open_junior(&mut env);
    lend(&mut env, 9_000 * USDC, false);
    lend(&mut env, 1_000 * USDC, true);
    borrow(&mut env, 1_000 * SOL, Some(5_000 * USDC));
    env
}

#[test]
fn interest_waits_in_the_buffer_and_each_friday_a_fixed_budget_is_paid_out_over_the_week() {
    let mut env = pool_with_both_tranches(1_000);
    // Until the first Friday there is nothing to pay
    let start = tranches(&env);
    let friday = next_friday(&env);
    until(&mut env, friday - 1);
    close(tranches(&env).0, start.0, 3);
    close(tranches(&env).1, start.1, 3);

    // The interest so far collects in the buffer, and on Friday at 00:00 UTC an epoch opens with a budget for the week
    until(&mut env, friday);
    let pool = env.pool_state();
    assert_eq!((pool.epoch_start, pool.epoch_end), (friday, friday + WEEK));
    assert_eq!((friday - EPOCH_ANCHOR).rem_euclid(WEEK), 0);
    close(tranches(&env).0, start.0, 3);
    close(tranches(&env).1, start.1, 3);
    let budget = (pool.epoch_senior_budget + pool.epoch_junior_budget) as u128;
    // The budget is the buffer less the 10% margin
    close(budget, pool.yield_buffer as u128 * 9 / 10, 1);
    // A junior dollar earns the senior rate times 1 + 15% x 9000 / 1000
    let rate = |budget: u64, size: u128| budget as f64 / size as f64;
    let ratio = rate(pool.epoch_junior_budget, start.1) / rate(pool.epoch_senior_budget, start.0);
    assert!((ratio - 2.35).abs() < 1e-3, "junior to senior rate {ratio}");

    // Half way through, half of each budget has been paid
    let (senior_budget, junior_budget) = (pool.epoch_senior_budget as u128, pool.epoch_junior_budget as u128);
    until(&mut env, friday + WEEK / 2);
    close(tranches(&env).0, start.0 + senior_budget / 2, 3);
    close(tranches(&env).1, start.1 + junior_budget / 2, 3);

    // By the next Friday all of it, and the margin plus the new week's interest fund the next budget
    until(&mut env, friday + WEEK);
    close(tranches(&env).0, start.0 + senior_budget, 4);
    close(tranches(&env).1, start.1 + junior_budget, 4);
    let next = env.pool_state();
    assert_eq!(next.epoch_start, friday + WEEK);
    close((next.epoch_senior_budget + next.epoch_junior_budget) as u128, next.yield_buffer as u128 * 9 / 10, 1);
    assert!(next.yield_buffer as u128 > budget / 9, "the margin carried over");
}

#[test]
fn money_moving_mid_week_changes_nobodys_budget_only_the_rate_it_pays() {
    let mut env = pool_with_both_tranches(0);
    let friday = next_friday(&env);
    until(&mut env, friday);
    let pool = env.pool_state();
    let budgets = (pool.epoch_senior_budget, pool.epoch_junior_budget);
    assert!(budgets.0 > 0 && budgets.1 > 0);
    until(&mut env, friday + DAY);
    // A new senior lender joins: the senior budget stays put, so it is now shared by twice the money
    lend(&mut env, 9_000 * USDC, false);
    let pool = env.pool_state();
    assert_eq!((pool.epoch_senior_budget, pool.epoch_junior_budget), budgets);
}

#[test]
fn unpaid_interest_takes_losses_before_the_reserve_and_junior_lenders() {
    let mut env = pool_with_both_tranches(1_000);
    let (sol, usdc) = (env.sol, env.usdc);
    // Twelve weeks of interest, all still in the buffer the moment the next epoch opens
    let at = next_friday(&env) + 11 * WEEK;
    until(&mut env, at);
    let user = borrow(&mut env, SOL / 2, None);
    env.set_price(&sol, 10 * USDC);
    let liquidator = env.wallet();
    env.fund(&usdc, &liquidator.pubkey(), 1_000 * USDC);
    env.fund(&sol, &liquidator.pubkey(), 0);
    let before = env.pool_state();
    expect_ok(env.send(&[env.liquidate_ix(&liquidator.pubkey(), &user.pubkey(), &sol, u64::MAX)], &[&liquidator]));
    let after = env.pool_state();
    let loss = after.bad_debt - before.bad_debt;
    assert!(loss > 0 && loss < before.yield_buffer, "loss {loss} against a buffer of {}", before.yield_buffer);
    assert_eq!(after.yield_buffer, before.yield_buffer - loss);
    assert_eq!((after.reserves, after.protocol_fees, after.junior_assets), (before.reserves, before.protocol_fees, before.junior_assets));
}

#[test]
fn a_buffer_cut_short_by_a_loss_pays_what_it_holds_and_never_more() {
    let mut env = pool_with_both_tranches(0);
    let (sol, usdc) = (env.sol, env.usdc);
    let friday = next_friday(&env);
    until(&mut env, friday);
    let start = tranches(&env);
    // A loss larger than the buffer empties it on the first day
    until(&mut env, friday + DAY);
    let user = borrow(&mut env, 10 * SOL, None);
    env.set_price(&sol, 10 * USDC);
    let liquidator = env.wallet();
    env.fund(&usdc, &liquidator.pubkey(), 10_000 * USDC);
    env.fund(&sol, &liquidator.pubkey(), 0);
    let before = env.pool_state();
    expect_ok(env.send(&[env.liquidate_ix(&liquidator.pubkey(), &user.pubkey(), &sol, u64::MAX)], &[&liquidator]));
    let after = env.pool_state();
    assert!(after.bad_debt - before.bad_debt > before.yield_buffer);
    assert_eq!(after.yield_buffer, 0);
    // The rest of the week pays only from interest that comes in after, never the forfeited budget
    let mid = tranches(&env);
    until(&mut env, friday + WEEK - 1);
    let end = env.pool_state();
    let paid = (tranches(&env).0 + tranches(&env).1) - (mid.0 + mid.1);
    let came_in = (end.reserves - after.reserves) as u128 * 8;
    assert!(paid <= came_in + 4, "paid {paid} with only about {came_in} of new interest");
    assert!(tranches(&env).0 >= start.0 - (after.bad_debt - before.bad_debt) as u128);
    let claims = end.lender_assets().unwrap() + (end.reserves + end.protocol_fees + end.yield_buffer) as u128;
    assert_eq!(claims, end.cash as u128 + end.total_debt().unwrap());
}

#[test]
fn after_skipped_weeks_the_current_epoch_opens_with_everything_in_the_buffer() {
    let mut env = pool_with_both_tranches(1_000);
    let friday = next_friday(&env);
    // Nobody touches the pool for three weeks and two days
    until(&mut env, friday + 3 * WEEK + 2 * DAY);
    let pool = env.pool_state();
    assert_eq!(pool.epoch_start, friday + 3 * WEEK);
    let budget = (pool.epoch_senior_budget + pool.epoch_junior_budget) as u128;
    // Two of seven days of the budget are already paid
    let paid = (pool.epoch_senior_paid + pool.epoch_junior_paid) as u128;
    close(paid, budget * 2 / 7, 2);
    // The budget is 90% of the interest earned before this Friday: about 27.7 of the 29.7 days since the pool opened,
    // while the last two days' interest arrived after the epoch opened and waits for the next one
    let earned = (pool.yield_buffer as u128 + paid) as f64;
    let share = budget as f64 / (0.9 * earned);
    assert!((share - 27.67 / 29.67).abs() < 0.01, "budget is {share} of 90% of everything earned");
}

#[test]
fn once_the_last_junior_leaves_the_rest_of_the_junior_budget_goes_to_seniors() {
    let mut env = weekly(0);
    open_junior(&mut env);
    lend(&mut env, 9_000 * USDC, false);
    let junior = lend(&mut env, 1_000 * USDC, true);
    borrow(&mut env, 1_000 * SOL, Some(5_000 * USDC));
    let (j, usdc, junior_mint) = (junior.pubkey(), env.usdc, env.junior_mint());
    let friday = next_friday(&env);
    until(&mut env, friday);
    let budgets = (env.pool_state().epoch_senior_budget as u128, env.pool_state().epoch_junior_budget as u128);
    assert!(budgets.1 > 0);
    // No exit delay in these tests, so the junior leaves at once
    expect_ok(env.send(&[env.request_exit_ix(&j, env.balance(&junior_mint, &j)), env.claim_exit_ix(&j, &usdc)], &[&junior]));
    assert_eq!(env.pool_state().junior_assets, 0);
    let senior_start = tranches(&env).0;
    until(&mut env, friday + WEEK - 1);
    // Nearly all of both budgets reach seniors, and no junior assets build up with no shares behind them
    assert_eq!(env.pool_state().junior_assets, 0);
    let gained = tranches(&env).0 - senior_start;
    assert!(gained + 3 >= (budgets.0 + budgets.1) * (WEEK as u128 - 1) / WEEK as u128, "seniors gained {gained} of {budgets:?}");
}

#[test]
fn turning_epochs_off_pays_the_whole_buffer_out_at_the_next_accrual() {
    let mut env = pool_with_both_tranches(1_000);
    let friday = next_friday(&env);
    until(&mut env, friday + DAY);
    let held = env.pool_state().yield_buffer;
    assert!(held > 0);
    let before = env.pool_state().lender_assets().unwrap();
    let admin = env.admin.insecure_clone();
    // No activation delay in these tests, so this applies at once
    let off = PoolParams { epoch_secs: 0, ..env.pool_state().params };
    expect_ok(env.send(&[env.set_params_ix(&admin.pubkey(), off)], &[&admin]));
    until(&mut env, friday + DAY + 60);
    let pool = env.pool_state();
    assert_eq!(pool.yield_buffer, 0);
    assert!(pool.lender_assets().unwrap() >= before + held as u128);
}
