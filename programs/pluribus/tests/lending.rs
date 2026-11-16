mod common;

use {
    anchor_lang::{error::ErrorCode, prelude::*, solana_program::instruction::Instruction, InstructionData, ToAccountMetas},
    common::*,
    pluribus::{constants::*, error::PluribusError, math, state::*},
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

const MILLION: u64 = 1_000_000 * USDC;
const YEAR: i64 = 365 * DAY;
// Account positions inside the lend instructions
const LEND_USDC: usize = 5;
const LEND_SHARES: usize = 6;
const LEND_TOKEN_PROGRAM: usize = 7;

/// Fixed-seed generator so every run takes the same path
struct Lcg(u64);

impl Lcg {
    fn below(&mut self, n: u64) -> u64 {
        self.0 = self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        (self.0 >> 33) % n
    }
}

fn open_junior(env: &mut Env) -> Pubkey {
    let admin = env.admin.insecure_clone();
    expect_ok(env.send(&[env.init_junior_ix(&admin.pubkey())], &[&admin]));
    env.junior_mint()
}

/// A wallet holding `usdc`, with an empty share account for every tranche that is open
fn lender(env: &mut Env, usdc: u64) -> Keypair {
    let wallet = env.wallet();
    let (mint, senior, junior) = (env.usdc, env.share_mint, env.junior_mint());
    env.fund(&mint, &wallet.pubkey(), usdc);
    env.fund(&senior, &wallet.pubkey(), 0);
    if env.svm.get_account(&junior).is_some() {
        env.fund(&junior, &wallet.pubkey(), 0);
    }
    wallet
}

/// A pool with both tranches open and one lender in each
fn two_tranches(senior_usdc: u64, junior_usdc: u64) -> (Env, Keypair, Keypair) {
    let mut env = Env::new();
    let junior_mint = open_junior(&mut env);
    let senior_mint = env.share_mint;
    let (senior, junior) = (lender(&mut env, senior_usdc), lender(&mut env, junior_usdc));
    expect_ok(deposit(&mut env, &senior, &senior_mint, senior_usdc));
    expect_ok(deposit(&mut env, &junior, &junior_mint, junior_usdc));
    (env, senior, junior)
}

fn deposit(env: &mut Env, who: &Keypair, share_mint: &Pubkey, amount: u64) -> TxResult {
    env.send(&[env.tranche_ix(&who.pubkey(), share_mint, amount, true)], &[who])
}

fn redeem(env: &mut Env, who: &Keypair, share_mint: &Pubkey, shares: u64) -> TxResult {
    env.send(&[env.tranche_ix(&who.pubkey(), share_mint, shares, false)], &[who])
}

fn top_up(env: &mut Env, who: &Pubkey, amount: u64) {
    let usdc = env.usdc;
    let held = env.balance(&usdc, who);
    env.fund(&usdc, who, held + amount);
}

fn supply(env: &Env, mint: &Pubkey) -> u64 {
    env.svm.get_account(mint).map_or(0, |a| u64::from_le_bytes(a.data[36..44].try_into().unwrap()))
}

/// Assets behind a tranche and its share supply
fn tranche(env: &Env, share_mint: &Pubkey) -> (u128, u128) {
    let assets = env.pool_state().tranche_assets(*share_mint == env.junior_mint()).unwrap();
    (assets, supply(env, share_mint) as u128)
}

/// Shares a deposit mints, with the tranche's virtual shares counted in
fn minted_for(amount: u128, (assets, supply): (u128, u128)) -> u128 {
    amount * (supply + VIRTUAL_SHARES) / (assets + VIRTUAL_SHARES)
}

/// What shares pay out with enough cash in the pool
fn paid_for(shares: u128, (assets, supply): (u128, u128)) -> u128 {
    if supply == 0 {
        return 0;
    }
    (shares * (assets + VIRTUAL_SHARES) / (supply + VIRTUAL_SHARES)).min(shares * assets / supply)
}

fn worth(env: &Env, share_mint: &Pubkey, who: &Pubkey) -> u128 {
    paid_for(env.balance(share_mint, who) as u128, tranche(env, share_mint))
}

/// Shares are plain SPL tokens, so a holder can burn them without going through the pool
fn burn_ix(holder: &Pubkey, mint: &Pubkey, amount: u64) -> Instruction {
    let data = [&[8u8][..], &amount.to_le_bytes()].concat();
    let metas = vec![AccountMeta::new(ata(holder, mint, &TOKEN), false), AccountMeta::new(*mint, false), AccountMeta::new_readonly(*holder, true)];
    Instruction::new_with_bytes(TOKEN, &data, metas)
}

/// An account backed by SOL that has drawn `usdc`, or as much as it may when `usdc` is None
fn borrower(env: &mut Env, sol_amount: u64, usdc: Option<u64>) -> Keypair {
    let sol = env.sol;
    let user = env.user();
    env.deposit(&user, &sol, sol_amount);
    // Debt rounds up once the index has moved, so stop a couple of base units short of the limit
    let amount = usdc.unwrap_or_else(|| env.health(&user.pubkey()).credit_limit - 2);
    expect_ok(env.draw(&user, amount));
    user
}

/// The program's view of an account and what it cost to compute, with room for more than the default compute budget
fn health_with_budget(env: &mut Env, owner: &Pubkey) -> (pluribus::instructions::HealthView, u64) {
    let mut metas = pluribus::accounts::ViewHealth { credit: env.credit_pda(owner), pool: env.pool }.to_account_metas(None);
    metas.extend(env.health_metas(owner));
    let view = Instruction::new_with_bytes(pluribus::ID, &pluribus::instruction::Health {}.data(), metas);
    let payer = env.admin.insecure_clone();
    env.svm.expire_blockhash();
    let msg = Message::new_with_blockhash(&[more_compute(), view], Some(&payer.pubkey()), &env.svm.latest_blockhash());
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&payer]).unwrap();
    let sim = env.svm.simulate_transaction(tx).expect("health view");
    (AnchorDeserialize::try_from_slice(&sim.meta.return_data.data).unwrap(), sim.meta.compute_units_consumed)
}

/// Asks for the largest compute budget a transaction can have
fn more_compute() -> Instruction {
    let data = [&[2u8][..], &1_400_000u32.to_le_bytes()].concat();
    Instruction::new_with_bytes(pubkey!("ComputeBudget111111111111111111111111111111"), &data, vec![])
}

fn liquidator(env: &mut Env) -> Keypair {
    let wallet = env.wallet();
    let (usdc, sol) = (env.usdc, env.sol);
    env.fund(&usdc, &wallet.pubkey(), MILLION);
    env.fund(&sol, &wallet.pubkey(), 0);
    wallet
}

/// A borrower at the limit whose SOL falls to $10: one liquidation takes all of it and the rest is written off
/// Returns the loss booked, with SOL back at $150 afterwards
fn default_on(env: &mut Env, liq: &Keypair, sol_amount: u64) -> u64 {
    let sol = env.sol;
    let user = borrower(env, sol_amount, None);
    env.set_price(&sol, 10 * USDC);
    let before = env.pool_state().bad_debt;
    expect_ok(env.send(&[env.liquidate_ix(&liq.pubkey(), &user.pubkey(), &sol, u64::MAX)], &[liq]));
    env.set_price(&sol, 150 * USDC);
    env.pool_state().bad_debt - before
}

fn refresh_prices(env: &mut Env) {
    let (sol, stock) = (env.sol, env.stock);
    env.set_price(&sol, 150 * USDC);
    env.set_price(&stock, 200 * USDC);
}

/// Moves the clock, renews the prices and accrues interest up to the new time
fn pass(env: &mut Env, secs: i64) {
    env.warp(secs);
    refresh_prices(env);
    let admin = env.admin.insecure_clone();
    expect_ok(env.send(&[env.accrue_ix()], &[&admin]));
}

/// Overwrites fields of the pool account, for states that real activity would take years to reach
fn set_pool(env: &mut Env, edit: impl FnOnce(&mut Pool)) {
    let mut pool = env.pool_state();
    edit(&mut pool);
    let mut data = vec![];
    pool.try_serialize(&mut data).unwrap();
    let mut account = env.svm.get_account(&env.pool).unwrap();
    account.data[..data.len()].copy_from_slice(&data);
    env.svm.set_account(env.pool, account).unwrap();
}

/// Puts USDC in shock group 2 with the same markdown in every scenario
fn shock_usdc(env: &mut Env, mut params: PoolParams, init: u16, maint: u16) -> PoolParams {
    let (usdc, admin) = (env.usdc, env.admin.insecure_clone());
    for scenario in 0..MAX_SCENARIOS {
        params.init_shock_bps[scenario * MAX_GROUPS + 2] = init;
        params.maint_shock_bps[scenario * MAX_GROUPS + 2] = maint;
    }
    expect_ok(env.send(&[env.set_params_ix(&admin.pubkey(), params)], &[&admin]));
    let asset: Asset = env.load(&env.asset_pda(&usdc));
    expect_ok(env.send(&[env.set_asset_ix(&admin.pubkey(), &usdc, AssetParams { group: 2, ..asset.params })], &[&admin]));
    params
}

#[track_caller]
fn expect_anchor(res: TxResult, code: ErrorCode) {
    let code = u32::from(code);
    assert!(failed_with_code(&res, code), "expected anchor error {code}, got {:#?}", res.map(|m| m.logs).map_err(|f| (f.err, f.meta.logs)));
}

/// True when the transaction landed, and a panic unless it was refused for one of the listed reasons
#[track_caller]
fn landed(res: TxResult, allowed: &[PluribusError]) -> bool {
    if res.is_ok() {
        return true;
    }
    assert!(allowed.iter().any(|e| failed_with(&res, *e)), "refused for an unexpected reason: {:#?}", res.err().map(|f| f.meta.logs));
    false
}

/// Tracked cash matches the vault, the tranches add up, and shares never claim more than is there
#[track_caller]
fn assert_books(env: &Env, holders: &[Pubkey]) {
    let pool = env.pool_state();
    assert_eq!(pool.cash, env.token_amount(&env.usdc_vault), "pool cash against its vault");
    let all = pool.lender_assets().unwrap();
    let debt = pool.total_debt().unwrap();
    assert_eq!(pool.tranche_assets(false).unwrap() + pool.tranche_assets(true).unwrap(), all, "tranches against lender assets");
    assert!(pool.junior_assets as u128 <= all, "junior assets {} above lender assets {all}", pool.junior_assets);
    assert_eq!(all + pool.reserves as u128 + pool.protocol_fees as u128, pool.cash as u128 + debt, "claims against cash and debt");
    let mut claims = 0;
    for mint in [env.share_mint, env.junior_mint()] {
        let held: u64 = holders.iter().map(|h| env.balance(&mint, h)).sum();
        assert_eq!(held, supply(env, &mint), "shares held against supply");
        let redeemable: u128 = holders.iter().map(|h| worth(env, &mint, h)).sum();
        assert!(redeemable <= tranche(env, &mint).0, "shares claim more than their tranche holds");
        claims += redeemable;
    }
    assert!(claims <= pool.cash as u128 + debt, "lenders claim more than cash plus debt");
}

/// Checks that a loss went to reserves first, then uncollected fees, then junior lenders, then senior ones
/// Returns what senior and junior lenders absorbed
#[track_caller]
fn assert_loss_order(before: &Pool, after: &Pool) -> (u128, u128) {
    let loss = after.bad_debt - before.bad_debt;
    let from_reserves = loss.min(before.reserves);
    let from_fees = (loss - from_reserves).min(before.protocol_fees);
    let from_junior = (loss - from_reserves - from_fees).min(before.junior_assets);
    let from_senior = (loss - from_reserves - from_fees - from_junior) as u128;
    assert_eq!(
        (after.reserves, after.protocol_fees, after.junior_assets),
        (before.reserves - from_reserves, before.protocol_fees - from_fees, before.junior_assets - from_junior),
        "loss {loss}"
    );
    // Debt rounds up per account and per tier, so senior lenders can come out a few base units ahead and never behind
    let senior = (before.tranche_assets(false).unwrap(), after.tranche_assets(false).unwrap());
    assert!((senior.0..=senior.0 + 4).contains(&(senior.1 + from_senior)), "loss {loss}: senior assets went from {} to {}", senior.0, senior.1);
    (from_senior, from_junior as u128)
}

/// Share price as a fraction did not fall, give or take `slack` base units of assets
fn price_held(before: (u128, u128), after: (u128, u128), slack: u128) -> bool {
    (after.0 + VIRTUAL_SHARES + slack) * (before.1 + VIRTUAL_SHARES) >= (before.0 + VIRTUAL_SHARES) * (after.1 + VIRTUAL_SHARES)
}

// Share price manipulation

#[test]
fn the_first_lender_in_a_tranche_cannot_take_value_from_the_next_one() {
    for junior in [false, true] {
        let mut env = Env::new();
        let junior_mint = open_junior(&mut env);
        let (usdc, mint) = (env.usdc, if junior { junior_mint } else { env.share_mint });
        let (first, second) = (lender(&mut env, 1_000 * USDC), lender(&mut env, 1_999 * USDC));
        expect_ok(deposit(&mut env, &first, &mint, 1_000 * USDC));
        expect_ok(env.send(&[burn_ix(&first.pubkey(), &mint, 1_000 * USDC - 1)], &[&first]));

        expect_ok(deposit(&mut env, &second, &mint, 1_999 * USDC));
        let kept = worth(&env, &mint, &second.pubkey());
        expect_ok(redeem(&mut env, &first, &mint, 1));
        let gained = env.balance(&usdc, &first.pubkey()).saturating_sub(1_000 * USDC);
        // The burnt 1000 USDC lifts one share to a tenth of a cent, which is the most rounding can cost the next lender
        assert!(kept + 1_001 >= 1_999 * USDC as u128 && gained == 0, "junior {junior}: 1999000000 in is worth {kept} and the first lender gained {gained}");
    }
}

#[test]
fn a_tranche_whose_share_price_was_pushed_up_still_takes_small_deposits() {
    for junior in [false, true] {
        let mut env = Env::new();
        let junior_mint = open_junior(&mut env);
        let mint = if junior { junior_mint } else { env.share_mint };
        let (first, second) = (lender(&mut env, 1_000 * USDC), lender(&mut env, 999 * USDC));
        expect_ok(deposit(&mut env, &first, &mint, 1_000 * USDC));
        expect_ok(env.send(&[burn_ix(&first.pubkey(), &mint, 1_000 * USDC - 1)], &[&first]));
        expect_ok(deposit(&mut env, &second, &mint, 999 * USDC));
    }
}

#[test]
fn a_same_second_round_trip_around_any_pool_event_never_pays() {
    const EVENTS: [&str; 5] = ["first accrual in a year", "large repayment", "liquidation without a loss", "fee collection", "write-off"];
    for junior in [false, true] {
        for (event, what) in EVENTS.iter().enumerate() {
            let (mut env, senior, junior_lender) = two_tranches(9_000 * USDC, 1_000 * USDC);
            let (sol, usdc, admin) = (env.sol, env.usdc, env.admin.insecure_clone());
            let mint = if junior { env.junior_mint() } else { env.share_mint };
            let resident = if junior { junior_lender.pubkey() } else { senior.pubkey() };
            let big = borrower(&mut env, 1_000 * SOL, Some(5_000 * USDC));
            let small = borrower(&mut env, 10 * SOL, None);
            let liq = liquidator(&mut env);
            let trader = lender(&mut env, 2_000 * USDC);
            env.fund(&usdc, &admin.pubkey(), 0);

            // Nobody touches the pool for a year, so the deposit below is what accrues it
            env.warp(YEAR);
            refresh_prices(&mut env);
            expect_ok(deposit(&mut env, &trader, &mint, 2_000 * USDC));
            let resident_before = worth(&env, &mint, &resident);
            match event {
                0 => drop(expect_ok(env.send(&[env.accrue_ix()], &[&admin]))),
                1 => {
                    top_up(&mut env, &big.pubkey(), 1_000 * USDC);
                    expect_ok(env.send(&[env.repay_ix(&big.pubkey(), &big.pubkey(), u64::MAX)], &[&big]));
                }
                2 => {
                    env.set_price(&sol, 120 * USDC);
                    expect_ok(env.send(&[env.liquidate_ix(&liq.pubkey(), &small.pubkey(), &sol, u64::MAX)], &[&liq]));
                    assert_eq!(env.pool_state().bad_debt, 0);
                }
                3 => drop(expect_ok(env.send(&[env.collect_protocol_fees_ix(&admin.pubkey(), u64::MAX)], &[&admin]))),
                _ => {
                    env.set_price(&sol, 10 * USDC);
                    expect_ok(env.send(&[env.liquidate_ix(&liq.pubkey(), &small.pubkey(), &sol, u64::MAX)], &[&liq]));
                    assert!(env.pool_state().bad_debt > 0);
                }
            }
            let shares = env.balance(&mint, &trader.pubkey());
            expect_ok(redeem(&mut env, &trader, &mint, shares));
            let out = env.balance(&usdc, &trader.pubkey());
            assert!(out <= 2_000 * USDC, "junior {junior}, {what}: 2000000000 in and {out} out");
            // Short of a loss, whoever was already in the tranche is no worse off for the visit
            if event < 4 {
                assert!(worth(&env, &mint, &resident) >= resident_before, "junior {junior}, {what}");
            }
            assert_books(&env, &[senior.pubkey(), junior_lender.pubkey(), trader.pubkey()]);
        }
    }
}

#[test]
fn dust_deposits_mint_nothing_for_free_at_any_share_price() {
    let (mut env, senior, junior) = two_tranches(9_000 * USDC, 1_000 * USDC);
    let (usdc, senior_mint, junior_mint) = (env.usdc, env.share_mint, env.junior_mint());
    borrower(&mut env, 1_000 * SOL, Some(5_000 * USDC));
    let liq = liquidator(&mut env);
    let trader = lender(&mut env, 0);
    let t = trader.pubkey();
    // First with both share prices above one after a year of interest, then with junior shares under one after a loss
    for round in 0..2 {
        if round == 0 {
            pass(&mut env, YEAR);
        } else {
            assert!(default_on(&mut env, &liq, 5 * SOL) > 0);
            let (assets, shares) = tranche(&env, &junior_mint);
            assert!(assets < shares);
        }
        for mint in [senior_mint, junior_mint] {
            for amount in [1, 2, 3, 10, 999] {
                env.fund(&usdc, &t, amount);
                let before = tranche(&env, &mint);
                if landed(deposit(&mut env, &trader, &mint, amount), &[PluribusError::ZeroAmount]) {
                    let minted = env.balance(&mint, &t);
                    assert!(minted as u128 * before.0 <= amount as u128 * before.1, "{minted} shares for {amount}");
                    landed(redeem(&mut env, &trader, &mint, minted), &[PluribusError::ZeroAmount]);
                    assert!(env.balance(&usdc, &t) <= amount);
                    // Shares too small to redeem stay behind, so drop them before the next amount
                    let left = env.balance(&mint, &t);
                    if left > 0 {
                        expect_ok(env.send(&[burn_ix(&t, &mint, left)], &[&trader]));
                    }
                }
                assert!(price_held(before, tranche(&env, &mint), 0));
            }
        }
    }
    assert_books(&env, &[senior.pubkey(), junior.pubkey(), t]);
}

// Yield without risk

#[test]
#[ignore = "a junior lender redeems, liquidates and deposits again in one transaction, so a 902 USDC loss lands on senior lenders while 1000 USDC of junior money stands aside"]
fn junior_lenders_cannot_step_aside_while_a_loss_is_booked() {
    let (mut env, _senior, junior) = two_tranches(9_000 * USDC, 1_000 * USDC);
    let (sol, junior_mint) = (env.sol, env.junior_mint());
    let j = junior.pubkey();
    let user = borrower(&mut env, 10 * SOL, None);
    env.set_price(&sol, 10 * USDC);
    env.fund(&sol, &j, 0);
    // Float to pay the liquidation with
    top_up(&mut env, &j, 100 * USDC);
    let before = env.pool_state();

    let steps = [
        env.tranche_ix(&j, &junior_mint, env.balance(&junior_mint, &j), false),
        env.liquidate_ix(&j, &user.pubkey(), &sol, u64::MAX),
        env.tranche_ix(&j, &junior_mint, 1_000 * USDC, true),
    ];
    expect_ok(env.send(&steps, &[&junior]));
    let after = env.pool_state();
    let loss = after.bad_debt;
    assert!(loss > 0 && loss < before.junior_assets);
    let senior = (before.tranche_assets(false).unwrap(), after.tranche_assets(false).unwrap());
    assert!(senior.1 + 2 >= senior.0, "loss {loss}: senior assets went from {} to {} and junior assets from {} to {}", senior.0, senior.1, before.junior_assets, after.junior_assets);
}

#[test]
fn one_base_unit_of_junior_money_earns_next_to_none_of_the_lender_interest() {
    let (mut env, _senior, _junior) = two_tranches(MILLION, 1);
    borrower(&mut env, 10_000 * SOL, Some(MILLION / 2));
    pass(&mut env, YEAR);
    let pool = env.pool_state();
    let interest = pool.lender_assets().unwrap() - (MILLION + 1) as u128;
    let taken = (pool.junior_assets - 1) as u128;
    println!("junior took {taken} of {interest} base units of lender interest");
    assert!(taken * 100 < interest, "junior took {taken} of {interest}");
}

// Tranches with nothing behind them or nobody in them

#[test]
fn a_wiped_out_junior_tranche_reopens_and_its_old_shares_take_under_a_dollar_from_new_money() {
    let (mut env, senior, junior) = two_tranches(9_000 * USDC, 500 * USDC);
    let (usdc, senior_mint, junior_mint) = (env.usdc, env.share_mint, env.junior_mint());
    let liq = liquidator(&mut env);
    let loss = default_on(&mut env, &liq, 60 * SOL);
    let pool = env.pool_state();
    assert!(loss > 500 * USDC);
    assert_eq!((pool.junior_assets, supply(&env, &junior_mint)), (0, 500 * USDC));
    assert_eq!(pool.tranche_assets(false).unwrap(), (9_500 * USDC - loss) as u128);

    // A year of interest all goes to senior lenders, and the dead shares stay worth nothing
    borrower(&mut env, 1_000 * SOL, Some(4_000 * USDC));
    pass(&mut env, YEAR);
    let pool = env.pool_state();
    assert_eq!((pool.junior_assets, pool.tranche_assets(true).unwrap()), (0, 0));
    assert!(pool.tranche_assets(false).unwrap() > (9_500 * USDC - loss) as u128);
    expect_err(redeem(&mut env, &junior, &junior_mint, 500 * USDC), PluribusError::ZeroAmount);

    // New money comes in at the price the virtual shares set, so the dead shares end up with less than the one virtual dollar
    let newcomer = lender(&mut env, 100 * USDC);
    let senior_before = tranche(&env, &senior_mint);
    expect_ok(deposit(&mut env, &newcomer, &junior_mint, 100 * USDC));
    assert_eq!(env.pool_state().junior_assets, 100 * USDC);
    assert_eq!(tranche(&env, &senior_mint), senior_before);
    expect_ok(redeem(&mut env, &junior, &junior_mint, 500 * USDC));
    let taken = env.balance(&usdc, &junior.pubkey());
    assert!(taken > 0 && taken < USDC, "the dead shares took {taken}");
    let held = env.balance(&junior_mint, &newcomer.pubkey());
    expect_ok(redeem(&mut env, &newcomer, &junior_mint, held));
    assert!(env.balance(&usdc, &newcomer.pubkey()) + taken + 1 >= 100 * USDC);
    assert_books(&env, &[senior.pubkey(), junior.pubkey(), newcomer.pubkey()]);
}

#[test]
fn a_tranche_with_assets_and_no_shares_keeps_its_books_and_leaves_the_other_tranche_alone() {
    for junior in [false, true] {
        let (mut env, senior, junior_lender) = two_tranches(5_000 * USDC, 5_000 * USDC);
        let (senior_mint, junior_mint) = (env.share_mint, env.junior_mint());
        let (mint, other, holder) = if junior { (junior_mint, senior_mint, &junior_lender) } else { (senior_mint, junior_mint, &senior) };
        borrower(&mut env, 1_000 * SOL, Some(5_000 * USDC));
        // The only holder throws its shares away
        expect_ok(env.send(&[burn_ix(&holder.pubkey(), &mint, 5_000 * USDC)], &[holder]));
        let other_before = tranche(&env, &other);
        pass(&mut env, YEAR);
        let orphaned = tranche(&env, &mint);
        assert!(orphaned.0 > 5_000 * USDC as u128 && orphaned.1 == 0);
        assert!(price_held(other_before, tranche(&env, &other), 0));

        // The next lender in gets its own money's worth and none of what was left behind
        let next = lender(&mut env, 100 * USDC);
        let other_before = tranche(&env, &other);
        expect_err(deposit(&mut env, &next, &mint, 1), PluribusError::ZeroAmount);
        expect_ok(deposit(&mut env, &next, &mint, 100 * USDC));
        let kept = worth(&env, &mint, &next.pubkey());
        assert!(kept <= 100 * USDC as u128 && kept + USDC as u128 / 100 >= 100 * USDC as u128, "junior {junior}: 100 USDC in is worth {kept}");
        assert_eq!(tranche(&env, &mint).0, orphaned.0 + 100 * USDC as u128);
        assert_eq!(tranche(&env, &other), other_before);
        assert_books(&env, &[senior.pubkey(), junior_lender.pubkey(), next.pubkey()]);
    }
}

#[test]
fn a_senior_tranche_with_shares_and_no_assets_pays_nothing_and_new_money_keeps_all_but_a_dollar() {
    let mut env = Env::new();
    let (usdc, senior_mint) = (env.usdc, env.share_mint);
    let senior = lender(&mut env, 1_000 * USDC);
    expect_ok(deposit(&mut env, &senior, &senior_mint, 1_000 * USDC));
    borrower(&mut env, 100 * SOL, Some(900 * USDC));
    // Every lender dollar is lost on paper: the reserve now claims all the cash and debt there is
    set_pool(&mut env, |p| p.reserves = p.cash + 900 * USDC);
    assert_eq!(env.pool_state().lender_assets().unwrap(), 0);
    expect_err(redeem(&mut env, &senior, &senior_mint, 1_000 * USDC), PluribusError::ZeroAmount);

    let newcomer = lender(&mut env, 100 * USDC);
    let before = tranche(&env, &senior_mint);
    expect_ok(deposit(&mut env, &newcomer, &senior_mint, 100 * USDC));
    let held = env.balance(&senior_mint, &newcomer.pubkey());
    assert_eq!(held as u128, minted_for(100 * USDC as u128, before));
    expect_ok(redeem(&mut env, &senior, &senior_mint, 1_000 * USDC));
    let taken = env.balance(&usdc, &senior.pubkey());
    assert!(taken > 0 && taken < USDC, "the old shares took {taken}");
    expect_ok(redeem(&mut env, &newcomer, &senior_mint, held));
    assert!(env.balance(&usdc, &newcomer.pubkey()) + taken + 1 >= 100 * USDC);
}

#[test]
fn a_nearly_wiped_out_tranche_still_takes_large_deposits() {
    let mut env = Env::new();
    let senior_mint = env.share_mint;
    let senior = lender(&mut env, 1_000 * USDC);
    expect_ok(deposit(&mut env, &senior, &senior_mint, 1_000 * USDC));
    set_pool(&mut env, |p| p.reserves = p.cash - 10);
    assert_eq!(tranche(&env, &senior_mint), (10, 1_000 * USDC as u128));
    let rescuer = lender(&mut env, 200_000 * USDC);
    expect_ok(deposit(&mut env, &rescuer, &senior_mint, 200_000 * USDC));
}

#[test]
fn junior_assets_a_few_units_above_lender_assets_cost_nobody_more_than_those_units() {
    let mut env = Env::new();
    let (usdc, senior_mint, junior_mint) = (env.usdc, env.share_mint, open_junior(&mut env));
    let (junior, senior) = (lender(&mut env, 1_000 * USDC), lender(&mut env, 1_000 * USDC));
    expect_ok(deposit(&mut env, &junior, &junior_mint, 1_000 * USDC));
    // Rounding in the interest split can leave junior assets this far ahead when no senior money is in
    set_pool(&mut env, |p| p.junior_assets += 3);
    let pool = env.pool_state();
    assert_eq!((pool.tranche_assets(true).unwrap(), pool.tranche_assets(false).unwrap()), (1_000 * USDC as u128, 0));
    pass(&mut env, DAY);

    expect_ok(redeem(&mut env, &junior, &junior_mint, 1_000 * USDC));
    assert_eq!(env.balance(&usdc, &junior.pubkey()), 1_000 * USDC);
    expect_ok(deposit(&mut env, &senior, &senior_mint, 1_000 * USDC));
    let pool = env.pool_state();
    assert_eq!(pool.tranche_assets(false).unwrap() + pool.tranche_assets(true).unwrap(), 1_000 * USDC as u128);
    expect_ok(redeem(&mut env, &senior, &senior_mint, 1_000 * USDC));
    let out = env.balance(&usdc, &senior.pubkey());
    assert!((1_000 * USDC - 3..=1_000 * USDC).contains(&out), "senior lender got {out}");
    assert_eq!(env.pool_state().cash, env.token_amount(&env.usdc_vault));
}

// Accrual

#[test]
fn thousands_of_one_second_accruals_split_interest_like_one_long_accrual() {
    const SPAN: i64 = 3_000;
    let run = |steps: i64| {
        let (mut env, senior, _junior) = two_tranches(20_000 * USDC, 3_000 * USDC);
        // Three loans opened 30, 7 and 0 days ago, so every rate tier carries debt
        let a = borrower(&mut env, 10 * SOL, Some(150 * USDC));
        pass(&mut env, 23 * DAY);
        let b = borrower(&mut env, 10 * SOL, Some(150 * USDC));
        pass(&mut env, 7 * DAY);
        let c = borrower(&mut env, 10 * SOL, Some(150 * USDC));
        let owners = [a.pubkey(), b.pubkey(), c.pubkey()];
        for owner in &owners[..2] {
            expect_ok(env.send(&[env.refresh_tier_ix(owner)], &[&senior]));
        }
        assert_eq!(owners.map(|o| env.credit(&o).tier), [2, 1, 0]);

        let start = env.pool_state();
        for _ in 0..steps {
            env.warp(SPAN / steps);
            expect_ok(env.send(&[env.accrue_ix()], &[&senior]));
        }
        let pool = env.pool_state();
        let grown = [
            pool.reserves - start.reserves,
            pool.protocol_fees - start.protocol_fees,
            pool.junior_assets - start.junior_assets,
            (pool.tranche_assets(false).unwrap() - start.tranche_assets(false).unwrap()) as u64,
        ];
        (grown, owners.map(|o| env.debt(&o)), (pool.total_debt().unwrap() - start.total_debt().unwrap()) as u64)
    };
    let (once, often) = (run(1), run(SPAN));
    // Under a base unit of interest per second, which a floor on every call would round away
    assert!(once.2 > 500 && once.2 < SPAN as u64, "interest {}", once.2);
    assert!(once.0[0] >= once.2 / 10 - 1 && once.0[1] >= once.2 / 10 - 1);
    for i in 0..4 {
        assert!(once.0[i].abs_diff(often.0[i]) <= 1, "split {:?} against {:?}", often.0, once.0);
    }
    for i in 0..3 {
        assert!(once.1[i].abs_diff(often.1[i]) <= 1, "debts {:?} against {:?}", often.1, once.1);
    }
}

#[test]
fn accrual_succeeds_on_states_far_beyond_real_use() {
    // More USDC than exists, at full utilization, left alone for a century
    const HUGE: u64 = 100_000 * MILLION;
    const CENTURY: i64 = 100 * YEAR;
    let cases: [(&str, fn(&mut Pool), i64); 9] = [
        ("nothing lent and nothing owed", |_| {}, CENTURY),
        ("all debt in the top tier and no cash", |p| {
            p.cash = 0;
            p.debt_shares = [0, 0, HUGE as u128];
            p.junior_assets = HUGE / 2;
        }, CENTURY),
        ("debt across three tiers at different indices", |p| {
            p.cash = HUGE / 10;
            p.borrow_index = [INDEX_ONE, 5 * INDEX_ONE, 40 * INDEX_ONE];
            p.debt_shares = [HUGE as u128 / 3, HUGE as u128 / 15, HUGE as u128 / 120];
            p.junior_assets = HUGE / 20;
        }, CENTURY),
        ("cash and no debt", |p| {
            p.cash = HUGE;
            p.junior_assets = HUGE / 3;
        }, CENTURY),
        ("debt with no lender assets behind it", |p| {
            p.debt_shares[0] = 1_000 * USDC as u128;
            p.reserves = 600 * USDC;
            p.protocol_fees = 400 * USDC;
        }, CENTURY),
        ("claims far above what the pool has", |p| {
            p.cash = 10 * USDC;
            p.debt_shares[0] = 1_000 * USDC as u128;
            p.reserves = u64::MAX / 4;
            p.protocol_fees = u64::MAX / 4;
            p.junior_assets = 50 * USDC;
        }, YEAR),
        ("junior assets far above lender assets", |p| {
            p.cash = 100 * USDC;
            p.debt_shares[1] = 900 * USDC as u128;
            p.junior_assets = HUGE;
        }, CENTURY),
        ("dust counters at their largest", |p| {
            p.cash = 100 * USDC;
            p.debt_shares[0] = 900 * USDC as u128;
            p.junior_assets = 300 * USDC;
            p.dust = [u32::MAX; 3];
        }, 1),
        ("one base unit owed for one second", |p| {
            p.cash = 1;
            p.debt_shares[0] = 1;
            p.junior_assets = 1;
        }, 1),
    ];
    for (what, edit, gap) in cases {
        let mut env = Env::new();
        let admin = env.admin.insecure_clone();
        set_pool(&mut env, edit);
        let before = env.pool_state();
        env.warp(gap);
        let res = env.send(&[env.accrue_ix()], &[&admin]);
        assert!(res.is_ok(), "{what}: {:#?}", res.err().map(|f| f.meta.logs));
        let after = env.pool_state();
        assert_eq!(after.last_accrual, env.now(), "{what}");
        assert!(after.total_debt().unwrap() >= before.total_debt().unwrap(), "{what}");
        assert!(after.reserves >= before.reserves && after.protocol_fees >= before.protocol_fees && after.junior_assets >= before.junior_assets, "{what}");
        assert_eq!(after.tranche_assets(false).unwrap() + after.tranche_assets(true).unwrap(), after.lender_assets().unwrap(), "{what}");
        env.warp(1);
        expect_ok(env.send(&[env.accrue_ix()], &[&admin]));
    }
}

#[test]
fn accrual_never_fails_however_far_the_index_has_run() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    set_pool(&mut env, |p| {
        p.debt_shares[0] = MILLION as u128;
        p.borrow_index[0] = 400_000_000 * INDEX_ONE;
    });
    env.warp(DAY);
    expect_ok(env.send(&[env.accrue_ix()], &[&admin]));
}

// Conservation

fn random_amount(rng: &mut Lcg) -> u64 {
    match rng.below(6) {
        0 => 1 + rng.below(5),
        1 => 1 + rng.below(USDC),
        _ => 1 + rng.below(20_000 * USDC),
    }
}

/// `default_sol` caps the collateral of the borrowers that default, and so the size of each loss
fn random_walk(seed: u64, steps: usize, default_sol: u64) {
    let mut rng = Lcg(seed);
    let (mut env, first_senior, first_junior) = two_tranches(50_000 * USDC, 8_000 * USDC);
    let (sol, usdc, admin) = (env.sol, env.usdc, env.admin.insecure_clone());
    let mints = [env.share_mint, env.junior_mint()];
    let mut lenders = vec![first_senior, first_junior];
    for _ in 0..2 {
        lenders.push(lender(&mut env, 0));
    }
    let holders: Vec<Pubkey> = lenders.iter().map(|l| l.pubkey()).collect();
    let borrowers: Vec<Keypair> = (0..3).map(|_| borrower(&mut env, 200 * SOL, Some(1_000 * USDC))).collect();
    let liq = liquidator(&mut env);
    env.fund(&usdc, &admin.pubkey(), 0);
    let (mut collected, mut losses, mut liquidations) = (0, 0, 0);

    for step in 0..steps {
        let before = env.pool_state();
        let prices = mints.map(|m| tranche(&env, &m));
        // How far a share price may slip in this step, senior then junior
        let mut slack = [0u128; 2];
        match rng.below(11) {
            0 | 1 | 2 => {
                let (who, t, amount) = (&lenders[rng.below(4) as usize], rng.below(2) as usize, random_amount(&mut rng));
                let held = env.balance(&mints[t], &who.pubkey());
                env.fund(&usdc, &who.pubkey(), amount);
                if landed(deposit(&mut env, who, &mints[t], amount), &[PluribusError::ZeroAmount]) {
                    let minted = env.balance(&mints[t], &who.pubkey()) - held;
                    assert_eq!(minted as u128, minted_for(amount as u128, prices[t]), "step {step}");
                    // One in three deposits turns straight round
                    if rng.below(3) == 0 && landed(redeem(&mut env, who, &mints[t], minted), &[PluribusError::ZeroAmount, PluribusError::InsufficientLiquidity]) {
                        let out = env.balance(&usdc, &who.pubkey()) as u128;
                        assert!(out <= amount as u128, "step {step}: {amount} in, {out} out");
                    }
                }
            }
            3 | 4 => {
                let (who, t) = (&lenders[rng.below(4) as usize], rng.below(2) as usize);
                let held = env.balance(&mints[t], &who.pubkey());
                let shares = if rng.below(4) == 0 { held } else { held / 100 * (1 + rng.below(100)) };
                let wallet = env.balance(&usdc, &who.pubkey());
                if shares > 0 && landed(redeem(&mut env, who, &mints[t], shares), &[PluribusError::ZeroAmount, PluribusError::InsufficientLiquidity]) {
                    let paid = env.balance(&usdc, &who.pubkey()) - wallet;
                    assert_eq!(paid as u128, paid_for(shares as u128, prices[t]), "step {step}");
                }
            }
            5 => {
                let user = &borrowers[rng.below(3) as usize];
                if !env.credit(&user.pubkey()).has_collateral() {
                    env.deposit(user, &sol, 200 * SOL);
                }
                let amount = 1 + rng.below(5_000 * USDC);
                landed(env.draw(user, amount), &[PluribusError::ExceedsCreditLimit, PluribusError::InsufficientLiquidity]);
            }
            6 => {
                let user = &borrowers[rng.below(3) as usize];
                let amount = 1 + rng.below(env.debt(&user.pubkey()) + USDC);
                top_up(&mut env, &user.pubkey(), amount);
                landed(env.send(&[env.repay_ix(&user.pubkey(), &user.pubkey(), amount)], &[user]), &[PluribusError::ZeroAmount]);
            }
            7 => {
                env.warp([1, 1, 7, 3_600, DAY, 30 * DAY][rng.below(6) as usize]);
                refresh_prices(&mut env);
                expect_ok(env.send(&[env.accrue_ix()], &[&admin]));
                let after = env.pool_state();
                let interest = (after.total_debt().unwrap() - before.total_debt().unwrap()) * DUST;
                let p = &before.params;
                let (to_reserves, to_protocol) = (interest * p.reserve_factor_bps as u128 / BPS, interest * p.protocol_fee_bps as u128 / BPS);
                assert_eq!((after.reserves - before.reserves) as u128, (to_reserves + before.dust[0] as u128) / DUST, "step {step}");
                assert_eq!((after.protocol_fees - before.protocol_fees) as u128, (to_protocol + before.dust[1] as u128) / DUST, "step {step}");
                let (all, junior) = (before.lender_assets().unwrap(), before.tranche_assets(true).unwrap());
                let gained = (after.junior_assets - before.junior_assets) as u128;
                if junior == 0 {
                    assert_eq!(gained, 0, "step {step}");
                } else {
                    // Junior lenders get their own share and at most the full protection fee on top
                    let to_lenders = interest - to_reserves - to_protocol;
                    let own = to_lenders * junior / all;
                    let fee = (to_lenders - own) * p.protection_fee_bps as u128 / BPS;
                    let carried = before.dust[2] as u128;
                    assert!(gained >= (own + carried) / DUST && gained <= (own + fee + carried) / DUST, "step {step}: junior gained {gained}");
                }
                // The three carried fractions can tick over together and take up to 3 base units back from senior lenders
                slack = [3, 0];
            }
            8 => {
                let held = env.balance(&usdc, &admin.pubkey());
                let asked = if rng.below(2) == 0 { u64::MAX } else { random_amount(&mut rng) };
                if landed(env.send(&[env.collect_protocol_fees_ix(&admin.pubkey(), asked)], &[&admin]), &[PluribusError::ZeroAmount]) {
                    let (after, paid) = (env.pool_state(), env.balance(&usdc, &admin.pubkey()) - held);
                    assert_eq!(paid, asked.min(before.protocol_fees).min(before.cash), "step {step}");
                    assert_eq!((after.protocol_fees, after.cash, after.reserves), (before.protocol_fees - paid, before.cash - paid, before.reserves));
                    assert_eq!((after.junior_assets, after.lender_assets().unwrap()), (before.junior_assets, before.lender_assets().unwrap()));
                    collected += paid;
                }
            }
            9 => {
                // SOL falls, then one liquidation: a standing borrower at $20, or a fresh one at $10 who loses everything
                let fresh = rng.below(3) == 0;
                let target = if fresh {
                    let user = env.user();
                    env.deposit(&user, &sol, (1 + rng.below(default_sol)) * SOL);
                    let limit = env.health(&user.pubkey()).credit_limit;
                    landed(env.draw(&user, limit - 2), &[PluribusError::InsufficientLiquidity]).then(|| (user.pubkey(), 10 * USDC, u64::MAX))
                } else {
                    Some((borrowers[rng.below(3) as usize].pubkey(), 20 * USDC, random_amount(&mut rng)))
                };
                if let Some((owner, price, repay)) = target {
                    env.set_price(&sol, price);
                    let before = env.pool_state();
                    let res = env.send(&[env.liquidate_ix(&liq.pubkey(), &owner, &sol, repay)], &[&liq]);
                    env.set_price(&sol, 150 * USDC);
                    let refusals = [PluribusError::NotLiquidatable, PluribusError::PositionNotFound, PluribusError::ZeroAmount, PluribusError::HealthNotImproved];
                    if landed(res, if fresh { &[] } else { &refusals }) {
                        let after = env.pool_state();
                        let (from_senior, from_junior) = assert_loss_order(&before, &after);
                        assert!(!fresh || after.bad_debt > before.bad_debt, "step {step}");
                        liquidations += 1;
                        losses += (after.bad_debt > before.bad_debt) as u32;
                        // A loss is the one event allowed to cut a share price
                        slack = [from_senior, from_junior];
                    }
                }
            }
            _ => {
                let owner = borrowers[rng.below(3) as usize].pubkey();
                expect_ok(env.send(&[env.refresh_tier_ix(&owner)], &[&admin]));
            }
        }
        assert_books(&env, &holders);
        for t in 0..2 {
            assert!(price_held(prices[t], tranche(&env, &mints[t]), slack[t]), "step {step}: tranche {t} went from {:?} to {:?}", prices[t], tranche(&env, &mints[t]));
        }
    }
    assert!(collected > 0 && losses > 0 && liquidations > 0, "seed {seed}: collected {collected}, {losses} losses, {liquidations} liquidations");
}

#[test]
fn books_hold_through_random_lending_borrowing_liquidations_losses_and_fee_collection() {
    for seed in [1, 2, 3, 4] {
        random_walk(seed, 300, 4);
    }
    // Losses large enough to wipe the junior tranche out part of the way through
    for seed in [5, 6] {
        random_walk(seed, 300, 16);
    }
}

// Protocol fees

#[test]
fn fee_collection_takes_no_lender_money_or_reserves_before_or_after_a_write_off() {
    let (mut env, senior, junior) = two_tranches(9_000 * USDC, 1_000 * USDC);
    let (usdc, admin) = (env.usdc, env.admin.insecure_clone());
    let boss = admin.pubkey();
    env.fund(&usdc, &boss, 0);
    borrower(&mut env, 1_000 * SOL, Some(6_000 * USDC));
    let liq = liquidator(&mut env);
    // What reached the admin, after checking it came out of cash and fees and nothing else moved
    let collect = |env: &mut Env, amount: u64| {
        let (before, held) = (env.pool_state(), env.balance(&usdc, &boss));
        let res = env.send(&[env.collect_protocol_fees_ix(&boss, amount)], &[&admin]);
        let (after, paid) = (env.pool_state(), env.balance(&usdc, &boss) - held);
        assert_eq!((after.cash, after.protocol_fees), (before.cash - paid, before.protocol_fees - paid));
        assert_eq!((after.reserves, after.junior_assets, after.dust), (before.reserves, before.junior_assets, before.dust));
        assert_eq!(after.tranche_assets(false).unwrap(), before.tranche_assets(false).unwrap());
        (res, paid)
    };

    pass(&mut env, YEAR);
    let pool = env.pool_state();
    assert!(pool.protocol_fees > 40 * USDC && pool.reserves > 40 * USDC);
    assert_eq!(collect(&mut env, 10 * USDC).1, 10 * USDC);

    // A loss larger than the reserve and the uncollected fees together uses both up
    let loss = default_on(&mut env, &liq, 8 * SOL);
    let after = env.pool_state();
    assert!(loss > pool.reserves + pool.protocol_fees - 10 * USDC);
    assert_eq!((after.reserves, after.protocol_fees), (0, 0));
    assert_eq!(after.junior_assets, pool.junior_assets - (loss - pool.reserves - (pool.protocol_fees - 10 * USDC)));
    expect_err(collect(&mut env, u64::MAX).0, PluribusError::ZeroAmount);
    expect_err(collect(&mut env, 1).0, PluribusError::ZeroAmount);

    // Only what accrues afterwards can be collected
    pass(&mut env, 30 * DAY);
    let fees = env.pool_state().protocol_fees;
    assert!(fees > 0 && fees < 10 * USDC);
    assert_eq!(collect(&mut env, u64::MAX).1, fees);
    expect_err(collect(&mut env, 1).0, PluribusError::ZeroAmount);
    assert_eq!(env.balance(&usdc, &boss), 10 * USDC + fees);
    assert_books(&env, &[senior.pubkey(), junior.pubkey()]);
}

// Share mints and share accounts

#[test]
fn shares_move_only_for_the_pools_own_mints_and_the_signers_own_accounts() {
    let mut env = Env::new();
    let (usdc, senior_mint, junior_mint) = (env.usdc, env.share_mint, env.junior_mint());
    let alice = lender(&mut env, 1_000 * USDC);
    let a = alice.pubkey();
    expect_ok(deposit(&mut env, &alice, &senior_mint, 400 * USDC));

    // Before the junior tranche is open neither its future mint nor the unset mint address stands for it
    expect_anchor(deposit(&mut env, &alice, &junior_mint, 100 * USDC), ErrorCode::AccountNotInitialized);
    assert!(deposit(&mut env, &alice, &Pubkey::default(), 100 * USDC).is_err());
    let fake = env.new_mint(6, &TOKEN);
    env.fund(&fake, &a, 1_000 * USDC);
    expect_err(deposit(&mut env, &alice, &fake, 100 * USDC), PluribusError::AccountMismatch);
    expect_err(redeem(&mut env, &alice, &fake, 100 * USDC), PluribusError::AccountMismatch);
    assert!(redeem(&mut env, &alice, &usdc, 100 * USDC).is_err());

    open_junior(&mut env);
    env.fund(&junior_mint, &a, 0);
    let bob = lender(&mut env, 1_000 * USDC);
    let b = bob.pubkey();
    expect_ok(deposit(&mut env, &bob, &junior_mint, 400 * USDC));
    expect_ok(deposit(&mut env, &bob, &senior_mint, 400 * USDC));
    expect_err(deposit(&mut env, &alice, &fake, 100 * USDC), PluribusError::AccountMismatch);
    expect_err(redeem(&mut env, &alice, &fake, 100 * USDC), PluribusError::AccountMismatch);

    let with = |env: &Env, mint: &Pubkey, is_deposit: bool, slot: usize, account: Pubkey| {
        let mut ix = env.tranche_ix(&a, mint, 100 * USDC, is_deposit);
        ix.accounts[slot].pubkey = account;
        ix
    };
    let state = |env: &Env| (env.svm.get_account(&env.pool).unwrap().data, [a, b].map(|w| [usdc, senior_mint, junior_mint].map(|m| env.balance(&m, &w))));
    let before = state(&env);
    // A share account of the other tranche, in both directions and for both instructions
    for is_deposit in [true, false] {
        expect_anchor(env.send(&[with(&env, &senior_mint, is_deposit, LEND_SHARES, ata(&b, &junior_mint, &TOKEN))], &[&alice]), ErrorCode::ConstraintTokenMint);
        expect_anchor(env.send(&[with(&env, &junior_mint, is_deposit, LEND_SHARES, ata(&a, &senior_mint, &TOKEN))], &[&alice]), ErrorCode::ConstraintTokenMint);
    }
    // Redeeming out of someone else's share account, or paying in from someone else's USDC
    for mint in [senior_mint, junior_mint] {
        assert!(env.send(&[with(&env, &mint, false, LEND_SHARES, ata(&b, &mint, &TOKEN))], &[&alice]).is_err());
        assert!(env.send(&[with(&env, &mint, true, LEND_USDC, ata(&b, &usdc, &TOKEN))], &[&alice]).is_err());
        assert!(env.send(&[with(&env, &mint, true, LEND_TOKEN_PROGRAM, TOKEN_2022)], &[&alice]).is_err());
    }
    // The pool's own vault as the payout account
    expect_anchor(env.send(&[with(&env, &senior_mint, false, LEND_USDC, env.usdc_vault)], &[&alice]), ErrorCode::ConstraintDuplicateMutableAccount);
    assert!(state(&env) == before);

    // Each tranche redeems at its own price with its own shares
    expect_ok(redeem(&mut env, &bob, &junior_mint, 400 * USDC));
    expect_ok(redeem(&mut env, &bob, &senior_mint, 400 * USDC));
    assert_eq!(env.balance(&usdc, &b), 1_000 * USDC);
    assert_books(&env, &[a, b]);
}

// LP valuation

struct Lp {
    liquidity: u128,
    lower: f64,
    upper: f64,
    decimals: u8,
    price: u128,
    group: u8,
    cost: u128,
}

/// Draw limit, liquidation limit and market value from the plain formulas, with a fresh square root for every price
fn limits(params: &PoolParams, usdc_group: u8, positions: &[Lp]) -> (u128, u128, u128) {
    let n = params.num_scenarios as usize;
    let (mut init, mut maint, mut market) = (vec![0u128; n], vec![0u128; n], 0);
    for p in positions {
        let (lower, upper) = math::range_sqrt_prices(tick(p.lower), tick(p.upper)).unwrap();
        let value = |price: u128, usdc_shock: u128| {
            let root = math::sqrt_price_x64(price, p.decimals).unwrap();
            let (base, usdc) = math::lp_parts(p.liquidity, lower, upper, price, root, p.decimals).unwrap();
            base + math::cut(usdc, usdc_shock).unwrap()
        };
        market += value(p.price, 0);
        for s in 0..n {
            for (is_init, total) in [(true, &mut init), (false, &mut maint)] {
                let shocked = math::cut(p.price, params.shock(is_init, s, p.group)).unwrap();
                total[s] += math::cut(value(shocked, params.shock(is_init, s, usdc_group)), p.cost).unwrap();
            }
        }
    }
    (*init.iter().min().unwrap(), *maint.iter().min().unwrap(), market)
}

#[test]
fn lp_limits_with_cached_roots_match_the_uncached_maths_exactly() {
    let mut env = Env::new();
    env.lender(MILLION);
    let (stock, usdc, admin) = (env.stock, env.usdc, env.admin.insecure_clone());
    // A second market whose base token has 6 decimals and trades at the same $150 as SOL
    let stock_pool = Pubkey::new_unique();
    env.set_whirlpool(&stock_pool, &stock, &usdc);
    expect_ok(env.send(&[env.init_lp_market_ix(&stock_pool, &stock, 600)], &[&admin]));
    env.set_price(&stock, 150 * USDC);

    // Four scenarios with repeated and zero shocks, so the same price comes up within and across positions
    let mut params = default_params();
    params.num_scenarios = 4;
    let rows: [([u16; 3], [u16; 3]); 4] = [([3000, 3000, 300], [2000, 2000, 100]), ([1500, 3500, 300], [1500, 2500, 100]), ([0, 2500, 0], [0, 1700, 0]), ([3000, 0, 500], [2000, 0, 300])];
    for (s, (init, maint)) in rows.iter().enumerate() {
        params.init_shock_bps[s * MAX_GROUPS..s * MAX_GROUPS + 3].copy_from_slice(init);
        params.maint_shock_bps[s * MAX_GROUPS..s * MAX_GROUPS + 3].copy_from_slice(maint);
    }
    expect_ok(env.send(&[env.set_params_ix(&admin.pubkey(), params)], &[&admin]));
    let asset: Asset = env.load(&env.asset_pda(&usdc));
    expect_ok(env.send(&[env.set_asset_ix(&admin.pubkey(), &usdc, AssetParams { group: 2, ..asset.params })], &[&admin]));

    let price = 150 * PRICE_ONE;
    let sol_lp = |lower: f64, upper: f64, usd: u64| Lp { liquidity: liquidity_for(usd, lower, upper, 150), lower, upper, decimals: 9, price, group: GROUP_SOL, cost: 500 };
    // Ticks are worked out for a 9 decimal base, so a 6 decimal range is given a thousand times higher
    let stock_lp = |lower: f64, upper: f64, liquidity: u128| Lp { liquidity, lower: lower * 1e3, upper: upper * 1e3, decimals: 6, price, group: GROUP_STOCK, cost: 600 };
    let positions = [
        sol_lp(120.0, 180.0, 10_000),
        stock_lp(120.0, 180.0, 40_000_000_000),
        sol_lp(145.5, 154.5, 3_333),
        stock_lp(60.0, 110.0, 7_777_777_777),
        sol_lp(160.0, 400.0, 25_000),
    ];
    let user = env.user();
    let me = user.pubkey();
    for (i, p) in positions.iter().enumerate() {
        let whirlpool = if p.decimals == 9 { env.whirlpool } else { stock_pool };
        let nft = env.lp(&me, &whirlpool, p.lower, p.upper, p.liquidity, &TOKEN);
        expect_ok(env.send(&[env.deposit_lp_ix(&me, &whirlpool, &nft)], &[&user]));

        let (credit, liquidation, market) = limits(&params, 2, &positions[..=i]);
        let (h, compute) = health_with_budget(&mut env, &me);
        println!("health view with {} lp positions over two markets and four scenarios: {compute} compute units", i + 1);
        assert_eq!((h.credit_limit as u128, h.liquidation_limit as u128, h.collateral_value as u128), (credit, liquidation, market), "{} positions", i + 1);
        assert!(credit < liquidation && liquidation < market);
    }

    // The draw path values positions in a different order and must land on the same limit
    let limit = health_with_budget(&mut env, &me).0.credit_limit;
    env.fund(&usdc, &me, 0);
    let draw = |env: &mut Env, amount: u64| env.send(&[more_compute(), env.draw_ix(&me, amount)], &[&user]);
    expect_err(draw(&mut env, limit + 1), PluribusError::ExceedsCreditLimit);
    let meta = expect_ok(draw(&mut env, limit));
    println!("draw against them: {} compute units", meta.compute_units_consumed);
}

#[test]
fn the_usdc_shock_marks_down_only_the_usdc_side_of_an_lp() {
    let mut env = Env::new();
    let user = env.user();
    let me = user.pubkey();
    // One scenario, so the limit is that scenario's value: SOL falls 20% and nothing else moves
    let mut params = default_params();
    params.num_scenarios = 1;
    let admin = env.admin.insecure_clone();
    expect_ok(env.send(&[env.set_params_ix(&admin.pubkey(), params)], &[&admin]));
    let liquidity = liquidity_for(10_000, 100.0, 180.0, 150);
    env.deposit_lp(&user, 100.0, 180.0, liquidity);

    // At the crash price of $120 the position holds both SOL and USDC
    let (lower, upper) = math::range_sqrt_prices(tick(100.0), tick(180.0)).unwrap();
    let crash = 120 * PRICE_ONE;
    let (base, quote) = math::lp_parts(liquidity, lower, upper, crash, math::sqrt_price_x64(crash, 9).unwrap(), 9).unwrap();
    assert!(base > 1_000 * PRICE_ONE && quote > 1_000 * PRICE_ONE);
    let market = env.health(&me).collateral_value;
    assert_eq!(env.health(&me).liquidation_limit as u128, math::cut(base + quote, 500).unwrap());

    // USDC marked down 10% for liquidation: the SOL side keeps its value and the market value is untouched
    shock_usdc(&mut env, params, 1_000, 1_000);
    let h = env.health(&me);
    assert_eq!(h.liquidation_limit as u128, math::cut(base + math::cut(quote, 1_000).unwrap(), 500).unwrap());
    assert_eq!(h.collateral_value, market);
    // Plain USDC collateral takes the same markdown
    let usdc = env.usdc;
    env.deposit(&user, &usdc, 1_000 * USDC);
    assert_eq!(env.health(&me).liquidation_limit, h.liquidation_limit + 900 * USDC);
}

#[test]
fn an_all_usdc_lp_can_be_drawn_to_its_limit_without_becoming_liquidatable_once_usdc_is_shocked() {
    let mut env = Env::new();
    env.lender(MILLION);
    let (user, liq) = (env.user(), liquidator(&mut env));
    let me = user.pubkey();
    // Far under the price, so the position is all USDC now and after every crash
    let nft = env.deposit_lp(&user, 50.0, 80.0, liquidity_for(10_000, 50.0, 80.0, 150));
    env.fund(&nft, &liq.pubkey(), 0);
    let h = env.health(&me);
    assert_eq!(h.credit_limit, h.liquidation_limit);

    shock_usdc(&mut env, default_params(), 300, 100);
    let h = env.health(&me);
    assert_eq!(h.credit_limit as u128, math::cut(math::cut(h.collateral_value as u128, 300).unwrap(), 500).unwrap());
    assert_eq!(h.liquidation_limit as u128, math::cut(math::cut(h.collateral_value as u128, 100).unwrap(), 500).unwrap());
    expect_err(env.draw(&user, h.credit_limit + 1), PluribusError::ExceedsCreditLimit);
    expect_ok(env.draw(&user, h.credit_limit));
    expect_err(env.send(&[env.liquidate_lp_ix(&liq.pubkey(), &me, &nft)], &[&liq]), PluribusError::NotLiquidatable);

    // A month of interest fits in the gap, and the position goes only once the debt passes the liquidation limit
    pass(&mut env, 30 * DAY);
    expect_err(env.send(&[env.liquidate_lp_ix(&liq.pubkey(), &me, &nft)], &[&liq]), PluribusError::NotLiquidatable);
    set_pool(&mut env, |p| p.borrow_index[0] = p.borrow_index[0] / 100 * 103);
    assert!(env.debt(&me) > h.liquidation_limit);
    expect_ok(env.send(&[env.liquidate_lp_ix(&liq.pubkey(), &me, &nft)], &[&liq]));
}

#[test]
fn the_health_view_of_a_full_lp_account_fits_the_compute_budget_the_sdk_asks_for() {
    let mut env = Env::new();
    let user = env.user();
    for _ in 0..MAX_POSITIONS {
        env.deposit_lp(&user, 120.0, 180.0, liquidity_for(10_000, 120.0, 180.0, 150));
    }
    let compute = health_with_budget(&mut env, &user.pubkey()).1;
    // Five positions pass the 200000 default, so the SDK simulates the view with 400000
    assert!(compute < 400_000, "health view used {compute} compute units");
}

#[test]
fn an_lp_account_can_still_be_liquidated_when_its_base_token_is_nearly_worthless() {
    let mut env = Env::new();
    env.lender(MILLION);
    let sol = env.sol;
    let (user, liq) = (env.user(), liquidator(&mut env));
    let nft = env.deposit_lp(&user, 120.0, 180.0, liquidity_for(10_000, 120.0, 180.0, 150));
    env.fund(&nft, &liq.pubkey(), 0);
    let limit = env.health(&user.pubkey()).credit_limit;
    expect_ok(env.draw(&user, limit));
    // A millionth of a dollar is the smallest price the feed can carry
    env.set_price(&sol, 1);
    expect_ok(env.send(&[env.liquidate_lp_ix(&liq.pubkey(), &user.pubkey(), &nft)], &[&liq]));
    assert_eq!(env.debt(&user.pubkey()), 0);
}
