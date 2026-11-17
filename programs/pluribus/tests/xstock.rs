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
    AssetParams { ui_multiplier: true, liq_price_age_secs: 4 * DAY as u32, ..asset_params(GROUP_STOCK, ORACLE_PYTH, STOCK_FEED, 1000) }
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
    expect_err(env.draw(&user, USDC), PluribusError::StalePrice);
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
