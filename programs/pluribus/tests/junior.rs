mod common;

use {
    anchor_lang::{error::ErrorCode, prelude::*, solana_program::program_pack::Pack},
    anchor_spl::token::spl_token::state::Mint as MintState,
    common::*,
    pluribus::{constants::*, error::PluribusError, state::*},
    solana_keypair::Keypair,
    solana_signer::Signer,
};

const YEAR: i64 = 365 * DAY;
const VIRTUAL: f64 = 1_000_000.0;

fn near(got: f64, want: f64, tolerance: f64) -> bool {
    (got / want - 1.0).abs() < tolerance
}

#[track_caller]
fn expect_anchor(res: TxResult, code: ErrorCode) {
    let code = u32::from(code);
    assert!(failed_with_code(&res, code), "expected anchor error {code}, got {:#?}", res.map(|m| m.logs).map_err(|f| (f.err, f.meta.logs)));
}

fn open_junior(env: &mut Env) {
    let admin = env.admin.insecure_clone();
    expect_ok(env.send(&[env.init_junior_ix(&admin.pubkey())], &[&admin]));
}

/// A wallet that has lent `amount` USDC into one tranche, with empty accounts for USDC and both share mints
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

fn borrow(env: &mut Env, sol_amount: u64, usdc: u64) -> Keypair {
    let sol = env.sol;
    let user = env.user();
    env.deposit(&user, &sol, sol_amount);
    expect_ok(env.draw(&user, usdc));
    user
}

fn supply(env: &Env, mint: &Pubkey) -> u64 {
    MintState::unpack(&env.svm.get_account(mint).unwrap().data).unwrap().supply
}

/// A tranche's share price with its virtual share and dollar, the price every move between tranches keeps
fn price(env: &Env, junior: bool) -> f64 {
    let mint = if junior { env.junior_mint() } else { env.share_mint };
    (env.pool_state().tranche_assets(junior).unwrap() as f64 + VIRTUAL) / (supply(env, &mint) as f64 + VIRTUAL)
}

fn activation() -> i64 {
    timed_params().activation_delay_secs as i64
}

fn exit(env: &Env, owner: &Pubkey) -> JuniorExit {
    env.load(&env.junior_exit_pda(owner))
}

fn pass(env: &mut Env, secs: i64) {
    env.warp(secs);
    let (sol, stock) = (env.sol, env.stock);
    env.set_price(&sol, 150 * USDC);
    env.set_price(&stock, 200 * USDC);
    let admin = env.admin.insecure_clone();
    expect_ok(env.send(&[env.accrue_ix()], &[&admin]));
}

// Converting senior money into junior money

#[test]
fn senior_shares_turn_into_junior_shares_with_no_cash_and_both_prices_unchanged() {
    let mut env = Env::new();
    open_junior(&mut env);
    let senior = lend(&mut env, 9_000 * USDC, false);
    lend(&mut env, 1_000 * USDC, true);
    // Everything is lent out, so withdrawing and lending again is impossible
    borrow(&mut env, 1_000 * SOL, 10_000 * USDC);
    pass(&mut env, YEAR);
    assert_eq!(env.pool_state().cash, 0);
    let (s, senior_mint, junior_mint) = (senior.pubkey(), env.share_mint, env.junior_mint());
    let held = env.balance(&senior_mint, &s);
    expect_err(env.send(&[env.lend_withdraw_ix(&s, held)], &[&senior]), PluribusError::InsufficientLiquidity);

    let before = env.pool_state();
    let (senior_price, junior_price) = (price(&env, false), price(&env, true));
    expect_ok(env.send(&[env.convert_ix(&s, held / 2)], &[&senior]));
    let after = env.pool_state();
    let moved = after.junior_assets - before.junior_assets;
    assert_eq!(after.cash, 0);
    assert_eq!(after.lender_assets().unwrap(), before.lender_assets().unwrap());
    assert!(near(moved as f64, (held / 2) as f64 * senior_price, 1e-6));
    assert!(near(price(&env, false), senior_price, 1e-9) && near(price(&env, true), junior_price, 1e-9));
    assert_eq!(env.balance(&senior_mint, &s), held - held / 2);
    assert!(near(env.balance(&junior_mint, &s) as f64 * junior_price, moved as f64, 1e-6));

    // Converted shares are junior money like any other and leave through the queue
    let converted = env.balance(&junior_mint, &s);
    expect_err(env.send(&[env.tranche_ix(&s, &junior_mint, converted, false)], &[&senior]), PluribusError::JuniorExitQueue);
    expect_err(env.send(&[env.convert_ix(&s, 0)], &[&senior]), PluribusError::ZeroAmount);
}

#[test]
fn nothing_converts_before_the_junior_tranche_is_open() {
    let mut env = Env::new();
    let senior = lend_senior_only(&mut env);
    let s = senior.pubkey();
    assert!(env.send(&[env.convert_ix(&s, USDC)], &[&senior]).is_err());
}

fn lend_senior_only(env: &mut Env) -> Keypair {
    let wallet = env.wallet();
    let (usdc, senior) = (env.usdc, env.share_mint);
    env.fund(&usdc, &wallet.pubkey(), 100 * USDC);
    env.fund(&senior, &wallet.pubkey(), 0);
    expect_ok(env.send(&[env.lend_deposit_ix(&wallet.pubkey(), 100 * USDC)], &[&wallet]));
    wallet
}

// The exit queue

#[test]
fn a_junior_exit_waits_out_its_delay_and_lapses_if_left_unclaimed() {
    let mut env = Env::timed();
    open_junior(&mut env);
    lend(&mut env, 9_000 * USDC, false);
    let junior = lend(&mut env, 1_000 * USDC, true);
    let (j, usdc, junior_mint) = (junior.pubkey(), env.usdc, env.junior_mint());
    let held = env.balance(&junior_mint, &j);
    let start = env.now();
    expect_ok(env.send(&[env.request_exit_ix(&j, held)], &[&junior]));
    assert_eq!((env.token_amount(&env.junior_escrow()), env.balance(&junior_mint, &j)), (held, 0));
    assert_eq!(env.pool_state().junior_queued, held);
    let queued = exit(&env, &j);
    assert_eq!((queued.unlock_at, queued.window_secs, queued.fee_bps), (start + 6 * DAY, 2 * DAY as u32, 5));

    // One exit per owner at a time
    assert!(env.send(&[env.request_exit_ix(&j, 1)], &[&junior]).is_err());
    expect_err(env.send(&[env.claim_exit_ix(&j, &usdc)], &[&junior]), PluribusError::ExitNotReady);
    env.warp(6 * DAY - 1);
    expect_err(env.send(&[env.claim_exit_ix(&j, &usdc)], &[&junior]), PluribusError::ExitNotReady);
    // Nobody else can hand the shares back while the exit is live
    let stranger = env.wallet();
    expect_err(env.send(&[env.cancel_exit_ix(&stranger.pubkey(), &j)], &[&stranger]), PluribusError::ExitNotLapsed);

    env.warp(1 + 2 * DAY);
    expect_err(env.send(&[env.claim_exit_ix(&j, &usdc)], &[&junior]), PluribusError::ExitLapsed);
    // Once it has lapsed anyone can put the shares back to work, and the owner gets the rent back
    let lamports = env.svm.get_balance(&j).unwrap();
    expect_ok(env.send(&[env.cancel_exit_ix(&stranger.pubkey(), &j)], &[&stranger]));
    assert_eq!((env.balance(&junior_mint, &j), env.pool_state().junior_queued), (held, 0));
    assert!(env.svm.get_account(&env.junior_exit_pda(&j)).map_or(true, |a| a.lamports == 0));
    assert!(env.svm.get_balance(&j).unwrap() > lamports);

    // The owner can always take a fresh exit back early
    expect_ok(env.send(&[env.request_exit_ix(&j, held / 2)], &[&junior]));
    expect_ok(env.send(&[env.cancel_exit_ix(&j, &j)], &[&junior]));
    assert_eq!(env.balance(&junior_mint, &j), held);
}

#[test]
fn a_claim_pays_at_most_what_the_shares_were_worth_when_queued_and_the_rest_stays_with_juniors() {
    let mut env = Env::timed();
    open_junior(&mut env);
    lend(&mut env, 8_000 * USDC, false);
    let (leaver, stayer) = (lend(&mut env, 1_000 * USDC, true), lend(&mut env, 1_000 * USDC, true));
    borrow(&mut env, 1_000 * SOL, 5_000 * USDC);
    let (l, usdc, junior_mint) = (leaver.pubkey(), env.usdc, env.junior_mint());
    let held = env.balance(&junior_mint, &l);
    expect_ok(env.send(&[env.request_exit_ix(&l, held)], &[&leaver]));
    let queued = exit(&env, &l).value;
    pass(&mut env, 6 * DAY);

    // The shares earned while they waited, but the exit pays what they were worth when queued, less the fee
    let before = env.pool_state();
    let now_worth = before.value_of(true, supply(&env, &junior_mint), held).unwrap();
    assert!(now_worth > queued);
    let fee = (queued * 5).div_ceil(10_000);
    expect_ok(env.send(&[env.claim_exit_ix(&l, &usdc)], &[&leaver]));
    let after = env.pool_state();
    assert_eq!(env.balance(&usdc, &l), queued - fee);
    assert_eq!((after.junior_assets, after.cash), (before.junior_assets - (queued - fee), before.cash - (queued - fee)));
    assert_eq!((after.junior_queued, env.token_amount(&env.junior_escrow())), (0, 0));
    assert!(env.svm.get_account(&env.junior_exit_pda(&l)).map_or(true, |a| a.lamports == 0));
    // The junior who stays keeps the leaver's yield and the fee
    let kept = after.value_of(true, supply(&env, &junior_mint), env.balance(&junior_mint, &stayer.pubkey())).unwrap();
    let gift = (now_worth - queued + fee) as f64;
    assert!(near((kept - now_worth) as f64, gift, 1e-3), "stayer gained {}, leaver left behind {gift}", kept - now_worth);
}

#[test]
fn a_cancelled_exit_hands_back_shares_worth_what_was_queued_and_burns_the_yield() {
    let mut env = Env::timed();
    open_junior(&mut env);
    lend(&mut env, 8_000 * USDC, false);
    let (leaver, stayer) = (lend(&mut env, 1_000 * USDC, true), lend(&mut env, 1_000 * USDC, true));
    borrow(&mut env, 1_000 * SOL, 5_000 * USDC);
    let (l, junior_mint) = (leaver.pubkey(), env.junior_mint());
    let held = env.balance(&junior_mint, &l);
    expect_ok(env.send(&[env.request_exit_ix(&l, held)], &[&leaver]));
    let queued = exit(&env, &l).value;
    pass(&mut env, 30 * DAY);
    let stayer_before = env.pool_state().value_of(true, supply(&env, &junior_mint), env.balance(&junior_mint, &stayer.pubkey())).unwrap();

    // Holding an exit open and then walking away costs the yield it would have earned
    expect_ok(env.send(&[env.cancel_exit_ix(&l, &l)], &[&leaver]));
    let back = env.balance(&junior_mint, &l);
    assert!(back < held);
    let pool = env.pool_state();
    let back_worth = pool.value_of(true, supply(&env, &junior_mint), back).unwrap();
    assert!(back_worth <= queued + 2 && back_worth + 2 >= queued, "back {back_worth}, queued {queued}");
    let stayer_after = pool.value_of(true, supply(&env, &junior_mint), env.balance(&junior_mint, &stayer.pubkey())).unwrap();
    assert!(stayer_after > stayer_before);
    assert_eq!(pool.junior_queued, 0);
}

#[test]
fn the_last_junior_out_leaves_what_is_left_to_the_insurance_reserve() {
    let mut env = Env::timed();
    open_junior(&mut env);
    lend(&mut env, 9_000 * USDC, false);
    let junior = lend(&mut env, 1_000 * USDC, true);
    borrow(&mut env, 1_000 * SOL, 5_000 * USDC);
    let (j, usdc, junior_mint) = (junior.pubkey(), env.usdc, env.junior_mint());
    expect_ok(env.send(&[env.request_exit_ix(&j, env.balance(&junior_mint, &j))], &[&junior]));
    pass(&mut env, 6 * DAY);
    let before = env.pool_state();
    expect_ok(env.send(&[env.claim_exit_ix(&j, &usdc)], &[&junior]));
    let after = env.pool_state();
    // Fee and the yield earned while queued would otherwise sit in a tranche with no shares, for the next lender to take
    assert_eq!((after.junior_assets, supply(&env, &junior_mint)), (0, 0));
    let paid = env.balance(&usdc, &j);
    assert_eq!(after.reserves, before.reserves + (before.junior_assets - paid));
}

#[test]
fn a_claim_in_senior_shares_needs_no_idle_cash() {
    let mut env = Env::new();
    open_junior(&mut env);
    lend(&mut env, 9_000 * USDC, false);
    let junior = lend(&mut env, 1_000 * USDC, true);
    borrow(&mut env, 1_000 * SOL, 10_000 * USDC);
    let (j, usdc, senior_mint, junior_mint) = (junior.pubkey(), env.usdc, env.share_mint, env.junior_mint());
    let held = env.balance(&junior_mint, &j);
    expect_ok(env.send(&[env.request_exit_ix(&j, held)], &[&junior]));
    expect_err(env.send(&[env.claim_exit_ix(&j, &usdc)], &[&junior]), PluribusError::InsufficientLiquidity);

    // A payout account in any other token is refused
    let fake = env.new_mint(6, &TOKEN);
    env.fund(&fake, &j, 0);
    expect_err(env.send(&[env.claim_exit_ix(&j, &fake)], &[&junior]), PluribusError::AccountMismatch);

    let (before, senior_price) = (env.pool_state(), price(&env, false));
    expect_ok(env.send(&[env.claim_exit_ix(&j, &senior_mint)], &[&junior]));
    let after = env.pool_state();
    let got = env.balance(&senior_mint, &j);
    let moved = (before.junior_assets - after.junior_assets) as f64;
    assert!(got > 0 && near(got as f64 * senior_price, moved, 1e-6));
    assert!(near(price(&env, false), senior_price, 1e-9));
    assert_eq!((after.cash, after.lender_assets().unwrap()), (before.cash, before.lender_assets().unwrap()));
}

#[test]
fn the_exit_delay_grows_with_the_share_of_junior_money_queued() {
    let params = PoolParams {
        junior_min_delay_secs: DAY as u32,
        junior_max_delay_secs: 10 * DAY as u32,
        junior_delay_threshold_bps: 5_000,
        junior_pause_gap_secs: 13 * DAY as u32,
        activation_delay_secs: 12 * DAY as u32,
        ..default_params()
    };
    let mut env = Env::with(params, true);
    open_junior(&mut env);
    let lenders = [100, 400, 500].map(|usdc| lend(&mut env, usdc * USDC, true));
    let junior_mint = env.junior_mint();
    // A tenth of the supply queued is a fifth of the way to the threshold: one day plus a fifth of the other nine
    // Half the supply is at the threshold and anything past it waits the max
    for (lender, wait) in lenders.iter().zip([DAY + 9 * DAY / 5, 10 * DAY, 10 * DAY]) {
        let who = lender.pubkey();
        let held = env.balance(&junior_mint, &who);
        expect_ok(env.send(&[env.request_exit_ix(&who, held)], &[lender]));
        assert_eq!(exit(&env, &who).unlock_at - env.now(), wait);
    }
}

// Governance pause

#[test]
fn governance_pauses_are_capped_spaced_out_and_never_cut_a_queued_exit_short() {
    let mut env = Env::timed();
    open_junior(&mut env);
    lend(&mut env, 9_000 * USDC, false);
    let (first, second) = (lend(&mut env, 500 * USDC, true), lend(&mut env, 500 * USDC, true));
    let (f, s, usdc, junior_mint) = (first.pubkey(), second.pubkey(), env.usdc, env.junior_mint());
    let admin = env.admin.insecure_clone();
    let a = admin.pubkey();
    let guardian = env.wallet();
    expect_ok(env.send(&[env.set_guardian_ix(&a, guardian.pubkey())], &[&admin]));
    expect_ok(env.send(&[env.request_exit_ix(&f, env.balance(&junior_mint, &f))], &[&first]));

    // Only the admin pauses, never the guardian, never for nothing and never past the cap
    expect_anchor(env.send(&[env.pause_exits_ix(&guardian.pubkey(), DAY as u32)], &[&guardian]), ErrorCode::ConstraintHasOne);
    for bad in [0, 90 * DAY as u32 + 1] {
        expect_err(env.send(&[env.pause_exits_ix(&a, bad)], &[&admin]), PluribusError::PauseNotAllowed);
    }
    expect_ok(env.send(&[env.pause_exits_ix(&a, 30 * DAY as u32)], &[&admin]));
    expect_err(env.send(&[env.pause_exits_ix(&a, DAY as u32)], &[&admin]), PluribusError::PauseNotAllowed);

    // Nothing is queued or claimed while it holds
    expect_err(env.send(&[env.request_exit_ix(&s, env.balance(&junior_mint, &s))], &[&second]), PluribusError::ExitsPaused);
    env.warp(7 * DAY);
    expect_err(env.send(&[env.claim_exit_ix(&f, &usdc)], &[&first]), PluribusError::ExitsPaused);

    // The first exit's window passed inside the pause, so a full window opens when the pause ends
    env.warp(23 * DAY);
    // A new pause has to wait out the gap
    expect_err(env.send(&[env.pause_exits_ix(&a, DAY as u32)], &[&admin]), PluribusError::PauseNotAllowed);
    env.warp(DAY);
    expect_ok(env.send(&[env.claim_exit_ix(&f, &usdc)], &[&first]));
    assert!(env.balance(&usdc, &f) > 0);

    // An exit that lapses before the next pause stays lapsed
    expect_ok(env.send(&[env.request_exit_ix(&s, env.balance(&junior_mint, &s))], &[&second]));
    env.warp(8 * DAY + 1);
    // Still inside the two-week gap
    expect_err(env.send(&[env.pause_exits_ix(&a, 5 * DAY as u32)], &[&admin]), PluribusError::PauseNotAllowed);
    env.warp(5 * DAY);
    expect_ok(env.send(&[env.pause_exits_ix(&a, 5 * DAY as u32)], &[&admin]));
    // Governance can lift a pause early, once
    expect_ok(env.send(&[env.unpause_exits_ix(&a)], &[&admin]));
    assert_eq!(env.pool_state().junior_pause_end, env.now());
    expect_err(env.send(&[env.unpause_exits_ix(&a)], &[&admin]), PluribusError::PauseNotAllowed);
    expect_err(env.send(&[env.claim_exit_ix(&s, &usdc)], &[&second]), PluribusError::ExitLapsed);
}

// Activation delay and the timelock on loosening

#[test]
fn a_new_listing_backs_no_debt_until_its_activation_delay_has_passed() {
    let mut env = Env::timed();
    env.lender(10_000 * USDC);
    let admin = env.admin.insecure_clone();
    let token = env.new_mint(6, &TOKEN);
    expect_ok(env.send(&[env.init_asset_ix(&token, asset_params(GROUP_STOCK, ORACLE_PYTH, STOCK_FEED, 1000))], &[&admin]));
    let asset: Asset = env.load(&env.asset_pda(&token));
    assert_eq!(asset.active_at, env.now() + activation());
    env.set_price(&token, 100 * USDC);
    let user = env.user();
    // It takes no deposits yet, so it can neither back new debt nor shield old debt from liquidation
    env.fund(&token, &user.pubkey(), 100 * STOCK);
    expect_err(env.send(&[env.deposit_token_ix(&user.pubkey(), &token, 100 * STOCK)], &[&user]), PluribusError::NotYetActive);
    env.warp(activation());
    env.set_price(&token, 100 * USDC);
    expect_ok(env.send(&[env.deposit_token_ix(&user.pubkey(), &token, 100 * STOCK)], &[&user]));
    assert!(env.health(&user.pubkey()).credit_limit > 0);
    expect_ok(env.draw(&user, 1_000 * USDC));

    // The guardian can cancel a listing still in its delay, and an unpause then waits a full delay of its own
    let guardian = env.wallet();
    expect_ok(env.send(&[env.set_guardian_ix(&admin.pubkey(), guardian.pubkey())], &[&admin]));
    let other = env.new_mint(6, &TOKEN);
    expect_ok(env.send(&[env.init_asset_ix(&other, asset_params(GROUP_STOCK, ORACLE_PYTH, STOCK_FEED, 1000))], &[&admin]));
    expect_ok(env.send(&[env.guard_asset_ix(&guardian.pubkey(), &other)], &[&guardian]));
    let cancelled: Asset = env.load(&env.asset_pda(&other));
    expect_ok(env.send(&[env.set_asset_ix(&admin.pubkey(), &other, AssetParams { paused: false, ..cancelled.params })], &[&admin]));
    let waiting: Asset = env.load(&env.asset_pda(&other));
    assert!(waiting.params.paused && waiting.pending_at == env.now() + activation());
}

#[test]
fn loosening_waits_out_the_activation_delay_and_tightening_applies_at_once() {
    let mut env = Env::timed();
    let admin = env.admin.insecure_clone();
    let a = admin.pubkey();
    let (guardian, stranger) = (env.wallet(), env.wallet());
    let g = guardian.pubkey();
    expect_ok(env.send(&[env.set_guardian_ix(&a, g)], &[&admin]));
    let params = timed_params();

    // A lower SOL shock waits out the activation delay, then anyone can apply it
    let mut looser = params;
    looser.init_shock_bps[0] = 2_500;
    expect_ok(env.send(&[env.set_params_ix(&a, looser)], &[&admin]));
    let pool = env.pool_state();
    assert_eq!((pool.params, pool.pending_params, pool.pending_at), (params, looser, env.now() + activation()));
    expect_err(env.send(&[env.apply_params_ix()], &[&stranger]), PluribusError::ChangeNotDue);
    env.warp(activation());
    expect_ok(env.send(&[env.apply_params_ix()], &[&stranger]));
    assert_eq!(env.pool_state().params, looser);
    expect_err(env.send(&[env.apply_params_ix()], &[&stranger]), PluribusError::NoPendingChange);

    // A rate cut is not a tightening either, and the guardian can drop it while a stranger cannot
    let cheaper = PoolParams { base_rate_bps: 100, ..looser };
    expect_ok(env.send(&[env.set_params_ix(&a, cheaper)], &[&admin]));
    assert_eq!(env.pool_state().params, looser);
    expect_err(env.send(&[env.cancel_pending_params_ix(&stranger.pubkey())], &[&stranger]), PluribusError::NotGuardian);
    expect_ok(env.send(&[env.cancel_pending_params_ix(&g)], &[&guardian]));
    expect_err(env.send(&[env.apply_params_ix()], &[&stranger]), PluribusError::NoPendingChange);

    // Raising shocks applies at once and drops whatever was waiting, as long as no group's worst shock rises alone
    expect_ok(env.send(&[env.set_params_ix(&a, cheaper)], &[&admin]));
    let mut tighter = looser;
    tighter.init_shock_bps[MAX_GROUPS] = 2_000;
    expect_ok(env.send(&[env.set_params_ix(&a, tighter)], &[&admin]));
    let pool = env.pool_state();
    assert_eq!((pool.params, pool.pending_at), (tighter, 0));
    // The guardian cannot set parameters
    expect_anchor(env.send(&[env.set_params_ix(&g, looser)], &[&guardian]), ErrorCode::ConstraintHasOne);

    // Assets: a pause is immediate, an unpause and a group change wait
    let sol = env.sol;
    let sol_asset = |env: &Env| -> Asset { env.load(&env.asset_pda(&sol)) };
    let base = sol_asset(&env).params;
    expect_ok(env.send(&[env.set_asset_ix(&a, &sol, AssetParams { paused: true, ..base })], &[&admin]));
    assert!(sol_asset(&env).params.paused);
    expect_ok(env.send(&[env.set_asset_ix(&a, &sol, base)], &[&admin]));
    assert!(sol_asset(&env).params.paused && sol_asset(&env).pending_at > 0);
    expect_err(env.send(&[env.apply_asset_ix(&sol)], &[&stranger]), PluribusError::ChangeNotDue);
    env.warp(activation());
    expect_ok(env.send(&[env.apply_asset_ix(&sol)], &[&stranger]));
    assert!(!sol_asset(&env).params.paused);
    expect_ok(env.send(&[env.set_asset_ix(&a, &sol, AssetParams { group: GROUP_STOCK, ..base })], &[&admin]));
    assert_eq!(sol_asset(&env).params.group, GROUP_SOL);
    // A stricter oracle limit waits too, since it could stop liquidations at once
    expect_ok(env.send(&[env.set_asset_ix(&a, &sol, AssetParams { max_conf_bps: 1, max_price_age_secs: 1, ..base })], &[&admin]));
    assert_eq!((sol_asset(&env).params.max_conf_bps, sol_asset(&env).pending.max_conf_bps), (base.max_conf_bps, 1));
    // The guardian's guard pauses the asset and drops the waiting change, a stranger's does nothing
    expect_err(env.send(&[env.guard_asset_ix(&stranger.pubkey(), &sol)], &[&stranger]), PluribusError::NotGuardian);
    expect_ok(env.send(&[env.guard_asset_ix(&g, &sol)], &[&guardian]));
    assert!(sol_asset(&env).params.paused && sol_asset(&env).pending_at == 0);

    // LP markets: a higher cost is immediate, a lower one waits
    let whirlpool = env.whirlpool;
    let market = |env: &Env| -> LpMarket { env.load(&env.lp_market_pda(&whirlpool)) };
    expect_ok(env.send(&[env.set_lp_market_ix(&whirlpool, 600, false)], &[&admin]));
    assert_eq!(market(&env).liq_cost_bps, 600);
    expect_ok(env.send(&[env.set_lp_market_ix(&whirlpool, 500, false)], &[&admin]));
    assert_eq!((market(&env).liq_cost_bps, market(&env).pending_liq_cost_bps), (600, 500));
    env.warp(activation());
    expect_ok(env.send(&[env.apply_lp_market_ix(&whirlpool)], &[&stranger]));
    assert_eq!(market(&env).liq_cost_bps, 500);
    expect_ok(env.send(&[env.guard_lp_market_ix(&g, &whirlpool)], &[&guardian]));
    assert!(market(&env).paused);
}

#[test]
fn a_pause_holds_back_waiting_changes_and_listings_until_juniors_have_had_a_full_delay_to_leave() {
    let mut env = Env::timed();
    open_junior(&mut env);
    lend(&mut env, 9_000 * USDC, false);
    let junior = lend(&mut env, 1_000 * USDC, true);
    let (j, usdc, junior_mint) = (junior.pubkey(), env.usdc, env.junior_mint());
    let admin = env.admin.insecure_clone();
    let a = admin.pubkey();
    let stranger = env.wallet();

    // The admin queues looser shocks and a listing, and a junior queues an exit
    let mut looser = timed_params();
    looser.init_shock_bps[0] = 2_500;
    expect_ok(env.send(&[env.set_params_ix(&a, looser)], &[&admin]));
    let token = env.new_mint(6, &TOKEN);
    expect_ok(env.send(&[env.init_asset_ix(&token, asset_params(GROUP_STOCK, ORACLE_PYTH, STOCK_FEED, 1000))], &[&admin]));
    expect_ok(env.send(&[env.request_exit_ix(&j, env.balance(&junior_mint, &j))], &[&junior]));
    // Then pauses exits for a month
    expect_ok(env.send(&[env.pause_exits_ix(&a, 30 * DAY as u32)], &[&admin]));

    // A week on neither the change nor the listing goes live while juniors cannot leave
    env.warp(7 * DAY);
    env.set_price(&token, 100 * USDC);
    let user = env.user();
    env.fund(&token, &user.pubkey(), 10 * STOCK);
    expect_err(env.send(&[env.apply_params_ix()], &[&stranger]), PluribusError::ChangeNotDue);
    expect_err(env.send(&[env.deposit_token_ix(&user.pubkey(), &token, 10 * STOCK)], &[&user]), PluribusError::NotYetActive);

    // Once the pause ends the junior can claim, and the change still waits a full delay
    env.warp(23 * DAY);
    expect_ok(env.send(&[env.claim_exit_ix(&j, &usdc)], &[&junior]));
    env.warp(activation() - 1);
    expect_err(env.send(&[env.apply_params_ix()], &[&stranger]), PluribusError::ChangeNotDue);
    env.warp(1);
    expect_ok(env.send(&[env.apply_params_ix()], &[&stranger]));
    env.set_price(&token, 100 * USDC);
    expect_ok(env.send(&[env.deposit_token_ix(&user.pubkey(), &token, 10 * STOCK)], &[&user]));
}

#[test]
fn a_junior_who_queues_when_a_change_is_announced_can_claim_before_it_applies() {
    let mut env = Env::timed();
    open_junior(&mut env);
    lend(&mut env, 9_000 * USDC, false);
    let junior = lend(&mut env, 1_000 * USDC, true);
    let (j, usdc, junior_mint) = (junior.pubkey(), env.usdc, env.junior_mint());
    let admin = env.admin.insecure_clone();
    let a = admin.pubkey();
    let mut looser = timed_params();
    looser.init_shock_bps[0] = 2_500;
    expect_ok(env.send(&[env.set_params_ix(&a, looser)], &[&admin]));
    expect_ok(env.send(&[env.request_exit_ix(&j, env.balance(&junior_mint, &j))], &[&junior]));
    // The wait ends a full claim window before the change can apply, so applying it and pausing at once traps nobody
    env.warp(6 * DAY);
    expect_err(env.send(&[env.apply_params_ix()], &[&admin]), PluribusError::ChangeNotDue);
    expect_ok(env.send(&[env.claim_exit_ix(&j, &usdc)], &[&junior]));
    env.warp(activation() - 6 * DAY);
    expect_ok(env.send(&[env.apply_params_ix(), env.pause_exits_ix(&a, 90 * DAY as u32)], &[&admin]));
}

#[test]
fn a_cut_to_the_pause_gap_cannot_bring_the_next_pause_forward() {
    let mut env = Env::timed();
    open_junior(&mut env);
    let admin = env.admin.insecure_clone();
    let a = admin.pubkey();
    expect_ok(env.send(&[env.pause_exits_ix(&a, 30 * DAY as u32)], &[&admin]));
    // The shortest gap the rules allow, queued during the pause, applies a full delay after it ends
    let shorter = PoolParams { junior_pause_gap_secs: 9 * DAY as u32, ..timed_params() };
    expect_ok(env.send(&[env.set_params_ix(&a, shorter)], &[&admin]));
    env.warp(30 * DAY + activation());
    expect_ok(env.send(&[env.apply_params_ix()], &[&admin]));
    assert_eq!(env.pool_state().params.junior_pause_gap_secs, 9 * DAY as u32);
    // The next pause still waits for the two-week gap fixed when the first one began
    env.warp(14 * DAY - activation() - 1);
    expect_err(env.send(&[env.pause_exits_ix(&a, DAY as u32)], &[&admin]), PluribusError::PauseNotAllowed);
    env.warp(1);
    expect_ok(env.send(&[env.pause_exits_ix(&a, DAY as u32)], &[&admin]));
}

#[test]
fn a_longer_gap_that_applies_later_holds_back_the_next_pause_too() {
    let mut env = Env::timed();
    open_junior(&mut env);
    let admin = env.admin.insecure_clone();
    let a = admin.pubkey();
    let longer = PoolParams { junior_pause_gap_secs: 20 * DAY as u32, ..timed_params() };
    expect_ok(env.send(&[env.set_params_ix(&a, longer)], &[&admin]));
    expect_ok(env.send(&[env.pause_exits_ix(&a, DAY as u32)], &[&admin]));
    let end = env.pool_state().junior_pause_end;
    env.warp(DAY + activation());
    expect_ok(env.send(&[env.apply_params_ix()], &[&admin]));
    // The two-week gap fixed at the pause no longer decides, the twenty-day one now in force does
    let wait = end + 14 * DAY - env.now();
    env.warp(wait);
    expect_err(env.send(&[env.pause_exits_ix(&a, DAY as u32)], &[&admin]), PluribusError::PauseNotAllowed);
    env.warp(6 * DAY);
    expect_ok(env.send(&[env.pause_exits_ix(&a, DAY as u32)], &[&admin]));
}

#[test]
fn with_no_activation_delay_nothing_loosens_while_exits_are_paused() {
    let mut env = Env::new();
    open_junior(&mut env);
    let admin = env.admin.insecure_clone();
    let a = admin.pubkey();
    expect_ok(env.send(&[env.pause_exits_ix(&a, 10 * DAY as u32)], &[&admin]));
    let mut looser = default_params();
    looser.init_shock_bps[0] = 2_500;
    expect_ok(env.send(&[env.set_params_ix(&a, looser)], &[&admin]));
    assert_eq!(env.pool_state().params, default_params());
    expect_err(env.send(&[env.apply_params_ix()], &[&admin]), PluribusError::ChangeNotDue);
    let sol = env.sol;
    let sol_params = env.load::<Asset>(&env.asset_pda(&sol)).params;
    expect_ok(env.send(&[env.set_asset_ix(&a, &sol, AssetParams { liq_cost_bps: 480, ..sol_params })], &[&admin]));
    assert_eq!(env.load::<Asset>(&env.asset_pda(&sol)).params.liq_cost_bps, sol_params.liq_cost_bps);
    expect_ok(env.send(&[env.unpause_exits_ix(&a)], &[&admin]));
    expect_ok(env.send(&[env.apply_params_ix(), env.apply_asset_ix(&sol)], &[&admin]));
    assert_eq!(env.pool_state().params, looser);
}

#[test]
fn an_lp_of_a_paused_or_waiting_base_token_takes_no_deposits() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let (sol, whirlpool) = (env.sol, env.whirlpool);
    let user = env.user();
    let sol_params = env.load::<Asset>(&env.asset_pda(&sol)).params;
    expect_ok(env.send(&[env.set_asset_ix(&admin.pubkey(), &sol, AssetParams { paused: true, ..sol_params })], &[&admin]));
    let nft = env.lp(&user.pubkey(), &whirlpool, 120.0, 180.0, liquidity_for(1_000, 120.0, 180.0, 150), &TOKEN);
    expect_err(env.send(&[env.deposit_lp_ix(&user.pubkey(), &whirlpool, &nft)], &[&user]), PluribusError::Paused);
    expect_ok(env.send(&[env.set_asset_ix(&admin.pubkey(), &sol, sol_params)], &[&admin]));
    expect_ok(env.send(&[env.deposit_lp_ix(&user.pubkey(), &whirlpool, &nft)], &[&user]));
}

#[test]
fn a_lone_junior_who_cancels_leaves_the_queued_yield_to_the_insurance_reserve() {
    let mut env = Env::timed();
    open_junior(&mut env);
    lend(&mut env, 9_000 * USDC, false);
    let junior = lend(&mut env, 1_000 * USDC, true);
    borrow(&mut env, 1_000 * SOL, 5_000 * USDC);
    let (j, junior_mint) = (junior.pubkey(), env.junior_mint());
    let held = env.balance(&junior_mint, &j);
    expect_ok(env.send(&[env.request_exit_ix(&j, held)], &[&junior]));
    let queued = exit(&env, &j).value;
    pass(&mut env, 30 * DAY);
    let before = env.pool_state();
    let current = before.value_of(true, supply(&env, &junior_mint), held).unwrap();
    expect_ok(env.send(&[env.cancel_exit_ix(&j, &j)], &[&junior]));
    let after = env.pool_state();
    // Every share comes back, worth what was queued but for the virtual share's thousandth of the yield,
    // and the yield went to the reserve rather than to nobody
    assert_eq!(env.balance(&junior_mint, &j), held);
    let worth = after.value_of(true, supply(&env, &junior_mint), held).unwrap();
    assert!(worth >= queued && worth - queued <= (current - queued) / 1_000 + 1, "worth {worth}, queued {queued}, was {current}");
    assert!(after.reserves > before.reserves);
    assert_eq!(after.reserves - before.reserves, before.junior_assets - after.junior_assets);
}

#[test]
fn settings_that_could_trap_junior_money_are_rejected() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let p = timed_params();
    let day = DAY as u32;
    let bad = [
        ("activation delay shorter than the longest exit wait", PoolParams { activation_delay_secs: 6 * day - 1, ..p }),
        ("activation delay shorter than the longest wait plus the claim window", PoolParams { activation_delay_secs: 8 * day - 1, ..p }),
        ("activation delay above thirty days", PoolParams { activation_delay_secs: 30 * day + 1, ..p }),
        ("pause above the ninety day cap", PoolParams { junior_max_pause_secs: 90 * day + 1, ..p }),
        ("pause gap shorter than the longest wait plus the longest claim window", PoolParams { junior_pause_gap_secs: 9 * day - 1, ..p }),
        ("pause gap shorter than the activation delay", PoolParams { activation_delay_secs: 12 * day, junior_pause_gap_secs: 12 * day - 1, ..p }),
        ("claim window under a minute", PoolParams { junior_exit_window_secs: 59, ..p }),
        ("claim window over three days", PoolParams { junior_exit_window_secs: 3 * day + 1, ..p }),
        ("a queue whose shortest wait is zero", PoolParams { junior_min_delay_secs: 0, ..p }),
        ("exit fee above one percent", PoolParams { junior_exit_fee_bps: 101, ..p }),
        ("shortest wait above the longest", PoolParams { junior_min_delay_secs: 7 * day, ..p }),
        ("wait above thirty days", PoolParams { junior_max_delay_secs: 31 * day, junior_pause_gap_secs: 40 * day, activation_delay_secs: 30 * day, ..p }),
        ("junior target under one percent", PoolParams { junior_target_bps: 99, ..p }),
        ("premium above half the senior yield", PoolParams { junior_premium_bps: 5_001, ..p }),
        ("margin holding back more than half the buffer", PoolParams { yield_margin_bps: 5_001, ..p }),
        ("epoch under a minute", PoolParams { epoch_secs: 59, ..p }),
        ("epoch over thirty days", PoolParams { epoch_secs: 30 * day + 1, ..p }),
        ("delay threshold of zero", PoolParams { junior_delay_threshold_bps: 0, ..p }),
    ];
    for (name, params) in bad {
        assert!(failed_with(&env.send(&[env.set_params_ix(&admin.pubkey(), params)], &[&admin]), PluribusError::InvalidParams), "{name}");
    }
    expect_ok(env.send(&[env.set_params_ix(&admin.pubkey(), p)], &[&admin]));
}

#[test]
fn share_tokens_of_the_pool_can_never_be_listed_as_collateral() {
    let mut env = Env::new();
    open_junior(&mut env);
    let admin = env.admin.insecure_clone();
    for mint in [env.share_mint, env.junior_mint()] {
        expect_err(
            env.send(&[env.init_asset_ix(&mint, asset_params(GROUP_STOCK, ORACLE_PYTH, STOCK_FEED, 1000))], &[&admin]),
            PluribusError::ShareMintNotCollateral,
        );
    }
}

// The junior premium

#[test]
fn juniors_earn_the_senior_rate_times_one_plus_the_premium_per_senior_dollar_scaled_below_the_target() {
    for (senior_usdc, junior_usdc) in [(9_000u64, 1_000u64), (9_999, 1)] {
        let mut env = Env::with(PoolParams { junior_premium_bps: 1_500, ..default_params() }, true);
        open_junior(&mut env);
        lend(&mut env, senior_usdc * USDC, false);
        lend(&mut env, junior_usdc * USDC, true);
        borrow(&mut env, 1_000 * SOL, 5_000 * USDC);
        let before = env.pool_state();
        pass(&mut env, YEAR);
        let after = env.pool_state();
        // Everything lenders earned, split senior : junior as S : J + 15% x filled x S
        let to_lenders = (after.lender_assets().unwrap() - before.lender_assets().unwrap()) as f64;
        let (senior, junior) = ((senior_usdc * USDC) as f64, (junior_usdc * USDC) as f64);
        let filled = (junior / ((senior + junior) * 0.1)).min(1.0);
        let junior_weight = junior + 0.15 * filled * senior;
        let want = to_lenders * junior_weight / (senior + junior_weight);
        let junior_gain = (after.junior_assets - before.junior_assets) as f64;
        assert!(near(junior_gain, want, 1e-4), "{junior_usdc}: junior gained {junior_gain}, expected {want}");
        assert_eq!(after.tranche_assets(false).unwrap() + after.tranche_assets(true).unwrap(), after.lender_assets().unwrap());
    }
}
