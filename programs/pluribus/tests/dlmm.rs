mod common;

use {
    anchor_lang::{
        prelude::*,
        solana_program::{instruction::Instruction, program_option::COption, program_pack::Pack, system_program},
        InstructionData, ToAccountMetas,
    },
    anchor_spl::token::spl_token::state::{Account as TokenState, AccountState},
    base64::{engine::general_purpose::STANDARD, Engine},
    common::*,
    litesvm::LiteSVM,
    pluribus::{
        constants::*,
        error::PluribusError,
        state::{Asset, LpMarket},
    },
    serde_json::Value,
    solana_account::Account,
    solana_keypair::Keypair,
    solana_signer::Signer,
    std::{collections::HashMap, fs, path::PathBuf, str::FromStr},
};

const MEMO: Pubkey = pubkey!("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
/// Meteora's strategy that spreads both tokens evenly, token Y under the active bin and token X over it
const SPOT: u8 = 6;
/// First 8 bytes of sha256("global:swap2")
const SWAP: [u8; 8] = [0x41, 0x4b, 0x3f, 0x4c, 0xeb, 0x5b, 0x5b, 0x88];
/// First 8 bytes of sha256("global:remove_liquidity_by_range2")
const REMOVE: [u8; 8] = [0xcc, 0x02, 0xc3, 0x91, 0x35, 0x91, 0x91, 0xcd];
/// First 8 bytes of sha256("global:claim_fee2")
const CLAIM: [u8; 8] = [0x70, 0xbf, 0x65, 0xab, 0x1c, 0x90, 0x7f, 0xbb];
/// First 8 bytes of sha256("global:close_position2")
const CLOSE: [u8; 8] = [0xae, 0x5a, 0x23, 0x73, 0xba, 0x28, 0x93, 0xe2];
/// First 8 bytes of sha256("global:close_position_if_empty")
const CLOSE_IF_EMPTY: [u8; 8] = [0x3b, 0x7c, 0xd4, 0x76, 0x5b, 0x98, 0x6e, 0x9d];
const BINS_PER_ARRAY: i32 = 70;

fn key(v: &Value) -> Pubkey {
    Pubkey::from_str(v.as_str().unwrap()).unwrap()
}

/// The SOL/USDC pair copied from mainnet, where SOL is token X
struct Pair {
    address: Pubkey,
    active: i32,
    reserve_x: Pubkey,
    reserve_y: Pubkey,
    oracle: Pubkey,
    event_authority: Pubkey,
    arrays: HashMap<i32, Pubkey>,
    /// USDC per SOL at the active bin, with 6 decimals
    price: u64,
}

impl Pair {
    /// The bin arrays covering bins `lower..=upper`, writable as every liquidity instruction needs them
    fn bins(&self, lower: i32, upper: i32) -> Vec<AccountMeta> {
        (lower.div_euclid(BINS_PER_ARRAY)..=upper.div_euclid(BINS_PER_ARRAY)).map(|i| AccountMeta::new(self.arrays[&i], false)).collect()
    }
}

/// A chain holding the real DLMM program and a pair copied from mainnet, with Pluribus set up on that pair's own mints
/// and the pair listed as its LP market
/// Returns None when the DLMM binary has not been fetched, since it is too large to commit
/// `DLMM_SO` names another binary in the fixtures folder, so the devnet build can be checked against the same accounts
fn real_pair() -> Option<(Env, Pair)> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/dlmm");
    let binary = std::env::var("DLMM_SO").unwrap_or_else(|_| "lb_clmm.so".into());
    let Ok(program) = fs::read(dir.join(binary)) else {
        eprintln!("Skipped: run `npm run dlmm:snapshot` to fetch lb_clmm.so");
        return None;
    };
    let manifest: Value = serde_json::from_str(&fs::read_to_string(dir.join("manifest.json")).unwrap()).unwrap();
    let mut svm = LiteSVM::new();
    svm.add_program(METEORA_DLMM_PROGRAM_ID, &program).unwrap();
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
    let pair = Pair {
        address: key(&manifest["lbPair"]),
        active: manifest["activeId"].as_i64().unwrap() as i32,
        reserve_x: key(&manifest["tokenX"]["reserve"]),
        reserve_y: key(&manifest["tokenY"]["reserve"]),
        oracle: key(&manifest["oracle"]),
        event_authority: key(&manifest["eventAuthority"]),
        arrays: manifest["binArrays"].as_array().unwrap().iter().map(|b| (b["index"].as_i64().unwrap() as i32, key(&b["address"]))).collect(),
        price: (manifest["price"].as_str().unwrap().parse::<f64>().unwrap() * 1e6).round() as u64,
    };
    let (usdc, sol) = (key(&manifest["tokenY"]["mint"]), key(&manifest["tokenX"]["mint"]));
    let mut env = Env::on(svm, default_params(), true, Some((usdc, sol, pair.address)));
    // The oracle reports the price the pair itself sits at, so both sides value the same thing
    env.set_price(&sol, pair.price);
    Some((env, pair))
}

/// DLMM instructions do more work than the 200k units a lone instruction gets
fn budget() -> Instruction {
    Instruction::new_with_bytes(pubkey!("ComputeBudget111111111111111111111111111111"), &[&[2u8][..], &1_400_000u32.to_le_bytes()].concat(), vec![])
}

/// The bin the pair trades in right now
fn active_of(env: &Env, pair: &Pair) -> i32 {
    i32::from_le_bytes(env.svm.get_account(&pair.address).unwrap().data[76..80].try_into().unwrap())
}

fn range_of(env: &Env, position: &Pubkey) -> (i32, i32) {
    let d = env.svm.get_account(position).unwrap().data;
    (i32::from_le_bytes(d[7912..7916].try_into().unwrap()), i32::from_le_bytes(d[7916..7920].try_into().unwrap()))
}

/// The liquidity share a position holds in each of its 70 bin slots
fn shares_of(env: &Env, position: &Pubkey) -> Vec<u128> {
    let d = env.svm.get_account(position).unwrap().data;
    (0..70).map(|i| u128::from_le_bytes(d[72 + 16 * i..88 + 16 * i].try_into().unwrap())).collect()
}

fn open_ix(env: &Env, pair: &Pair, owner: &Pubkey, position: &Pubkey, lower: i32, width: i32) -> Instruction {
    Instruction::new_with_bytes(
        pluribus::ID,
        &pluribus::instruction::DlmmOpen { lower_bin_id: lower, width }.data(),
        pluribus::accounts::DlmmOpen {
            owner: *owner,
            credit: env.credit_pda(owner),
            pool: env.pool,
            lp_market: env.lp_market_pda(&pair.address),
            base_asset: env.asset_pda(&env.sol),
            lb_pair: pair.address,
            position: *position,
            event_authority: pair.event_authority,
            dlmm_program: METEORA_DLMM_PROGRAM_ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn add_ix(env: &Env, pair: &Pair, owner: &Pubkey, position: &Pubkey, sol: u64, usdc: u64) -> Instruction {
    let (lower, upper) = range_of(env, position);
    let mut metas = pluribus::accounts::DlmmAdd {
        owner: *owner,
        credit: env.credit_pda(owner),
        pool: env.pool,
        lp_market: env.lp_market_pda(&pair.address),
        base_asset: env.asset_pda(&env.sol),
        position: *position,
        lb_pair: pair.address,
        bitmap_extension: METEORA_DLMM_PROGRAM_ID,
        owner_token_x: ata(owner, &env.sol, &TOKEN),
        owner_token_y: ata(owner, &env.usdc, &TOKEN),
        reserve_x: pair.reserve_x,
        reserve_y: pair.reserve_y,
        token_x_mint: env.sol,
        token_y_mint: env.usdc,
        token_x_program: TOKEN,
        token_y_program: TOKEN,
        event_authority: pair.event_authority,
        dlmm_program: METEORA_DLMM_PROGRAM_ID,
    }
    .to_account_metas(None);
    metas.extend(pair.bins(lower, upper));
    let data = pluribus::instruction::DlmmAdd { amount_x: sol, amount_y: usdc, active_id: pair.active, max_active_bin_slippage: 200, strategy: SPOT };
    Instruction::new_with_bytes(pluribus::ID, &data.data(), metas)
}

fn exit_metas(env: &Env, pair: &Pair, owner: &Pubkey, position: &Pubkey) -> Vec<AccountMeta> {
    pluribus::accounts::DlmmExit {
        owner: *owner,
        credit: env.credit_pda(owner),
        pool: env.pool,
        position: *position,
        lb_pair: pair.address,
        bitmap_extension: METEORA_DLMM_PROGRAM_ID,
        owner_token_x: ata(owner, &env.sol, &TOKEN),
        owner_token_y: ata(owner, &env.usdc, &TOKEN),
        reserve_x: pair.reserve_x,
        reserve_y: pair.reserve_y,
        token_x_mint: env.sol,
        token_y_mint: env.usdc,
        token_x_program: TOKEN,
        token_y_program: TOKEN,
        memo_program: MEMO,
        event_authority: pair.event_authority,
        dlmm_program: METEORA_DLMM_PROGRAM_ID,
    }
    .to_account_metas(None)
}

fn remove_ix(env: &Env, pair: &Pair, owner: &Pubkey, position: &Pubkey, bps: u16) -> Instruction {
    let (lower, upper) = range_of(env, position);
    let bins = pair.bins(lower, upper);
    let data = pluribus::instruction::DlmmRemove { bps, bin_arrays: bins.len() as u8 }.data();
    let mut metas = exit_metas(env, pair, owner, position);
    metas.extend(bins);
    metas.extend(env.health_metas(owner));
    Instruction::new_with_bytes(pluribus::ID, &data, metas)
}

/// Health accounts are listed for the positions as they will be once this one is gone
fn close_ix(env: &Env, pair: &Pair, owner: &Pubkey, position: &Pubkey, claim: bool) -> Instruction {
    let (lower, upper) = range_of(env, position);
    let bins = if claim { pair.bins(lower, upper) } else { vec![] };
    let data = pluribus::instruction::DlmmClose { bin_arrays: bins.len() as u8 }.data();
    let mut metas = exit_metas(env, pair, owner, position);
    metas.extend(bins);
    let mut health = env.health_metas(owner);
    // Market and pair come before the position, base asset and price after it
    let at = health.iter().position(|m| m.pubkey == *position).unwrap() - 2;
    health.drain(at..at + 5);
    metas.extend(health);
    Instruction::new_with_bytes(pluribus::ID, &data, metas)
}

fn liquidate_ix(env: &Env, pair: &Pair, liquidator: &Pubkey, owner: &Pubkey, position: &Pubkey, repay_amount: u64) -> Instruction {
    let (lower, upper) = range_of(env, position);
    // A position that holds nothing is closed without naming bin arrays, which it may not even have
    let bins = if shares_of(env, position).iter().any(|s| *s > 0) { pair.bins(lower, upper) } else { vec![] };
    let data = pluribus::instruction::DlmmLiquidate { repay_amount, bin_arrays: bins.len() as u8 }.data();
    let mut metas = pluribus::accounts::DlmmLiquidate {
        liquidator: *liquidator,
        credit: env.credit_pda(owner),
        pool: env.pool,
        usdc_mint: env.usdc,
        usdc_vault: env.usdc_vault,
        liquidator_usdc: ata(liquidator, &env.usdc, &TOKEN),
        owner: *owner,
        token_program: TOKEN,
        position: *position,
        lb_pair: pair.address,
        bitmap_extension: METEORA_DLMM_PROGRAM_ID,
        liquidator_token_x: ata(liquidator, &env.sol, &TOKEN),
        liquidator_token_y: ata(liquidator, &env.usdc, &TOKEN),
        reserve_x: pair.reserve_x,
        reserve_y: pair.reserve_y,
        token_x_mint: env.sol,
        token_y_mint: env.usdc,
        token_x_program: TOKEN,
        token_y_program: TOKEN,
        memo_program: MEMO,
        event_authority: pair.event_authority,
        dlmm_program: METEORA_DLMM_PROGRAM_ID,
    }
    .to_account_metas(None);
    metas.extend(bins);
    metas.extend(env.health_metas(owner));
    Instruction::new_with_bytes(pluribus::ID, &data, metas)
}

fn autopay_ix(env: &Env, pair: &Pair, caller: &Pubkey, owner: &Pubkey, position: &Pubkey) -> Instruction {
    let (lower, upper) = range_of(env, position);
    let mut metas = pluribus::accounts::DlmmAutopay {
        caller: *caller,
        credit: env.credit_pda(owner),
        pool: env.pool,
        lp_market: env.lp_market_pda(&pair.address),
        lb_pair: pair.address,
        position: *position,
        base_asset: env.asset_pda(&env.sol),
        base_vault: env.vault_pda(&env.sol),
        base_mint: env.sol,
        usdc_asset: env.asset_pda(&env.usdc),
        usdc_collateral_vault: env.vault_pda(&env.usdc),
        usdc_mint: env.usdc,
        usdc_vault: env.usdc_vault,
        reserve_x: pair.reserve_x,
        reserve_y: pair.reserve_y,
        token_program: TOKEN,
        memo_program: MEMO,
        event_authority: pair.event_authority,
        dlmm_program: METEORA_DLMM_PROGRAM_ID,
    }
    .to_account_metas(None);
    metas.extend(pair.bins(lower, upper));
    Instruction::new_with_bytes(pluribus::ID, &pluribus::instruction::DlmmAutopay {}.data(), metas)
}

/// A swap sent straight to the DLMM program: SOL for USDC when `sell_sol`, walking the bin arrays the price moves through
fn swap_ix(env: &Env, pair: &Pair, trader: &Pubkey, sell_sol: bool, amount_in: u64) -> Instruction {
    let (sol, usdc) = (ata(trader, &env.sol, &TOKEN), ata(trader, &env.usdc, &TOKEN));
    let (token_in, token_out) = if sell_sol { (sol, usdc) } else { (usdc, sol) };
    let optional = AccountMeta::new_readonly(METEORA_DLMM_PROGRAM_ID, false);
    let mut metas = vec![
        AccountMeta::new(pair.address, false),
        optional.clone(),
        AccountMeta::new(pair.reserve_x, false),
        AccountMeta::new(pair.reserve_y, false),
        AccountMeta::new(token_in, false),
        AccountMeta::new(token_out, false),
        AccountMeta::new_readonly(env.sol, false),
        AccountMeta::new_readonly(env.usdc, false),
        AccountMeta::new(pair.oracle, false),
        optional,
        AccountMeta::new_readonly(*trader, true),
        AccountMeta::new_readonly(TOKEN, false),
        AccountMeta::new_readonly(TOKEN, false),
        AccountMeta::new_readonly(MEMO, false),
        AccountMeta::new_readonly(pair.event_authority, false),
        AccountMeta::new_readonly(METEORA_DLMM_PROGRAM_ID, false),
    ];
    // Selling SOL pushes the price down through lower bins, buying it pushes up
    let start = active_of(env, pair).div_euclid(BINS_PER_ARRAY);
    let path = if sell_sol { [start, start - 1, start - 2] } else { [start, start + 1, start + 2] };
    metas.extend(path.iter().map(|i| AccountMeta::new(pair.arrays[i], false)));
    let data = [&SWAP[..], &amount_in.to_le_bytes(), &0u64.to_le_bytes(), &[0u8; 4]].concat();
    Instruction::new_with_bytes(METEORA_DLMM_PROGRAM_ID, &data, metas)
}

/// Sets `owner`'s wrapped SOL account to hold exactly `amount`, the way the token program keeps it:
/// the pair's SOL here is the real native mint, whose accounts carry their balance in lamports as well
fn fund_sol(env: &mut Env, owner: &Pubkey, amount: u64) {
    let rent = env.svm.minimum_balance_for_rent_exemption(TokenState::LEN);
    let state = TokenState {
        mint: env.sol,
        owner: *owner,
        amount,
        delegate: COption::None,
        state: AccountState::Initialized,
        is_native: COption::Some(rent),
        delegated_amount: 0,
        close_authority: COption::None,
    };
    let mut data = vec![0; TokenState::LEN];
    TokenState::pack(state, &mut data).unwrap();
    let account = Account { lamports: rent + amount, data, owner: TOKEN, executable: false, rent_epoch: 0 };
    env.svm.set_account(ata(owner, &env.sol, &TOKEN), account).unwrap();
}

/// Deposits `amount` lamports of wrapped SOL as plain token collateral
fn deposit_sol(env: &mut Env, user: &Keypair, amount: u64) {
    fund_sol(env, &user.pubkey(), amount);
    let sol = env.sol;
    expect_ok(env.send(&[env.deposit_token_ix(&user.pubkey(), &sol, amount)], &[user]));
}

/// A wallet holding `sol` and `usdc` that trades on the pair without ever touching Pluribus
fn trader(env: &mut Env, sol: u64, usdc: u64) -> Keypair {
    let wallet = env.wallet();
    let usdc_mint = env.usdc;
    fund_sol(env, &wallet.pubkey(), sol);
    env.fund(&usdc_mint, &wallet.pubkey(), usdc);
    wallet
}

/// Opens a 70-bin position centred on the active bin for `user` and funds it with `sol` and `usdc`
fn open_position(env: &mut Env, pair: &Pair, user: &Keypair, sol: u64, usdc: u64) -> Pubkey {
    let (me, position) = (user.pubkey(), Keypair::new());
    let usdc_mint = env.usdc;
    fund_sol(env, &me, sol);
    env.fund(&usdc_mint, &me, usdc);
    expect_ok(env.send(&[open_ix(env, pair, &me, &position.pubkey(), pair.active - 34, 70)], &[user, &position]));
    let meta = expect_ok(env.send(&[budget(), add_ix(env, pair, &me, &position.pubkey(), sol, usdc)], &[user]));
    println!("add liquidity to 70 bins: {} compute units", meta.compute_units_consumed);
    position.pubkey()
}

/// What `sol` lamports and `usdc` are worth together at `price`
fn worth(sol: u64, usdc: u64, price: u64) -> u64 {
    (sol as u128 * price as u128 / SOL as u128) as u64 + usdc
}

#[test]
fn the_pool_owns_the_position_it_opens_and_the_owner_funds_it() {
    let Some((mut env, pair)) = real_pair() else { return };
    let user = env.user();
    let me = user.pubkey();
    let (sol, usdc) = (env.sol, env.usdc);
    let position = open_position(&mut env, &pair, &user, 70 * SOL, 5_000 * USDC);

    // The DLMM program made the account, the pool PDA owns the position, and nobody is left as operator
    let account = env.svm.get_account(&position).unwrap();
    assert_eq!(account.owner, METEORA_DLMM_PROGRAM_ID);
    assert_eq!(account.data[8..40], pair.address.to_bytes());
    assert_eq!(account.data[40..72], env.pool.to_bytes());
    assert_eq!(account.data[7960..7992], [0; 32]);
    let credit = env.credit(&me);
    assert_eq!(credit.positions[credit.find(KIND_DLMM, &position).unwrap()].amount, 1);

    // Every token that left the wallet is in the position, which is worth it at the pair's own price
    let (spent_sol, spent_usdc) = (70 * SOL - env.balance(&sol, &me), 5_000 * USDC - env.balance(&usdc, &me));
    assert!(spent_sol > 60 * SOL && spent_usdc > 4_900 * USDC, "spent {spent_sol} lamports and {spent_usdc} USDC");
    let (value, paid) = (env.health(&me).position_value[0], worth(spent_sol, spent_usdc, pair.price));
    assert!(value <= paid && value > paid - paid / 100, "valued {value} for {paid} paid in");
    assert!(shares_of(&env, &position).iter().all(|s| *s > 0));

    // It backs a draw like any collateral
    env.lender(100_000 * USDC);
    let limit = env.health(&me).credit_limit;
    assert!(limit > paid / 2 && limit < paid);
    let meta = expect_ok(env.send(&[env.draw_ix(&me, limit)], &[&user]));
    println!("draw against one 70-bin position: {} compute units", meta.compute_units_consumed);
    expect_err(env.draw(&user, USDC), PluribusError::ExceedsCreditLimit);
}

#[test]
fn a_position_is_never_valued_above_what_it_pays_out() {
    let Some((mut env, pair)) = real_pair() else { return };
    let user = env.user();
    let me = user.pubkey();
    let (sol, usdc) = (env.sol, env.usdc);
    let position = open_position(&mut env, &pair, &user, 70 * SOL, 5_000 * USDC);
    // The program's value at prices under, at and over the pair's own, before anything comes out
    let prices = [pair.price / 2, pair.price * 99 / 100, pair.price, pair.price * 101 / 100, pair.price * 2];
    let values: Vec<u64> = prices
        .iter()
        .map(|p| {
            env.set_price(&sol, *p);
            env.health(&me).position_value[0]
        })
        .collect();

    let (had_sol, had_usdc) = (env.balance(&sol, &me), env.balance(&usdc, &me));
    let meta = expect_ok(env.send(&[budget(), remove_ix(&env, &pair, &me, &position, 10_000)], &[&user]));
    println!("remove all liquidity from 70 bins: {} compute units", meta.compute_units_consumed);
    let (got_sol, got_usdc) = (env.balance(&sol, &me) - had_sol, env.balance(&usdc, &me) - had_usdc);
    for (price, value) in prices.iter().zip(values) {
        let paid = worth(got_sol, got_usdc, *price);
        assert!(value <= paid, "at {price}: valued {value}, paid out {paid}");
        // The pair has not moved, so at its own price the two agree to within a bin's width
        if *price == pair.price {
            assert!(value > paid - paid / 200, "valued {value}, paid out {paid}");
        }
    }
    assert!(shares_of(&env, &position).iter().all(|s| *s == 0));
    assert_eq!(env.health(&me).position_value[0], 0);
}

#[test]
fn moving_the_pair_price_does_not_move_the_value() {
    let Some((mut env, pair)) = real_pair() else { return };
    let user = env.user();
    let me = user.pubkey();
    let (sol, usdc) = (env.sol, env.usdc);
    let position = open_position(&mut env, &pair, &user, 70 * SOL, 5_000 * USDC);
    let before = env.health(&me);

    for sell_sol in [true, false] {
        // Enough to walk the active bin through a good part of the position's range, as a flash loan could
        let whale = trader(&mut env, 3_000 * SOL, 300_000 * USDC);
        let amount = if sell_sol { 2_000 * SOL } else { 250_000 * USDC };
        expect_ok(env.send(&[budget(), swap_ix(&env, &pair, &whale.pubkey(), sell_sol, amount)], &[&whale]));
        let active = active_of(&env, &pair);
        assert!((active - pair.active).abs() > 10, "the active bin only moved from {} to {active}", pair.active);
        // The value is built from the position's shares and the oracle price, neither of which a swap touches
        assert_eq!(env.health(&me), before);
    }

    // What it pays out after the swaps is still worth at least that value at the oracle price
    let (had_sol, had_usdc) = (env.balance(&sol, &me), env.balance(&usdc, &me));
    expect_ok(env.send(&[budget(), remove_ix(&env, &pair, &me, &position, 10_000)], &[&user]));
    let paid = worth(env.balance(&sol, &me) - had_sol, env.balance(&usdc, &me) - had_usdc, pair.price);
    assert!(before.position_value[0] <= paid, "valued {}, paid out {paid}", before.position_value[0]);
}

/// Everything that takes value out of a position, sent straight to the DLMM program and signed by `who`:
/// removing its liquidity, collecting its fees, closing it and closing it if empty
fn direct_ixs(env: &Env, pair: &Pair, who: &Pubkey, position: &Pubkey) -> Vec<Instruction> {
    let (lower, upper) = range_of(env, position);
    let (range, no_hooks) = ([lower.to_le_bytes(), upper.to_le_bytes()].concat(), [0u8; 4]);
    let exit = exit_metas(env, pair, who, position);
    let [position, lb_pair, token_x, token_y, reserve_x, reserve_y] = [3, 4, 6, 7, 8, 9].map(|i| exit[i].clone());
    let signer = AccountMeta::new_readonly(*who, true);
    // After the leading accounts both share the mints, token programs, memo program, event authority and the program itself
    let mut remove = exit[3..10].to_vec();
    remove.extend([vec![exit[10].clone(), exit[11].clone(), signer.clone()], exit[12..].to_vec()].concat());
    let mut claim = vec![lb_pair, position.clone(), signer.clone(), reserve_x, reserve_y, token_x, token_y];
    claim.extend(exit[10..].to_vec());
    let close = vec![position, signer, AccountMeta::new(*who, false), exit[15].clone(), exit[16].clone()];
    let bins = pair.bins(lower, upper);
    [
        ([&REMOVE[..], &range, &10_000u16.to_le_bytes(), &no_hooks].concat(), [remove, bins.clone()].concat()),
        ([&CLAIM[..], &range, &no_hooks].concat(), [claim, bins].concat()),
        (CLOSE.to_vec(), close.clone()),
        (CLOSE_IF_EMPTY.to_vec(), close),
    ]
    .into_iter()
    .map(|(data, metas)| Instruction::new_with_bytes(METEORA_DLMM_PROGRAM_ID, &data, metas))
    .collect()
}

#[test]
fn a_position_comes_out_only_through_the_program_and_within_the_credit_limit() {
    let Some((mut env, pair)) = real_pair() else { return };
    env.lender(100_000 * USDC);
    let (user, other) = (env.user(), env.user());
    let me = user.pubkey();
    let usdc = env.usdc;
    let position = open_position(&mut env, &pair, &user, 70 * SOL, 5_000 * USDC);

    // Nobody can go around the program, the borrower included: to Meteora the position is the pool's alone
    fund_sol(&mut env, &other.pubkey(), SOL);
    env.fund(&usdc, &other.pubkey(), USDC);
    for who in [&user, &other] {
        for ix in direct_ixs(&env, &pair, &who.pubkey(), &position) {
            // Anchor's code for a failed account constraint, here the one that asks for the owner or operator
            assert!(failed_with_code(&env.send(&[budget(), ix], &[who]), 2003));
        }
    }
    // Nor can another account's owner name it as their own
    expect_err(env.send(&[budget(), add_ix(&env, &pair, &other.pubkey(), &position, SOL, USDC)], &[&other]), PluribusError::PositionNotFound);
    expect_err(env.send(&[budget(), remove_ix(&env, &pair, &other.pubkey(), &position, 10_000)], &[&other]), PluribusError::PositionNotFound);

    let limit = env.health(&me).credit_limit;
    expect_ok(env.draw(&user, limit / 2));
    // Half the liquidity still covers half the limit, all of it does not
    expect_err(env.send(&[budget(), remove_ix(&env, &pair, &me, &position, 10_000)], &[&user]), PluribusError::ExceedsCreditLimit);
    expect_ok(env.send(&[budget(), remove_ix(&env, &pair, &me, &position, 4_000)], &[&user]));
    expect_err(env.send(&[budget(), remove_ix(&env, &pair, &me, &position, 5_000)], &[&user]), PluribusError::ExceedsCreditLimit);
    // A position that still holds liquidity cannot be closed
    assert!(env.send(&[budget(), close_ix(&env, &pair, &me, &position, true)], &[&user]).is_err());

    // Once the debt is repaid everything comes out, and closing returns the rent and frees the slot
    env.fund(&usdc, &me, 10_000 * USDC);
    let debt = env.debt(&me);
    expect_ok(env.send(&[env.repay_ix(&me, &me, debt)], &[&user]));
    expect_ok(env.send(&[budget(), remove_ix(&env, &pair, &me, &position, 10_000)], &[&user]));
    let lamports = env.svm.get_balance(&me).unwrap();
    let meta = expect_ok(env.send(&[budget(), close_ix(&env, &pair, &me, &position, true)], &[&user]));
    println!("claim fees and close: {} compute units", meta.compute_units_consumed);
    assert!(env.svm.get_balance(&me).unwrap() > lamports);
    assert!(env.svm.get_account(&position).is_none_or(|a| a.lamports == 0));
    assert!(!env.credit(&me).has_collateral());
    expect_ok(env.send(&[env.close_account_ix(&me)], &[&user]));
}

#[test]
fn a_pair_meteora_disables_still_lets_liquidity_out() {
    let Some((mut env, pair)) = real_pair() else { return };
    let user = env.user();
    let me = user.pubkey();
    let position = open_position(&mut env, &pair, &user, 70 * SOL, 5_000 * USDC);
    // Meteora's admin can switch a pair off, which is the status byte it sets
    let mut account = env.svm.get_account(&pair.address).unwrap();
    account.data[82] = 1;
    env.svm.set_account(pair.address, account).unwrap();
    // Nothing more goes in, with Meteora's own error for a disabled pool
    fund_sol(&mut env, &me, SOL);
    assert!(failed_with_code(&env.send(&[budget(), add_ix(&env, &pair, &me, &position, SOL, 0)], &[&user]), 6042));
    // What is in still comes out, so a liquidator is never left with a position it cannot empty
    expect_ok(env.send(&[budget(), remove_ix(&env, &pair, &me, &position, 10_000)], &[&user]));
    expect_ok(env.send(&[budget(), close_ix(&env, &pair, &me, &position, true)], &[&user]));
    assert!(!env.credit(&me).has_collateral());
}

#[test]
fn a_liquidator_repays_debt_and_takes_that_share_of_every_bin_at_the_bonus() {
    let Some((mut env, pair)) = real_pair() else { return };
    env.lender(1_000_000 * USDC);
    let (user, liquidator) = (env.user(), env.wallet());
    let (me, buyer) = (user.pubkey(), liquidator.pubkey());
    let (sol, usdc) = (env.sol, env.usdc);
    let position = open_position(&mut env, &pair, &user, 70 * SOL, 5_000 * USDC);
    let limit = env.health(&me).credit_limit;
    expect_ok(env.draw(&user, limit));
    env.fund(&usdc, &buyer, 100_000 * USDC);
    fund_sol(&mut env, &buyer, 0);
    expect_err(env.send(&[budget(), liquidate_ix(&env, &pair, &buyer, &me, &position, 1_000 * USDC)], &[&liquidator]), PluribusError::NotLiquidatable);

    let price = pair.price * 80 / 100;
    env.set_price(&sol, price);
    let (before, debt, held) = (env.health(&me), env.debt(&me), shares_of(&env, &position));
    assert!(before.debt > before.liquidation_limit);
    let meta = expect_ok(env.send(&[budget(), liquidate_ix(&env, &pair, &buyer, &me, &position, debt / 4)], &[&liquidator]));
    println!("liquidate part of a 70-bin position: {} compute units", meta.compute_units_consumed);

    // The payment went to the debt, never more than was offered
    let paid = debt - env.debt(&me);
    assert!(paid <= debt / 4 && paid > debt / 4 - debt / 1_000, "paid {paid} of {}", debt / 4);
    // The same share left every bin, the one the payment buys at a 5% bonus
    let (left, part) = (shares_of(&env, &position), paid as u128 * 10_500 / before.position_value[0] as u128);
    for (was, is) in held.iter().zip(&left) {
        let taken = (was - is) * 10_000 / was;
        assert!(taken.abs_diff(part) <= 1, "{taken} bps taken, {part} bought");
    }
    // What reached the liquidator is worth at least the payment plus the bonus at the oracle price,
    // and more here because nobody has traded the pair down to that price yet
    let got = worth(env.balance(&sol, &buyer), env.balance(&usdc, &buyer) + paid - 100_000 * USDC, price);
    assert!(got as u128 * 10_000 >= paid as u128 * 10_490, "got {got} for {paid}");
    // The borrower keeps the position and is no worse off against the liquidation line
    let after = env.health(&me);
    assert!(after.debt as i128 - after.liquidation_limit as i128 <= before.debt as i128 - before.liquidation_limit as i128 + 1_000);
    assert!(env.credit(&me).find(KIND_DLMM, &position).is_ok());
    assert_eq!(env.credit(&me).tier, 0);
}

#[test]
fn a_position_worth_less_than_the_payment_is_sold_whole_and_closed() {
    let Some((mut env, pair)) = real_pair() else { return };
    env.lender(1_000_000 * USDC);
    let (user, liquidator) = (env.user(), env.wallet());
    let (me, buyer) = (user.pubkey(), liquidator.pubkey());
    let (sol, usdc) = (env.sol, env.usdc);
    // Most of the collateral is plain SOL, with a small position beside it
    deposit_sol(&mut env, &user, 100 * SOL);
    let position = open_position(&mut env, &pair, &user, 2 * SOL, 150 * USDC);
    // So it has fees it has not collected when it is sold
    trade_through(&mut env, &pair);
    let limit = env.health(&me).credit_limit;
    expect_ok(env.draw(&user, limit));
    let price = pair.price * 75 / 100;
    env.set_price(&sol, price);
    let value = env.health(&me).position_value[1];
    assert!(value > 100 * USDC);

    env.fund(&usdc, &buyer, 100_000 * USDC);
    fund_sol(&mut env, &buyer, 0);
    let (debt, lamports) = (env.debt(&me), env.svm.get_balance(&me).unwrap());
    let meta = expect_ok(env.send(&[budget(), liquidate_ix(&env, &pair, &buyer, &me, &position, 50_000 * USDC)], &[&liquidator]));
    println!("liquidate a whole 70-bin position: {} compute units", meta.compute_units_consumed);

    // Only what the position is worth was charged, at the bonus discount
    let paid = debt - env.debt(&me);
    assert!((paid as u128 * 10_500).abs_diff(value as u128 * 10_000) <= 10_500, "paid {paid} for {value}");
    let got = worth(env.balance(&sol, &buyer), env.balance(&usdc, &buyer) + paid - 100_000 * USDC, price);
    assert!(got >= value, "got {got} for a position valued {value}");
    // The position is gone from Meteora and from the account, and its rent went back to the borrower
    assert!(env.svm.get_account(&position).is_none_or(|a| a.lamports == 0));
    let credit = env.credit(&me);
    assert!(credit.find(KIND_DLMM, &position).is_err() && credit.find(KIND_TOKEN, &sol).is_ok());
    assert!(env.svm.get_balance(&me).unwrap() > lamports);
}

#[test]
fn an_emptied_position_cannot_keep_bad_debt_from_being_written_off() {
    let Some((mut env, pair)) = real_pair() else { return };
    env.lender(1_000_000 * USDC);
    let (user, liquidator) = (env.user(), env.wallet());
    let (me, buyer) = (user.pubkey(), liquidator.pubkey());
    let (sol, usdc) = (env.sol, env.usdc);
    // The debt is backed by plain SOL, beside a position that was opened and never funded
    deposit_sol(&mut env, &user, 100 * SOL);
    let position = Keypair::new();
    expect_ok(env.send(&[open_ix(&env, &pair, &me, &position.pubkey(), pair.active - 34, 70)], &[&user, &position]));
    let limit = env.health(&me).credit_limit;
    expect_ok(env.draw(&user, limit));

    // After a crash this deep the SOL sells whole and still leaves debt behind
    env.set_price(&sol, pair.price / 5);
    env.fund(&usdc, &buyer, 100_000 * USDC);
    fund_sol(&mut env, &buyer, 0);
    expect_ok(env.send(&[env.liquidate_ix(&buyer, &me, &sol, 50_000 * USDC)], &[&liquidator]));
    let credit = env.credit(&me);
    assert!(credit.find(KIND_TOKEN, &sol).is_err() && credit.find(KIND_DLMM, &position.pubkey()).is_ok());
    assert!(env.debt(&me) > 0 && env.pool_state().bad_debt == 0);

    // The empty position goes for nothing, which frees the slot and lets the loss be booked
    let lamports = env.svm.get_balance(&me).unwrap();
    expect_ok(env.send(&[budget(), liquidate_ix(&env, &pair, &buyer, &me, &position.pubkey(), 0)], &[&liquidator]));
    assert!(!env.credit(&me).has_collateral());
    assert!(env.debt(&me) == 0 && env.pool_state().bad_debt > 0);
    assert!(env.svm.get_balance(&me).unwrap() > lamports);
}

/// Trades both ways through the position's range and back, which leaves it fees in both tokens
fn trade_through(env: &mut Env, pair: &Pair) {
    for sell_sol in [true, false] {
        let whale = trader(env, 3_000 * SOL, 300_000 * USDC);
        let amount = if sell_sol { 1_000 * SOL } else { 73_000 * USDC };
        expect_ok(env.send(&[budget(), swap_ix(env, pair, &whale.pubkey(), sell_sol, amount)], &[&whale]));
    }
}

fn assert_books_match_vaults(env: &Env) {
    assert_eq!(env.pool_state().cash, env.token_amount(&env.usdc_vault));
    for mint in [env.usdc, env.sol] {
        let asset: Asset = env.load(&env.asset_pda(&mint));
        assert_eq!(asset.total_deposited, env.token_amount(&env.vault_pda(&mint)));
    }
}

#[test]
fn autopay_collects_real_fees_and_repays_debt() {
    let Some((mut env, pair)) = real_pair() else { return };
    env.lender(1_000_000 * USDC);
    let (user, other, keeper) = (env.user(), env.user(), env.wallet());
    let me = user.pubkey();
    let (sol, usdc) = (env.sol, env.usdc);
    let position = open_position(&mut env, &pair, &user, 700 * SOL, 50_000 * USDC);
    expect_ok(env.draw(&user, 1_000 * USDC));
    trade_through(&mut env, &pair);
    let value = env.health(&me).position_value[0];

    // Only the account that holds the position can have its fees collected
    let steal = autopay_ix(&env, &pair, &keeper.pubkey(), &other.pubkey(), &position);
    expect_err(env.send(&[budget(), steal], &[&keeper]), PluribusError::PositionNotFound);
    let autopay = autopay_ix(&env, &pair, &keeper.pubkey(), &me, &position);
    let meta = expect_ok(env.send(&[budget(), autopay.clone()], &[&keeper]));
    println!("autopay over 70 bins: {} compute units", meta.compute_units_consumed);

    // The USDC part paid debt down and the SOL part became collateral, while the position itself is untouched
    let paid = 1_000 * USDC - env.debt(&me);
    let credit = env.credit(&me);
    let fee_sol = credit.positions[credit.find(KIND_TOKEN, &sol).unwrap()].amount;
    assert!(paid > 0 && fee_sol > 0, "{paid} USDC and {fee_sol} lamports of fees");
    assert!(credit.find(KIND_TOKEN, &usdc).is_err());
    assert_eq!(env.health(&me).position_value[0], value);
    assert_books_match_vaults(&env);

    // Nothing is left to collect, so a second run changes nothing
    expect_ok(env.send(&[budget(), autopay], &[&keeper]));
    assert_eq!(env.debt(&me), 1_000 * USDC - paid);
    assert_eq!(env.credit(&me).positions, credit.positions);
}

#[test]
fn autopay_keeps_fees_as_collateral_when_nothing_is_owed() {
    let Some((mut env, pair)) = real_pair() else { return };
    let (user, keeper) = (env.user(), env.wallet());
    let me = user.pubkey();
    let (sol, usdc) = (env.sol, env.usdc);
    let position = open_position(&mut env, &pair, &user, 700 * SOL, 50_000 * USDC);
    trade_through(&mut env, &pair);
    expect_ok(env.send(&[budget(), autopay_ix(&env, &pair, &keeper.pubkey(), &me, &position)], &[&keeper]));
    let credit = env.credit(&me);
    assert!(credit.positions[credit.find(KIND_TOKEN, &sol).unwrap()].amount > 0);
    assert!(credit.positions[credit.find(KIND_TOKEN, &usdc).unwrap()].amount > 0);
    assert_books_match_vaults(&env);
}

#[test]
fn only_a_position_the_pool_alone_controls_counts() {
    let Some((mut env, pair)) = real_pair() else { return };
    env.lender(100_000 * USDC);
    let user = env.user();
    let me = user.pubkey();
    let position = open_position(&mut env, &pair, &user, 70 * SOL, 5_000 * USDC);
    let real = env.svm.get_account(&position).unwrap();
    let tampered = |env: &mut Env, at: usize, bytes: &[u8]| {
        let mut account = real.clone();
        account.data[at..at + bytes.len()].copy_from_slice(bytes);
        env.svm.set_account(position, account).unwrap();
        env.draw(&user, USDC)
    };
    // Another owner, an operator who could pull the liquidity, a lock that would keep a liquidator out, a fee owner
    expect_err(tampered(&mut env, 40, me.as_ref()), PluribusError::InvalidDlmmPosition);
    expect_err(tampered(&mut env, 7960, me.as_ref()), PluribusError::InvalidDlmmPosition);
    expect_err(tampered(&mut env, 7992, &u64::MAX.to_le_bytes()), PluribusError::InvalidDlmmPosition);
    expect_err(tampered(&mut env, 8001, me.as_ref()), PluribusError::InvalidDlmmPosition);
    // Another account type, or more bins than a position starts with
    expect_err(tampered(&mut env, 0, &[0]), PluribusError::InvalidDlmmPosition);
    expect_err(tampered(&mut env, 7916, &(pair.active + 400).to_le_bytes()), PluribusError::InvalidDlmmPosition);
    // The same account written by another program
    let mut forged = real.clone();
    forged.owner = Pubkey::new_unique();
    env.svm.set_account(position, forged).unwrap();
    expect_err(env.draw(&user, USDC), PluribusError::InvalidDlmmPosition);
    // Untouched it backs the draw
    env.svm.set_account(position, real.clone()).unwrap();
    expect_ok(env.draw(&user, USDC));
}

#[test]
fn only_a_listed_and_live_pair_takes_positions() {
    let Some((mut env, pair)) = real_pair() else { return };
    let admin = env.admin.insecure_clone();
    let user = env.user();
    let me = user.pubkey();
    let sol = env.sol;
    let market: LpMarket = env.load(&env.lp_market_pda(&pair.address));
    assert_eq!((market.dex_program, market.base_first), (METEORA_DLMM_PROGRAM_ID, true));

    // A copy of the pair lists only while it is a plain pair of two classic tokens
    let real = env.svm.get_account(&pair.address).unwrap();
    let copy = |env: &mut Env, at: usize, byte: u8| {
        let (address, mut account) = (Pubkey::new_unique(), real.clone());
        account.data[at] = byte;
        env.svm.set_account(address, account).unwrap();
        env.send(&[env.init_lp_market_ix(&address, &sol, 500)], &[&admin])
    };
    // Token X on Token-2022, a limit-order pair, a disabled pair, a pair with farming rewards, another account type,
    // a bin step that no longer agrees with the one the pair's address was seeded with
    for (at, byte) in [(880, 1), (35, 2), (82, 1), (264, 7), (0, 0), (80, 5)] {
        expect_err(copy(&mut env, at, byte), PluribusError::PoolNotWhitelisted);
    }
    expect_ok(copy(&mut env, 880, 0));

    // A position spans 1 to 70 bins
    for width in [0, 71] {
        let position = Keypair::new();
        expect_err(env.send(&[open_ix(&env, &pair, &me, &position.pubkey(), pair.active, width)], &[&user, &position]), PluribusError::InvalidParams);
    }
    // A Meteora market has no NFT to deposit
    let nft = env.lp(&me, &pair.address, 60.0, 90.0, 1_000_000, &TOKEN);
    assert!(env.send(&[env.deposit_lp_ix(&me, &pair.address, &nft)], &[&user]).is_err());
    assert!(!env.credit(&me).has_collateral());

    // A paused market opens and funds nothing new, but what is in can still come out
    let position = open_position(&mut env, &pair, &user, 7 * SOL, 500 * USDC);
    expect_ok(env.send(&[env.set_lp_market_ix(&pair.address, 500, true)], &[&admin]));
    let next = Keypair::new();
    expect_err(env.send(&[open_ix(&env, &pair, &me, &next.pubkey(), pair.active, 10)], &[&user, &next]), PluribusError::Paused);
    expect_err(env.send(&[budget(), add_ix(&env, &pair, &me, &position, SOL, USDC)], &[&user]), PluribusError::Paused);
    expect_ok(env.send(&[budget(), remove_ix(&env, &pair, &me, &position, 10_000)], &[&user]));
    expect_ok(env.send(&[budget(), close_ix(&env, &pair, &me, &position, true)], &[&user]));
}

#[test]
fn health_checks_with_meteora_positions_need_a_raised_compute_budget() {
    let Some((mut env, pair)) = real_pair() else { return };
    env.lender(1_000_000 * USDC);
    let user = env.user();
    let me = user.pubkey();
    for held in 1..=MAX_POSITIONS {
        open_position(&mut env, &pair, &user, 70 * SOL, 5_000 * USDC);
        let meta = expect_ok(env.send(&[budget(), env.draw_ix(&me, 100 * USDC)], &[&user]));
        println!("draw against {held} 70-bin positions: {} compute units", meta.compute_units_consumed);
        // Under the most one transaction can ask for, with room left for the rest of it
        assert!(meta.compute_units_consumed < 600_000);
    }
}
