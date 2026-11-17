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
    let budget = pool.epoch_budget as u128;
    // The budget is the buffer less the 10% margin
    close(budget, pool.yield_buffer as u128 * 9 / 10, 1);

    // Half way through, half of the budget has been paid
    until(&mut env, friday + WEEK / 2);
    let mid = tranches(&env);
    close((mid.0 + mid.1) - (start.0 + start.1), budget / 2, 3);
    // A junior dollar earns the senior rate times 1 + 15% x 9000 / 1000
    let ratio = ((mid.1 - start.1) as f64 / start.1 as f64) / ((mid.0 - start.0) as f64 / start.0 as f64);
    assert!((ratio - 2.35).abs() < 2e-3, "junior to senior rate {ratio}");

    // By the next Friday all of it, and the margin plus the new week's interest fund the next budget
    until(&mut env, friday + WEEK);
    let end = tranches(&env);
    close((end.0 + end.1) - (start.0 + start.1), budget, 4);
    let next = env.pool_state();
    assert_eq!(next.epoch_start, friday + WEEK);
    close(next.epoch_budget as u128, next.yield_buffer as u128 * 9 / 10, 1);
    assert!(next.yield_buffer as u128 > budget / 9, "the margin carried over");
}

#[test]
fn money_moving_mid_week_leaves_the_budget_alone_and_lowers_the_rate_it_pays() {
    let mut env = pool_with_both_tranches(0);
    let friday = next_friday(&env);
    until(&mut env, friday);
    let budget = env.pool_state().epoch_budget;
    assert!(budget > 0);
    until(&mut env, friday + DAY);
    // A new senior lender joins: the week's dollars stay put, so they are now shared by more money
    lend(&mut env, 9_000 * USDC, false);
    assert_eq!(env.pool_state().epoch_budget, budget);
}

#[test]
fn a_deposit_held_across_the_friday_opening_earns_only_for_the_seconds_it_sat_there() {
    // The same week with and without a million-dollar senior deposit made a second before Friday and taken out a second after
    let run = |whale: bool| {
        let mut env = pool_with_both_tranches(0);
        let friday = next_friday(&env);
        until(&mut env, friday - 1);
        let start = tranches(&env);
        if whale {
            let big = lend(&mut env, 1_000_000 * USDC, false);
            until(&mut env, friday + 1);
            let shares = env.balance(&env.share_mint.clone(), &big.pubkey());
            expect_ok(env.send(&[env.lend_withdraw_ix(&big.pubkey(), shares)], &[&big]));
            let usdc = env.usdc;
            (env.balance(&usdc, &big.pubkey()) as i128 - 1_000_000 * USDC as i128, start, friday, env)
        } else {
            (0, start, friday, env)
        }
    };
    let (_, honest_start, friday, mut honest) = run(false);
    let (whale_gain, attacked_start, _, mut attacked) = run(true);
    until(&mut honest, friday + WEEK - 1);
    until(&mut attacked, friday + WEEK - 1);
    let gain = |env: &Env, start: (u128, u128)| (tranches(env).1 - start.1) as f64;
    // Juniors keep their share of the week, and the deposit made next to nothing
    let (honest_junior, attacked_junior) = (gain(&honest, honest_start), gain(&attacked, attacked_start));
    assert!((attacked_junior / honest_junior - 1.0).abs() < 0.01, "juniors got {attacked_junior} instead of {honest_junior}");
    assert!(whale_gain <= 1_000, "the deposit made {whale_gain}");
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
    let budget = pool.epoch_budget as u128;
    // Two of seven days of the budget are already paid
    let paid = pool.epoch_paid as u128;
    close(paid, budget * 2 / 7, 2);
    // The buffer filled for about 27.7 days before this Friday, so the budget is a week's worth of it:
    // 90% x 7 / 27.7 of that interest, while the last two days' interest arrived after the epoch opened
    let earned = (pool.yield_buffer as u128 + paid) as f64;
    let share = budget as f64 / (0.9 * earned);
    let expected = (27.67 / 29.67) * (7.0 / 27.67);
    assert!((share / expected - 1.0).abs() < 0.02, "budget is {share} of 90% of everything earned, expected {expected}");
}

#[test]
fn once_the_last_junior_leaves_the_rest_of_the_week_goes_to_seniors_and_a_newcomer_gets_only_its_share() {
    let mut env = weekly(0);
    open_junior(&mut env);
    lend(&mut env, 9_000 * USDC, false);
    let junior = lend(&mut env, 1_000 * USDC, true);
    borrow(&mut env, 1_000 * SOL, Some(5_000 * USDC));
    let (j, usdc, junior_mint) = (junior.pubkey(), env.usdc, env.junior_mint());
    let friday = next_friday(&env);
    until(&mut env, friday);
    let budget = env.pool_state().epoch_budget as u128;
    // No exit delay in these tests, so the junior leaves at once
    expect_ok(env.send(&[env.request_exit_ix(&j, env.balance(&junior_mint, &j)), env.claim_exit_ix(&j, &usdc)], &[&junior]));
    assert_eq!(env.pool_state().junior_assets, 0);
    let senior_start = tranches(&env).0;
    until(&mut env, friday + 3 * DAY);
    // Three days of the budget reach seniors, and no junior assets build up with no shares behind them
    assert_eq!(env.pool_state().junior_assets, 0);
    close(tranches(&env).0 - senior_start, budget * 3 / 7, 3);
    // A dollar of new junior money earns about what its size and the premium say, not the junior part of the week
    let newcomer = lend(&mut env, USDC, true);
    until(&mut env, friday + WEEK - 1);
    let worth = env.pool_state().value_of(true, 1_000_000, env.balance(&junior_mint, &newcomer.pubkey())).unwrap_or(0);
    assert!(worth < USDC + USDC / 100, "a dollar grew to {worth} in four days");
}

#[test]
fn turning_epochs_off_keeps_paying_the_buffer_on_its_schedule() {
    let mut env = pool_with_both_tranches(1_000);
    let friday = next_friday(&env);
    until(&mut env, friday + DAY);
    let pool = env.pool_state();
    let (held, end) = (pool.yield_buffer, pool.epoch_end);
    assert!(held > 0);
    let admin = env.admin.insecure_clone();
    // No activation delay in these tests, so this applies at once
    let off = PoolParams { epoch_secs: 0, ..pool.params };
    expect_ok(env.send(&[env.set_params_ix(&admin.pubkey(), off)], &[&admin]));
    // A minute later almost all of it is still waiting, so nobody can grab the buffer by being there at the switch
    until(&mut env, friday + DAY + 60);
    assert!(env.pool_state().yield_buffer > held * 8 / 10);
    // The open week runs to its end, then the rest pays out over one more week
    until(&mut env, end + WEEK / 2);
    let left = env.pool_state().yield_buffer;
    assert!(left > 0 && left < held / 2);
    until(&mut env, end + WEEK);
    assert!(env.pool_state().yield_buffer <= 2);
}

#[test]
fn turning_epochs_off_and_on_within_a_week_continues_the_same_week() {
    let mut env = pool_with_both_tranches(1_000);
    let friday = next_friday(&env);
    until(&mut env, friday + DAY);
    let budget = env.pool_state().epoch_budget;
    let admin = env.admin.insecure_clone();
    let params = env.pool_state().params;
    expect_ok(env.send(&[env.set_params_ix(&admin.pubkey(), PoolParams { epoch_secs: 0, ..params })], &[&admin]));
    until(&mut env, friday + 2 * DAY);
    expect_ok(env.send(&[env.set_params_ix(&admin.pubkey(), params)], &[&admin]));
    until(&mut env, friday + WEEK);
    // The week's budget was paid once, and the next one is funded as usual
    let pool = env.pool_state();
    assert_eq!(pool.epoch_start, friday + WEEK);
    assert!(pool.epoch_budget as u128 * 10 > budget as u128 * 8, "next budget {} after {budget}", pool.epoch_budget);
}

#[test]
fn a_shorter_epoch_waits_until_the_buffer_is_paid_out() {
    let mut env = pool_with_both_tranches(0);
    let friday = next_friday(&env);
    until(&mut env, friday + DAY);
    assert!(env.pool_state().yield_buffer > 0);
    let admin = env.admin.insecure_clone();
    let params = env.pool_state().params;
    // Paying a week's buffer out over a day would hand it to whoever is there that day
    let daily = PoolParams { epoch_secs: DAY as u32, ..params };
    expect_err(env.send(&[env.set_params_ix(&admin.pubkey(), daily)], &[&admin]), pluribus::error::PluribusError::EpochChangeNotAllowed);
    // Through 0 it works: the buffer drains on its weekly schedule, then the new length applies
    expect_ok(env.send(&[env.set_params_ix(&admin.pubkey(), PoolParams { epoch_secs: 0, ..params })], &[&admin]));
    let end = env.pool_state().epoch_end;
    until(&mut env, end + WEEK);
    assert!(env.pool_state().yield_buffer <= 2);
    // The empty buffer still reads a few units of dust at most, so wait for the next accrual to clear it
    let mut pool = env.pool_state();
    if pool.yield_buffer > 0 {
        until(&mut env, end + 2 * WEEK);
        pool = env.pool_state();
    }
    assert_eq!(pool.yield_buffer, 0);
    expect_ok(env.send(&[env.set_params_ix(&admin.pubkey(), daily)], &[&admin]));
}

#[test]
fn a_new_length_chosen_while_the_buffer_is_empty_starts_at_once_and_pays_no_burst() {
    // A fresh pool: lenders and a borrower, nothing in the buffer yet
    let run = |change: bool| {
        let mut env = pool_with_both_tranches(0);
        let admin = env.admin.insecure_clone();
        assert_eq!(env.pool_state().yield_buffer, 0);
        if change {
            let params = PoolParams { epoch_secs: 60, ..env.pool_state().params };
            expect_ok(env.send(&[env.set_params_ix(&admin.pubkey(), params)], &[&admin]));
        }
        let friday = next_friday(&env);
        // A week passes with one transaction a day, then a big deposit lands right as an epoch opens and leaves a minute later
        for d in 1..7 {
            until(&mut env, friday - 7 * DAY + d * DAY);
        }
        until(&mut env, friday);
        let start = env.pool_state().epoch_start;
        let big = lend(&mut env, 1_000_000 * USDC, false);
        until(&mut env, start.max(friday) + 60);
        let shares = env.balance(&env.share_mint.clone(), &big.pubkey());
        expect_ok(env.send(&[env.lend_withdraw_ix(&big.pubkey(), shares)], &[&big]));
        let usdc = env.usdc;
        env.balance(&usdc, &big.pubkey()) as i128 - 1_000_000 * USDC as i128
    };
    let (weekly_gain, minute_gain) = (run(false), run(true));
    // A day's interest buffered under one-minute epochs pays a minute's worth per minute, not all at once
    assert!(minute_gain < 100_000, "one-minute epochs gave a minute of deposit {minute_gain}, weekly gave {weekly_gain}");
}

#[test]
fn with_nobody_lending_the_buffer_waits_and_the_next_lender_earns_it_over_time() {
    let mut env = weekly(0);
    open_junior(&mut env);
    let (usdc, senior_mint, junior_mint) = (env.usdc, env.share_mint, env.junior_mint());
    let senior = lend(&mut env, 9_000 * USDC, false);
    let junior = lend(&mut env, 1_000 * USDC, true);
    let user = borrow(&mut env, 1_000 * SOL, Some(5_000 * USDC));
    let friday = next_friday(&env);
    until(&mut env, friday + DAY);
    let admin = env.admin.insecure_clone();
    let params = env.pool_state().params;
    expect_ok(env.send(&[env.set_params_ix(&admin.pubkey(), PoolParams { epoch_secs: 0, ..params })], &[&admin]));
    // The debt is repaid and every lender leaves, so the buffer sits with nobody to pay
    env.fund(&usdc, &user.pubkey(), 6_000 * USDC);
    expect_ok(env.send(&[env.repay_ix(&user.pubkey(), &user.pubkey(), u64::MAX)], &[&user]));
    let (s, j) = (senior.pubkey(), junior.pubkey());
    expect_ok(env.send(&[env.lend_withdraw_ix(&s, env.balance(&senior_mint, &s))], &[&senior]));
    expect_ok(env.send(&[env.request_exit_ix(&j, env.balance(&junior_mint, &j)), env.claim_exit_ix(&j, &usdc)], &[&junior]));
    let held = env.pool_state().yield_buffer;
    assert!(held > 0);
    // Weeks later a newcomer lends ten dollars: a second on it has earned about a second's worth, not the buffer
    let later = env.now() + 3 * WEEK;
    until(&mut env, later);
    let newcomer = lend(&mut env, 10 * USDC, false);
    until(&mut env, later + 1);
    let worth = env.pool_state().value_of(false, 10 * USDC + 1, env.balance(&senior_mint, &newcomer.pubkey())).unwrap_or(0);
    assert!(worth < 10 * USDC + held / 1_000, "ten dollars grew to {worth} in a second, with {held} waiting");
}

#[test]
fn a_new_epoch_length_never_pays_backdated_time() {
    let set = |env: &mut Env, epoch: i64| {
        let admin = env.admin.insecure_clone();
        let params = PoolParams { epoch_secs: epoch as u32, ..env.pool_state().params };
        env.send(&[env.set_params_ix(&admin.pubkey(), params)], &[&admin])
    };
    // Daily epochs from the start, with nothing in the buffer yet
    let mut env = weekly(0);
    expect_ok(set(&mut env, DAY));
    open_junior(&mut env);
    lend(&mut env, 9_000 * USDC, false);
    lend(&mut env, 1_000 * USDC, true);
    borrow(&mut env, 1_000 * SOL, Some(5_000 * USDC));
    let friday = next_friday(&env);
    until(&mut env, friday + 4 * DAY + DAY / 2);
    // Straight to weekly is refused while a buffer is waiting, through 0 it works
    assert!(set(&mut env, WEEK).is_err());
    expect_ok(set(&mut env, 0));
    let drained = env.pool_state().epoch_end + DAY;
    until(&mut env, drained);
    until(&mut env, drained + 1);
    assert_eq!(env.pool_state().yield_buffer, 0);
    expect_ok(set(&mut env, WEEK));
    // The first weekly epoch runs to the next Friday and its budget pays nothing that was earned before it opened
    let start = env.now();
    until(&mut env, start + 60);
    let pool = env.pool_state();
    assert_eq!(pool.epoch_end, friday + WEEK);
    assert!(pool.epoch_paid <= 1, "paid {} of {} at once", pool.epoch_paid, pool.epoch_budget);
}
