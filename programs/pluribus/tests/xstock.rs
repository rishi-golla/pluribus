mod common;

use {
    anchor_lang::{prelude::Pubkey, solana_program::program_pack::Pack},
    anchor_spl::token::spl_token::state::Mint as MintState,
    common::*,
    pluribus::{constants::*, error::PluribusError, state::*},
    solana_signer::Signer,
};

// Token-2022 extension types and the value layouts the program reads
const TRANSFER_FEE: u16 = 1;
const DEFAULT_ACCOUNT_STATE: u16 = 6;
const INTEREST_BEARING: u16 = 10;
const PERMANENT_DELEGATE: u16 = 12;
const TRANSFER_HOOK: u16 = 14;
const METADATA_POINTER: u16 = 18;
const SCALED_UI_AMOUNT: u16 = 25;
const PAUSABLE: u16 = 26;
const SHARE: u64 = 100_000_000;

struct Xstock {
    multiplier: f64,
    new_multiplier: f64,
    switch_at: i64,
    paused: bool,
    hook: Option<Pubkey>,
    extra: Vec<(u16, Vec<u8>)>,
    default_state: u8,
}

impl Default for Xstock {
    fn default() -> Self {
        Xstock { multiplier: 1.0, new_multiplier: 1.0, switch_at: 0, paused: false, hook: None, extra: vec![], default_state: 1 }
    }
}

/// A Token-2022 mint laid out like Backed's xStocks: delegate, pause, multiplier, null hook, metadata pointer
fn mint_bytes(x: &Xstock) -> Vec<u8> {
    let issuer = Pubkey::new_unique();
    let state = MintState { mint_authority: None.into(), supply: u64::MAX / 2, decimals: 8, is_initialized: true, freeze_authority: None.into() };
    let mut data = vec![0u8; MintState::LEN];
    MintState::pack(state, &mut data).unwrap();
    data.resize(165, 0);
    data.push(1);
    let mut ext = |kind: u16, value: Vec<u8>| {
        data.extend(kind.to_le_bytes());
        data.extend((value.len() as u16).to_le_bytes());
        data.extend(value);
    };
    ext(PERMANENT_DELEGATE, issuer.to_bytes().to_vec());
    ext(PAUSABLE, [issuer.to_bytes().to_vec(), vec![x.paused as u8]].concat());
    let scaled = [issuer.to_bytes().to_vec(), x.multiplier.to_le_bytes().to_vec(), x.switch_at.to_le_bytes().to_vec(), x.new_multiplier.to_le_bytes().to_vec()];
    ext(SCALED_UI_AMOUNT, scaled.concat());
    ext(TRANSFER_HOOK, [issuer.to_bytes().to_vec(), x.hook.unwrap_or_default().to_bytes().to_vec()].concat());
    ext(DEFAULT_ACCOUNT_STATE, vec![x.default_state]);
    ext(METADATA_POINTER, [issuer.to_bytes(), Pubkey::new_unique().to_bytes()].concat());
    for (kind, value) in &x.extra {
        ext(*kind, value.clone());
    }
    data
}

fn xstock_params() -> AssetParams {
    // A weekend plus a day of the last price still counts for liquidations
    AssetParams {
        ui_multiplier: true,
        liq_price_age_secs: 4 * DAY as u32,
        vol_horizon_secs: 3 * DAY as u32,
        jump_hold_secs: 3_600,
        ..asset_params(GROUP_STOCK, ORACLE_PYTH, STOCK_FEED, 1000)
    }
}

/// Lists an xStock priced at `price` dollars a share
fn list(env: &mut Env, x: &Xstock, price: u64) -> Pubkey {
    let mint = Pubkey::new_unique();
    env.set_raw(mint, TOKEN_2022, mint_bytes(x));
    let admin = env.admin.insecure_clone();
    expect_ok(env.send(&[env.init_asset_ix(&mint, xstock_params())], &[&admin]));
    env.set_price(&mint, price * USDC);
    mint
}

/// Sets what the vault really holds and whether it is frozen, as the issuer's delegate or freeze authority could
fn set_vault(env: &mut Env, mint: &Pubkey, held: u64, frozen: bool) {
    let vault = env.vault_pda(mint);
    let mut data = env.svm.get_account(&vault).unwrap().data;
    data[64..72].copy_from_slice(&held.to_le_bytes());
    data[108] = if frozen { 2 } else { 1 };
    env.set_raw(vault, TOKEN_2022, data);
}

fn vault_held(env: &Env, mint: &Pubkey) -> u64 {
    let data = env.svm.get_account(&env.vault_pda(mint)).unwrap().data;
    u64::from_le_bytes(data[64..72].try_into().unwrap())
}

/// A multiplier the issuer applied at once: Token-2022 then keeps the same old and new multiplier
fn applied_now(env: &Env, m: f64) -> Xstock {
    Xstock { multiplier: m, new_multiplier: m, switch_at: env.now() - 1, ..Default::default() }
}

fn rewrite(env: &mut Env, mint: &Pubkey, x: &Xstock) {
    env.set_raw(*mint, TOKEN_2022, mint_bytes(x));
}

#[test]
fn an_xstock_lists_with_its_issuer_controls_and_a_mint_with_anything_else_does_not() {
    let mut env = Env::new();
    let mint = list(&mut env, &Xstock::default(), 100);
    let asset: Asset = env.load(&env.asset_pda(&mint));
    assert_eq!(asset.token_program, TOKEN_2022);
    let admin = env.admin.insecure_clone();
    let refused = [
        ("a transfer fee", Xstock { extra: vec![(TRANSFER_FEE, vec![0; 108])], ..Default::default() }),
        ("interest", Xstock { extra: vec![(INTEREST_BEARING, vec![0; 52])], ..Default::default() }),
        ("a live transfer hook", Xstock { hook: Some(Pubkey::new_unique()), ..Default::default() }),
        ("frozen new accounts", Xstock { default_state: 2, ..Default::default() }),
    ];
    for (name, x) in refused {
        let other = Pubkey::new_unique();
        env.set_raw(other, TOKEN_2022, mint_bytes(&x));
        expect_err(env.send(&[env.init_asset_ix(&other, xstock_params())], &[&admin]), PluribusError::UnsupportedMint);
        let _ = name;
    }
}

#[test]
fn an_xstock_is_worth_its_share_price_times_the_multiplier_in_force() {
    let mut env = Env::new();
    let now = env.now();
    // A 2-for-1 split scheduled a day out: balances double then and the share price halves
    let x = Xstock { multiplier: 1.05, new_multiplier: 2.1, switch_at: now + DAY, ..Default::default() };
    let mint = list(&mut env, &x, 200);
    // A volatility sample is what tells the two bases apart around the change
    let keeper = env.wallet();
    expect_ok(env.send(&[env.update_vol_ix(&mint)], &[&keeper]));
    let user = env.user();
    env.deposit(&user, &mint, 10 * SHARE);
    let value = |env: &mut Env| env.health(&user.pubkey()).position_value[0] as f64 / USDC as f64;
    assert!((value(&mut env) / (10.0 * 200.0 * 1.05) - 1.0).abs() < 1e-6);
    env.warp(DAY);
    env.set_price(&mint, 100 * USDC);
    assert!((value(&mut env) / (10.0 * 100.0 * 2.1) - 1.0).abs() < 1e-6);
}

#[test]
fn a_paused_or_hooked_xstock_backs_no_new_debt_but_still_counts_toward_the_liquidation_line() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    let mint = list(&mut env, &Xstock::default(), 100);
    let user = env.user();
    env.deposit(&user, &mint, 10 * SHARE);
    let sol = env.sol;
    env.deposit(&user, &sol, SOL);
    let before = env.health(&user.pubkey());
    for halted in [Xstock { paused: true, ..Default::default() }, Xstock { hook: Some(Pubkey::new_unique()), ..Default::default() }] {
        rewrite(&mut env, &mint, &halted);
        let h = env.health(&user.pubkey());
        assert!(h.credit_limit < before.credit_limit / 2, "limit {} from {}", h.credit_limit, before.credit_limit);
        assert_eq!(h.liquidation_limit, before.liquidation_limit);
    }
    // A paused mint moves nothing, so deposits stop too
    rewrite(&mut env, &mint, &Xstock { paused: true, ..Default::default() });
    env.fund(&mint, &user.pubkey(), SHARE);
    assert!(env.send(&[env.deposit_token_ix(&user.pubkey(), &mint, SHARE)], &[&user]).is_err());
}

#[test]
fn after_hours_the_last_price_still_liquidates_but_backs_no_new_debt() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    let mint = list(&mut env, &Xstock::default(), 100);
    let user = env.user();
    env.deposit(&user, &mint, 10 * SHARE);
    expect_ok(env.draw(&user, 500 * USDC));
    // The market closes with the stock down hard: Friday's last price is all there is until Monday
    env.set_price(&mint, 40 * USDC);
    env.warp(2 * DAY);
    let sol = env.sol;
    env.set_price(&sol, 150 * USDC);
    // A price too old for draws backs nothing, which leaves this account no credit at all
    expect_err(env.draw(&user, USDC), PluribusError::ExceedsCreditLimit);
    let h = env.health(&user.pubkey());
    assert_eq!(h.credit_limit, 0);
    assert!(h.debt > h.liquidation_limit);
    let liquidator = env.wallet();
    let usdc = env.usdc;
    env.fund(&usdc, &liquidator.pubkey(), 1_000 * USDC);
    env.fund(&mint, &liquidator.pubkey(), 0);
    expect_ok(env.send(&[env.liquidate_ix(&liquidator.pubkey(), &user.pubkey(), &mint, u64::MAX)], &[&liquidator]));
    assert!(env.balance(&mint, &liquidator.pubkey()) > 0);
    // Past the liquidation age nothing counts
    env.warp(3 * DAY);
    env.set_price(&sol, 150 * USDC);
    expect_err(env.send(&[env.liquidate_ix(&liquidator.pubkey(), &user.pubkey(), &mint, u64::MAX)], &[&liquidator]), PluribusError::StalePrice);
}

#[test]
fn a_price_from_before_a_split_keeps_the_old_multiplier_and_one_near_the_split_backs_no_new_debt() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    let now = env.now();
    // A 2-for-1 split applies a day out, but the feed's last price is Friday's until the market opens again
    let x = Xstock { multiplier: 1.0, new_multiplier: 2.0, switch_at: now + DAY, ..Default::default() };
    let mint = list(&mut env, &x, 200);
    let user = env.user();
    env.deposit(&user, &mint, 10 * SHARE);
    let before = env.health(&user.pubkey());
    env.warp(2 * DAY);
    // Friday's $200 a share still goes with one token per share, not with the split's two
    let h = env.health(&user.pubkey());
    assert_eq!(h.position_value[0], before.position_value[0]);
    // Monday's $100 goes with two tokens per share
    env.set_price(&mint, 100 * USDC);
    let h = env.health(&user.pubkey());
    assert!((h.position_value[0] as f64 / before.position_value[0] as f64 - 1.0).abs() < 1e-6);
    assert!(h.credit_limit > 0);
    // A price published within the guard of a change might be on either basis: it takes the larger multiplier for
    // the liquidation line, so no one is liquidated over the mix-up, and backs no new debt
    let soon = Xstock { multiplier: 2.0, new_multiplier: 1.0, switch_at: env.now() + 600, ..Default::default() };
    rewrite(&mut env, &mint, &soon);
    let h = env.health(&user.pubkey());
    assert_eq!(h.credit_limit, 0);
    assert!(h.liquidation_limit > 0);
    expect_err(env.draw(&user, USDC), PluribusError::ExceedsCreditLimit);
}

#[test]
fn a_split_restarts_the_volatility_measure_instead_of_reading_as_a_crash() {
    let mut env = Env::new();
    let now = env.now();
    let x = Xstock { multiplier: 1.0, new_multiplier: 2.0, switch_at: now + DAY, ..Default::default() };
    let mint = list(&mut env, &x, 200);
    let keeper = env.wallet();
    expect_ok(env.send(&[env.update_vol_ix(&mint)], &[&keeper]));
    let before: Asset = env.load(&env.asset_pda(&mint));
    env.warp(2 * DAY);
    env.set_price(&mint, 100 * USDC);
    expect_ok(env.send(&[env.update_vol_ix(&mint)], &[&keeper]));
    let after: Asset = env.load(&env.asset_pda(&mint));
    // The halved share price times the doubled multiplier is the same token price, and nothing was folded in
    assert_eq!(after.vol_price, before.vol_price);
    assert_eq!((after.var_fast, after.var_slow), (before.var_fast, before.var_slow));
    // A real move after it is measured as usual
    env.warp(DAY);
    env.set_price(&mint, 80 * USDC);
    expect_ok(env.send(&[env.update_vol_ix(&mint)], &[&keeper]));
    let moved: Asset = env.load(&env.asset_pda(&mint));
    assert!(moved.var_fast > after.var_fast);
    // Without the mint the sample is refused
    let mut ix = env.update_vol_ix(&mint);
    ix.accounts.truncate(3);
    env.warp(DAY);
    env.set_price(&mint, 80 * USDC);
    expect_err(env.send(&[ix], &[&keeper]), PluribusError::MissingAccount);
}

#[test]
fn a_multiplier_applied_at_once_never_reprices_a_price_from_before_it() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    let mint = list(&mut env, &Xstock::default(), 100);
    let keeper = env.wallet();
    expect_ok(env.send(&[env.update_vol_ix(&mint)], &[&keeper]));
    let user = env.user();
    let me = user.pubkey();
    env.deposit(&user, &mint, 10 * SHARE);
    let limit = env.health(&me).credit_limit;
    expect_ok(env.draw(&user, limit));
    // A 1-for-10 reverse split applied at once, while the last price is still the $100 from before it
    env.warp(600);
    let x = applied_now(&env, 0.1);
    rewrite(&mut env, &mint, &x);
    let h = env.health(&me);
    assert_eq!(h.credit_limit, 0);
    assert!((h.position_value[0] as f64 / (1_000.0 * USDC as f64) - 1.0).abs() < 1e-6, "value {}", h.position_value[0]);
    assert!(h.debt <= h.liquidation_limit);
    let liquidator = env.wallet();
    let usdc = env.usdc;
    env.fund(&usdc, &liquidator.pubkey(), 1_000 * USDC);
    env.fund(&mint, &liquidator.pubkey(), 0);
    expect_err(env.send(&[env.liquidate_ix(&liquidator.pubkey(), &me, &mint, u64::MAX)], &[&liquidator]), PluribusError::NotLiquidatable);
    // Anyone records the change, dated when first seen, and a price an hour after that is on the new basis for sure
    expect_ok(env.send(&[env.sync_mint_ix(&mint)], &[&keeper]));
    let asset: Asset = env.load(&env.asset_pda(&mint));
    assert_eq!((asset.mult, asset.mult_prev, asset.mult_exact), (100_000_000, 1_000_000_000, false));
    env.warp(3_600);
    env.set_price(&mint, 1_000 * USDC);
    let h = env.health(&me);
    assert!((h.position_value[0] as f64 / (1_000.0 * USDC as f64) - 1.0).abs() < 1e-6, "value {}", h.position_value[0]);
    assert!(h.credit_limit > 0);
}

#[test]
fn a_multiplier_applied_at_once_restarts_the_volatility_measure() {
    let mut env = Env::new();
    let mint = list(&mut env, &Xstock::default(), 100);
    let keeper = env.wallet();
    expect_ok(env.send(&[env.update_vol_ix(&mint)], &[&keeper]));
    let before: Asset = env.load(&env.asset_pda(&mint));
    env.warp(600);
    let x = applied_now(&env, 0.1);
    rewrite(&mut env, &mint, &x);
    env.set_price(&mint, 1_000 * USDC);
    // The crank records the new multiplier and takes no sample while the price's basis is unclear
    expect_ok(env.send(&[env.update_vol_ix(&mint)], &[&keeper]));
    let synced: Asset = env.load(&env.asset_pda(&mint));
    assert_eq!((synced.mult, synced.vol_time), (100_000_000, 0));
    assert_eq!((synced.var_fast, synced.var_slow), (before.var_fast, before.var_slow));
    // An hour on it samples again from the same $100 a token, with nothing folded in
    env.warp(3_600);
    env.set_price(&mint, 1_000 * USDC);
    expect_ok(env.send(&[env.update_vol_ix(&mint)], &[&keeper]));
    let after: Asset = env.load(&env.asset_pda(&mint));
    assert_eq!(after.vol_price, before.vol_price);
    assert_eq!((after.var_fast, after.var_slow), (before.var_fast, before.var_slow));
}

#[test]
fn near_a_split_the_basis_that_keeps_the_token_price_is_used() {
    let mut env = Env::new();
    let at = env.now() + 3 * 3_600;
    let mint = list(&mut env, &Xstock { multiplier: 1.0, new_multiplier: 2.0, switch_at: at, ..Default::default() }, 200);
    let keeper = env.wallet();
    expect_ok(env.send(&[env.update_vol_ix(&mint)], &[&keeper]));
    let user = env.user();
    env.deposit(&user, &mint, 10 * SHARE);
    let worth = 10.0 * 200.0 * USDC as f64;
    // Half an hour before the split, a price still on the old basis is not doubled
    env.warp(at - 1_800 - env.now());
    env.set_price(&mint, 200 * USDC);
    let h = env.health(&user.pubkey());
    assert!((h.position_value[0] as f64 / worth - 1.0).abs() < 1e-6, "value {}", h.position_value[0]);
    assert_eq!(h.credit_limit, 0);
    // Half an hour after it, the halved price goes with the doubled multiplier
    env.warp(3_600);
    env.set_price(&mint, 100 * USDC);
    let h = env.health(&user.pubkey());
    assert!((h.position_value[0] as f64 / worth - 1.0).abs() < 1e-6, "value {}", h.position_value[0]);
    assert_eq!(h.credit_limit, 0);
    // Past the guard it backs debt again
    env.warp(3_600);
    env.set_price(&mint, 100 * USDC);
    assert!(env.health(&user.pubkey()).credit_limit > 0);
}

#[test]
fn a_multiplier_outside_the_priced_range_halts_only_its_own_token() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    let mint = list(&mut env, &Xstock::default(), 100);
    let user = env.user();
    let me = user.pubkey();
    env.deposit(&user, &mint, 10 * SHARE);
    let sol = env.sol;
    env.deposit(&user, &sol, 10 * SOL);
    let full = env.health(&me).credit_limit;
    // A tiny multiplier scheduled a year out changes nothing today
    let later = Xstock { multiplier: 1.0, new_multiplier: 1e-5, switch_at: env.now() + 365 * DAY, ..Default::default() };
    rewrite(&mut env, &mint, &later);
    assert_eq!(env.health(&me).credit_limit, full);
    // Once in effect the token backs no new debt, and the rest of the account still values, withdraws and draws
    let x = applied_now(&env, 1e-5);
    rewrite(&mut env, &mint, &x);
    let h = env.health(&me);
    assert!(h.credit_limit > 0 && h.credit_limit < full);
    expect_ok(env.send(&[env.withdraw_token_ix(&me, &sol, SOL)], &[&user]));
    expect_ok(env.draw(&user, USDC));
}

#[test]
fn a_vault_short_of_its_books_pays_out_pro_rata_and_takes_no_deposits() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    let mint = list(&mut env, &Xstock::default(), 100);
    let (a, b) = (env.user(), env.user());
    env.deposit(&a, &mint, 10 * SHARE);
    env.deposit(&b, &mint, 10 * SHARE);
    expect_ok(env.draw(&a, 300 * USDC));
    // A frozen vault backs no new debt
    set_vault(&mut env, &mint, 20 * SHARE, true);
    assert_eq!(env.health(&b.pubkey()).credit_limit, 0);
    // The issuer's delegate takes three quarters of the vault
    set_vault(&mut env, &mint, 5 * SHARE, false);
    let h = env.health(&a.pubkey());
    assert_eq!(h.credit_limit, 0);
    assert!((h.position_value[0] as f64 / (250.0 * USDC as f64) - 1.0).abs() < 1e-6, "value {}", h.position_value[0]);
    env.fund(&mint, &b.pubkey(), SHARE);
    expect_err(env.send(&[env.deposit_token_ix(&b.pubkey(), &mint, SHARE)], &[&b]), PluribusError::VaultShort);
    // B has no debt and leaves with a quarter of what was booked, so the loss is shared, not left to the last to leave
    let before = env.balance(&mint, &b.pubkey());
    expect_ok(env.send(&[env.withdraw_token_ix(&b.pubkey(), &mint, 10 * SHARE)], &[&b]));
    assert_eq!(env.balance(&mint, &b.pubkey()) - before, 10 * SHARE / 4);
    // A is worth $250 against $300 owed and is liquidated for real tokens at the same rate
    let liquidator = env.wallet();
    let usdc = env.usdc;
    env.fund(&usdc, &liquidator.pubkey(), 1_000 * USDC);
    env.fund(&mint, &liquidator.pubkey(), 0);
    expect_ok(env.send(&[env.liquidate_ix(&liquidator.pubkey(), &a.pubkey(), &mint, u64::MAX)], &[&liquidator]));
    assert!(env.balance(&mint, &liquidator.pubkey()) > 0);
    let asset: Asset = env.load(&env.asset_pda(&mint));
    let ratio = vault_held(&env, &mint) as f64 / asset.total_deposited as f64;
    assert!((ratio - 0.25).abs() < 1e-6, "vault over books {ratio}");
}

#[test]
fn an_after_hours_price_blocks_nothing_the_other_collateral_covers() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    let mint = list(&mut env, &Xstock::default(), 100);
    let user = env.user();
    let me = user.pubkey();
    env.deposit(&user, &mint, 10 * SHARE);
    let sol = env.sol;
    env.deposit(&user, &sol, 10 * SOL);
    expect_ok(env.draw(&user, 100 * USDC));
    env.warp(2 * DAY);
    env.set_price(&sol, 150 * USDC);
    // Friday's stock price backs nothing new, but SOL still covers a withdrawal and a draw
    expect_ok(env.send(&[env.withdraw_token_ix(&me, &sol, SOL)], &[&user]));
    expect_ok(env.draw(&user, USDC));
}

#[test]
fn a_price_from_before_the_last_two_multiplier_changes_takes_the_lowest_basis_and_blocks_nothing_else() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    let mint = list(&mut env, &Xstock::default(), 100);
    let keeper = env.wallet();
    let user = env.user();
    let me = user.pubkey();
    env.deposit(&user, &mint, 10 * SHARE);
    let sol = env.sol;
    env.deposit(&user, &sol, 10 * SOL);
    expect_ok(env.draw(&user, 100 * USDC));
    // Two changes applied at once, each seen soon after, while the last price stays the one from before both
    for m in [0.1, 0.101] {
        env.warp(2 * 3_600);
        let x = applied_now(&env, m);
        rewrite(&mut env, &mint, &x);
        expect_ok(env.send(&[env.sync_mint_ix(&mint)], &[&keeper]));
    }
    let asset: Asset = env.load(&env.asset_pda(&mint));
    assert!(asset.mult_prev_since > 0 && asset.mult_since > asset.mult_prev_since);
    // That price can't be placed on a known basis: the token counts at the lowest it could be on and backs nothing new,
    // while the rest of the account still values, withdraws and draws
    env.set_price(&sol, 150 * USDC);
    let h = env.health(&me);
    assert!((h.position_value[0] as f64 / (10.0 * 100.0 * 0.1 * USDC as f64) - 1.0).abs() < 1e-6, "value {}", h.position_value[0]);
    expect_ok(env.send(&[env.withdraw_token_ix(&me, &sol, SOL)], &[&user]));
    expect_ok(env.draw(&user, USDC));
    // A new price an hour after the last change is on the new basis
    env.warp(3_600);
    env.set_price(&mint, 990 * USDC);
    env.set_price(&sol, 150 * USDC);
    let h = env.health(&me);
    assert!((h.position_value[0] as f64 / (10.0 * 990.0 * 0.101 * USDC as f64) - 1.0).abs() < 1e-6, "value {}", h.position_value[0]);
}

#[test]
fn a_feed_that_reprices_before_the_mint_backs_no_new_debt_and_is_not_sampled() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    let mint = list(&mut env, &Xstock::default(), 100);
    let keeper = env.wallet();
    expect_ok(env.send(&[env.update_vol_ix(&mint)], &[&keeper]));
    let before: Asset = env.load(&env.asset_pda(&mint));
    let user = env.user();
    let me = user.pubkey();
    env.deposit(&user, &mint, 10 * SHARE);
    let worth = 1_000.0 * USDC as f64;
    // The feed moves to $1000 a share for a 1-for-10 reverse split two minutes before the issuer applies it
    env.warp(120);
    env.set_price(&mint, 1_000 * USDC);
    let h = env.health(&me);
    assert_eq!(h.credit_limit, 0);
    assert!((h.position_value[0] as f64 / worth - 1.0).abs() < 1e-6, "value {}", h.position_value[0]);
    expect_err(env.draw(&user, USDC), PluribusError::ExceedsCreditLimit);
    // The crank notes the jump and folds nothing in
    expect_ok(env.send(&[env.update_vol_ix(&mint)], &[&keeper]));
    let noted: Asset = env.load(&env.asset_pda(&mint));
    assert_eq!(noted.jump_since, env.now());
    assert_eq!((noted.vol_price, noted.var_fast, noted.var_slow), (before.vol_price, before.var_fast, before.var_slow));
    // The issuer applies it: the crank records the multiplier, and the same price is $100 a token again
    env.warp(120);
    let x = applied_now(&env, 0.1);
    rewrite(&mut env, &mint, &x);
    env.set_price(&mint, 1_000 * USDC);
    expect_ok(env.send(&[env.update_vol_ix(&mint)], &[&keeper]));
    let synced: Asset = env.load(&env.asset_pda(&mint));
    assert_eq!((synced.mult, synced.jump_since, synced.var_fast), (100_000_000, 0, before.var_fast));
    let h = env.health(&me);
    assert!((h.position_value[0] as f64 / worth - 1.0).abs() < 1e-6, "value {}", h.position_value[0]);
}

#[test]
fn a_real_crash_shows_on_the_liquidation_line_at_once_and_the_token_is_seized_once_it_has_held() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    let mint = list(&mut env, &Xstock::default(), 100);
    let keeper = env.wallet();
    expect_ok(env.send(&[env.update_vol_ix(&mint)], &[&keeper]));
    let before: Asset = env.load(&env.asset_pda(&mint));
    let user = env.user();
    let me = user.pubkey();
    env.deposit(&user, &mint, 10 * SHARE);
    expect_ok(env.draw(&user, 500 * USDC));
    // The stock falls 60% with no corporate action: the line takes the lower price at once, but the token isn't seized
    // while the jump could still be a split the issuer has yet to apply
    env.warp(120);
    env.set_price(&mint, 40 * USDC);
    let h = env.health(&me);
    assert!((h.position_value[0] as f64 / (400.0 * USDC as f64) - 1.0).abs() < 1e-6, "value {}", h.position_value[0]);
    assert!(h.credit_limit == 0 && h.debt > h.liquidation_limit);
    let liquidator = env.wallet();
    let usdc = env.usdc;
    env.fund(&usdc, &liquidator.pubkey(), 1_000 * USDC);
    env.fund(&mint, &liquidator.pubkey(), 0);
    let liquidate = |env: &mut Env| env.send(&[env.liquidate_ix(&liquidator.pubkey(), &me, &mint, u64::MAX)], &[&liquidator]);
    expect_err(liquidate(&mut env), PluribusError::PriceUnclear);
    expect_ok(env.send(&[env.update_vol_ix(&mint)], &[&keeper]));
    // Once it has held for the asset's hold the crank folds it in as volatility, and the token can be seized
    env.warp(3_600);
    env.set_price(&mint, 40 * USDC);
    expect_ok(env.send(&[env.update_vol_ix(&mint)], &[&keeper]));
    let after: Asset = env.load(&env.asset_pda(&mint));
    assert_eq!((after.vol_price, after.jump_since), (40 * USDC, 0));
    assert!(after.var_fast > before.var_fast);
    expect_ok(liquidate(&mut env));
}

#[test]
fn a_jump_up_lifts_nothing_and_the_token_is_not_seized_at_the_old_price() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    let mint = list(&mut env, &Xstock::default(), 100);
    let keeper = env.wallet();
    expect_ok(env.send(&[env.update_vol_ix(&mint)], &[&keeper]));
    let user = env.user();
    let me = user.pubkey();
    env.deposit(&user, &mint, 10 * SHARE);
    let sol = env.sol;
    env.deposit(&user, &sol, 10 * SOL);
    let limit = env.health(&me).credit_limit;
    expect_ok(env.draw(&user, limit));
    // The stock jumps 70% as SOL crashes: the stock still counts at its last sample, and only SOL can be taken
    env.warp(120);
    env.set_price(&mint, 170 * USDC);
    env.set_price(&sol, 50 * USDC);
    let h = env.health(&me);
    assert!((h.position_value[0] as f64 / (1_000.0 * USDC as f64) - 1.0).abs() < 1e-6, "value {}", h.position_value[0]);
    assert!(h.debt > h.liquidation_limit);
    let liquidator = env.wallet();
    let usdc = env.usdc;
    env.fund(&usdc, &liquidator.pubkey(), 10_000 * USDC);
    env.fund(&mint, &liquidator.pubkey(), 0);
    env.fund(&sol, &liquidator.pubkey(), 0);
    expect_err(env.send(&[env.liquidate_ix(&liquidator.pubkey(), &me, &mint, u64::MAX)], &[&liquidator]), PluribusError::PriceUnclear);
    expect_ok(env.send(&[env.liquidate_ix(&liquidator.pubkey(), &me, &sol, u64::MAX)], &[&liquidator]));
}

#[test]
fn a_jump_counts_as_held_only_while_the_price_stays_near_it() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    let mint = list(&mut env, &Xstock::default(), 100);
    let keeper = env.wallet();
    expect_ok(env.send(&[env.update_vol_ix(&mint)], &[&keeper]));
    let user = env.user();
    let me = user.pubkey();
    env.deposit(&user, &mint, 10 * SHARE);
    let crank = |env: &mut Env| env.send(&[env.update_vol_ix(&mint)], &[&keeper]);
    // A $60 print is noted, and $100 ten seconds later ends it even though that is too soon for a sample
    env.warp(30);
    env.set_price(&mint, 60 * USDC);
    expect_ok(crank(&mut env));
    assert_eq!(env.load::<Asset>(&env.asset_pda(&mint)).jump_price, 60 * USDC);
    env.warp(10);
    env.set_price(&mint, 100 * USDC);
    expect_ok(crank(&mut env));
    assert_eq!(env.load::<Asset>(&env.asset_pda(&mint)).jump_since, 0);
    // Days later the feed moves to $1000 a share for a reverse split the mint hasn't applied: a fresh jump, held at the sample
    env.warp(2 * DAY);
    env.set_price(&mint, 1_000 * USDC);
    let h = env.health(&me);
    assert!((h.position_value[0] as f64 / (1_000.0 * USDC as f64) - 1.0).abs() < 1e-6, "value {}", h.position_value[0]);
    assert_eq!(h.credit_limit, 0);
    expect_ok(crank(&mut env));
    // A jump to somewhere else before its hold is up starts the hold again instead of inheriting it
    env.warp(3_600);
    env.set_price(&mint, 40 * USDC);
    expect_ok(crank(&mut env));
    let asset: Asset = env.load(&env.asset_pda(&mint));
    assert_eq!((asset.jump_since, asset.jump_price), (env.now(), 40 * USDC));
    assert_eq!(env.health(&me).credit_limit, 0);
}

#[test]
fn a_deeper_fall_keeps_its_hold_but_a_stale_jump_lends_none() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    let mint = list(&mut env, &Xstock::default(), 100);
    let keeper = env.wallet();
    let crank = |env: &mut Env| env.send(&[env.update_vol_ix(&mint)], &[&keeper]);
    expect_ok(crank(&mut env));
    let user = env.user();
    let me = user.pubkey();
    env.deposit(&user, &mint, 10 * SHARE);
    expect_ok(env.draw(&user, 500 * USDC));
    let liquidator = env.wallet();
    let usdc = env.usdc;
    env.fund(&usdc, &liquidator.pubkey(), 1_000 * USDC);
    env.fund(&mint, &liquidator.pubkey(), 0);
    let liquidate = |env: &mut Env| env.send(&[env.liquidate_ix(&liquidator.pubkey(), &me, &mint, u64::MAX)], &[&liquidator]);
    // A fall to $60, then further to $45 half an hour on: the same jump, so its hold runs from the first print
    env.warp(120);
    env.set_price(&mint, 60 * USDC);
    expect_ok(crank(&mut env));
    let since = env.load::<Asset>(&env.asset_pda(&mint)).jump_since;
    env.warp(1_800);
    env.set_price(&mint, 45 * USDC);
    expect_ok(crank(&mut env));
    assert_eq!(env.load::<Asset>(&env.asset_pda(&mint)).jump_since, since);
    expect_err(liquidate(&mut env), PluribusError::PriceUnclear);
    // An hour after the first print the fall has held and the stock can be seized
    env.warp(1_800);
    env.set_price(&mint, 40 * USDC);
    expect_ok(liquidate(&mut env));

    // On another listing, a jump noted and then left for longer than a hold lends nothing to a later print near it
    let other = list(&mut env, &Xstock::default(), 100);
    let crank2 = |env: &mut Env| env.send(&[env.update_vol_ix(&other)], &[&keeper]);
    expect_ok(crank2(&mut env));
    let holder = env.user();
    env.deposit(&holder, &other, 10 * SHARE);
    env.warp(120);
    env.set_price(&other, 60 * USDC);
    expect_ok(crank2(&mut env));
    env.warp(2 * 3_600);
    env.set_price(&other, 50 * USDC);
    let h = env.health(&holder.pubkey());
    assert_eq!(h.credit_limit, 0);
}

#[test]
fn an_xstock_is_never_the_base_of_an_lp_market() {
    let mut env = Env::new();
    let mint = list(&mut env, &Xstock::default(), 100);
    let pool = Pubkey::new_unique();
    let usdc = env.usdc;
    env.set_whirlpool(&pool, &mint, &usdc);
    let admin = env.admin.insecure_clone();
    expect_err(env.send(&[env.init_lp_market_ix(&pool, &mint, 1000)], &[&admin]), PluribusError::PoolNotWhitelisted);
}

#[test]
fn an_xstock_moves_only_through_token_2022_and_usdc_only_through_the_classic_program() {
    let mut env = Env::new();
    let mint = list(&mut env, &Xstock::default(), 100);
    let user = env.user();
    env.fund(&mint, &user.pubkey(), SHARE);
    let mut ix = env.deposit_token_ix(&user.pubkey(), &mint, SHARE);
    let at = ix.accounts.len() - 1;
    ix.accounts[at].pubkey = TOKEN;
    expect_err(env.send(&[ix], &[&user]), PluribusError::AccountMismatch);
    expect_ok(env.send(&[env.deposit_token_ix(&user.pubkey(), &mint, SHARE)], &[&user]));
}

#[test]
fn liquidation_ages_shorter_than_the_draw_age_are_rejected() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let stock = env.stock;
    let base: Asset = env.load(&env.asset_pda(&stock));
    let bad = AssetParams { liq_price_age_secs: 59, ..base.params };
    expect_err(env.send(&[env.set_asset_ix(&admin.pubkey(), &stock, bad)], &[&admin]), PluribusError::InvalidParams);
}
