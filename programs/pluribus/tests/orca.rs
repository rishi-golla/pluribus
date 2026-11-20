mod common;

use {
    anchor_lang::prelude::Pubkey,
    base64::{engine::general_purpose::STANDARD, Engine},
    common::*,
    litesvm::LiteSVM,
    pluribus::constants::*,
    serde_json::Value,
    solana_account::Account,
    solana_keypair::Keypair,
    solana_signer::Signer,
    std::{fs, path::PathBuf, str::FromStr},
};

fn key(v: &Value) -> Pubkey {
    Pubkey::from_str(v.as_str().unwrap()).unwrap()
}

fn num(v: &Value) -> u64 {
    v.as_str().unwrap().parse().unwrap()
}

/// A chain holding the real Whirlpool program and a pool snapshotted from a local validator,
/// with Pluribus set up on top of that pool's own mints
/// Returns None when the Whirlpool binary has not been fetched, since it is too large to commit
fn real_pool() -> Option<(Env, Value)> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/orca");
    let Ok(program) = fs::read(dir.join("whirlpool.so")) else {
        eprintln!("Skipped: run `npm run orca:snapshot` to fetch whirlpool.so");
        return None;
    };
    let manifest: Value = serde_json::from_str(&fs::read_to_string(dir.join("manifest.json")).unwrap()).unwrap();
    let mut svm = LiteSVM::new();
    svm.add_program(WHIRLPOOL_PROGRAM_ID, &program).unwrap();
    for entry in manifest["accounts"].as_object().unwrap().values() {
        let file = fs::read_to_string(dir.join(entry["file"].as_str().unwrap())).unwrap();
        let v: Value = serde_json::from_str(&file).unwrap();
        let a = &v["account"];
        let account = Account {
            lamports: a["lamports"].as_u64().unwrap(),
            data: STANDARD.decode(a["data"][0].as_str().unwrap()).unwrap(),
            owner: key(&a["owner"]),
            executable: a["executable"].as_bool().unwrap(),
            rent_epoch: 0,
        };
        svm.set_account(key(&v["pubkey"]), account).unwrap();
    }
    let (usdc, sol) = (key(&manifest["tokenB"]["mint"]), key(&manifest["tokenA"]["mint"]));
    let mut env = Env::on(svm, default_params(), true, Some((usdc, sol, key(&manifest["whirlpool"]))));
    // The oracle reports the price the pool itself sits at, so both sides value the same thing
    env.set_price(&sol, pool_price(&manifest));
    Some((env, manifest))
}

fn pool_price(manifest: &Value) -> u64 {
    (manifest["price"].as_str().unwrap().parse::<f64>().unwrap() * 1e6).round() as u64
}

/// Hands a snapshotted position NFT to `to` by rewriting the owner of the token account that holds it
fn take_nft(env: &mut Env, manifest: &Value, index: usize, to: &Pubkey) -> (Pubkey, Pubkey) {
    let position = &manifest["positions"][index];
    let holder = key(&position["ownerTokenAccount"]);
    let mut account = env.svm.get_account(&holder).unwrap();
    account.data[32..64].copy_from_slice(to.as_ref());
    env.svm.set_account(holder, account).unwrap();
    (key(&position["positionMint"]), holder)
}

fn deposit(env: &mut Env, manifest: &Value, index: usize, user: &Keypair) -> Pubkey {
    let (nft, holder) = take_nft(env, manifest, index, &user.pubkey());
    let whirlpool = env.whirlpool;
    expect_ok(env.send(&[env.deposit_lp_from_ix(&user.pubkey(), &whirlpool, &nft, &holder)], &[user]));
    nft
}

/// The Whirlpool accounts autopay needs for a position: both tick arrays, then the pool's token vaults
fn orca_accounts(manifest: &Value, index: usize) -> [Pubkey; 4] {
    let p = &manifest["positions"][index];
    [key(&p["tickArrayLower"]), key(&p["tickArrayUpper"]), key(&manifest["tokenA"]["vault"]), key(&manifest["tokenB"]["vault"])]
}

fn assert_books_match_vaults(env: &Env) {
    let pool = env.pool_state();
    assert_eq!(pool.cash, env.token_amount(&env.usdc_vault));
    for mint in [env.usdc, env.sol, env.stock] {
        let asset: pluribus::state::Asset = env.load(&env.asset_pda(&mint));
        assert_eq!(asset.total_deposited, env.token_amount(&env.vault_pda(&mint)));
    }
}

#[test]
fn real_positions_are_valued_like_the_orca_sdk() {
    let Some((mut env, manifest)) = real_pool() else { return };
    let price = pool_price(&manifest) as u128;
    for index in 0..3 {
        let p = &manifest["positions"][index];
        // Our derivation of the position address must be the one Orca really used
        assert_eq!(orca_position(&key(&p["positionMint"])), key(&p["position"]));
        let user = env.user();
        deposit(&mut env, &manifest, index, &user);
        // Token amounts the Orca SDK computed for this position at the pool price
        let want = num(&p["amountA"]) as u128 * price / SOL as u128 + num(&p["amountB"]) as u128;
        let got = env.health(&user.pubkey()).collateral_value as u128;
        assert!(got.abs_diff(want) * 1_000_000 < want, "position {index}: got {got}, want {want}");
    }
}

#[test]
fn autopay_collects_real_fees_and_repays_debt() {
    let Some((mut env, manifest)) = real_pool() else { return };
    env.lender(1_000_000 * USDC);
    let (user, keeper) = (env.user(), env.harvester());
    let (me, whirlpool, sol, usdc) = (user.pubkey(), env.whirlpool, env.sol, env.usdc);
    // The second snapshotted position is the Token-2022 flavour and has earned the most fees
    let nft = deposit(&mut env, &manifest, 1, &user);
    expect_ok(env.draw(&user, 1000 * USDC));
    let (fee_sol, fee_usdc) = (num(&manifest["positions"][1]["uncollectedFeeA"]), num(&manifest["positions"][1]["uncollectedFeeB"]));
    assert!(fee_sol > 0 && fee_usdc > 0);

    let autopay = env.autopay_ix(&keeper.pubkey(), &me, &whirlpool, &nft, orca_accounts(&manifest, 1));
    let meta = expect_ok(env.send(&[autopay.clone()], &[&keeper]));
    println!("autopay: {} compute units", meta.compute_units_consumed);

    // The USDC part paid debt down and the SOL part became collateral
    assert_eq!(env.debt(&me), 1000 * USDC - fee_usdc);
    let credit = env.credit(&me);
    assert_eq!(credit.positions[credit.find(KIND_TOKEN, &sol).unwrap()].amount, fee_sol);
    assert!(credit.find(KIND_TOKEN, &usdc).is_err());
    assert_eq!(env.balance(&nft, &env.pool), 1);
    assert_books_match_vaults(&env);

    // Nothing is left to collect, so a second run changes nothing
    expect_ok(env.send(&[autopay], &[&keeper]));
    assert_eq!(env.debt(&me), 1000 * USDC - fee_usdc);
}

#[test]
fn autopay_keeps_fees_as_collateral_when_nothing_is_owed() {
    let Some((mut env, manifest)) = real_pool() else { return };
    let (user, keeper) = (env.user(), env.harvester());
    let (me, whirlpool, sol, usdc) = (user.pubkey(), env.whirlpool, env.sol, env.usdc);
    let nft = deposit(&mut env, &manifest, 0, &user);
    let (fee_sol, fee_usdc) = (num(&manifest["positions"][0]["uncollectedFeeA"]), num(&manifest["positions"][0]["uncollectedFeeB"]));

    expect_ok(env.send(&[env.autopay_ix(&keeper.pubkey(), &me, &whirlpool, &nft, orca_accounts(&manifest, 0))], &[&keeper]));
    let credit = env.credit(&me);
    assert_eq!(credit.positions[credit.find(KIND_TOKEN, &sol).unwrap()].amount, fee_sol);
    assert_eq!(credit.positions[credit.find(KIND_TOKEN, &usdc).unwrap()].amount, fee_usdc);
    assert_books_match_vaults(&env);
}

#[test]
fn autopay_rejects_a_position_the_account_does_not_hold() {
    let Some((mut env, manifest)) = real_pool() else { return };
    let (user, other, keeper) = (env.user(), env.user(), env.harvester());
    let whirlpool = env.whirlpool;
    let nft = deposit(&mut env, &manifest, 0, &user);
    let steal = env.autopay_ix(&keeper.pubkey(), &other.pubkey(), &whirlpool, &nft, orca_accounts(&manifest, 0));
    expect_err(env.send(&[steal], &[&keeper]), pluribus::error::PluribusError::PositionNotFound);
}

#[test]
fn autopay_pays_the_caller_the_compounding_bounty_and_books_the_rest() {
    let Some((mut env, manifest)) = real_pool() else { return };
    env.lender(1_000_000 * USDC);
    let admin = env.admin.insecure_clone();
    expect_ok(env.send(&[env.set_compound_bounty_ix(&admin.pubkey(), 200)], &[&admin]));
    let (user, keeper) = (env.user(), env.harvester());
    let (me, whirlpool, sol, usdc) = (user.pubkey(), env.whirlpool, env.sol, env.usdc);
    let nft = deposit(&mut env, &manifest, 1, &user);
    expect_ok(env.draw(&user, 1000 * USDC));
    let (fee_sol, fee_usdc) = (num(&manifest["positions"][1]["uncollectedFeeA"]), num(&manifest["positions"][1]["uncollectedFeeB"]));
    let bounty = (fee_sol * 200 / 10_000, fee_usdc * 200 / 10_000);
    assert!(bounty.0 > 0 && bounty.1 > 0);

    expect_ok(env.send(&[env.autopay_ix(&keeper.pubkey(), &me, &whirlpool, &nft, orca_accounts(&manifest, 1))], &[&keeper]));

    // The caller got the same 2% of each fee a compound pays, and the rest went to the account as before
    assert_eq!((env.balance(&sol, &keeper.pubkey()), env.balance(&usdc, &keeper.pubkey())), bounty);
    assert_eq!(env.debt(&me), 1000 * USDC - (fee_usdc - bounty.1));
    let credit = env.credit(&me);
    assert_eq!(credit.positions[credit.find(KIND_TOKEN, &sol).unwrap()].amount, fee_sol - bounty.0);
    assert!(credit.find(KIND_TOKEN, &usdc).is_err());
    assert_books_match_vaults(&env);
}

#[test]
fn autopay_pays_its_bounty_only_into_accounts_that_are_not_the_programs_vaults() {
    let Some((mut env, manifest)) = real_pool() else { return };
    let (user, keeper) = (env.user(), env.harvester());
    let (me, whirlpool, sol, usdc) = (user.pubkey(), env.whirlpool, env.sol, env.usdc);
    let nft = deposit(&mut env, &manifest, 0, &user);
    let ix = env.autopay_ix(&keeper.pubkey(), &me, &whirlpool, &nft, orca_accounts(&manifest, 0));
    let (mine_sol, mine_usdc) = (ata(&keeper.pubkey(), &sol, &TOKEN), ata(&keeper.pubkey(), &usdc, &TOKEN));
    // The collateral vaults or the lending vault as recipients would only move the protocol's money around
    for (mine, vault) in [(mine_sol, env.vault_pda(&sol)), (mine_usdc, env.vault_pda(&usdc)), (mine_usdc, env.usdc_vault)] {
        let mut bad = ix.clone();
        let at = bad.accounts.iter().position(|m| m.pubkey == mine).unwrap();
        bad.accounts[at].pubkey = vault;
        assert!(env.send(&[bad], &[&keeper]).is_err());
    }
    assert_eq!(env.balance(&sol, &keeper.pubkey()) + env.balance(&usdc, &keeper.pubkey()), 0);
    // And the untouched instruction still works
    expect_ok(env.send(&[ix], &[&keeper]));
    assert_books_match_vaults(&env);
}

#[test]
fn a_liquidated_real_position_reaches_the_liquidator() {
    let Some((mut env, manifest)) = real_pool() else { return };
    env.lender(1_000_000 * USDC);
    let (user, liquidator) = (env.user(), env.wallet());
    let (me, sol, usdc) = (user.pubkey(), env.sol, env.usdc);
    let nft = deposit(&mut env, &manifest, 0, &user);
    let limit = env.health(&me).credit_limit;
    expect_ok(env.draw(&user, limit));

    env.set_price(&sol, 100 * USDC);
    env.fund(&usdc, &liquidator.pubkey(), 1_000_000 * USDC);
    env.fund(&nft, &liquidator.pubkey(), 0);
    let debt = env.debt(&me);
    expect_ok(env.send(&[env.liquidate_lp_ix(&liquidator.pubkey(), &me, &nft)], &[&liquidator]));

    assert_eq!(env.balance(&nft, &liquidator.pubkey()), 1);
    // One call repays at most half the debt, and the rest of the price stays with the borrower as USDC
    assert!(env.debt(&me) >= debt - debt / 2);
    let credit = env.credit(&me);
    assert!(credit.positions[credit.find(KIND_TOKEN, &usdc).unwrap()].amount > 0);
    assert_books_match_vaults(&env);
}

/// Liquidity the Orca position for this NFT holds
fn liquidity_of(env: &Env, nft: &Pubkey) -> u128 {
    let d = env.svm.get_account(&orca_position(nft)).unwrap().data;
    u128::from_le_bytes(d[72..88].try_into().unwrap())
}

/// A pool with a 2% bounty, the second snapshotted position deposited and set to compound within `tolerance_bps`,
/// and a bounty hunter with token accounts for both of the pool's tokens
fn compounding(tolerance_bps: u16) -> Option<(Env, Value, Keypair, Keypair, Pubkey)> {
    let (mut env, manifest) = real_pool()?;
    let admin = env.admin.insecure_clone();
    let (user, hunter) = (env.user(), env.wallet());
    let (sol, usdc) = (env.sol, env.usdc);
    let nft = deposit(&mut env, &manifest, 1, &user);
    expect_ok(env.send(&[env.set_compound_bounty_ix(&admin.pubkey(), 200)], &[&admin]));
    if tolerance_bps > 0 {
        expect_ok(env.send(&[env.set_compound_ix(&user.pubkey(), &nft, tolerance_bps)], &[&user]));
    }
    env.fund(&sol, &hunter.pubkey(), 0);
    env.fund(&usdc, &hunter.pubkey(), 0);
    Some((env, manifest, user, hunter, nft))
}

#[test]
fn compound_puts_real_fees_back_into_the_position_and_pays_the_bounty() {
    let Some((mut env, manifest, user, hunter, nft)) = compounding(100) else { return };
    let (me, whirlpool, sol, usdc) = (user.pubkey(), env.whirlpool, env.sol, env.usdc);
    let (fee_sol, fee_usdc) = (num(&manifest["positions"][1]["uncollectedFeeA"]), num(&manifest["positions"][1]["uncollectedFeeB"]));
    let before = (liquidity_of(&env, &nft), env.health(&me).collateral_value);

    let compound = env.compound_orca_ix(&hunter.pubkey(), &me, &whirlpool, &nft, orca_accounts(&manifest, 1), &hunter.pubkey());
    let meta = expect_ok(env.send(&[compound], &[&hunter]));
    println!("compound_orca: {} compute units", meta.compute_units_consumed);

    // The caller got 2% of each fee, the position grew, and what the range could not take is the account's collateral
    assert_eq!(env.balance(&sol, &hunter.pubkey()), fee_sol * 200 / 10_000);
    assert_eq!(env.balance(&usdc, &hunter.pubkey()), fee_usdc * 200 / 10_000);
    assert!(liquidity_of(&env, &nft) > before.0);
    let credit = env.credit(&me);
    let kept = |mint: &Pubkey| credit.find(KIND_TOKEN, mint).map_or(0, |i| credit.positions[i].amount);
    // At most the fees after the bounty stay behind, and at least one side went in
    assert!(kept(&sol) < fee_sol - fee_sol * 2 / 100 || kept(&usdc) < fee_usdc - fee_usdc * 2 / 100);
    assert!(env.health(&me).collateral_value > before.1);
    assert_books_match_vaults(&env);
}

#[test]
fn compound_waits_for_the_pool_price_to_sit_near_the_oracle() {
    let Some((mut env, manifest, user, hunter, nft)) = compounding(100) else { return };
    let (me, whirlpool, sol) = (user.pubkey(), env.whirlpool, env.sol);
    let price = pool_price(&manifest);
    // The oracle 3% above the pool: outside a 1% tolerance, inside 5%
    env.set_price(&sol, price * 103 / 100);
    let compound = env.compound_orca_ix(&hunter.pubkey(), &me, &whirlpool, &nft, orca_accounts(&manifest, 1), &hunter.pubkey());
    expect_err(env.send(&[compound.clone()], &[&hunter]), pluribus::error::PluribusError::PoolPriceOff);
    expect_ok(env.send(&[env.set_compound_ix(&me, &nft, 500)], &[&user]));
    expect_ok(env.send(&[compound], &[&hunter]));
}

#[test]
fn compounding_is_the_owners_choice_and_autopay_steps_aside_for_it() {
    let Some((mut env, manifest, user, hunter, nft)) = compounding(0) else { return };
    let (me, whirlpool) = (user.pubkey(), env.whirlpool);
    let compound = env.compound_orca_ix(&hunter.pubkey(), &me, &whirlpool, &nft, orca_accounts(&manifest, 1), &hunter.pubkey());
    expect_err(env.send(&[compound.clone()], &[&hunter]), pluribus::error::PluribusError::CompoundOff);

    // Capped, and set only through the owner's own account
    expect_err(env.send(&[env.set_compound_ix(&me, &nft, MAX_COMPOUND_SLIPPAGE_BPS + 1)], &[&user]), pluribus::error::PluribusError::InvalidParams);
    assert!(env.send(&[env.set_compound_ix(&hunter.pubkey(), &nft, 100)], &[&hunter]).is_err());
    expect_ok(env.send(&[env.set_compound_ix(&me, &nft, 100)], &[&user]));
    let autopay = env.autopay_ix(&hunter.pubkey(), &me, &whirlpool, &nft, orca_accounts(&manifest, 1));
    expect_err(env.send(&[autopay.clone()], &[&hunter]), pluribus::error::PluribusError::CompoundOn);

    // Off again, and autopay takes the fees as before
    expect_ok(env.send(&[env.set_compound_ix(&me, &nft, 0)], &[&user]));
    expect_ok(env.send(&[autopay], &[&hunter]));
    expect_err(env.send(&[compound], &[&hunter]), pluribus::error::PluribusError::CompoundOff);

    // The bounty has a hard cap
    let admin = env.admin.insecure_clone();
    expect_err(env.send(&[env.set_compound_bounty_ix(&admin.pubkey(), MAX_COMPOUND_BOUNTY_BPS + 1)], &[&admin]), pluribus::error::PluribusError::InvalidParams);
}

#[test]
fn a_withdrawn_position_forgets_its_compound_setting() {
    let Some((mut env, manifest, user, _hunter, nft)) = compounding(300) else { return };
    let me = user.pubkey();
    let slot = |env: &Env| env.credit(&me).positions.iter().position(|p| p.mint == nft);
    assert_eq!(env.credit(&me).compound_slippage_bps[slot(&env).unwrap()], 300);
    let whirlpool = env.whirlpool;
    let program = env.svm.get_account(&nft).unwrap().owner;
    env.fund(&nft, &me, 0);
    expect_ok(env.send(&[env.withdraw_lp_ix(&me, &nft)], &[&user]));
    assert!(env.credit(&me).compound_slippage_bps.iter().all(|s| *s == 0));
    let holder = ata(&me, &nft, &program);
    expect_ok(env.send(&[env.deposit_lp_from_ix(&me, &whirlpool, &nft, &holder)], &[&user]));
    assert_eq!(env.credit(&me).compound_slippage_bps[slot(&env).unwrap()], 0);
    let _ = manifest;
}
