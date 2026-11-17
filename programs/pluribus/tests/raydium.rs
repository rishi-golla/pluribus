mod common;

use {
    anchor_lang::prelude::Pubkey,
    common::*,
    pluribus::{error::PluribusError, state::*},
    solana_signer::Signer,
};

/// A Raydium SOL/USDC pool listed as an LP market, with USDC as token 0 when `usdc_first`
fn raydium_market(env: &mut Env, usdc_first: bool) -> Pubkey {
    let pool = Pubkey::new_unique();
    let (sol, usdc) = (env.sol, env.usdc);
    if usdc_first {
        env.set_raydium_pool(&pool, &usdc, &sol);
    } else {
        env.set_raydium_pool(&pool, &sol, &usdc);
    }
    let admin = env.admin.insecure_clone();
    expect_ok(env.send(&[env.init_lp_market_ix(&pool, &sol, 500)], &[&admin]));
    pool
}

/// Ticks of a SOL price range the way the pool quotes it: USDC per SOL, or SOL per USDC when USDC comes first
fn ticks(lower: f64, upper: f64, usdc_first: bool) -> (i32, i32) {
    if usdc_first {
        (-tick(upper), -tick(lower))
    } else {
        (tick(lower), tick(upper))
    }
}

fn close(a: u64, b: u64) -> bool {
    (a as f64 - b as f64).abs() <= b as f64 * 1e-6 + 2.0
}

#[test]
fn a_raydium_position_is_worth_what_the_same_orca_position_is_in_either_token_order() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    let whirlpool = env.whirlpool;
    let liquidity = liquidity_for(1_000, 120.0, 180.0, 150);
    let user = env.user();
    let orca = env.lp(&user.pubkey(), &whirlpool, 120.0, 180.0, liquidity, &TOKEN_2022);
    expect_ok(env.send(&[env.deposit_lp_ix(&user.pubkey(), &whirlpool, &orca)], &[&user]));
    let want = env.health(&user.pubkey());
    for usdc_first in [false, true] {
        let pool = raydium_market(&mut env, usdc_first);
        let market: LpMarket = env.load(&env.lp_market_pda(&pool));
        assert_eq!((market.dex_program, market.base_first), (RAYDIUM, !usdc_first));
        let (lower, upper) = ticks(120.0, 180.0, usdc_first);
        let owner = env.user();
        let nft = env.raydium_lp(&owner.pubkey(), &pool, lower, upper, liquidity, &TOKEN);
        expect_ok(env.send(&[env.deposit_lp_ix(&owner.pubkey(), &pool, &nft)], &[&owner]));
        let h = env.health(&owner.pubkey());
        assert!(close(h.position_value[0], want.position_value[0]), "value {} vs {}", h.position_value[0], want.position_value[0]);
        assert!(close(h.credit_limit, want.credit_limit), "limit {} vs {}", h.credit_limit, want.credit_limit);
        assert!(close(h.liquidation_limit, want.liquidation_limit));
        // Out of range on either side, the position is all one token whichever order the pool keeps them in
        let sol = env.sol;
        for price in [100, 250] {
            env.set_price(&sol, price * USDC);
            let (h, o) = (env.health(&owner.pubkey()), env.health(&user.pubkey()));
            assert!(close(h.position_value[0], o.position_value[0]), "at {price}: {} vs {}", h.position_value[0], o.position_value[0]);
        }
        env.set_price(&sol, 150 * USDC);
    }
}

#[test]
fn a_raydium_position_backs_draws_and_is_liquidated_and_withdrawn_like_any_lp() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    let pool = raydium_market(&mut env, true);
    let (lower, upper) = ticks(120.0, 180.0, true);
    let user = env.user();
    let me = user.pubkey();
    let nft = env.raydium_lp(&me, &pool, lower, upper, liquidity_for(1_000, 120.0, 180.0, 150), &TOKEN_2022);
    expect_ok(env.send(&[env.deposit_lp_ix(&me, &pool, &nft)], &[&user]));
    assert_eq!(env.balance(&nft, &me), 0);
    // Withdrawing with nothing drawn hands the NFT back, and it can come in again
    expect_ok(env.send(&[env.withdraw_lp_ix(&me, &nft)], &[&user]));
    assert_eq!(env.balance(&nft, &me), 1);
    expect_ok(env.send(&[env.deposit_lp_ix(&me, &pool, &nft)], &[&user]));
    let limit = env.health(&me).credit_limit;
    assert!(limit > 0);
    expect_ok(env.draw(&user, limit));
    expect_err(env.send(&[env.withdraw_lp_ix(&me, &nft)], &[&user]), PluribusError::ExceedsCreditLimit);
    let sol = env.sol;
    env.set_price(&sol, 90 * USDC);
    let liquidator = env.wallet();
    let usdc = env.usdc;
    env.fund(&usdc, &liquidator.pubkey(), 10_000 * USDC);
    env.fund(&nft, &liquidator.pubkey(), 0);
    expect_ok(env.send(&[env.liquidate_lp_ix(&liquidator.pubkey(), &me, &nft)], &[&liquidator]));
    assert_eq!(env.balance(&nft, &liquidator.pubkey()), 1);
}

#[test]
fn only_positions_of_a_listed_raydium_pool_count() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let (sol, usdc, stock) = (env.sol, env.usdc, env.stock);
    // A pool copied under a program that is not Raydium, or pairing two tokens that are not base and USDC, never lists
    let fake = Pubkey::new_unique();
    env.set_raw(fake, Pubkey::new_unique(), raydium_pool_bytes(&sol, &usdc));
    expect_err(env.send(&[env.init_lp_market_ix(&fake, &sol, 500)], &[&admin]), PluribusError::PoolNotWhitelisted);
    let pair = Pubkey::new_unique();
    env.set_raydium_pool(&pair, &sol, &stock);
    expect_err(env.send(&[env.init_lp_market_ix(&pair, &sol, 500)], &[&admin]), PluribusError::PoolNotWhitelisted);
    let wrong_layout = Pubkey::new_unique();
    let mut bytes = raydium_pool_bytes(&sol, &usdc);
    bytes[0] ^= 1;
    env.set_raw(wrong_layout, RAYDIUM, bytes);
    expect_err(env.send(&[env.init_lp_market_ix(&wrong_layout, &sol, 500)], &[&admin]), PluribusError::PoolNotWhitelisted);

    let pool = raydium_market(&mut env, false);
    let (lower, upper) = ticks(120.0, 180.0, false);
    let liquidity = liquidity_for(1_000, 120.0, 180.0, 150);
    let user = env.user();
    let me = user.pubkey();
    // A position in another Raydium pool, even one with the same mints
    let other = Pubkey::new_unique();
    env.set_raydium_pool(&other, &sol, &usdc);
    let stray = env.raydium_lp(&me, &other, lower, upper, liquidity, &TOKEN);
    expect_err(env.send(&[env.deposit_lp_ix(&me, &pool, &stray)], &[&user]), PluribusError::PoolNotWhitelisted);
    // A position account at Raydium's address that some other program wrote, or with another discriminator
    let forged = env.raydium_lp(&me, &pool, lower, upper, liquidity, &TOKEN);
    let (address, bump) = position_pda(&RAYDIUM, &forged);
    env.set_raw(address, Pubkey::new_unique(), raydium_position_bytes(&pool, &forged, liquidity, lower, upper, bump));
    let mut ix = env.deposit_lp_ix(&me, &pool, &forged);
    let at = ix.accounts.iter().position(|m| m.pubkey == orca_position(&forged)).unwrap();
    ix.accounts[at].pubkey = address;
    expect_err(env.send(&[ix.clone()], &[&user]), PluribusError::InvalidLpPosition);
    let mut bytes = raydium_position_bytes(&pool, &forged, liquidity, lower, upper, bump);
    bytes[0] ^= 1;
    env.set_raw(address, RAYDIUM, bytes);
    expect_err(env.send(&[ix], &[&user]), PluribusError::InvalidLpPosition);
    // A position that names another NFT
    let real = env.raydium_lp(&me, &pool, lower, upper, liquidity, &TOKEN);
    let (address, bump) = position_pda(&RAYDIUM, &real);
    env.set_raw(address, RAYDIUM, raydium_position_bytes(&pool, &stray, liquidity, lower, upper, bump));
    expect_err(env.send(&[env.deposit_lp_ix(&me, &pool, &real)], &[&user]), PluribusError::AccountMismatch);
    // An Orca position NFT does not come in through the Raydium market
    let whirlpool = env.whirlpool;
    let orca = env.lp(&me, &whirlpool, 120.0, 180.0, liquidity, &TOKEN);
    assert!(env.send(&[env.deposit_lp_ix(&me, &pool, &orca)], &[&user]).is_err());
    assert!(!env.credit(&me).has_collateral());
}

#[test]
fn autopay_harvests_only_orca_markets() {
    let mut env = Env::new();
    let pool = raydium_market(&mut env, false);
    let (lower, upper) = ticks(120.0, 180.0, false);
    let user = env.user();
    let me = user.pubkey();
    let nft = env.raydium_lp(&me, &pool, lower, upper, liquidity_for(1_000, 120.0, 180.0, 150), &TOKEN);
    expect_ok(env.send(&[env.deposit_lp_ix(&me, &pool, &nft)], &[&user]));
    let keeper = env.wallet();
    let dummies = [Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique(), Pubkey::new_unique()];
    expect_err(env.send(&[env.autopay_ix(&keeper.pubkey(), &me, &pool, &nft, dummies)], &[&keeper]), PluribusError::UnsupportedDex);
}
