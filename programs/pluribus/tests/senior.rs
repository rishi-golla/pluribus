mod common;

use {
    anchor_lang::{prelude::*, solana_program::{instruction::Instruction, system_program}, InstructionData, ToAccountMetas},
    common::*,
    pluribus::{error::PluribusError, state::*},
    solana_keypair::Keypair,
    solana_signer::Signer,
};

const YEAR: i64 = 365 * DAY;

/// A pool with two senior lenders of `each` USDC and a SOL-backed borrower who has drawn `drawn`
fn lent_out(each: u64, drawn: u64) -> (Env, Keypair, Keypair, Keypair) {
    let mut env = Env::new();
    let (a, b) = (env.lender(each), env.lender(each));
    let sol = env.sol;
    let user = env.user();
    env.deposit(&user, &sol, 1_000 * SOL);
    expect_ok(env.draw(&user, drawn));
    (env, a, b, user)
}

fn shares_of(env: &Env, who: &Keypair) -> u64 {
    env.balance(&env.share_mint.clone(), &who.pubkey())
}

fn queue(env: &mut Env, who: &Keypair) -> u64 {
    let ticket = env.pool_state().senior_next_ticket;
    let held = shares_of(env, who);
    expect_ok(env.send(&[env.request_senior_exit_ix(&who.pubkey(), held)], &[who]));
    ticket
}

fn repay(env: &mut Env, user: &Keypair, amount: u64) {
    let usdc = env.usdc;
    let held = env.balance(&usdc, &user.pubkey());
    env.fund(&usdc, &user.pubkey(), held + amount);
    expect_ok(env.send(&[env.repay_ix(&user.pubkey(), &user.pubkey(), amount)], &[user]));
}

fn exit(env: &Env, ticket: u64) -> SeniorExit {
    env.load(&env.senior_exit_pda(ticket))
}

#[test]
fn queued_exits_hold_cash_back_and_are_paid_strictly_in_order() {
    let (mut env, a, b, user) = lent_out(1_000 * USDC, 1_900 * USDC);
    let keeper = env.wallet();
    let usdc = env.usdc;

    // Only 100 USDC is idle, so an instant withdrawal of either lender fails
    let (held, held_b) = (shares_of(&env, &a), shares_of(&env, &b));
    expect_err(env.send(&[env.lend_withdraw_ix(&a.pubkey(), held)], &[&a]), PluribusError::InsufficientLiquidity);

    let (ta, tb) = (queue(&mut env, &a), queue(&mut env, &b));
    assert_eq!((ta, tb), (0, 1));
    let pool = env.pool_state();
    let (va, vb) = (exit(&env, ta).value, exit(&env, tb).value);
    assert!(va >= 999 * USDC && vb >= 999 * USDC);
    assert_eq!((pool.senior_reserved, pool.senior_queued, pool.senior_head), (va + vb, held + held_b, 0));
    assert_eq!(env.token_amount(&env.senior_escrow()), held + held_b);

    // The head cannot be paid out of 100 USDC, and the ticket behind it is never next
    expect_err(env.send(&[env.settle_head_ix(&keeper.pubkey())], &[&keeper]), PluribusError::InsufficientLiquidity);
    assert!(env.send(&[env.settle_senior_exit_ix(&keeper.pubkey(), tb)], &[&keeper]).is_err());

    // A repayment lands in the reserve: the borrower cannot draw it back out
    repay(&mut env, &user, 1_000 * USDC);
    assert_eq!(env.pool_state().available_cash(), 0);
    expect_err(env.draw(&user, 50 * USDC), PluribusError::InsufficientLiquidity);

    // Now the head is covered: A is paid what the shares were worth when queued, and B still waits
    expect_ok(env.send(&[env.settle_head_ix(&keeper.pubkey())], &[&keeper]));
    assert_eq!(env.balance(&usdc, &a.pubkey()), va);
    assert!(env.svm.get_account(&env.senior_exit_pda(ta)).is_none());
    let pool = env.pool_state();
    assert_eq!((pool.senior_head, pool.senior_reserved, pool.senior_queued), (1, vb, held_b));
    expect_err(env.send(&[env.settle_head_ix(&keeper.pubkey())], &[&keeper]), PluribusError::InsufficientLiquidity);

    repay(&mut env, &user, u64::MAX / 4);
    expect_ok(env.send(&[env.settle_head_ix(&keeper.pubkey())], &[&keeper]));
    assert_eq!(env.balance(&usdc, &b.pubkey()), vb);
    let pool = env.pool_state();
    assert_eq!((pool.senior_head, pool.senior_next_ticket, pool.senior_reserved, pool.senior_queued), (2, 2, 0, 0));
    assert_eq!(env.token_amount(&env.senior_escrow()), 0);
}

#[test]
fn the_reservation_stops_other_withdrawals_and_fee_collection_jumping_the_queue() {
    let (mut env, a, b, user) = lent_out(1_000 * USDC, 1_500 * USDC);
    let admin = env.admin.insecure_clone();
    env.warp(YEAR);
    expect_ok(env.send(&[env.accrue_ix()], &[&admin]));
    let ta = queue(&mut env, &a);
    let va = exit(&env, ta).value;
    // 500 is idle against about 1,000 reserved
    assert_eq!(env.pool_state().available_cash(), 0);
    let held = shares_of(&env, &b);
    expect_err(env.send(&[env.lend_withdraw_ix(&b.pubkey(), held / 10)], &[&b]), PluribusError::InsufficientLiquidity);
    let usdc = env.usdc;
    env.fund(&usdc, &admin.pubkey(), 0);
    expect_err(env.send(&[env.collect_protocol_fees_ix(&admin.pubkey(), u64::MAX)], &[&admin]), PluribusError::ZeroAmount);

    // Cash above the reservation is free again for everyone
    repay(&mut env, &user, 1_000 * USDC);
    let free = env.pool_state().available_cash();
    assert!(free > 0 && env.pool_state().cash - free == va);
    expect_ok(env.send(&[env.collect_protocol_fees_ix(&admin.pubkey(), u64::MAX)], &[&admin]));
    assert!(env.pool_state().cash >= va);
}

#[test]
fn a_queued_exit_earns_nothing_and_cancelling_hands_back_only_what_was_queued() {
    let (mut env, a, b, _user) = lent_out(1_000 * USDC, 1_500 * USDC);
    let admin = env.admin.insecure_clone();
    let share_mint = env.share_mint;
    let held = shares_of(&env, &a);
    let ta = queue(&mut env, &a);
    let queued = exit(&env, ta).value;

    env.warp(YEAR);
    expect_ok(env.send(&[env.accrue_ix()], &[&admin]));
    let (pool, supply) = (env.pool_state(), env.svm.get_account(&share_mint).map(|m| u64::from_le_bytes(m.data[36..44].try_into().unwrap())).unwrap());
    assert!(pool.value_of(false, supply, held).unwrap() > queued, "the queued shares grew while waiting");
    let b_before = pool.value_of(false, supply, shares_of(&env, &b)).unwrap();

    expect_ok(env.send(&[env.cancel_senior_exit_ix(&a.pubkey(), ta)], &[&a]));
    let returned = shares_of(&env, &a);
    assert!(returned < held);
    let pool = env.pool_state();
    let supply = supply - (held - returned);
    let worth = pool.value_of(false, supply, returned).unwrap();
    assert!(worth.abs_diff(queued) <= 2, "worth {worth} against {queued} queued");
    // The yield the queued shares would have earned went to the lender who stayed
    assert!(pool.value_of(false, supply, shares_of(&env, &b)).unwrap() > b_before);
    assert_eq!((pool.senior_reserved, pool.senior_queued), (0, 0));
    expect_err(env.send(&[env.cancel_senior_exit_ix(&a.pubkey(), ta)], &[&a]), PluribusError::ExitCancelled);

    // The empty ticket is skipped once the queue reaches it, and its rent goes back to the owner
    let keeper = env.wallet();
    let lamports = env.svm.get_account(&a.pubkey()).unwrap().lamports;
    expect_ok(env.send(&[env.settle_head_ix(&keeper.pubkey())], &[&keeper]));
    assert_eq!(env.pool_state().senior_head, 1);
    assert!(env.svm.get_account(&a.pubkey()).unwrap().lamports > lamports);
    assert_eq!(env.balance(&env.usdc.clone(), &a.pubkey()), 0);
}

#[test]
fn only_the_owner_cancels_and_settling_pays_the_owner_whoever_calls() {
    let (mut env, a, _b, _user) = lent_out(1_000 * USDC, 500 * USDC);
    let ta = queue(&mut env, &a);
    let stranger = env.wallet();
    let share_mint = env.share_mint;
    env.fund(&share_mint, &stranger.pubkey(), 0);
    let mut ix = env.cancel_senior_exit_ix(&a.pubkey(), ta);
    ix.accounts[0].pubkey = stranger.pubkey();
    ix.accounts[5].pubkey = ata(&stranger.pubkey(), &share_mint, &TOKEN);
    assert!(env.send(&[ix], &[&stranger]).is_err());

    // The owner never opened a USDC account: settling makes one, paid for by the caller
    assert!(env.svm.get_account(&ata(&a.pubkey(), &env.usdc, &TOKEN)).map_or(true, |acc| acc.lamports > 0));
    let value = exit(&env, ta).value;
    expect_ok(env.send(&[env.settle_head_ix(&stranger.pubkey())], &[&stranger]));
    assert_eq!(env.balance(&env.usdc.clone(), &a.pubkey()), value);
}

#[test]
fn a_queued_exit_still_takes_its_share_of_a_loss() {
    let mut env = Env::new();
    let a = env.lender(10_000 * USDC);
    let _b = env.lender(10_000 * USDC);
    let sol = env.sol;
    let user = env.user();
    env.deposit(&user, &sol, 100 * SOL);
    let limit = env.health(&user.pubkey()).credit_limit - 2;
    expect_ok(env.draw(&user, limit));
    let ta = queue(&mut env, &a);
    let queued = exit(&env, ta).value;

    // SOL collapses and the account is liquidated with debt left over, which seniors carry since nothing sits ahead of them
    let liq = env.wallet();
    let usdc = env.usdc;
    env.fund(&usdc, &liq.pubkey(), 1_000_000 * USDC);
    env.fund(&sol, &liq.pubkey(), 0);
    env.set_price(&sol, 10 * USDC);
    expect_ok(env.send(&[env.liquidate_ix(&liq.pubkey(), &user.pubkey(), &sol, u64::MAX)], &[&liq]));
    env.set_price(&sol, 150 * USDC);
    assert!(env.pool_state().bad_debt > 0);

    let keeper = env.wallet();
    expect_ok(env.send(&[env.settle_head_ix(&keeper.pubkey())], &[&keeper]));
    let paid = env.balance(&usdc, &a.pubkey());
    assert!(paid < queued, "paid {paid} of {queued} after a loss");
    let pool = env.pool_state();
    assert_eq!((pool.senior_reserved, pool.senior_queued), (0, 0));
}

#[test]
fn a_credit_account_closes_only_when_empty_and_can_be_opened_again() {
    let mut env = Env::new();
    env.lender(10_000 * USDC);
    let sol = env.sol;
    let user = env.user();
    env.deposit(&user, &sol, 10 * SOL);
    expect_ok(env.draw(&user, 100 * USDC));
    let me = user.pubkey();

    expect_err(env.send(&[env.close_account_ix(&me)], &[&user]), PluribusError::DebtOutstanding);
    repay(&mut env, &user, u64::MAX / 4);
    expect_err(env.send(&[env.close_account_ix(&me)], &[&user]), PluribusError::CollateralLeft);
    expect_ok(env.send(&[env.withdraw_token_ix(&me, &sol, 10 * SOL)], &[&user]));

    let credit = env.credit_pda(&me);
    let rent = env.svm.get_account(&credit).unwrap().lamports;
    let before = env.svm.get_account(&me).unwrap().lamports;
    expect_ok(env.send(&[env.close_account_ix(&me)], &[&user]));
    assert!(env.svm.get_account(&credit).is_none_or(|a| a.lamports == 0));
    assert!(env.svm.get_account(&me).unwrap().lamports + 10_000 >= before + rent);

    // The owner can start over with a fresh account
    let open = Instruction::new_with_bytes(
        pluribus::ID,
        &pluribus::instruction::OpenAccount {}.data(),
        pluribus::accounts::OpenAccount { owner: me, credit, system_program: system_program::ID }.to_account_metas(None),
    );
    expect_ok(env.send(&[open], &[&user]));
    let reopened = env.credit(&me);
    assert_eq!((reopened.owner, reopened.debt_shares, reopened.has_collateral()), (me, 0, false));
}

#[test]
fn nobody_else_can_close_an_account() {
    let mut env = Env::new();
    let user = env.user();
    let stranger = env.wallet();
    let mut ix = env.close_account_ix(&user.pubkey());
    ix.accounts[0].pubkey = stranger.pubkey();
    // The account is seeded by its owner, so signing for someone else's address fails the seeds check
    assert!(env.send(&[ix], &[&stranger]).is_err());
    assert!(env.svm.get_account(&env.credit_pda(&user.pubkey())).is_some());
}

#[test]
fn a_pool_from_before_the_queue_is_grown_in_place_by_the_admin_only() {
    let mut env = Env::new();
    let lender = env.lender(1_000 * USDC);
    let size = 8 + Pool::INIT_SPACE;
    let before = env.pool_state();
    // The layout before the senior queue: the same account without its last four u64s
    let mut account = env.svm.get_account(&env.pool).unwrap();
    account.data.truncate(size - 32);
    env.svm.set_account(env.pool, account).unwrap();
    let held = shares_of(&env, &lender);
    assert!(env.send(&[env.lend_withdraw_ix(&lender.pubkey(), held)], &[&lender]).is_err());

    let stranger = env.wallet();
    expect_err(env.send(&[env.migrate_pool_ix(&stranger.pubkey())], &[&stranger]), PluribusError::AccountMismatch);
    let admin = env.admin.insecure_clone();
    expect_ok(env.send(&[env.migrate_pool_ix(&admin.pubkey())], &[&admin]));
    let account = env.svm.get_account(&env.pool).unwrap();
    assert_eq!(account.data.len(), size);
    assert!(account.lamports >= env.svm.minimum_balance_for_rent_exemption(size));
    let after = env.pool_state();
    assert_eq!((after.cash, after.admin, after.params), (before.cash, before.admin, before.params));
    assert_eq!((after.senior_queued, after.senior_reserved, after.senior_next_ticket, after.senior_head), (0, 0, 0, 0));
    // A second run changes nothing, and the pool works again
    expect_ok(env.send(&[env.migrate_pool_ix(&admin.pubkey())], &[&admin]));
    expect_ok(env.send(&[env.lend_withdraw_ix(&lender.pubkey(), held)], &[&lender]));
}
