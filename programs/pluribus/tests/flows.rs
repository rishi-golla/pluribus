mod common;

use {common::*, pluribus::error::PluribusError, solana_signer::Signer};

fn near(got: u64, want: f64, tolerance: f64) -> bool {
    (got as f64 / want - 1.0).abs() < tolerance
}

/// The handoff's three-regime formula in floats, independent of the on-chain integer maths
fn lp_value(liquidity: f64, lower: f64, upper: f64, price: f64) -> f64 {
    // The range a position really has is set by its ticks
    let at = |p: f64| 1.0001f64.powi(tick(p)) * 1000.0;
    let (pa, pb) = (at(lower), at(upper));
    let (a, b, s) = (pa.sqrt(), pb.sqrt(), price.sqrt());
    // Liquidity is in raw units: sqrt(lamports * micro-USDC)
    let l = liquidity / (1e9f64 * 1e6).sqrt();
    if price <= pa {
        l * (1.0 / a - 1.0 / b) * price
    } else if price >= pb {
        l * (b - a)
    } else {
        l * (2.0 * s - a - price / b)
    }
}

#[test]
fn crash_tested_ltvs_match_the_reference_on_chain() {
    // Range, then the reference LTV at a 30% crash and 5% liquidation cost with SOL at $150
    for (lower, upper, want) in [(145.5, 154.5, 0.670), (120.0, 180.0, 0.708), (75.0, 300.0, 0.764), (100.0, 140.0, 0.840)] {
        let mut env = Env::new();
        let user = env.user();
        env.deposit_lp(&user, lower, upper, liquidity_for(10_000, lower, upper, 150));
        let h = env.health(&user.pubkey());
        assert!(near(h.collateral_value, 10_000.0 * USDC as f64, 1e-6));
        let ltv = h.credit_limit as f64 / h.collateral_value as f64;
        assert!((ltv - want).abs() < 0.001, "{lower}-{upper}: got {ltv}, want {want}");
    }

    let mut env = Env::new();
    let user = env.user();
    let sol = env.sol;
    env.deposit(&user, &sol, 10 * SOL);
    let h = env.health(&user.pubkey());
    assert_eq!(h.collateral_value, 1500 * USDC);
    assert_eq!(h.credit_limit, 997_500_000);
}

#[test]
fn one_credit_line_across_every_asset_type() {
    let mut env = Env::new();
    env.lender(1_000_000 * USDC);
    let user = env.user();
    let (sol, stock, usdc) = (env.sol, env.stock, env.usdc);
    env.deposit(&user, &sol, 10 * SOL);
    env.deposit(&user, &stock, 10 * STOCK);
    let liquidity = liquidity_for(10_000, 120.0, 180.0, 150);
    env.deposit_lp(&user, 120.0, 180.0, liquidity);

    // Every position shocked together per scenario, summed, then the worst scenario taken
    let scenario = |sol_shock: f64, stock_shock: f64| {
        1500.0 * (1.0 - sol_shock) * 0.95
            + 2000.0 * (1.0 - stock_shock) * 0.90
            + lp_value(liquidity as f64, 120.0, 180.0, 150.0 * (1.0 - sol_shock)) * 0.95
    };
    let want = [scenario(0.30, 0.15), scenario(0.15, 0.35), scenario(0.25, 0.25)].into_iter().fold(f64::MAX, f64::min);
    let h = env.health(&user.pubkey());
    assert!(near(h.credit_limit, want * USDC as f64, 1e-5), "limit {} want {want}", h.credit_limit);
    assert!(near(h.collateral_value, 13_500.0 * USDC as f64, 1e-5));

    expect_ok(env.draw(&user, h.credit_limit));
    assert_eq!(env.balance(&usdc, &user.pubkey()), h.credit_limit);
    assert_eq!(env.debt(&user.pubkey()), h.credit_limit);
    expect_err(env.draw(&user, 1), PluribusError::ExceedsCreditLimit);
}

#[test]
fn shared_buffer_beats_separate_loans() {
    let mut env = Env::new();
    let (sol, stock) = (env.sol, env.stock);
    let limit = |env: &mut Env, sol_amount: u64, stock_amount: u64| {
        let user = env.user();
        if sol_amount > 0 {
            env.deposit(&user, &sol, sol_amount);
        }
        if stock_amount > 0 {
            env.deposit(&user, &stock, stock_amount);
        }
        env.health(&user.pubkey()).credit_limit
    };
    let sol_only = limit(&mut env, 10 * SOL, 0);
    let stock_only = limit(&mut env, 0, 10 * STOCK);
    let together = limit(&mut env, 10 * SOL, 10 * STOCK);
    assert_eq!(sol_only, 997_500_000);
    assert_eq!(stock_only, 1_170_000_000);
    // Worst joint scenario is the equity crash: 1500*0.85*0.95 + 2000*0.65*0.90
    assert_eq!(together, 2_381_250_000);
    assert!(together > sol_only + stock_only);
}

#[test]
fn interest_accrues_tiers_discount_it_and_lenders_earn() {
    let mut env = Env::new();
    let lender = env.lender(100_000 * USDC);
    let user = env.user();
    let (sol, usdc, shares) = (env.sol, env.usdc, env.share_mint);
    env.deposit(&user, &sol, 1000 * SOL);
    expect_ok(env.draw(&user, 45_000 * USDC));
    // 45% utilization on the gentle slope: 2% + 8% * 45/90
    assert_eq!(env.pool_state().base_rate_bps().unwrap(), 600);

    env.warp(365 * DAY);
    env.set_price(&sol, 150 * USDC);
    expect_ok(env.send(&[env.accrue_ix()], &[&lender]));
    // Debt rounds up, never down: at most a base unit over the exact figure
    let debt = env.debt(&user.pubkey());
    assert!((47_700 * USDC..=47_700 * USDC + 1).contains(&debt), "debt {debt}");
    // A tenth of the interest goes to the insurance reserve and a tenth to the protocol
    assert!(near(env.pool_state().reserves, 270.0 * USDC as f64, 1e-8));
    assert!(near(env.pool_state().protocol_fees, 270.0 * USDC as f64, 1e-8));

    // A year of good standing earns the top tier in one step
    expect_ok(env.send(&[env.refresh_tier_ix(&user.pubkey())], &[&lender]));
    assert_eq!(env.credit(&user.pubkey()).tier, 2);
    assert!((debt..=debt + 1).contains(&env.debt(&user.pubkey())));
    let h = env.health(&user.pubkey());
    assert_eq!(h.borrow_rate_bps as u128, env.pool_state().base_rate_bps().unwrap() - 80);

    env.warp(365 * DAY);
    expect_ok(env.send(&[env.accrue_ix()], &[&lender]));
    let want = 47_700.0 * (1.0 + h.borrow_rate_bps as f64 / 10_000.0);
    assert!(near(env.debt(&user.pubkey()), want * USDC as f64, 1e-9));

    // Repay everything, then the lender leaves with more than went in
    let debt = env.debt(&user.pubkey());
    env.fund(&usdc, &user.pubkey(), debt);
    expect_ok(env.send(&[env.repay_ix(&user.pubkey(), &user.pubkey(), u64::MAX)], &[&user]));
    assert_eq!(env.debt(&user.pubkey()), 0);
    assert_eq!(env.balance(&usdc, &user.pubkey()), 0);
    let held = env.balance(&shares, &lender.pubkey());
    expect_ok(env.send(&[env.lend_withdraw_ix(&lender.pubkey(), held)], &[&lender]));
    let out = env.balance(&usdc, &lender.pubkey());
    let pool = env.pool_state();
    assert!(out > 104_000 * USDC, "lender got {out}");
    // What is left in the pool is the reserve and the protocol's cut, to the rounding unit
    assert!(pool.cash - pool.reserves - pool.protocol_fees <= 2);
    assert_eq!(pool.cash, env.token_amount(&env.usdc_vault));

    // The admin collects the protocol's cut and the insurance reserve stays put
    let admin = env.admin.insecure_clone();
    env.fund(&usdc, &admin.pubkey(), 0);
    expect_ok(env.send(&[env.collect_protocol_fees_ix(&admin.pubkey(), u64::MAX)], &[&admin]));
    assert_eq!(env.balance(&usdc, &admin.pubkey()), pool.protocol_fees);
    let after = env.pool_state();
    assert_eq!((after.protocol_fees, after.reserves), (0, pool.reserves));
    assert_eq!(after.cash, env.token_amount(&env.usdc_vault));
    // Nobody but the admin can collect
    env.fund(&usdc, &user.pubkey(), 0);
    let stranger = env.collect_protocol_fees_ix(&user.pubkey(), 1);
    assert!(failed_with_code(&env.send(&[stranger], &[&user]), anchor_lang::error::ErrorCode::ConstraintHasOne.into()));
}

#[test]
fn tiers_follow_health() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    let user = env.user();
    let sol = env.sol;
    let keeper = env.wallet();
    env.deposit(&user, &sol, 10 * SOL);
    expect_ok(env.draw(&user, 900 * USDC));
    let refresh = |env: &mut Env| expect_ok(env.send(&[env.refresh_tier_ix(&user.pubkey())], &[&keeper]));

    env.warp(6 * DAY);
    env.set_price(&sol, 150 * USDC);
    refresh(&mut env);
    assert_eq!(env.credit(&user.pubkey()).tier, 0);

    env.warp(2 * DAY);
    env.set_price(&sol, 150 * USDC);
    refresh(&mut env);
    assert_eq!(env.credit(&user.pubkey()).tier, 1);

    // SOL at $125: liquidation limit 10 * 125 * 0.8 * 0.95 = 950, health about 1.05, under the 1.10 warning level
    env.set_price(&sol, 125 * USDC);
    let debt = env.debt(&user.pubkey());
    refresh(&mut env);
    let credit = env.credit(&user.pubkey());
    assert_eq!(credit.tier, 0);
    assert_eq!(credit.healthy_since, env.now());
    // Moving between indices never forgives debt
    assert!(env.debt(&user.pubkey()) >= debt);
    let pool = env.pool_state();
    assert_eq!(pool.debt_shares[0], credit.debt_shares);
    assert_eq!(pool.debt_shares[1], 0);
}

#[test]
fn withdrawals_respect_the_limit_and_always_work_without_debt() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    let user = env.user();
    let (sol, usdc) = (env.sol, env.usdc);
    let me = user.pubkey();
    env.deposit(&user, &sol, 10 * SOL);
    expect_ok(env.draw(&user, 500 * USDC));

    // 4 SOL left would back only $399
    expect_err(env.send(&[env.withdraw_token_ix(&me, &sol, 6 * SOL)], &[&user]), PluribusError::ExceedsCreditLimit);
    expect_ok(env.send(&[env.withdraw_token_ix(&me, &sol, 4 * SOL)], &[&user]));
    assert_eq!(env.balance(&sol, &me), 4 * SOL);
    expect_err(env.send(&[env.withdraw_token_ix(&me, &sol, 6 * SOL)], &[&user]), PluribusError::ExceedsCreditLimit);

    expect_ok(env.send(&[env.repay_ix(&me, &me, u64::MAX)], &[&user]));
    assert_eq!(env.balance(&usdc, &me), 0);
    // Prices are an hour stale now, and the exit still works because nothing is owed
    env.warp(3600);
    expect_ok(env.send(&[env.withdraw_token_ix(&me, &sol, 6 * SOL)], &[&user]));
    assert_eq!(env.balance(&sol, &me), 10 * SOL);
    assert!(!env.credit(&me).has_collateral());
}

#[test]
fn lp_nft_round_trip_for_both_token_programs() {
    for program in [TOKEN, TOKEN_2022] {
        let mut env = Env::new();
        let user = env.user();
        let me = user.pubkey();
        let whirlpool = env.whirlpool;
        let nft = env.lp(&me, &whirlpool, 120.0, 180.0, liquidity_for(10_000, 120.0, 180.0, 150), &program);
        expect_ok(env.send(&[env.deposit_lp_ix(&me, &whirlpool, &nft)], &[&user]));
        assert_eq!(env.balance(&nft, &me), 0);
        assert_eq!(env.balance(&nft, &env.pool), 1);
        assert!(near(env.health(&me).collateral_value, 10_000.0 * USDC as f64, 1e-6));

        expect_ok(env.send(&[env.withdraw_lp_ix(&me, &nft)], &[&user]));
        assert_eq!(env.balance(&nft, &me), 1);
        // The vault account is closed and its rent returned
        assert!(env.svm.get_account(&ata(&env.pool, &nft, &program)).map_or(true, |a| a.lamports == 0));
        assert!(!env.credit(&me).has_collateral());
    }
}

#[test]
fn lent_out_usdc_cannot_be_withdrawn_and_the_rate_kinks() {
    let mut env = Env::new();
    let lender = env.lender(1000 * USDC);
    let user = env.user();
    let (sol, shares) = (env.sol, env.share_mint);
    env.deposit(&user, &sol, 100 * SOL);
    expect_ok(env.draw(&user, 900 * USDC));
    // At the kink: 2% + 8%
    assert_eq!(env.pool_state().base_rate_bps().unwrap(), 1000);
    expect_ok(env.draw(&user, 50 * USDC));
    // Halfway up the steep slope: 10% + 60% / 2
    assert_eq!(env.pool_state().base_rate_bps().unwrap(), 4000);

    let held = env.balance(&shares, &lender.pubkey());
    expect_err(env.send(&[env.lend_withdraw_ix(&lender.pubkey(), held)], &[&lender]), PluribusError::InsufficientLiquidity);
    expect_ok(env.send(&[env.lend_withdraw_ix(&lender.pubkey(), held / 20)], &[&lender]));
    expect_err(env.draw(&user, 1), PluribusError::InsufficientLiquidity);
}
