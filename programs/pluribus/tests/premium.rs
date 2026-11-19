mod common;

use {
    anchor_lang::{prelude::*, solana_program::instruction::Instruction},
    common::*,
    pluribus::{constants::*, error::PluribusError, state::*},
    solana_keypair::Keypair,
    solana_signer::Signer,
};

const TIERS_HALVING: [u16; TIERS] = [10_000, 5_000, 2_500];

/// A pool with both tranches, 1M senior and 100k junior, and the premium charged in full at the base tier
fn pool_with_juniors(stock_premium: u16) -> Env {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let stock = env.stock;
    expect_ok(env.send(&[env.init_junior_ix(&admin.pubkey())], &[&admin]));
    env.lender(1_000_000 * USDC);
    let junior = env.wallet();
    let (usdc, mint) = (env.usdc, env.junior_mint());
    env.fund(&usdc, &junior.pubkey(), 100_000 * USDC);
    env.fund(&mint, &junior.pubkey(), 0);
    expect_ok(env.send(&[env.tranche_ix(&junior.pubkey(), &mint, 100_000 * USDC, true)], &[&junior]));
    expect_ok(env.send(&[env.set_premium_tiers_ix(&admin.pubkey(), TIERS_HALVING)], &[&admin]));
    expect_ok(env.send(&[env.set_asset_premium_ix(&admin.pubkey(), &stock, stock_premium)], &[&admin]));
    env
}

/// A borrower with 100 stock ($20,000) drawn to $5,000, a month later, with the premium booked by a refresh
fn month_on_stock(env: &mut Env) -> Keypair {
    let stock = env.stock;
    let user = env.user();
    env.deposit(&user, &stock, 100 * STOCK);
    expect_ok(env.draw(&user, 5_000 * USDC));
    env.warp(30 * DAY);
    env.set_price(&stock, 200 * USDC);
    expect_ok(env.send(&[env.refresh_tier_ix(&user.pubkey())], &[&user]));
    user
}

#[test]
fn risky_collateral_pays_its_premium_to_junior_lenders() {
    let (mut with, mut without) = (pool_with_juniors(1_000), pool_with_juniors(0));
    let user = month_on_stock(&mut with);
    month_on_stock(&mut without);
    assert_eq!(with.credit(&user.pubkey()).premium_bps, 1_000);

    let (a, b) = (with.pool_state(), without.pool_state());
    // 10% a year on about $5,008 of debt for 30 days
    let premium = a.premium_booked;
    assert!((41_000_000..41_300_000).contains(&premium), "premium {premium}");
    assert_eq!(b.premium_booked, 0);
    // Reserves and the protocol take their 10% cuts and juniors the rest, so seniors end exactly where they would have
    assert_eq!(a.reserves - b.reserves, premium / 10);
    assert_eq!(a.protocol_fees - b.protocol_fees, premium / 10);
    assert_eq!(a.junior_assets - b.junior_assets, premium - 2 * (premium / 10));
    let senior = |p: &Pool| p.tranche_assets(false).unwrap() as i128;
    assert!((senior(&a) - senior(&b)).abs() <= 2, "seniors moved by {}", senior(&a) - senior(&b));
    // The borrower owes it as debt
    assert!(a.total_debt().unwrap() - b.total_debt().unwrap() >= premium as u128);
}

#[test]
fn the_premium_is_weighted_by_what_each_position_adds_to_the_credit_limit() {
    let mut env = pool_with_juniors(1_000);
    let (sol, stock) = (env.sol, env.stock);
    let user = env.user();
    env.deposit(&user, &sol, 100 * SOL);
    env.deposit(&user, &stock, 50 * STOCK);
    expect_ok(env.draw(&user, 1_000 * USDC));
    // The broad selloff is the worst scenario: SOL adds 15,000 x 75% x 95% = 10,687.5, the stock 10,000 x 75% x 90% = 6,750,
    // so the stock's 10% is weighted by 6,750 / 17,437.5
    assert_eq!(env.credit(&user.pubkey()).premium_bps, 387);
    assert_eq!(env.health(&user.pubkey()).premium_rate_bps, 387);
    // Nothing risky, nothing charged
    let safe = env.user();
    env.deposit(&safe, &sol, 100 * SOL);
    expect_ok(env.draw(&safe, 1_000 * USDC));
    assert_eq!(env.credit(&safe.pubkey()).premium_bps, 0);
}

#[test]
fn the_premium_fades_with_the_loyalty_tier_and_comes_back_after_a_liquidation() {
    let mut env = pool_with_juniors(1_000);
    let (stock, usdc) = (env.stock, env.usdc);
    let user = env.user();
    env.deposit(&user, &stock, 100 * STOCK);
    expect_ok(env.draw(&user, 5_000 * USDC));
    let base = env.health(&user.pubkey()).borrow_rate_bps;
    assert_eq!(env.health(&user.pubkey()).premium_rate_bps, 1_000);

    // Eight healthy days earn tier 1, which pays half the premium
    env.warp(8 * DAY);
    env.set_price(&stock, 200 * USDC);
    expect_ok(env.send(&[env.refresh_tier_ix(&user.pubkey())], &[&user]));
    assert_eq!(env.credit(&user.pubkey()).tier, 1);
    let view = env.health(&user.pubkey());
    assert_eq!(view.premium_rate_bps, 500);
    assert!(view.borrow_rate_bps < base);

    // A liquidation drops the account back to the base tier and the full premium
    env.set_price(&stock, 70 * USDC);
    let liquidator = env.wallet();
    env.fund(&usdc, &liquidator.pubkey(), 1_000_000 * USDC);
    env.fund(&stock, &liquidator.pubkey(), 0);
    expect_ok(env.send(&[env.liquidate_ix(&liquidator.pubkey(), &user.pubkey(), &stock, 100 * USDC)], &[&liquidator]));
    assert_eq!(env.credit(&user.pubkey()).tier, 0);
    assert_eq!(env.pool_state().premium_rate_bps(&env.credit(&user.pubkey())), 1_000);
}

#[test]
fn a_premium_raise_waits_out_the_activation_delay_and_a_cut_applies_at_once() {
    let mut env = Env::timed();
    let admin = env.admin.insecure_clone();
    let stock = env.stock;
    let asset = |env: &Env| -> Asset { env.load(&env.asset_pda(&stock)) };

    expect_ok(env.send(&[env.set_asset_premium_ix(&admin.pubkey(), &stock, 1_000)], &[&admin]));
    assert_eq!((asset(&env).premium_bps, asset(&env).pending_premium_bps), (0, 1_000));
    expect_err(env.send(&[env.apply_asset_premium_ix(&stock)], &[&admin]), PluribusError::ChangeNotDue);
    env.warp(8 * DAY);
    let anyone = env.wallet();
    expect_ok(env.send(&[env.apply_asset_premium_ix(&stock)], &[&anyone]));
    assert_eq!((asset(&env).premium_bps, asset(&env).premium_pending_at), (1_000, 0));
    expect_err(env.send(&[env.apply_asset_premium_ix(&stock)], &[&anyone]), PluribusError::NoPendingChange);

    // A cut lands at once and drops a waiting raise
    expect_ok(env.send(&[env.set_asset_premium_ix(&admin.pubkey(), &stock, 2_000)], &[&admin]));
    expect_ok(env.send(&[env.set_asset_premium_ix(&admin.pubkey(), &stock, 400)], &[&admin]));
    assert_eq!((asset(&env).premium_bps, asset(&env).premium_pending_at), (400, 0));

    // Capped, and only the admin may set it
    expect_err(env.send(&[env.set_asset_premium_ix(&admin.pubkey(), &stock, MAX_RISK_PREMIUM_BPS + 1)], &[&admin]), PluribusError::InvalidParams);
    assert!(env.send(&[env.set_asset_premium_ix(&anyone.pubkey(), &stock, 0)], &[&anyone]).is_err());

    // Tier shares follow the same rule, and may never rise with loyalty
    expect_err(env.send(&[env.set_premium_tiers_ix(&admin.pubkey(), [5_000, 6_000, 0])], &[&admin]), PluribusError::InvalidParams);
    expect_err(env.send(&[env.set_premium_tiers_ix(&admin.pubkey(), [10_001, 0, 0])], &[&admin]), PluribusError::InvalidParams);
    expect_ok(env.send(&[env.set_premium_tiers_ix(&admin.pubkey(), TIERS_HALVING)], &[&admin]));
    assert_eq!(env.pool_state().premium_tier_bps, [0; TIERS]);
    expect_err(env.send(&[env.apply_premium_tiers_ix()], &[&anyone]), PluribusError::ChangeNotDue);
    env.warp(8 * DAY);
    expect_ok(env.send(&[env.apply_premium_tiers_ix()], &[&anyone]));
    assert_eq!(env.pool_state().premium_tier_bps, TIERS_HALVING);
    expect_ok(env.send(&[env.set_premium_tiers_ix(&admin.pubkey(), [8_000, 4_000, 0])], &[&admin]));
    assert_eq!(env.pool_state().premium_tier_bps, [8_000, 4_000, 0]);
}

#[test]
fn accounts_from_before_the_premium_grow_with_its_fields_at_zero() {
    let mut env = pool_with_juniors(1_000);
    let (stock, usdc) = (env.stock, env.usdc);
    let user = env.user();
    env.deposit(&user, &stock, 100 * STOCK);
    expect_ok(env.draw(&user, 1_000 * USDC));

    // Cut both accounts back to their old length, as an account made before the upgrade would be
    let shrink = |env: &mut Env, address: Pubkey, by: usize| {
        let mut account = env.svm.get_account(&address).unwrap();
        let len = account.data.len() - by;
        account.data.truncate(len);
        // The appended fields of an old account were never written
        env.set_raw(address, account.owner, account.data);
    };
    let (credit, asset) = (env.credit_pda(&user.pubkey()), env.asset_pda(&stock));
    let draw = env.draw_ix(&user.pubkey(), USDC);
    shrink(&mut env, credit, 2 + 8);
    shrink(&mut env, asset, 2 + 2 + 8);
    assert!(env.send(&[draw], &[&user]).is_err(), "an old account can't be read until it grows");

    let payer = env.wallet();
    expect_ok(env.send(&[env.migrate_account_ix(&payer.pubkey(), &credit), env.migrate_account_ix(&payer.pubkey(), &asset)], &[&payer]));
    assert_eq!(env.svm.get_account(&credit).unwrap().data.len(), 8 + CreditAccount::INIT_SPACE);
    assert_eq!(env.svm.get_account(&asset).unwrap().data.len(), 8 + Asset::INIT_SPACE);
    let (c, a): (CreditAccount, Asset) = (env.load(&credit), env.load(&asset));
    assert_eq!((c.premium_bps, c.premium_since, a.premium_bps, a.premium_pending_at), (0, 0, 0, 0));
    // Rent exempt at the new size, and a second run changes nothing
    let lamports = env.svm.get_account(&credit).unwrap().lamports;
    assert_eq!(lamports, env.svm.minimum_balance_for_rent_exemption(8 + CreditAccount::INIT_SPACE));
    expect_ok(env.send(&[env.migrate_account_ix(&payer.pubkey(), &credit)], &[&payer]));
    assert_eq!(env.svm.get_account(&credit).unwrap().lamports, lamports);

    // The first booking only starts the clock, then the account works as before
    let admin = env.admin.insecure_clone();
    expect_ok(env.send(&[env.set_asset_premium_ix(&admin.pubkey(), &stock, 1_000)], &[&admin]));
    expect_ok(env.draw(&user, USDC));
    assert_eq!(env.credit(&user.pubkey()).premium_bps, 1_000);
    assert_eq!(env.pool_state().premium_booked, 0);

    // Only asset and credit accounts, and only this program's
    let pool = env.pool;
    expect_err(env.send(&[env.migrate_account_ix(&payer.pubkey(), &pool)], &[&payer]), PluribusError::AccountMismatch);
    let vault = env.vault_pda(&usdc);
    expect_err(env.send(&[env.migrate_account_ix(&payer.pubkey(), &vault)], &[&payer]), PluribusError::WrongOwner);
}

#[test]
fn demo_mode_can_end_the_waits_for_new_listings_and_changes() {
    let mut env = Env::timed();
    let admin = env.admin.insecure_clone();
    let meme = env.new_mint(5, &TOKEN);
    expect_ok(env.send(&[env.init_asset_ix(&meme, asset_params(GROUP_STOCK, ORACLE_PYTH, [3; 32], 1500))], &[&admin]));
    env.set_price(&meme, 2_000);
    expect_ok(env.send(&[env.set_asset_premium_ix(&admin.pubkey(), &meme, 1_500)], &[&admin]));
    let user = env.user();
    env.fund(&meme, &user.pubkey(), 1_000_000);
    expect_err(env.send(&[env.deposit_token_ix(&user.pubkey(), &meme, 1_000_000)], &[&user]), PluribusError::NotYetActive);

    // Only the admin, and only for this program's assets and markets
    let stranger = env.wallet();
    assert!(env.send(&[env.demo_activate_ix(&stranger.pubkey(), &[env.asset_pda(&meme)])], &[&stranger]).is_err());
    let vault = env.vault_pda(&meme);
    expect_err(env.send(&[env.demo_activate_ix(&admin.pubkey(), &[vault])], &[&admin]), PluribusError::WrongOwner);

    let market = env.lp_market_pda(&env.whirlpool.clone());
    expect_ok(env.send(&[env.demo_activate_ix(&admin.pubkey(), &[env.asset_pda(&meme), market])], &[&admin]));
    let asset: Asset = env.load(&env.asset_pda(&meme));
    assert!(asset.active_at <= env.now());
    assert_eq!((asset.premium_bps, asset.premium_pending_at), (1_500, 0));
    expect_ok(env.send(&[env.deposit_token_ix(&user.pubkey(), &meme, 1_000_000)], &[&user]));

    // Waiting pool settings apply too
    let looser = PoolParams { base_rate_bps: 100, ..timed_params() };
    expect_ok(env.send(&[env.set_params_ix(&admin.pubkey(), looser)], &[&admin]));
    assert_ne!(env.pool_state().pending_at, 0);
    expect_ok(env.send(&[env.demo_activate_ix(&admin.pubkey(), &[])], &[&admin]));
    assert_eq!((env.pool_state().params.base_rate_bps, env.pool_state().pending_at), (100, 0));

    // With demo mode off for good, the waits hold
    expect_ok(env.send(&[env.set_flags_ix(&admin.pubkey(), false, false)], &[&admin]));
    expect_err(env.send(&[env.demo_activate_ix(&admin.pubkey(), &[])], &[&admin]), PluribusError::DemoDisabled);
}

#[test]
fn a_live_asset_reads_its_pyth_feed_in_demo_mode() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let (stock, usdc) = (env.stock, env.usdc);
    env.lender(100_000 * USDC);
    let user = env.user();
    env.deposit(&user, &stock, 100 * STOCK);
    expect_ok(env.send(&[env.demo_set_live_price_ix(&admin.pubkey(), &stock, true)], &[&admin]));

    // The demo account no longer prices it
    expect_err(env.draw(&user, 1_000 * USDC), PluribusError::InvalidPriceAccount);
    let pyth = Pubkey::new_unique();
    let now = env.now();
    env.set_pyth(pyth, STOCK_FEED, 20_000_000_000, 0, -8, now);
    let mut draw: Instruction = env.draw_ix(&user.pubkey(), 1_000 * USDC);
    let demo = env.price_account(&stock);
    draw.accounts.iter_mut().filter(|m| m.pubkey == demo).for_each(|m| m.pubkey = pyth);
    expect_ok(env.send(&[draw], &[&user]));

    // A fixed-price asset has no feed to switch to, and the switch is the admin's alone
    expect_err(env.send(&[env.demo_set_live_price_ix(&admin.pubkey(), &usdc, true)], &[&admin]), PluribusError::InvalidParams);
    let stranger = env.wallet();
    assert!(env.send(&[env.demo_set_live_price_ix(&stranger.pubkey(), &stock, false)], &[&stranger]).is_err());

    // Back on the demo price
    expect_ok(env.send(&[env.demo_set_live_price_ix(&admin.pubkey(), &stock, false)], &[&admin]));
    expect_ok(env.draw(&user, 1_000 * USDC));
    expect_ok(env.send(&[env.set_flags_ix(&admin.pubkey(), false, false)], &[&admin]));
    expect_err(env.send(&[env.demo_set_live_price_ix(&admin.pubkey(), &stock, true)], &[&admin]), PluribusError::DemoDisabled);
}
