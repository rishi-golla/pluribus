mod common;

use {
    anchor_lang::{error::ErrorCode, prelude::Pubkey, solana_program::instruction::Instruction},
    common::*,
    pluribus::{constants::*, error::PluribusError, state::*},
    solana_keypair::Keypair,
    solana_signer::Signer,
};

/// What every liquidator wallet starts with
const FLOAT: u64 = 1_000_000 * USDC;
/// Debt rounds up against the borrower, so once interest has accrued a call may cost the margin this many base units
const ROUNDING: i128 = 2;

// Account positions inside the liquidate instruction
const LIQ_USDC_VAULT: usize = 4;
const LIQ_PAYER: usize = 5;
const LIQ_ASSET: usize = 6;
const LIQ_VAULT: usize = 8;
const LIQ_RECEIVER: usize = 9;
const LIQ_HEALTH: usize = 12;
// Account positions inside the liquidate_lp instruction
const LP_COLLATERAL_VAULT: usize = 7;
const LP_VAULT_NFT: usize = 9;
const LP_RECEIVER: usize = 10;
const LP_OWNER: usize = 11;
const LP_HEALTH: usize = 14;

/// A wallet with plenty of USDC and empty SOL and stock accounts
fn liquidator(env: &mut Env) -> Keypair {
    let wallet = env.wallet();
    for (mint, amount) in [(env.usdc, FLOAT), (env.sol, 0), (env.stock, 0)] {
        env.fund(&mint, &wallet.pubkey(), amount);
    }
    wallet
}

/// An account holding SOL and stock that has drawn `percent` of its credit limit
fn borrower(env: &mut Env, sol_amount: u64, stock_amount: u64, percent: u64) -> Keypair {
    let user = env.user();
    for (mint, amount) in [(env.sol, sol_amount), (env.stock, stock_amount)] {
        if amount > 0 {
            env.deposit(&user, &mint, amount);
        }
    }
    let limit = env.health(&user.pubkey()).credit_limit;
    expect_ok(env.draw(&user, limit / 100 * percent));
    user
}

/// Deposits a 120 to 180 position worth `usd` dollars at $150, under either token program
fn add_lp(env: &mut Env, user: &Keypair, usd: u64, program: &Pubkey) -> Pubkey {
    let whirlpool = env.whirlpool;
    let nft = env.lp(&user.pubkey(), &whirlpool, 120.0, 180.0, liquidity_for(usd, 120.0, 180.0, 150), program);
    expect_ok(env.send(&[env.deposit_lp_ix(&user.pubkey(), &whirlpool, &nft)], &[user]));
    nft
}

/// An account whose only collateral is one such position, drawn to its credit limit
fn lp_borrower(env: &mut Env, usd: u64, program: &Pubkey) -> (Keypair, Pubkey) {
    let user = env.user();
    let nft = add_lp(env, &user, usd, program);
    let limit = env.health(&user.pubkey()).credit_limit;
    expect_ok(env.draw(&user, limit));
    (user, nft)
}

fn liquidate(env: &mut Env, liquidator: &Keypair, owner: &Pubkey, mint: &Pubkey, repay: u64) -> TxResult {
    env.send(&[env.liquidate_ix(&liquidator.pubkey(), owner, mint, repay)], &[liquidator])
}

fn swap(mut ix: Instruction, index: usize, account: Pubkey) -> Instruction {
    ix.accounts[index].pubkey = account;
    ix
}

/// Liquidation limit minus debt, negative once the account can be liquidated
fn margin(env: &mut Env, owner: &Pubkey) -> i128 {
    let h = env.health(owner);
    h.liquidation_limit as i128 - h.debt as i128
}

fn spent(env: &Env, liquidator: &Keypair) -> u64 {
    FLOAT - env.balance(&env.usdc, &liquidator.pubkey())
}

/// Collateral worth `repay` plus the 5% bonus at `price`, rounded down
fn with_bonus(repay: u64, price: u64, unit: u64) -> u64 {
    (repay as u128 * 10_500 * unit as u128 / (price as u128 * 10_000)) as u64
}

/// The price of collateral worth `value` once the 5% bonus is taken off, rounded up
fn discounted(value: u64) -> u64 {
    (value as u128 * 10_000).div_ceil(10_500) as u64
}

fn total_usdc(env: &Env, wallets: &[Pubkey]) -> u64 {
    let vaults = env.token_amount(&env.usdc_vault) + env.token_amount(&env.vault_pda(&env.usdc));
    wallets.iter().map(|w| env.balance(&env.usdc, w)).sum::<u64>() + vaults
}

/// Pool and asset records against the token vaults and every credit account on chain
#[track_caller]
fn assert_books(env: &Env) {
    let pool = env.pool_state();
    let accounts = env.svm.get_program_accounts(&pluribus::ID);
    let credits: Vec<CreditAccount> =
        accounts.iter().filter(|(_, a)| a.data.starts_with(discriminator::<CreditAccount>())).map(|(address, _)| env.load(address)).collect();
    let positions = || credits.iter().flat_map(|c| c.positions.iter());

    assert_eq!(pool.cash, env.token_amount(&env.usdc_vault), "pool cash against its vault");
    for mint in [env.usdc, env.sol, env.stock] {
        let asset: Asset = env.load(&env.asset_pda(&mint));
        let held: u64 = positions().filter(|p| p.kind == KIND_TOKEN && p.mint == mint).map(|p| p.amount).sum();
        assert_eq!(asset.total_deposited, env.token_amount(&asset.vault), "deposits against the vault");
        assert_eq!(asset.total_deposited, held, "deposits against positions");
    }
    for p in positions().filter(|p| p.kind == KIND_LP) {
        assert_eq!(env.balance(&p.mint, &env.pool), 1, "position NFT in the pool vault");
    }
    for tier in 0..TIERS {
        let shares: u128 = credits.iter().filter(|c| c.tier as usize == tier).map(|c| c.debt_shares).sum();
        assert_eq!(shares, pool.debt_shares[tier], "debt shares in tier {tier}");
    }
}

/// Runs each forged instruction, expecting its error code and no change to the account or to any wallet
#[track_caller]
fn assert_all_rejected(env: &mut Env, signer: &Keypair, victim: &Pubkey, wallets: &[Pubkey], cases: Vec<(&str, Instruction, u32)>) {
    let balances = |env: &Env| wallets.iter().map(|w| env.balance(&env.usdc, w)).collect::<Vec<_>>();
    let snapshot = |env: &Env| (env.svm.get_account(&env.credit_pda(victim)).unwrap().data, balances(env), env.pool_state().cash);
    let before = snapshot(env);
    let mut wrong = vec![];
    for (what, ix, code) in cases {
        let res = env.send(&[ix], &[signer]);
        if !failed_with_code(&res, code) {
            wrong.push(format!("{what}: expected {code}, got {:?}", res.map(|m| m.logs).map_err(|f| (f.err, f.meta.logs.last().cloned()))));
        }
        assert!(snapshot(env) == before, "{what} changed state");
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

// The demo story

#[test]
fn stock_absorbs_the_sol_drop_until_sol_falls_further() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    let (sol, stock) = (env.sol, env.stock);
    let a = borrower(&mut env, 10 * SOL, 10 * STOCK, 95).pubkey();
    let b = borrower(&mut env, 10 * SOL, 0, 95).pubkey();
    let liq = liquidator(&mut env);
    assert_eq!((env.debt(&a), env.debt(&b)), (2_262_187_500, 947_625_000));

    env.set_price(&sol, 120 * USDC);
    assert!(margin(&mut env, &a) > 0 && margin(&mut env, &b) < 0);
    for mint in [sol, stock] {
        expect_err(liquidate(&mut env, &liq, &a, &mint, 100 * USDC), PluribusError::NotLiquidatable);
    }
    expect_ok(liquidate(&mut env, &liq, &b, &sol, 100 * USDC));

    env.set_price(&sol, 100 * USDC);
    assert!(margin(&mut env, &a) < 0);
    for mint in [sol, stock] {
        expect_ok(liquidate(&mut env, &liq, &a, &mint, 100 * USDC));
    }
    assert_eq!(env.balance(&stock, &liq.pubkey()), with_bonus(100 * USDC, 200 * USDC, STOCK));
    assert_books(&env);
}

// Who can be liquidated

#[test]
fn healthy_account_cannot_be_liquidated_by_any_instruction() {
    let mut env = Env::new();
    env.lender(1_000_000 * USDC);
    let (sol, usdc) = (env.sol, env.usdc);
    let user = env.user();
    let me = user.pubkey();
    env.deposit(&user, &sol, 10 * SOL);
    env.deposit(&user, &usdc, 200 * USDC);
    let nft = add_lp(&mut env, &user, 10_000, &TOKEN);
    // Drawn to the limit is as close to the line as a healthy account gets
    let limit = env.health(&me).credit_limit;
    expect_ok(env.draw(&user, limit));
    let liq = liquidator(&mut env);
    env.fund(&nft, &liq.pubkey(), 0);

    let attempts = vec![
        ("full liquidation", env.liquidate_ix(&liq.pubkey(), &me, &sol, u64::MAX), PluribusError::NotLiquidatable.into()),
        ("smallest liquidation", env.liquidate_ix(&liq.pubkey(), &me, &sol, 1), PluribusError::NotLiquidatable.into()),
        ("lp liquidation", env.liquidate_lp_ix(&liq.pubkey(), &me, &nft), PluribusError::NotLiquidatable.into()),
        ("netting by an outsider", env.repay_from_collateral_ix(&liq.pubkey(), &me, u64::MAX), PluribusError::NotLiquidatable.into()),
    ];
    assert_all_rejected(&mut env, &liq, &me, &[me, liq.pubkey()], attempts);
}

#[test]
fn debt_equal_to_the_liquidation_limit_is_safe_and_one_unit_under_is_not() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    let sol = env.sol;
    let user = env.user();
    let me = user.pubkey();
    env.deposit(&user, &sol, 10 * SOL);
    expect_ok(env.draw(&user, 950 * USDC));
    let liq = liquidator(&mut env);

    // 10 SOL at $125, less the 20% shock and the 5% cost, is exactly the $950 owed
    env.set_price(&sol, 125 * USDC);
    assert_eq!(margin(&mut env, &me), 0);
    expect_err(liquidate(&mut env, &liq, &me, &sol, 100 * USDC), PluribusError::NotLiquidatable);

    env.set_price(&sol, 125 * USDC - 1);
    assert!(margin(&mut env, &me) < 0);
    expect_ok(liquidate(&mut env, &liq, &me, &sol, 100 * USDC));
}

#[test]
fn stale_or_uncertain_prices_block_every_liquidation_path() {
    let mut env = Env::new();
    env.lender(1_000_000 * USDC);
    let (sol, stock, usdc) = (env.sol, env.stock, env.usdc);
    let user = env.user();
    let me = user.pubkey();
    env.deposit(&user, &sol, 10 * SOL);
    env.deposit(&user, &stock, 10 * STOCK);
    env.deposit(&user, &usdc, 200 * USDC);
    let nft = add_lp(&mut env, &user, 10_000, &TOKEN);
    let limit = env.health(&me).credit_limit;
    expect_ok(env.draw(&user, limit));
    let liq = liquidator(&mut env);
    env.fund(&nft, &liq.pubkey(), 0);
    env.set_price(&sol, 100 * USDC);
    assert!(margin(&mut env, &me) < 0);

    let attempts = |env: &Env, err: PluribusError| {
        vec![
            ("token liquidation", env.liquidate_ix(&liq.pubkey(), &me, &sol, 100 * USDC), err.into()),
            ("lp liquidation", env.liquidate_lp_ix(&liq.pubkey(), &me, &nft), err.into()),
            ("netting by an outsider", env.repay_from_collateral_ix(&liq.pubkey(), &me, USDC), err.into()),
        ]
    };
    let wallets = [me, liq.pubkey()];
    env.warp(61);
    let cases = attempts(&env, PluribusError::StalePrice);
    assert_all_rejected(&mut env, &liq, &me, &wallets, cases);

    // One stale quote among fresh ones is enough
    env.set_price(&sol, 100 * USDC);
    let cases = attempts(&env, PluribusError::StalePrice);
    assert_all_rejected(&mut env, &liq, &me, &wallets, cases);

    // A confidence band wider than the 2% the asset allows
    env.set_price(&stock, 200 * USDC);
    expect_ok(env.set_price_conf(&sol, 100 * USDC, 3 * USDC));
    let cases = attempts(&env, PluribusError::PriceTooUncertain);
    assert_all_rejected(&mut env, &liq, &me, &wallets, cases);

    // The owner nets USDC collateral without any price at all
    expect_ok(env.send(&[env.repay_from_collateral_ix(&me, &me, 50 * USDC)], &[&user]));
    env.set_price(&sol, 100 * USDC);
    expect_ok(liquidate(&mut env, &liq, &me, &sol, 100 * USDC));
    assert_books(&env);
}

#[test]
fn paused_pool_still_allows_liquidation() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    let sol = env.sol;
    let user = borrower(&mut env, 10 * SOL, 0, 95);
    let liq = liquidator(&mut env);
    env.set_price(&sol, 120 * USDC);
    let admin = env.admin.insecure_clone();
    expect_ok(env.send(&[env.set_flags_ix(&admin.pubkey(), true, true)], &[&admin]));
    expect_err(env.draw(&user, 1), PluribusError::Paused);
    expect_ok(liquidate(&mut env, &liq, &user.pubkey(), &sol, 100 * USDC));
}

// Token liquidation amounts

#[test]
fn liquidator_receives_the_repayment_plus_the_bonus_in_collateral() {
    let mut env = Env::new();
    let lender = env.lender(100_000 * USDC);
    let sol = env.sol;
    let me = borrower(&mut env, 10 * SOL, 0, 95).pubkey();
    let liq = liquidator(&mut env);
    env.set_price(&sol, 120 * USDC);
    let wallets = [me, liq.pubkey(), lender.pubkey()];
    let (usdc_before, margin_before) = (total_usdc(&env, &wallets), margin(&mut env, &me));
    let assets_before = env.pool_state().lender_assets().unwrap();

    expect_ok(liquidate(&mut env, &liq, &me, &sol, 100 * USDC));
    assert_eq!(spent(&env, &liq), 100 * USDC);
    // $100 plus 5% buys 0.875 SOL at $120
    assert_eq!(env.balance(&sol, &liq.pubkey()), 875_000_000);
    assert_eq!(env.credit(&me).positions[0].amount, 10 * SOL - 875_000_000);
    assert_eq!(env.debt(&me), 847_625_000);
    assert!(margin(&mut env, &me) >= margin_before);
    assert_eq!(total_usdc(&env, &wallets), usdc_before);
    // Debt turned into cash, so lenders are exactly where they were
    assert_eq!(env.pool_state().lender_assets().unwrap(), assets_before);
    assert_books(&env);
}

#[test]
fn one_call_repays_at_most_half_the_debt_however_much_is_asked() {
    for asked in [500 * USDC, u64::MAX] {
        let mut env = Env::new();
        env.lender(100_000 * USDC);
        let sol = env.sol;
        let me = borrower(&mut env, 10 * SOL, 0, 95).pubkey();
        let liq = liquidator(&mut env);
        env.set_price(&sol, 120 * USDC);

        expect_ok(liquidate(&mut env, &liq, &me, &sol, asked));
        // Half of the $947.625 owed
        assert_eq!(spent(&env, &liq), 473_812_500);
        assert_eq!(env.balance(&sol, &liq.pubkey()), with_bonus(473_812_500, 120 * USDC, SOL));
        assert_eq!(env.debt(&me), 473_812_500);
        // Healthy again, so the next call is refused
        assert!(margin(&mut env, &me) > 0);
        expect_err(liquidate(&mut env, &liq, &me, &sol, asked), PluribusError::NotLiquidatable);
        assert_books(&env);
    }
}

#[test]
fn calls_stacked_in_one_transaction_are_each_capped_and_stop_once_healthy() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    let sol = env.sol;
    let me = borrower(&mut env, 10 * SOL, 0, 95).pubkey();
    let liq = liquidator(&mut env);
    let ix = |env: &Env| env.liquidate_ix(&liq.pubkey(), &me, &sol, u64::MAX);

    // At $120 the first call restores health, so a second one sinks the whole transaction
    env.set_price(&sol, 120 * USDC);
    expect_err(env.send(&[ix(&env), ix(&env)], &[&liq]), PluribusError::NotLiquidatable);
    assert_eq!((env.debt(&me), spent(&env, &liq)), (947_625_000, 0));

    // At $90 the account stays under water, and three calls repay a half, a quarter and an eighth
    env.set_price(&sol, 90 * USDC);
    expect_ok(env.send(&[ix(&env), ix(&env), ix(&env)], &[&liq]));
    let (mut debt, mut repaid, mut seized) = (947_625_000, 0, 0);
    for _ in 0..3 {
        repaid += debt / 2;
        seized += with_bonus(debt / 2, 90 * USDC, SOL);
        debt -= debt / 2;
    }
    assert_eq!(spent(&env, &liq), repaid);
    assert_eq!(env.balance(&sol, &liq.pubkey()), seized);
    assert_eq!(env.debt(&me), debt);
    assert_books(&env);
}

#[test]
fn each_call_is_priced_at_the_oracle_value_of_the_moment() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    let sol = env.sol;
    let me = borrower(&mut env, 10 * SOL, 0, 95).pubkey();
    let liq = liquidator(&mut env);

    env.set_price(&sol, 120 * USDC);
    expect_ok(liquidate(&mut env, &liq, &me, &sol, 100 * USDC));
    env.set_price(&sol, 100 * USDC);
    expect_ok(liquidate(&mut env, &liq, &me, &sol, 100 * USDC));
    assert_eq!(env.balance(&sol, &liq.pubkey()), 875_000_000 + 1_050_000_000);

    // A recovery between calls ends the liquidation
    env.set_price(&sol, 150 * USDC);
    expect_err(liquidate(&mut env, &liq, &me, &sol, 100 * USDC), PluribusError::NotLiquidatable);
    assert_eq!(spent(&env, &liq), 200 * USDC);
    assert_books(&env);
}

#[test]
fn no_liquidation_costs_the_margin_more_than_rounding_tops_the_bonus_or_breaks_the_books() {
    for sol_price in [120, 100, 70, 40] {
        for asked in [1, 2, 17, 999, USDC, 250 * USDC, u64::MAX] {
            for take_stock in [false, true] {
                let mut env = Env::new();
                let lender = env.lender(100_000 * USDC);
                let (sol, stock) = (env.sol, env.stock);
                let me = borrower(&mut env, 10 * SOL, 10 * STOCK, 95).pubkey();
                let liq = liquidator(&mut env);
                // A month of interest, so that debt and debt shares are no longer one to one
                env.warp(30 * DAY);
                // The stock falls alongside SOL
                let stock_price = 200 * sol_price / 150;
                env.set_price(&sol, sol_price * USDC);
                env.set_price(&stock, stock_price * USDC);
                let (mint, price, unit) = if take_stock { (stock, stock_price * USDC, STOCK) } else { (sol, sol_price * USDC, SOL) };
                let wallets = [me, liq.pubkey(), lender.pubkey()];
                let (h, usdc_before) = (env.health(&me), total_usdc(&env, &wallets));
                let case = format!("sol at ${sol_price}, asked {asked}, stock {take_stock}");

                let res = liquidate(&mut env, &liq, &me, &mint, asked);
                if with_bonus(asked, price, unit) == 0 {
                    // Too little to buy one base unit of the collateral
                    expect_err(res, PluribusError::ZeroAmount);
                    continue;
                }
                expect_ok(res);
                let (paid, seized) = (spent(&env, &liq), env.balance(&mint, &liq.pubkey()));
                assert!(paid <= asked.min(h.debt / 2), "{case}");
                assert!(seized as u128 * price as u128 * 10_000 <= paid as u128 * 10_500 * unit as u128, "{case}");
                assert!(margin(&mut env, &me) + ROUNDING >= h.liquidation_limit as i128 - h.debt as i128, "{case}");
                assert_eq!(total_usdc(&env, &wallets), usdc_before, "{case}");
                assert_books(&env);
            }
        }
    }
}

#[test]
fn dust_calls_after_interest_cost_the_margin_no_more_than_rounding() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    let (sol, usdc) = (env.sol, env.usdc);
    let user = env.user();
    let me = user.pubkey();
    env.deposit(&user, &sol, 10 * SOL);
    env.deposit(&user, &usdc, 2000 * USDC);
    expect_ok(env.draw(&user, 2950 * USDC));
    let liq = liquidator(&mut env);
    env.warp(30 * DAY);
    env.set_price(&sol, 120 * USDC);

    for asked in 1..=20 {
        let (before, paid, seized) = (margin(&mut env, &me), spent(&env, &liq), env.balance(&sol, &liq.pubkey()));
        expect_ok(liquidate(&mut env, &liq, &me, &sol, asked));
        let (paid, seized) = (spent(&env, &liq) - paid, env.balance(&sol, &liq.pubkey()) - seized);
        // Whatever the margin lost went to rounding, never to the liquidator
        assert!(seized as u128 * 120 * USDC as u128 * 10_000 <= paid as u128 * 10_500 * SOL as u128, "asked {asked}");
        let after = margin(&mut env, &me);
        assert!(after + ROUNDING >= before, "asked {asked}: margin went from {before} to {after}");

        expect_ok(env.send(&[env.repay_from_collateral_ix(&liq.pubkey(), &me, asked)], &[&liq]));
        let netted = margin(&mut env, &me);
        assert!(netted + ROUNDING >= after, "netting {asked}: margin went from {after} to {netted}");
    }
    assert_books(&env);
}

#[test]
fn a_dust_liquidation_that_demotes_the_tier_costs_the_margin_no_more_than_rounding() {
    // Three steps round against the borrower here, one base unit each while the index is under two
    // They are the repayment's share count, the shares re-minted in the base tier, and the debt read back
    const TIER_MOVE_ROUNDING: i128 = ROUNDING + 2;
    // The rounding depends on where the indices sit, so the same call is tried at a run of timestamps
    for extra in 0..20 {
        let mut env = Env::new();
        env.lender(10_000 * USDC);
        let sol = env.sol;
        let me = borrower(&mut env, 60 * SOL, 0, 97).pubkey();
        let liq = liquidator(&mut env);
        env.warp(31 * DAY);
        env.set_price(&sol, 150 * USDC);
        expect_ok(env.send(&[env.refresh_tier_ix(&me)], &[&liq]));
        assert_eq!(env.credit(&me).tier, 2);
        env.warp(365 * DAY + extra);
        env.set_price(&sol, 120 * USDC);

        let before = env.health(&me);
        expect_ok(liquidate(&mut env, &liq, &me, &sol, 1));
        let after = env.health(&me);
        let cost = (before.liquidation_limit as i128 - before.debt as i128) - (after.liquidation_limit as i128 - after.debt as i128);
        assert!(
            cost <= TIER_MOVE_ROUNDING,
            "{extra}s in: 1 unit paid, debt {} to {}, limit {} to {}",
            before.debt,
            after.debt,
            before.liquidation_limit,
            after.liquidation_limit
        );
    }
}

#[test]
fn self_liquidation_leaves_the_borrower_no_richer_than_a_plain_repayment() {
    // Wallet plus account equity at the oracle price, before and after, and the debt left
    let run = |self_liquidate: bool| {
        let mut env = Env::new();
        env.lender(100_000 * USDC);
        let (sol, usdc) = (env.sol, env.usdc);
        let user = borrower(&mut env, 10 * SOL, 0, 95);
        let me = user.pubkey();
        env.set_price(&sol, 120 * USDC);
        let worth = |env: &mut Env| {
            let h = env.health(&me);
            let wallet = env.balance(&usdc, &me) as i128 + env.balance(&sol, &me) as i128 * 120 * USDC as i128 / SOL as i128;
            wallet + h.collateral_value as i128 - h.debt as i128
        };
        let before = worth(&mut env);
        let ix = if self_liquidate { env.liquidate_ix(&me, &me, &sol, 300 * USDC) } else { env.repay_ix(&me, &me, 300 * USDC) };
        expect_ok(env.send(&[ix], &[&user]));
        (before, worth(&mut env), env.debt(&me))
    };
    let (before, liquidated, debt) = run(true);
    let (_, repaid, debt_repaid) = run(false);
    assert!(liquidated <= before);
    assert!(liquidated <= repaid);
    assert_eq!(debt, debt_repaid);
}

#[test]
fn liquidation_drops_the_account_to_the_base_tier_and_restarts_its_clock() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    let sol = env.sol;
    let user = env.user();
    let me = user.pubkey();
    env.deposit(&user, &sol, 10 * SOL);
    expect_ok(env.draw(&user, 900 * USDC));
    let liq = liquidator(&mut env);
    env.warp(8 * DAY);
    env.set_price(&sol, 150 * USDC);
    expect_ok(env.send(&[env.refresh_tier_ix(&me)], &[&liq]));
    assert_eq!(env.credit(&me).tier, 1);

    env.warp(DAY);
    env.set_price(&sol, 110 * USDC);
    let debt = env.health(&me).debt;
    expect_ok(liquidate(&mut env, &liq, &me, &sol, 100 * USDC));
    let (credit, pool) = (env.credit(&me), env.pool_state());
    assert_eq!((credit.tier, credit.healthy_since), (0, env.now()));
    assert_eq!(pool.debt_shares, [credit.debt_shares, 0, 0]);
    // Changing tier never forgives debt
    let left = env.debt(&me);
    assert!((debt - 100 * USDC..=debt - 100 * USDC + 2).contains(&left), "debt {left}");
    // Still under water, so a refresh cannot hand the discount back
    expect_ok(env.send(&[env.refresh_tier_ix(&me)], &[&liq]));
    assert_eq!(env.credit(&me).tier, 0);
    assert_books(&env);
}

// Dust

#[test]
fn one_unit_repayments_never_pay_out_more_than_the_bonus() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    let sol = env.sol;
    let me = borrower(&mut env, 10 * SOL, 0, 95).pubkey();
    let liq = liquidator(&mut env);
    env.set_price(&sol, 120 * USDC);
    let margin_before = margin(&mut env, &me);
    for _ in 0..10 {
        expect_ok(liquidate(&mut env, &liq, &me, &sol, 1));
    }
    // One millionth of a dollar plus 5% is 8.75 lamports at $120, and the fraction stays with the borrower
    assert_eq!(env.balance(&sol, &liq.pubkey()), 80);
    assert_eq!((spent(&env, &liq), env.debt(&me)), (10, 947_625_000 - 10));
    assert!(margin(&mut env, &me) >= margin_before);
    assert_books(&env);
}

#[test]
fn dust_position_is_taken_whole_and_charged_its_value_rounded_up() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    let (sol, stock) = (env.sol, env.stock);
    // One base unit of stock is worth 200 millionths of a dollar
    let me = borrower(&mut env, 10 * SOL, 1, 95).pubkey();
    let liq = liquidator(&mut env);
    env.set_price(&sol, 120 * USDC);
    let margin_before = margin(&mut env, &me);

    expect_ok(liquidate(&mut env, &liq, &me, &stock, u64::MAX));
    assert_eq!((env.balance(&stock, &liq.pubkey()), spent(&env, &liq)), (1, discounted(200)));
    assert_eq!(env.credit(&me).positions[1], Position::default());
    assert!(margin(&mut env, &me) >= margin_before);
    assert_books(&env);
}

/// Crashes SOL to $40 and liquidates all but 25 lamports of a 10 SOL account
fn leave_dust(env: &mut Env) -> (Pubkey, Keypair) {
    env.lender(100_000 * USDC);
    let sol = env.sol;
    let me = borrower(env, 10 * SOL, 0, 95).pubkey();
    let liq = liquidator(env);
    env.set_price(&sol, 40 * USDC);
    // One unit short of the price of all 10 SOL
    expect_ok(liquidate(env, &liq, &me, &sol, discounted(400 * USDC) - 1));
    assert_eq!(env.credit(&me).positions[0].amount, 25);
    assert_eq!(env.pool_state().bad_debt, 0);
    (me, liq)
}

#[test]
fn dust_left_behind_can_be_taken_and_then_the_debt_is_written_off() {
    let mut env = Env::new();
    let (me, liq) = leave_dust(&mut env);
    let sol = env.sol;
    expect_ok(liquidate(&mut env, &liq, &me, &sol, u64::MAX));
    assert_eq!((env.balance(&sol, &liq.pubkey()), spent(&env, &liq)), (10 * SOL, discounted(400 * USDC)));
    assert_eq!(env.credit(&me).debt_shares, 0);
    assert_eq!(env.pool_state().bad_debt, 947_625_000 - discounted(400 * USDC));
    assert_books(&env);
}

#[test]
fn dust_left_behind_can_still_be_taken_after_interest_accrues() {
    let mut env = Env::new();
    let (me, liq) = leave_dust(&mut env);
    let sol = env.sol;
    env.warp(DAY);
    env.set_price(&sol, 40 * USDC);
    let owed = env.health(&me).debt;
    expect_ok(liquidate(&mut env, &liq, &me, &sol, u64::MAX));
    // The last unit paid is too little to retire a debt share, and the dust goes all the same
    assert_eq!((env.balance(&sol, &liq.pubkey()), spent(&env, &liq)), (10 * SOL, discounted(400 * USDC)));
    assert!(!env.credit(&me).has_collateral());
    assert_eq!((env.credit(&me).debt_shares, env.pool_state().bad_debt), (0, owed));
    assert_books(&env);
}

#[test]
fn one_unit_of_usdc_collateral_does_not_shield_bad_debt_from_the_write_off() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    let (sol, usdc) = (env.sol, env.usdc);
    let user = env.user();
    let me = user.pubkey();
    env.deposit(&user, &sol, 10 * SOL);
    env.deposit(&user, &usdc, 1);
    expect_ok(env.draw(&user, 947 * USDC));
    let liq = liquidator(&mut env);
    env.warp(DAY);
    env.set_price(&sol, 40 * USDC);
    expect_ok(liquidate(&mut env, &liq, &me, &sol, u64::MAX));
    assert_eq!(env.balance(&sol, &liq.pubkey()), 10 * SOL);

    // All that is left against the remaining debt is the single unit of USDC
    let owed = env.debt(&me);
    expect_ok(env.send(&[env.repay_from_collateral_ix(&liq.pubkey(), &me, u64::MAX)], &[&liq]));
    assert!(!env.credit(&me).has_collateral());
    assert_eq!((env.credit(&me).debt_shares, env.pool_state().bad_debt), (0, owed));
    assert_books(&env);
}

// Bad debt

#[test]
fn repeated_liquidations_run_the_collateral_out_and_the_last_one_writes_off_the_rest() {
    let mut env = Env::new();
    let lender = env.lender(100_000 * USDC);
    let (sol, usdc, shares) = (env.sol, env.usdc, env.share_mint);
    let me = borrower(&mut env, 10 * SOL, 0, 95).pubkey();
    let liq = liquidator(&mut env);
    // 10 SOL at $90 no longer cover the $947.625 owed
    env.set_price(&sol, 90 * USDC);

    let mut calls = 0;
    while env.credit(&me).has_collateral() {
        let (debt, paid, margin_before) = (env.debt(&me), spent(&env, &liq), margin(&mut env, &me));
        expect_ok(liquidate(&mut env, &liq, &me, &sol, u64::MAX));
        assert!(spent(&env, &liq) - paid <= debt / 2);
        assert!(margin(&mut env, &me) >= margin_before);
        assert_books(&env);
        calls += 1;
    }
    assert_eq!(calls, 4);
    assert_eq!(env.balance(&sol, &liq.pubkey()), 10 * SOL);
    // Rounding on each call goes against the liquidator, never below the collateral's value less the bonus
    let repaid = spent(&env, &liq);
    assert!((discounted(900 * USDC)..discounted(900 * USDC) + calls).contains(&repaid), "repaid {repaid}");

    let pool = env.pool_state();
    assert_eq!(env.credit(&me).debt_shares, 0);
    assert_eq!(pool.bad_debt, 947_625_000 - repaid);
    // No insurance reserve yet, so lenders carry all of it
    assert_eq!(pool.lender_assets().unwrap(), (100_000 * USDC - pool.bad_debt) as u128);
    let held = env.balance(&shares, &lender.pubkey());
    expect_ok(env.send(&[env.lend_withdraw_ix(&lender.pubkey(), held)], &[&lender]));
    assert_eq!(env.balance(&usdc, &lender.pubkey()), 100_000 * USDC - pool.bad_debt);
    assert_books(&env);
}

#[test]
fn write_off_waits_until_the_last_position_is_gone() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    let (sol, stock) = (env.sol, env.stock);
    let me = borrower(&mut env, 10 * SOL, 10 * STOCK, 95).pubkey();
    let liq = liquidator(&mut env);
    env.set_price(&sol, 20 * USDC);
    env.set_price(&stock, 50 * USDC);

    // All 10 SOL go for their $200 less the bonus, and the stock still stands behind the rest
    expect_ok(liquidate(&mut env, &liq, &me, &sol, u64::MAX));
    assert_eq!((env.balance(&sol, &liq.pubkey()), spent(&env, &liq)), (10 * SOL, discounted(200 * USDC)));
    assert_eq!((env.debt(&me), env.pool_state().bad_debt), (2_262_187_500 - discounted(200 * USDC), 0));

    expect_ok(liquidate(&mut env, &liq, &me, &stock, u64::MAX));
    let repaid = discounted(200 * USDC) + discounted(500 * USDC);
    assert_eq!((env.balance(&stock, &liq.pubkey()), spent(&env, &liq)), (10 * STOCK, repaid));
    let credit = env.credit(&me);
    assert!(!credit.has_collateral());
    assert_eq!((credit.debt_shares, env.pool_state().bad_debt), (0, 2_262_187_500 - repaid));
    assert_eq!(env.pool_state().debt_shares, [0; TIERS]);

    // Nothing is left to seize or to write off a second time
    expect_err(liquidate(&mut env, &liq, &me, &sol, u64::MAX), PluribusError::PositionNotFound);
    assert_books(&env);
}

#[test]
fn reserves_absorb_bad_debt_before_lenders_do() {
    let mut env = Env::new();
    let lender = env.lender(100_000 * USDC);
    let (sol, usdc, shares) = (env.sol, env.usdc, env.share_mint);
    // A large healthy loan earns the interest that fills the reserve and the protocol's cut
    borrower(&mut env, 1000 * SOL, 0, 45);
    let small = borrower(&mut env, SOL, 0, 95).pubkey();
    let big = borrower(&mut env, 10 * SOL, 0, 95).pubkey();
    let liq = liquidator(&mut env);
    env.warp(365 * DAY);
    env.set_price(&sol, 40 * USDC);
    expect_ok(env.send(&[env.accrue_ix()], &[&liq]));
    let start = env.pool_state();
    assert!(start.reserves > 250 * USDC);

    // 1 SOL at $40 against about $100 of debt: the reserve covers the whole loss
    let debt = env.debt(&small);
    expect_ok(liquidate(&mut env, &liq, &small, &sol, u64::MAX));
    let mid = env.pool_state();
    let paid = discounted(40 * USDC);
    assert_eq!((spent(&env, &liq), env.credit(&small).debt_shares), (paid, 0));
    // What is left of the debt is the loss, rounded up by at most a base unit
    assert!((debt - paid..=debt - paid + 1).contains(&mid.bad_debt), "loss {}", mid.bad_debt);
    assert_eq!((mid.reserves, mid.protocol_fees), (start.reserves - mid.bad_debt, start.protocol_fees));
    // Lenders lose nothing: their assets move only by the debt that left the books, the cash paid and the reserve used
    let gone = start.total_debt().unwrap() - mid.total_debt().unwrap();
    assert_eq!(mid.lender_assets().unwrap() + gone, start.lender_assets().unwrap() + (paid + mid.bad_debt) as u128);
    assert!(mid.lender_assets().unwrap() >= start.lender_assets().unwrap());

    // 10 SOL at $40 against about $1005: more than the reserve and the protocol's uncollected fees together
    let debt = env.debt(&big);
    expect_ok(liquidate(&mut env, &liq, &big, &sol, u64::MAX));
    let end = env.pool_state();
    let (loss, paid) = (end.bad_debt - mid.bad_debt, discounted(400 * USDC));
    assert_eq!(env.credit(&big).debt_shares, 0);
    assert!((debt - paid..=debt - paid + 1).contains(&loss), "loss {loss}");
    assert!(loss > mid.reserves + mid.protocol_fees);
    // The reserve empties first, the protocol's fees go next, and lenders take only what is left
    assert_eq!((end.reserves, end.protocol_fees), (0, 0));
    let (assets, assets_end) = (mid.lender_assets().unwrap(), end.lender_assets().unwrap());
    let gone = (mid.total_debt().unwrap() - end.total_debt().unwrap()) as u64;
    assert_eq!(assets - assets_end, (gone - paid - mid.reserves - mid.protocol_fees) as u128);
    assert!((loss - 1..=loss + 1).contains(&(gone - paid)), "debt off the books {gone}, paid {paid}, loss {loss}");

    // The share price fell by the uncovered part and withdrawals pay the new price
    let supply = env.balance(&shares, &lender.pubkey()) as u128;
    expect_ok(env.send(&[env.lend_withdraw_ix(&lender.pubkey(), 1000 * USDC)], &[&lender]));
    let out = env.balance(&usdc, &lender.pubkey()) as u128;
    let unit = pluribus::constants::VIRTUAL_SHARES;
    assert_eq!(out, 1000 * USDC as u128 * (assets_end + unit) / (supply + unit));
    assert!(out < 1000 * USDC as u128 * (assets + unit) / (supply + unit));
    assert_books(&env);
}

// LP positions

#[test]
fn lp_liquidation_sells_the_nft_at_the_bonus_and_parks_the_excess_as_usdc_collateral() {
    for program in [TOKEN, TOKEN_2022] {
        let mut env = Env::new();
        let lender = env.lender(1_000_000 * USDC);
        let (sol, usdc) = (env.sol, env.usdc);
        let (user, nft) = lp_borrower(&mut env, 10_000, &program);
        let (me, drawn) = (user.pubkey(), env.balance(&usdc, &user.pubkey()));
        let liq = liquidator(&mut env);
        env.fund(&nft, &liq.pubkey(), 0);
        let outsider = env.wallet();
        env.warp(3600);
        env.set_price(&sol, 120 * USDC);

        let h = env.health(&me);
        assert!(h.debt > h.liquidation_limit);
        let (payment, repay) = (discounted(h.position_value[0]), h.debt / 2);
        // Even after the bonus the position is worth more than half the debt
        assert!(payment > repay);
        let vault_nft = ata(&env.pool, &nft, &program);
        let (rent, lamports) = (env.svm.get_balance(&vault_nft).unwrap(), env.svm.get_balance(&me).unwrap());
        let wallets = [me, liq.pubkey(), lender.pubkey()];
        let (usdc_before, cash_before) = (total_usdc(&env, &wallets), env.pool_state().cash);

        expect_ok(env.send(&[env.liquidate_lp_ix(&liq.pubkey(), &me, &nft)], &[&liq]));
        assert_eq!((env.balance(&nft, &liq.pubkey()), spent(&env, &liq)), (1, payment));
        let credit = env.credit(&me);
        let parked = credit.positions[0];
        assert_eq!((parked.kind, parked.mint, parked.amount), (KIND_TOKEN, usdc, payment - repay));
        assert!(credit.positions[1..].iter().all(|p| p.kind == KIND_EMPTY));
        assert_eq!((credit.tier, credit.healthy_since), (0, env.now()));
        let debt = env.debt(&me);
        assert!((h.debt - repay..=h.debt - repay + 1).contains(&debt), "debt {debt}");
        // The NFT vault is closed and its rent is back with the owner
        assert_eq!(env.svm.get_balance(&vault_nft).unwrap_or(0), 0);
        assert_eq!(env.svm.get_balance(&me).unwrap(), lamports + rent);
        assert!(margin(&mut env, &me) + ROUNDING >= h.liquidation_limit as i128 - h.debt as i128);
        assert_eq!(total_usdc(&env, &wallets), usdc_before);
        assert_books(&env);

        // Healthy again, so an outsider cannot touch the parked USDC
        expect_err(env.send(&[env.repay_from_collateral_ix(&outsider.pubkey(), &me, u64::MAX)], &[&outsider]), PluribusError::NotLiquidatable);
        // The owner clears the debt with it and takes the rest home
        expect_ok(env.send(&[env.repay_from_collateral_ix(&me, &me, u64::MAX)], &[&user]));
        assert_eq!(env.debt(&me), 0);
        let rest = payment - repay - debt;
        expect_ok(env.send(&[env.withdraw_token_ix(&me, &usdc, rest)], &[&user]));
        assert!(!env.credit(&me).has_collateral());
        // Every unit the liquidator paid is either in the pool or with the borrower
        assert_eq!(env.balance(&usdc, &me), drawn + rest);
        assert_eq!(env.pool_state().cash, cash_before + payment - rest);
        assert_eq!(total_usdc(&env, &wallets), usdc_before);
        assert_books(&env);
    }
}

#[test]
fn lp_payment_under_the_cap_all_goes_to_debt_and_leaves_no_usdc_position() {
    let mut env = Env::new();
    env.lender(1_000_000 * USDC);
    let (sol, usdc) = (env.sol, env.usdc);
    let user = env.user();
    let me = user.pubkey();
    env.deposit(&user, &sol, 100 * SOL);
    let nft = add_lp(&mut env, &user, 1000, &TOKEN);
    let limit = env.health(&me).credit_limit;
    expect_ok(env.draw(&user, limit));
    let liq = liquidator(&mut env);
    env.fund(&nft, &liq.pubkey(), 0);
    env.set_price(&sol, 120 * USDC);

    let h = env.health(&me);
    let payment = discounted(h.position_value[1]);
    assert!(h.debt > h.liquidation_limit && payment < h.debt / 2);
    expect_ok(env.send(&[env.liquidate_lp_ix(&liq.pubkey(), &me, &nft)], &[&liq]));
    assert_eq!((env.balance(&nft, &liq.pubkey()), spent(&env, &liq)), (1, payment));
    assert_eq!(env.debt(&me), h.debt - payment);
    let credit = env.credit(&me);
    assert!(credit.positions[1..].iter().all(|p| p.kind == KIND_EMPTY));
    assert_eq!(env.token_amount(&env.vault_pda(&usdc)), 0);
    assert!(margin(&mut env, &me) >= h.liquidation_limit as i128 - h.debt as i128);
    assert_books(&env);
}

#[test]
fn lp_liquidation_with_every_slot_full_reuses_the_freed_slot_for_the_excess() {
    let mut env = Env::new();
    env.lender(1_000_000 * USDC);
    let (sol, stock, usdc) = (env.sol, env.stock, env.usdc);
    let user = env.user();
    let me = user.pubkey();
    env.deposit(&user, &sol, SOL);
    env.deposit(&user, &stock, STOCK);
    let nft = add_lp(&mut env, &user, 100_000, &TOKEN);
    add_lp(&mut env, &user, 1000, &TOKEN);
    add_lp(&mut env, &user, 1000, &TOKEN);
    let limit = env.health(&me).credit_limit;
    expect_ok(env.draw(&user, limit));
    let liq = liquidator(&mut env);
    env.fund(&nft, &liq.pubkey(), 0);
    env.set_price(&sol, 120 * USDC);

    let h = env.health(&me);
    let (payment, repay) = (discounted(h.position_value[2]), h.debt / 2);
    assert!(h.debt > h.liquidation_limit && payment > repay);
    expect_ok(env.send(&[env.liquidate_lp_ix(&liq.pubkey(), &me, &nft)], &[&liq]));
    let credit = env.credit(&me);
    let parked = credit.positions[2];
    assert_eq!((parked.kind, parked.mint, parked.amount), (KIND_TOKEN, usdc, payment - repay));
    assert!(credit.positions.iter().all(|p| p.kind != KIND_EMPTY));
    assert_eq!(spent(&env, &liq), payment);
    assert!(margin(&mut env, &me) >= h.liquidation_limit as i128 - h.debt as i128);
    assert_books(&env);
}

#[test]
fn lp_liquidation_of_the_last_position_writes_off_what_the_payment_cannot_cover() {
    let mut env = Env::new();
    env.lender(1_000_000 * USDC);
    let sol = env.sol;
    let (user, nft) = lp_borrower(&mut env, 10_000, &TOKEN);
    let me = user.pubkey();
    let liq = liquidator(&mut env);
    env.fund(&nft, &liq.pubkey(), 0);
    // At $40 the position is worth less than half the debt
    env.set_price(&sol, 40 * USDC);
    let h = env.health(&me);
    let payment = discounted(h.position_value[0]);
    assert!(payment < h.debt / 2);

    expect_ok(env.send(&[env.liquidate_lp_ix(&liq.pubkey(), &me, &nft)], &[&liq]));
    let credit = env.credit(&me);
    assert!(!credit.has_collateral());
    assert_eq!((spent(&env, &liq), credit.debt_shares), (payment, 0));
    assert_eq!(env.pool_state().bad_debt, h.debt - payment);
    assert_books(&env);
}

/// Liquidates a position that sits above its range, all USDC, after a year of interest took its debt past the limit
/// The admin first sets the bonus and the LP liquidation cost, and a refusal there is returned as it is
fn liquidate_lp_above_its_range(bonus_bps: u16, lp_cost_bps: u16) -> TxResult {
    let mut env = Env::new();
    env.lender(1_000_000 * USDC);
    let (sol, whirlpool) = (env.sol, env.whirlpool);
    let admin = env.admin.insecure_clone();
    let params = PoolParams { liq_bonus_bps: bonus_bps, ..default_params() };
    env.send(&[env.set_params_ix(&admin.pubkey(), params), env.set_lp_market_ix(&whirlpool, lp_cost_bps, false)], &[&admin])?;
    // At $300 no SOL shock brings the price back into the 120 to 180 range, so the value does not move
    env.set_price(&sol, 300 * USDC);
    let (user, nft) = lp_borrower(&mut env, 10_000, &TOKEN);
    let liq = liquidator(&mut env);
    env.fund(&nft, &liq.pubkey(), 0);
    env.warp(365 * DAY);
    env.set_price(&sol, 300 * USDC);
    assert!(margin(&mut env, &user.pubkey()) < 0);
    env.send(&[env.liquidate_lp_ix(&liq.pubkey(), &user.pubkey(), &nft)], &[&liq])
}

#[test]
fn every_bonus_and_lp_cost_the_program_accepts_can_liquidate_a_position_above_its_range() {
    // The defaults, the largest bonus a 5% cost leaves room for, and no bonus against no cost
    for (bonus, cost) in [(500, 500), (526, 500), (0, 0)] {
        expect_ok(liquidate_lp_above_its_range(bonus, cost));
    }
    // A bonus that outweighs the haircut would have the margin check refuse every liquidation of such a position
    for (bonus, cost) in [(527, 500), (600, 500), (500, 400)] {
        expect_err(liquidate_lp_above_its_range(bonus, cost), PluribusError::InvalidParams);
    }
}

#[test]
fn self_liquidating_an_lp_position_gains_nothing() {
    let mut env = Env::new();
    env.lender(1_000_000 * USDC);
    let (sol, usdc) = (env.sol, env.usdc);
    let (user, nft) = lp_borrower(&mut env, 10_000, &TOKEN);
    let me = user.pubkey();
    env.fund(&usdc, &me, 20_000 * USDC);
    env.set_price(&sol, 120 * USDC);

    // The NFT counts at its oracle value whether it sits in the account or in the wallet
    let before = env.health(&me);
    expect_ok(env.send(&[env.liquidate_lp_ix(&me, &me, &nft)], &[&user]));
    let after = env.health(&me);
    assert_eq!(env.balance(&nft, &me), 1);
    let worth_before = 20_000 * USDC as i128 + before.collateral_value as i128 - before.debt as i128;
    let worth_after = env.balance(&usdc, &me) as i128 + before.collateral_value as i128 + after.collateral_value as i128 - after.debt as i128;
    assert!(worth_after <= worth_before, "{worth_after} against {worth_before}");
    assert_books(&env);
}

// USDC collateral

#[test]
fn outsiders_net_usdc_collateral_only_while_liquidatable_and_within_the_cap() {
    let mut env = Env::new();
    let lender = env.lender(100_000 * USDC);
    let (sol, usdc) = (env.sol, env.usdc);
    let user = env.user();
    let me = user.pubkey();
    env.deposit(&user, &sol, 10 * SOL);
    env.deposit(&user, &usdc, 2000 * USDC);
    expect_ok(env.draw(&user, 2950 * USDC));
    let outsider = env.wallet();
    env.fund(&usdc, &outsider.pubkey(), 0);
    let net = |env: &mut Env, caller: &Keypair, amount: u64| env.send(&[env.repay_from_collateral_ix(&caller.pubkey(), &me, amount)], &[caller]);
    let parked = |env: &Env| env.token_amount(&env.vault_pda(&usdc));

    expect_err(net(&mut env, &outsider, 100 * USDC), PluribusError::NotLiquidatable);
    // The owner may, in any amount, and it costs nothing in standing
    env.warp(3600);
    env.set_price(&sol, 150 * USDC);
    let (owed, opened) = (env.health(&me).debt, env.credit(&me).healthy_since);
    expect_ok(net(&mut env, &user, 100 * USDC));
    let debt = env.debt(&me);
    assert!((owed - 100 * USDC..=owed - 100 * USDC + 1).contains(&debt), "debt {debt}");
    assert_eq!((parked(&env), env.credit(&me).healthy_since), (1900 * USDC, opened));

    env.set_price(&sol, 120 * USDC);
    let h = env.health(&me);
    assert!(h.debt > h.liquidation_limit);
    let wallets = [me, outsider.pubkey(), lender.pubkey()];
    let usdc_before = total_usdc(&env, &wallets);

    // Asking for everything still nets only half the debt
    expect_ok(net(&mut env, &outsider, u64::MAX));
    assert_eq!(parked(&env), 1900 * USDC - h.debt / 2);
    let debt = env.debt(&me);
    assert!((h.debt - h.debt / 2..=h.debt - h.debt / 2 + 1).contains(&debt), "debt {debt}");
    let credit = env.credit(&me);
    assert_eq!((credit.tier, credit.healthy_since), (0, env.now()));

    // The second call takes what is left, and the SOL still stands behind the rest
    expect_ok(net(&mut env, &outsider, u64::MAX));
    assert_eq!(parked(&env), 0);
    assert!(env.debt(&me) > 0 && env.pool_state().bad_debt == 0);
    // No bonus is paid for netting
    assert_eq!(env.balance(&usdc, &outsider.pubkey()), 0);
    assert_eq!(total_usdc(&env, &wallets), usdc_before);
    assert_books(&env);
}

/// An LP-only account after a crash to $80 and one LP liquidation, left with less USDC collateral than debt
fn underwater_after_lp_liquidation(env: &mut Env) -> Keypair {
    env.lender(1_000_000 * USDC);
    let sol = env.sol;
    let (user, nft) = lp_borrower(env, 10_000, &TOKEN);
    let me = user.pubkey();
    let liq = liquidator(env);
    env.fund(&nft, &liq.pubkey(), 0);
    env.set_price(&sol, 80 * USDC);
    expect_ok(env.send(&[env.liquidate_lp_ix(&liq.pubkey(), &me, &nft)], &[&liq]));
    let h = env.health(&me);
    assert!(h.collateral_value > 0 && h.collateral_value < h.debt);
    user
}

#[test]
fn outsiders_netting_the_last_usdc_collateral_trigger_the_write_off() {
    let mut env = Env::new();
    let me = underwater_after_lp_liquidation(&mut env).pubkey();
    let outsider = env.wallet();
    let h = env.health(&me);
    let mut calls = 0;
    while env.credit(&me).has_collateral() {
        expect_ok(env.send(&[env.repay_from_collateral_ix(&outsider.pubkey(), &me, u64::MAX)], &[&outsider]));
        calls += 1;
    }
    assert_eq!(calls, 2);
    assert_eq!(env.credit(&me).debt_shares, 0);
    assert_eq!(env.pool_state().bad_debt, h.debt - h.collateral_value);
    assert_books(&env);
}

#[test]
fn owner_netting_the_last_usdc_collateral_triggers_the_write_off() {
    let mut env = Env::new();
    let user = underwater_after_lp_liquidation(&mut env);
    let me = user.pubkey();
    let h = env.health(&me);
    expect_ok(env.send(&[env.repay_from_collateral_ix(&me, &me, u64::MAX)], &[&user]));
    assert!(!env.credit(&me).has_collateral());
    assert_eq!(env.credit(&me).debt_shares, 0);
    assert_eq!(env.pool_state().bad_debt, h.debt - h.collateral_value);
    assert_books(&env);
}

#[test]
fn a_day_of_interest_on_a_usdc_backed_loan_is_not_written_off() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    let (usdc, admin) = (env.usdc, env.admin.insecure_clone());
    // USDC gets a shock group of its own: 3% off for draws and 1% off for liquidation
    // That gap is the room interest has before a USDC-backed loan can be touched
    let mut params = default_params();
    for scenario in 0..3 {
        params.init_shock_bps[scenario * pluribus::constants::MAX_GROUPS + 2] = 300;
        params.maint_shock_bps[scenario * pluribus::constants::MAX_GROUPS + 2] = 100;
    }
    expect_ok(env.send(&[env.set_params_ix(&admin.pubkey(), params)], &[&admin]));
    let asset: pluribus::state::Asset = env.load(&env.asset_pda(&usdc));
    let grouped = pluribus::state::AssetParams { group: 2, ..asset.params };
    expect_ok(env.send(&[env.set_asset_ix(&admin.pubkey(), &usdc, grouped)], &[&admin]));

    let user = env.user();
    let me = user.pubkey();
    let outsider = liquidator(&mut env);
    env.deposit(&user, &usdc, 10_000 * USDC);
    expect_err(env.draw(&user, 9_700 * USDC + 1), PluribusError::ExceedsCreditLimit);
    expect_ok(env.draw(&user, 9_700 * USDC));
    env.warp(DAY);

    // A day of interest leaves the loan inside the liquidation line, so nobody else can touch it
    let netting = env.repay_from_collateral_ix(&outsider.pubkey(), &me, u64::MAX);
    expect_err(env.send(&[netting], &[&outsider]), PluribusError::NotLiquidatable);
    // The borrower nets collateral against the debt, pays the interest out of it, and nothing is written off
    expect_ok(env.send(&[env.repay_from_collateral_ix(&me, &me, u64::MAX)], &[&user]));
    assert_eq!(env.debt(&me), 0);
    assert_eq!(env.pool_state().bad_debt, 0);
    let credit = env.credit(&me);
    let left = credit.positions[credit.find(pluribus::constants::KIND_TOKEN, &usdc).unwrap()].amount;
    assert!(left < 300 * USDC && left > 299 * USDC, "left {left}");
}

// Forged accounts

#[test]
fn liquidate_rejects_accounts_that_do_not_belong() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    let (sol, stock, usdc) = (env.sol, env.stock, env.usdc);
    let victim = env.user();
    let me = victim.pubkey();
    env.deposit(&victim, &sol, 10 * SOL);
    env.deposit(&victim, &usdc, 200 * USDC);
    expect_ok(env.draw(&victim, 1150 * USDC));
    // A neighbour, so that the stock vault holds tokens and another USDC wallet exists
    let other = borrower(&mut env, 0, 10 * STOCK, 50).pubkey();
    let liq = liquidator(&mut env);
    let payer = liq.pubkey();
    env.set_price(&sol, 120 * USDC);
    assert!(margin(&mut env, &me) < 0);

    // A quote of $1 for SOL in an account this program does not own
    let forged = Pubkey::new_unique();
    let quote = DemoPrice { mint: sol, price: USDC, conf: 0, publish_time: env.now(), bump: 0 };
    env.set_raw(forged, Pubkey::new_unique(), [discriminator::<DemoPrice>(), &borsh(&quote)].concat());

    let good = env.liquidate_ix(&payer, &me, &sol, 100 * USDC);
    let token_account = |owner: &Pubkey, mint: &Pubkey| ata(owner, mint, &TOKEN);
    let mut reordered = good.clone();
    reordered.accounts[LIQ_HEALTH..].rotate_right(1);
    let mut truncated = good.clone();
    truncated.accounts.truncate(LIQ_HEALTH + 2);
    // SPL Token's code for an authority that does not own the source account
    let owner_mismatch = 4;
    let duplicate: u32 = ErrorCode::ConstraintDuplicateMutableAccount.into();
    let cases = vec![
        ("mint the account does not hold", env.liquidate_ix(&payer, &me, &stock, 100 * USDC), PluribusError::PositionNotFound.into()),
        (
            "usdc collateral at a bonus",
            swap(env.liquidate_ix(&payer, &me, &usdc, 100 * USDC), LIQ_RECEIVER, token_account(&other, &usdc)),
            PluribusError::InvalidParams.into(),
        ),
        ("vault of another asset", swap(good.clone(), LIQ_VAULT, env.vault_pda(&stock)), ErrorCode::ConstraintHasOne.into()),
        (
            "asset and vault of another mint",
            swap(swap(good.clone(), LIQ_ASSET, env.asset_pda(&stock)), LIQ_VAULT, env.vault_pda(&stock)),
            ErrorCode::ConstraintSeeds.into(),
        ),
        ("collateral vault as the pool vault", swap(good.clone(), LIQ_USDC_VAULT, env.vault_pda(&usdc)), ErrorCode::ConstraintHasOne.into()),
        ("paying in another token", swap(good.clone(), LIQ_PAYER, token_account(&payer, &stock)), ErrorCode::ConstraintTokenMint.into()),
        ("paying from a neighbour's wallet", swap(good.clone(), LIQ_PAYER, token_account(&other, &usdc)), owner_mismatch),
        ("paying from the usdc collateral vault", swap(good.clone(), LIQ_PAYER, env.vault_pda(&usdc)), owner_mismatch),
        ("paying from the pool vault", swap(good.clone(), LIQ_PAYER, env.usdc_vault), duplicate),
        ("receiving into the vault", swap(good.clone(), LIQ_RECEIVER, env.vault_pda(&sol)), duplicate),
        ("receiving another token", swap(good.clone(), LIQ_RECEIVER, token_account(&payer, &stock)), ErrorCode::ConstraintTokenMint.into()),
        ("sol priced with the stock quote", swap(good.clone(), LIQ_HEALTH + 1, env.price_account(&stock)), PluribusError::InvalidPriceAccount.into()),
        ("forged quote", swap(good.clone(), LIQ_HEALTH + 1, forged), PluribusError::InvalidPriceAccount.into()),
        ("health accounts out of order", reordered, PluribusError::AccountMismatch.into()),
        ("health accounts cut short", truncated, PluribusError::MissingAccount.into()),
    ];
    assert_all_rejected(&mut env, &liq, &me, &[me, other, payer], cases);

    // The untouched instruction goes through, so every failure above came from the swapped account
    expect_ok(env.send(&[good], &[&liq]));
    assert_books(&env);
}

#[test]
fn liquidate_lp_rejects_accounts_that_do_not_belong() {
    let mut env = Env::new();
    env.lender(1_000_000 * USDC);
    let sol = env.sol;
    let (victim, nft) = lp_borrower(&mut env, 10_000, &TOKEN);
    let me = victim.pubkey();
    // A debt-free neighbour with a position of its own
    let neighbour = env.user();
    let other = neighbour.pubkey();
    let other_nft = add_lp(&mut env, &neighbour, 10_000, &TOKEN);
    let liq = liquidator(&mut env);
    let payer = liq.pubkey();
    env.fund(&nft, &payer, 0);
    env.fund(&other_nft, &payer, 0);
    env.set_price(&sol, 120 * USDC);
    assert!(margin(&mut env, &me) < 0);

    let good = env.liquidate_lp_ix(&payer, &me, &nft);
    let duplicate: u32 = ErrorCode::ConstraintDuplicateMutableAccount.into();
    let cases = vec![
        ("position of another account", env.liquidate_lp_ix(&payer, &me, &other_nft), PluribusError::PositionNotFound.into()),
        ("healthy neighbour", env.liquidate_lp_ix(&payer, &other, &other_nft), PluribusError::NotLiquidatable.into()),
        ("rent refund to the liquidator", swap(good.clone(), LP_OWNER, payer), ErrorCode::ConstraintAddress.into()),
        ("vault of another position", swap(good.clone(), LP_VAULT_NFT, ata(&env.pool, &other_nft, &TOKEN)), ErrorCode::ConstraintAssociated.into()),
        ("receiving another mint", swap(good.clone(), LP_RECEIVER, ata(&payer, &other_nft, &TOKEN)), ErrorCode::ConstraintTokenMint.into()),
        ("receiving into the vault", swap(good.clone(), LP_RECEIVER, ata(&env.pool, &nft, &TOKEN)), duplicate),
        ("pool vault as the collateral vault", swap(good.clone(), LP_COLLATERAL_VAULT, env.usdc_vault), duplicate),
        ("valued as another position", swap(good.clone(), LP_HEALTH + 1, orca_position(&other_nft)), PluribusError::AccountMismatch.into()),
    ];
    assert_all_rejected(&mut env, &liq, &me, &[me, other, payer], cases);

    expect_ok(env.send(&[good], &[&liq]));
    assert_eq!(env.balance(&nft, &payer), 1);
    assert_books(&env);
}
