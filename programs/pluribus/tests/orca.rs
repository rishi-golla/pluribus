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
    let (user, keeper) = (env.user(), env.wallet());
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
    let (user, keeper) = (env.user(), env.wallet());
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
    let (user, other, keeper) = (env.user(), env.user(), env.wallet());
    let whirlpool = env.whirlpool;
    let nft = deposit(&mut env, &manifest, 0, &user);
    let steal = env.autopay_ix(&keeper.pubkey(), &other.pubkey(), &whirlpool, &nft, orca_accounts(&manifest, 0));
    expect_err(env.send(&[steal], &[&keeper]), pluribus::error::PluribusError::PositionNotFound);
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
