mod common;

use {
    anchor_lang::{
        error::ErrorCode,
        prelude::*,
        solana_program::{instruction::Instruction, system_program},
        AnchorSerialize, Discriminator, InstructionData, ToAccountMetas,
    },
    anchor_spl::associated_token::ID as ATA_PROGRAM,
    common::*,
    litesvm::LiteSVM,
    pluribus::{constants::*, error::PluribusError, state::*},
    solana_keypair::Keypair,
    solana_signer::Signer,
};

const RENT_SYSVAR: Pubkey = pubkey!("SysvarRent111111111111111111111111111111111");

#[track_caller]
fn expect_anchor(res: TxResult, code: ErrorCode) {
    let code = u32::from(code);
    assert!(failed_with_code(&res, code), "expected anchor error {code}, got {:#?}", res.map(|m| m.logs).map_err(|f| (f.err, f.meta.logs)));
}

/// The same instruction with one account replaced wherever it appears
fn swap(mut ix: Instruction, from: Pubkey, to: Pubkey) -> Instruction {
    let hits = ix.accounts.iter_mut().filter(|m| m.pubkey == from).map(|m| m.pubkey = to).count();
    assert!(hits > 0, "the account to replace is not in the instruction");
    ix
}

/// An account with believable contents that some other program owns
fn forged<T: AnchorSerialize + Discriminator>(env: &mut Env, value: &T) -> Pubkey {
    let address = Pubkey::new_unique();
    env.set_raw(address, Pubkey::new_unique(), [discriminator::<T>(), &borsh(value)].concat());
    address
}

/// Tracked balances match the vaults, and per-account debt shares add up to the pool totals
/// `owners` has to list every credit account that exists
#[track_caller]
fn assert_books_balance(env: &Env, owners: &[Pubkey]) {
    let pool = env.pool_state();
    assert_eq!(pool.cash, env.token_amount(&env.usdc_vault), "pool cash against the usdc vault");
    let credits: Vec<CreditAccount> = owners.iter().map(|o| env.credit(o)).collect();
    for mint in [env.usdc, env.sol, env.stock] {
        let asset: Asset = env.load(&env.asset_pda(&mint));
        assert_eq!(asset.total_deposited, env.token_amount(&asset.vault), "total deposited against the vault");
        let held: u64 = credits.iter().flat_map(|c| c.positions.iter()).filter(|p| p.kind == KIND_TOKEN && p.mint == mint).map(|p| p.amount).sum();
        assert_eq!(asset.total_deposited, held, "total deposited against the positions");
    }
    let mut shares = [0u128; TIERS];
    for credit in &credits {
        shares[credit.tier as usize] += credit.debt_shares;
    }
    assert_eq!(shares, pool.debt_shares, "debt shares per tier");
}

/// A chain with the program deployed and no pool yet
fn bare() -> Env {
    let mut svm = LiteSVM::new();
    svm.add_program(pluribus::ID, include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/pluribus.so"))).unwrap();
    let admin = Keypair::new();
    svm.airdrop(&admin.pubkey(), 1000 * SOL).unwrap();
    // The admin stands in for the deployer, as in the shared harness
    let mut program_data = svm.get_account(&program_data_address()).unwrap();
    program_data.data[12] = 1;
    program_data.data[13..45].copy_from_slice(admin.pubkey().as_ref());
    svm.set_account(program_data_address(), program_data).unwrap();
    Env {
        svm,
        admin,
        usdc: Pubkey::default(),
        sol: Pubkey::default(),
        stock: Pubkey::default(),
        whirlpool: Pubkey::new_unique(),
        pool: pda(&[POOL_SEED]),
        usdc_vault: pda(&[USDC_VAULT_SEED]),
        share_mint: pda(&[SHARE_MINT_SEED]),
    }
}

fn initialize_ix(env: &Env, admin: &Pubkey, usdc_mint: &Pubkey, params: PoolParams) -> Instruction {
    Instruction::new_with_bytes(
        pluribus::ID,
        &pluribus::instruction::Initialize { params, demo_mode: true }.data(),
        pluribus::accounts::Initialize {
            admin: *admin,
            program_data: program_data_address(),
            pool: env.pool,
            usdc_mint: *usdc_mint,
            usdc_vault: env.usdc_vault,
            share_mint: env.share_mint,
            token_program: env.svm.get_account(usdc_mint).unwrap().owner,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn set_admin_ix(env: &Env, admin: &Pubkey, new_admin: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        pluribus::ID,
        &pluribus::instruction::SetAdmin { new_admin }.data(),
        pluribus::accounts::AdminPool { admin: *admin, pool: env.pool }.to_account_metas(None),
    )
}

fn open_account_ix(owner: &Pubkey, credit: Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        pluribus::ID,
        &pluribus::instruction::OpenAccount {}.data(),
        pluribus::accounts::OpenAccount { owner: *owner, credit, system_program: system_program::ID }.to_account_metas(None),
    )
}

/// Withdraws `nft` out of `credit` to the signer, with no health accounts
fn withdraw_lp_from(env: &Env, signer: &Pubkey, credit: Pubkey, nft: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        pluribus::ID,
        &pluribus::instruction::WithdrawLp {}.data(),
        pluribus::accounts::WithdrawLp {
            owner: *signer,
            credit,
            pool: env.pool,
            position_mint: *nft,
            vault_nft: ata(&env.pool, nft, &TOKEN),
            owner_nft: ata(signer, nft, &TOKEN),
            token_program: TOKEN,
        }
        .to_account_metas(None),
    )
}

fn pause_asset(env: &mut Env, mint: &Pubkey, paused: bool) {
    let admin = env.admin.insecure_clone();
    let params = env.load::<Asset>(&env.asset_pda(mint)).params;
    expect_ok(env.send(&[env.set_asset_ix(&admin.pubkey(), mint, AssetParams { paused, ..params })], &[&admin]));
}

// Rule 1: every account is validated

#[test]
fn look_alike_accounts_owned_by_another_program_are_rejected() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    let user = env.user();
    let me = user.pubkey();
    let (sol, whirlpool, now) = (env.sol, env.whirlpool, env.now());
    env.deposit(&user, &sol, 10 * SOL);
    let nft = env.deposit_lp(&user, 120.0, 180.0, liquidity_for(1_000, 120.0, 180.0, 150));
    let limit = env.health(&me).credit_limit;
    expect_ok(env.draw(&user, limit));

    // Each forgery would add credit if it were believed
    let (asset, market, price, position) = (env.asset_pda(&sol), env.lp_market_pda(&whirlpool), env.price_account(&sol), orca_position(&nft));
    let real_asset: Asset = env.load(&asset);
    let real_market: LpMarket = env.load(&market);
    let fake_asset = forged(&mut env, &Asset { params: AssetParams { group: u8::MAX, liq_cost_bps: 0, ..real_asset.params }, ..real_asset });
    let fake_market = forged(&mut env, &LpMarket { liq_cost_bps: 0, ..real_market });
    let fake_price = forged(&mut env, &DemoPrice { mint: sol, price: 1_000_000 * USDC, conf: 0, publish_time: now, bump: 255 });
    let fake_position = Pubkey::new_unique();
    env.set_raw(fake_position, Pubkey::new_unique(), position_bytes(&whirlpool, &nft, u64::MAX as u128, tick(120.0), tick(180.0)));

    for (real, fake, err) in [
        (asset, fake_asset, PluribusError::WrongOwner),
        (market, fake_market, PluribusError::WrongOwner),
        (price, fake_price, PluribusError::InvalidPriceAccount),
        // The position is rejected for sitting at the wrong address before its owner is even read
        (position, fake_position, PluribusError::AccountMismatch),
    ] {
        expect_err(env.send(&[swap(env.draw_ix(&me, 1), real, fake)], &[&user]), err);
    }
    expect_err(env.draw(&user, 1), PluribusError::ExceedsCreditLimit);

    env.fund(&sol, &me, SOL);
    expect_anchor(env.send(&[swap(env.deposit_token_ix(&me, &sol, SOL), asset, fake_asset)], &[&user]), ErrorCode::AccountOwnedByWrongProgram);
    let second = env.lp(&me, &whirlpool, 120.0, 180.0, 1_000_000, &TOKEN);
    expect_anchor(env.send(&[swap(env.deposit_lp_ix(&me, &whirlpool, &second), market, fake_market)], &[&user]), ErrorCode::AccountOwnedByWrongProgram);
    // A program that is not a token program, which could report transfers it never made
    expect_anchor(env.send(&[swap(env.deposit_token_ix(&me, &sol, SOL), TOKEN, ATA_PROGRAM)], &[&user]), ErrorCode::InvalidProgramId);
    expect_anchor(env.send(&[swap(env.repay_ix(&me, &me, USDC), TOKEN, ATA_PROGRAM)], &[&user]), ErrorCode::InvalidProgramId);
    assert_eq!(env.debt(&me), limit);
}

#[test]
fn accounts_for_a_different_mint_are_rejected() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    let user = env.user();
    let me = user.pubkey();
    let (sol, stock) = (env.sol, env.stock);
    env.deposit(&user, &sol, 10 * SOL);
    env.deposit(&user, &stock, 10 * STOCK);
    let limit = env.health(&me).credit_limit;
    expect_ok(env.draw(&user, limit));

    // A base unit of the stock is worth far more than a lamport, so SOL read through stock accounts would add credit
    let draw = env.draw_ix(&me, 1);
    expect_err(env.send(&[swap(draw.clone(), env.asset_pda(&sol), env.asset_pda(&stock))], &[&user]), PluribusError::AccountMismatch);
    expect_err(env.send(&[swap(draw, env.price_account(&sol), env.price_account(&stock))], &[&user]), PluribusError::InvalidPriceAccount);

    env.fund(&sol, &me, SOL);
    let deposit = env.deposit_token_ix(&me, &sol, SOL);
    expect_anchor(env.send(&[swap(deposit.clone(), env.asset_pda(&sol), env.asset_pda(&stock))], &[&user]), ErrorCode::ConstraintSeeds);
    expect_anchor(env.send(&[swap(deposit.clone(), env.vault_pda(&sol), env.vault_pda(&stock))], &[&user]), ErrorCode::ConstraintHasOne);
    // A vault the depositor controls would give credit for tokens that never left
    let stash = env.fund(&sol, &Pubkey::new_unique(), 0);
    expect_anchor(env.send(&[swap(deposit, env.vault_pda(&sol), stash)], &[&user]), ErrorCode::ConstraintHasOne);
    // Lamports passed off as stock
    let as_stock = swap(env.deposit_token_ix(&me, &stock, SOL), ata(&me, &stock, &TOKEN), ata(&me, &sol, &TOKEN));
    expect_anchor(env.send(&[as_stock], &[&user]), ErrorCode::ConstraintTokenMint);

    assert_eq!(env.balance(&sol, &me), SOL);
    assert_books_balance(&env, &[me]);
}

#[test]
fn lp_deposit_needs_the_real_position_for_that_nft_in_a_whitelisted_pool() {
    let mut env = Env::new();
    let user = env.user();
    let me = user.pubkey();
    let (sol, usdc, whirlpool) = (env.sol, env.usdc, env.whirlpool);
    let liquidity = liquidity_for(10_000, 120.0, 180.0, 150);
    let nft = env.lp(&me, &whirlpool, 120.0, 180.0, liquidity, &TOKEN);
    let (deposit, position) = (env.deposit_lp_ix(&me, &whirlpool, &nft), orca_position(&nft));
    let good = position_bytes(&whirlpool, &nft, liquidity, tick(120.0), tick(180.0));
    let big = env.lp(&Pubkey::new_unique(), &whirlpool, 120.0, 180.0, liquidity * 100, &TOKEN);
    let rogue = Pubkey::new_unique();
    env.set_whirlpool(&rogue, &sol, &usdc);

    // Only Orca's own address for the NFT is read, so neither a copy elsewhere nor someone else's larger position will do
    let copy = Pubkey::new_unique();
    env.set_raw(copy, WHIRLPOOL_PROGRAM_ID, good.clone());
    for other in [copy, orca_position(&big)] {
        expect_anchor(env.send(&[swap(deposit.clone(), position, other)], &[&user]), ErrorCode::ConstraintSeeds);
    }

    // At that address the account still has to be a funded Orca position for this NFT in the whitelisted pool
    let mut wrong_type = good.clone();
    wrong_type[0] ^= 1;
    for (name, owner, data, err) in [
        ("another owner program", Pubkey::new_unique(), good.clone(), PluribusError::InvalidLpPosition),
        ("not a position account", WHIRLPOOL_PROGRAM_ID, wrong_type, PluribusError::InvalidLpPosition),
        ("another NFT's position", WHIRLPOOL_PROGRAM_ID, position_bytes(&whirlpool, &big, liquidity, tick(120.0), tick(180.0)), PluribusError::AccountMismatch),
        ("another pool", WHIRLPOOL_PROGRAM_ID, position_bytes(&rogue, &nft, liquidity, tick(120.0), tick(180.0)), PluribusError::PoolNotWhitelisted),
        ("no liquidity", WHIRLPOOL_PROGRAM_ID, position_bytes(&whirlpool, &nft, 0, tick(120.0), tick(180.0)), PluribusError::InvalidLpPosition),
    ] {
        env.set_raw(position, owner, data);
        assert!(failed_with(&env.send(&[deposit.clone()], &[&user]), err), "{name}");
    }
    env.set_raw(position, WHIRLPOOL_PROGRAM_ID, good);

    // A pool nobody whitelisted has no market of its own to deposit against
    let rogue_nft = env.lp(&me, &rogue, 120.0, 180.0, liquidity, &TOKEN);
    expect_anchor(env.send(&[env.deposit_lp_ix(&me, &rogue, &rogue_nft)], &[&user]), ErrorCode::AccountNotInitialized);

    // The NFT has to land in the pool's own token account
    let stash = env.fund(&nft, &Pubkey::new_unique(), 0);
    expect_anchor(env.send(&[swap(deposit.clone(), ata(&env.pool, &nft, &TOKEN), stash)], &[&user]), ErrorCode::ConstraintTokenOwner);

    assert!(!env.credit(&me).has_collateral());
    assert_eq!(env.balance(&nft, &me), 1);
    expect_ok(env.send(&[deposit], &[&user]));
    assert_eq!(env.balance(&nft, &env.pool), 1);
}

#[test]
fn health_accounts_must_be_complete_in_order_and_the_borrowers_own() {
    let mut env = Env::new();
    env.lender(1_000_000 * USDC);
    let admin = env.admin.insecure_clone();
    let user = env.user();
    let me = user.pubkey();
    let (sol, stock, usdc, whirlpool) = (env.sol, env.stock, env.usdc, env.whirlpool);
    env.deposit(&user, &sol, 10 * SOL);
    env.deposit(&user, &stock, 10 * STOCK);
    let nft = env.deposit_lp(&user, 120.0, 180.0, liquidity_for(100, 120.0, 180.0, 150));
    let limit = env.health(&me).credit_limit;
    expect_ok(env.draw(&user, limit));

    let draw = env.draw_ix(&me, 1);
    let health = env.health_metas(&me).len();
    let fixed = draw.accounts.len() - health;
    assert_eq!(health, 8);
    for keep in 0..health {
        let mut ix = draw.clone();
        ix.accounts.truncate(fixed + keep);
        expect_err(env.send(&[ix], &[&user]), PluribusError::MissingAccount);
    }
    let mut short = env.withdraw_token_ix(&me, &sol, 1);
    short.accounts.pop();
    expect_err(env.send(&[short], &[&user]), PluribusError::MissingAccount);

    // The two token positions listed in each other's place
    let mut reordered = draw.clone();
    reordered.accounts.swap(fixed, fixed + 2);
    reordered.accounts.swap(fixed + 1, fixed + 3);
    expect_err(env.send(&[reordered], &[&user]), PluribusError::AccountMismatch);
    // A price account where the asset belongs
    let mut flipped = draw.clone();
    flipped.accounts.swap(fixed, fixed + 1);
    expect_anchor(env.send(&[flipped], &[&user]), ErrorCode::AccountDiscriminatorMismatch);

    // Another user's much larger position
    let whale = env.user();
    let big = env.deposit_lp(&whale, 120.0, 180.0, liquidity_for(1_000_000, 120.0, 180.0, 150));
    expect_err(env.send(&[swap(draw.clone(), orca_position(&nft), orca_position(&big))], &[&user]), PluribusError::AccountMismatch);

    // A second whitelisted market with a lower liquidation cost does not apply to a position in the first pool
    let cheap = Pubkey::new_unique();
    env.set_whirlpool(&cheap, &sol, &usdc);
    expect_ok(env.send(&[env.init_lp_market_ix(&cheap, &sol, 480)], &[&admin]));
    expect_err(env.send(&[swap(draw.clone(), env.lp_market_pda(&whirlpool), env.lp_market_pda(&cheap))], &[&user]), PluribusError::PoolNotWhitelisted);

    expect_err(env.send(&[draw], &[&user]), PluribusError::ExceedsCreditLimit);
    assert_eq!(env.debt(&me), limit);
}

#[test]
fn a_signature_only_moves_the_signers_own_account() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    let (victim, thief) = (env.user(), env.user());
    let (v, t) = (victim.pubkey(), thief.pubkey());
    let (sol, stock, usdc) = (env.sol, env.stock, env.usdc);
    env.deposit(&victim, &sol, 10 * SOL);
    env.deposit(&victim, &stock, 10 * STOCK);
    let nft = env.deposit_lp(&victim, 120.0, 180.0, liquidity_for(10_000, 120.0, 180.0, 150));
    env.deposit(&thief, &sol, SOL);
    env.fund(&usdc, &t, 0);
    env.fund(&nft, &t, 0);
    let (mine, theirs) = (env.credit_pda(&t), env.credit_pda(&v));
    let before = env.svm.get_account(&theirs).unwrap().data;

    // The victim's credit account under the thief's signature
    for ix in [
        env.draw_ix(&t, USDC),
        env.withdraw_token_ix(&t, &sol, SOL),
        env.deposit_token_ix(&t, &sol, 1),
        withdraw_lp_from(&env, &t, mine, &nft),
        open_account_ix(&t, mine),
    ] {
        expect_anchor(env.send(&[swap(ix, mine, theirs)], &[&thief]), ErrorCode::ConstraintSeeds);
    }

    // Vaults are shared, so the thief's own account must not reach what others deposited
    expect_err(env.send(&[withdraw_lp_from(&env, &t, mine, &nft)], &[&thief]), PluribusError::PositionNotFound);
    expect_err(env.send(&[env.withdraw_token_ix(&t, &sol, SOL + 1)], &[&thief]), PluribusError::InsufficientCollateral);
    env.fund(&stock, &t, 0);
    expect_err(env.send(&[env.withdraw_token_ix(&t, &stock, 1)], &[&thief]), PluribusError::PositionNotFound);

    // One credit account per owner: the System program finds the address already in use
    assert!(failed_with_code(&env.send(&[open_account_ix(&t, mine)], &[&thief]), 0));

    assert_eq!(env.svm.get_account(&theirs).unwrap().data, before);
    assert_eq!((env.balance(&usdc, &t), env.balance(&nft, &t), env.balance(&stock, &t)), (0, 0, 0));
    assert_books_balance(&env, &[v, t]);
}

#[test]
fn only_the_upgrade_authority_can_initialize_and_only_with_classic_usdc() {
    let mut env = bare();
    let (boss, mallory) = (env.admin.insecure_clone(), env.wallet());
    let usdc = env.new_mint(6, &TOKEN);
    let loader = anchor_lang::solana_program::bpf_loader_upgradeable::ID;
    let attempt = initialize_ix(&env, &mallory.pubkey(), &usdc, default_params());
    expect_err(env.send(&[attempt.clone()], &[&mallory]), PluribusError::NotUpgradeAuthority);

    // Program data that names the caller: under the loader for some other program, then under a program of the caller's own
    let mut data = env.svm.get_account(&program_data_address()).unwrap().data[..45].to_vec();
    data[13..45].copy_from_slice(mallory.pubkey().as_ref());
    for owner in [loader, Pubkey::new_unique()] {
        let fake = Pubkey::new_unique();
        env.set_raw(fake, owner, data.clone());
        expect_err(env.send(&[swap(attempt.clone(), program_data_address(), fake)], &[&mallory]), PluribusError::NotUpgradeAuthority);
    }

    for mint in [env.new_mint(6, &TOKEN_2022), env.new_mint(9, &TOKEN)] {
        expect_err(env.send(&[initialize_ix(&env, &boss.pubkey(), &mint, default_params())], &[&boss]), PluribusError::UnsupportedMint);
    }
    assert!(env.svm.get_account(&env.pool).is_none());
    expect_ok(env.send(&[initialize_ix(&env, &boss.pubkey(), &usdc, default_params())], &[&boss]));
    assert_eq!(env.pool_state().admin, boss.pubkey());
}

#[test]
fn only_the_admin_can_call_admin_instructions() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let mallory = env.wallet();
    let m = mallory.pubkey();
    let (sol, usdc, whirlpool) = (env.sol, env.usdc, env.whirlpool);
    let new_mint = env.new_mint(6, &TOKEN);
    let new_pool = Pubkey::new_unique();
    env.set_whirlpool(&new_pool, &sol, &usdc);
    env.fund(&usdc, &m, 0);
    let sol_params = env.load::<Asset>(&env.asset_pda(&sol)).params;
    let watched = [env.pool, env.asset_pda(&sol), env.lp_market_pda(&whirlpool), env.price_account(&sol)];
    let snapshot = |env: &Env| watched.map(|k| env.svm.get_account(&k).unwrap().data);
    let before = snapshot(&env);

    let mut loose = default_params();
    loose.init_shock_bps = [0; MAX_SCENARIOS * MAX_GROUPS];
    loose.maint_shock_bps = [0; MAX_SCENARIOS * MAX_GROUPS];
    for ix in [
        env.set_params_ix(&m, loose),
        env.set_flags_ix(&m, true, false),
        set_admin_ix(&env, &m, m),
        swap(env.init_asset_ix(&new_mint, asset_params(u8::MAX, ORACLE_PYTH, SOL_FEED, 0)), admin.pubkey(), m),
        env.set_asset_ix(&m, &sol, AssetParams { group: u8::MAX, liq_cost_bps: 0, ..sol_params }),
        swap(env.init_lp_market_ix(&new_pool, &sol, 0), admin.pubkey(), m),
        swap(env.set_lp_market_ix(&whirlpool, 0, true), admin.pubkey(), m),
        env.set_demo_price_ix(&m, &sol, 1_000_000 * USDC, 0),
        env.collect_protocol_fees_ix(&m, 1),
    ] {
        expect_anchor(env.send(&[ix], &[&mallory]), ErrorCode::ConstraintHasOne);
    }
    // The pool cannot be initialized a second time to take it over: the System program finds it already in use
    assert!(failed_with_code(&env.send(&[initialize_ix(&env, &m, &usdc, default_params())], &[&mallory]), 0));
    assert_eq!(snapshot(&env), before);
    assert!(env.svm.get_account(&env.asset_pda(&new_mint)).is_none());
    assert!(env.svm.get_account(&env.lp_market_pda(&new_pool)).is_none());

    // Handing over the role moves the power with it
    expect_ok(env.send(&[set_admin_ix(&env, &admin.pubkey(), m)], &[&admin]));
    expect_anchor(env.send(&[env.set_flags_ix(&admin.pubkey(), true, true)], &[&admin]), ErrorCode::ConstraintHasOne);
    expect_ok(env.send(&[env.set_flags_ix(&m, true, true)], &[&mallory]));
}

#[test]
fn a_fake_usdc_vault_or_mint_is_rejected() {
    let mut env = Env::new();
    let lender = env.lender(100_000 * USDC);
    let user = env.user();
    let (me, l) = (user.pubkey(), lender.pubkey());
    let (sol, usdc, shares, vault, pool) = (env.sol, env.usdc, env.share_mint, env.usdc_vault, env.pool);
    env.deposit(&user, &sol, 10 * SOL);
    env.deposit(&user, &usdc, 100 * USDC);
    expect_ok(env.draw(&user, 500 * USDC));
    env.fund(&usdc, &l, 1_000 * USDC);
    let (debt, cash, held) = (env.debt(&me), env.pool_state().cash, env.balance(&shares, &l));

    // A USDC account the caller controls, then the pool's collateral vault, in place of the lending vault
    let stash = env.fund(&usdc, &Pubkey::new_unique(), 0);
    for fake_vault in [stash, env.vault_pda(&usdc)] {
        for (ix, signer) in [
            (env.repay_ix(&me, &me, 100 * USDC), &user),
            (env.draw_ix(&me, USDC), &user),
            (env.lend_deposit_ix(&l, USDC), &lender),
            (env.lend_withdraw_ix(&l, USDC), &lender),
        ] {
            expect_anchor(env.send(&[swap(ix, vault, fake_vault)], &[signer]), ErrorCode::ConstraintHasOne);
        }
    }

    // A worthless mint with the right decimals, with a vault the pool really owns
    let fake = env.new_mint(6, &TOKEN);
    let fake_vault = env.fund(&fake, &pool, 1_000_000 * USDC);
    for (ix, signer) in [(env.repay_ix(&me, &me, 100 * USDC), &user), (env.lend_deposit_ix(&l, 1_000 * USDC), &lender), (env.draw_ix(&me, USDC), &user)] {
        let who = signer.pubkey();
        env.fund(&fake, &who, 1_000_000 * USDC);
        let ix = swap(swap(swap(ix, usdc, fake), vault, fake_vault), ata(&who, &usdc, &TOKEN), ata(&who, &fake, &TOKEN));
        expect_anchor(env.send(&[ix], &[signer]), ErrorCode::ConstraintHasOne);
    }

    // Home-made shares cannot be redeemed
    let fake_shares = env.new_mint(6, &TOKEN);
    env.fund(&fake_shares, &l, 1_000_000 * USDC);
    let redeem = swap(swap(env.lend_withdraw_ix(&l, 1_000 * USDC), shares, fake_shares), ata(&l, &shares, &TOKEN), ata(&l, &fake_shares, &TOKEN));
    expect_err(env.send(&[redeem], &[&lender]), PluribusError::AccountMismatch);

    assert_eq!((env.debt(&me), env.pool_state().cash, env.balance(&shares, &l)), (debt, cash, held));
    assert_books_balance(&env, &[me]);
}

// Rule 2: prices come only from the oracle

#[test]
fn with_demo_mode_off_only_a_fully_verified_pyth_account_for_the_feed_is_a_price() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    let admin = env.admin.insecure_clone();
    let user = env.user();
    let me = user.pubkey();
    let sol = env.sol;
    env.deposit(&user, &sol, 10 * SOL);
    let (price, now) = (env.price_account(&sol), env.now());

    // Demo mode goes off for good, and the demo price it left behind stops counting
    expect_ok(env.send(&[env.set_flags_ix(&admin.pubkey(), false, false)], &[&admin]));
    for paused in [false, true] {
        expect_err(env.send(&[env.set_flags_ix(&admin.pubkey(), paused, true)], &[&admin]), PluribusError::DemoDisabled);
    }
    expect_err(env.set_price_conf(&sol, 1_000_000 * USDC, 0), PluribusError::DemoDisabled);
    expect_err(env.draw(&user, 1), PluribusError::InvalidPriceAccount);

    let good = pyth_bytes(1, SOL_FEED, 15_000_000_000, 0, -8, now);
    let mut wrong_type = good.clone();
    wrong_type[0] ^= 1;
    for (name, owner, data) in [
        ("owned by a stranger", Pubkey::new_unique(), good.clone()),
        ("owned by this program", pluribus::ID, good.clone()),
        ("partial verification", PYTH_RECEIVER_ID, pyth_bytes(0, SOL_FEED, 15_000_000_000, 0, -8, now)),
        ("another feed", PYTH_RECEIVER_ID, pyth_bytes(1, STOCK_FEED, 15_000_000_000, 0, -8, now)),
        ("negative price", PYTH_RECEIVER_ID, pyth_bytes(1, SOL_FEED, -15_000_000_000, 0, -8, now)),
        ("zero price", PYTH_RECEIVER_ID, pyth_bytes(1, SOL_FEED, 0, 0, -8, now)),
        ("price that rounds to zero", PYTH_RECEIVER_ID, pyth_bytes(1, SOL_FEED, 99, 0, -8, now)),
        ("positive exponent", PYTH_RECEIVER_ID, pyth_bytes(1, SOL_FEED, 15, 0, 1, now)),
        ("exponent under -18", PYTH_RECEIVER_ID, pyth_bytes(1, SOL_FEED, i64::MAX, 0, -19, now)),
        ("wrong account type", PYTH_RECEIVER_ID, wrong_type),
        ("cut short", PYTH_RECEIVER_ID, good[..100].to_vec()),
    ] {
        env.set_raw(price, owner, data);
        assert!(failed_with(&env.draw(&user, 1), PluribusError::InvalidPriceAccount), "{name}");
    }
    assert_eq!(env.debt(&me), 0);

    // 149.99999999 give or take 0.00000001 rescales to 149.999999 less 0.000001: price down, confidence up
    env.set_pyth(price, SOL_FEED, 14_999_999_999, 1, -8, now);
    let h = env.health(&me);
    assert_eq!(h.position_price[0], 149_999_998);
    assert_eq!(h.credit_limit, 997_499_981);
    expect_err(env.draw(&user, h.credit_limit + 1), PluribusError::ExceedsCreditLimit);
    expect_ok(env.draw(&user, h.credit_limit / 2));

    env.set_pyth(price, SOL_FEED, 15_000_000_000, 0, -8, now - 60);
    expect_ok(env.draw(&user, 1));
    env.set_pyth(price, SOL_FEED, 15_000_000_000, 0, -8, now - 61);
    expect_err(env.draw(&user, 1), PluribusError::StalePrice);
    // The band is 2% of the price, and a confidence a hair over it rounds up past the line
    env.set_pyth(price, SOL_FEED, 15_000_000_000, 300_000_000, -8, now);
    expect_ok(env.draw(&user, 1));
    env.set_pyth(price, SOL_FEED, 15_000_000_000, 300_000_001, -8, now);
    expect_err(env.draw(&user, 1), PluribusError::PriceTooUncertain);
    assert_books_balance(&env, &[me]);
}

#[test]
fn with_demo_mode_on_only_the_demo_account_for_that_mint_is_a_price() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    let user = env.user();
    let me = user.pubkey();
    let (sol, usdc, now) = (env.sol, env.usdc, env.now());
    env.deposit(&user, &sol, 10 * SOL);
    env.fund(&usdc, &me, 0);

    let pyth = Pubkey::new_unique();
    env.set_pyth(pyth, SOL_FEED, 15_000_000_000, 0, -8, now);
    expect_err(env.send(&[swap(env.draw_ix(&me, 1), env.price_account(&sol), pyth)], &[&user]), PluribusError::InvalidPriceAccount);
    expect_err(env.send(&[swap(env.draw_ix(&me, 1), env.price_account(&sol), env.price_account(&env.stock))], &[&user]), PluribusError::InvalidPriceAccount);

    env.set_price(&sol, 0);
    expect_err(env.draw(&user, 1), PluribusError::InvalidPriceAccount);
    env.set_price(&sol, 150 * USDC);
    expect_ok(env.draw(&user, 1));
}

// Rule 3: stale or uncertain prices stop anything that can lower health, and nothing else

#[test]
fn stale_or_uncertain_prices_block_draws_and_withdrawals_but_not_deposits_or_repayments() {
    let mut env = Env::new();
    env.lender(1_000_000 * USDC);
    let user = env.user();
    let me = user.pubkey();
    let (sol, usdc, whirlpool) = (env.sol, env.usdc, env.whirlpool);
    let liquidity = liquidity_for(1_000, 120.0, 180.0, 150);
    env.deposit(&user, &sol, 10 * SOL);
    let nft = env.deposit_lp(&user, 120.0, 180.0, liquidity);
    expect_ok(env.draw(&user, 100 * USDC));

    let blocked = |env: &mut Env, err: PluribusError| {
        expect_err(env.draw(&user, 1), err);
        expect_err(env.send(&[env.withdraw_token_ix(&me, &sol, 1)], &[&user]), err);
        expect_err(env.send(&[env.withdraw_lp_ix(&me, &nft)], &[&user]), err);
    };
    let open = |env: &mut Env| {
        env.fund(&sol, &me, SOL);
        expect_ok(env.send(&[env.deposit_token_ix(&me, &sol, SOL)], &[&user]));
        env.fund(&usdc, &me, 20 * USDC);
        expect_ok(env.send(&[env.deposit_token_ix(&me, &usdc, 10 * USDC)], &[&user]));
        let extra = env.lp(&me, &whirlpool, 100.0, 140.0, liquidity, &TOKEN);
        expect_ok(env.send(&[env.deposit_lp_ix(&me, &whirlpool, &extra)], &[&user]));
        expect_ok(env.send(&[env.repay_ix(&me, &me, 10 * USDC)], &[&user]));
    };

    // A price exactly at the age limit still counts
    env.warp(60);
    expect_ok(env.draw(&user, 1));
    env.warp(1);
    blocked(&mut env, PluribusError::StalePrice);
    open(&mut env);

    // Confidence exactly at 2% counts, and the price is taken at the low end of the band
    expect_ok(env.set_price_conf(&sol, 150 * USDC, 3 * USDC));
    expect_ok(env.draw(&user, 1));
    assert_eq!(env.health(&me).position_price[0], 147 * USDC);
    expect_ok(env.set_price_conf(&sol, 150 * USDC, 3 * USDC + 1));
    blocked(&mut env, PluribusError::PriceTooUncertain);
    open(&mut env);

    // Paying everything back needs no price either
    env.fund(&usdc, &me, 1_000 * USDC);
    expect_ok(env.send(&[env.repay_ix(&me, &me, u64::MAX)], &[&user]));
    assert_eq!(env.debt(&me), 0);
    assert_books_balance(&env, &[me]);
}

// Rule 4: rounding goes against the borrower

#[test]
fn dust_draws_and_repays_never_favour_the_borrower() {
    let mut env = Env::new();
    let supplied = 1_000_000 * USDC;
    let lender = env.lender(supplied);
    let user = env.user();
    let me = user.pubkey();
    let (sol, usdc) = (env.sol, env.usdc);
    env.deposit(&user, &sol, 1000 * SOL);
    let (mut out, mut back) = (0u64, 0u64);

    // With the index at exactly 1 a round trip is zero sum
    for amount in [1, 2, 3] {
        expect_ok(env.draw(&user, amount));
        assert_eq!(env.debt(&me), amount);
        expect_ok(env.send(&[env.repay_ix(&me, &me, amount)], &[&user]));
        assert_eq!((env.debt(&me), env.balance(&usdc, &me)), (0, 0));
    }

    expect_ok(env.draw(&user, 10_000 * USDC));
    out += 10_000 * USDC;
    env.warp(30 * DAY);
    env.set_price(&sol, 150 * USDC);
    expect_ok(env.send(&[env.accrue_ix()], &[&lender]));
    assert!(env.pool_state().borrow_index[0] > INDEX_ONE);

    // No time passes in the loop, so any gain could only come from rounding
    for round in 0..40u64 {
        let amount = 1 + round % 7;
        let (debt, wallet) = (env.debt(&me), env.balance(&usdc, &me));
        expect_ok(env.draw(&user, amount));
        assert_eq!(env.balance(&usdc, &me), wallet + amount);
        assert!(env.debt(&me) >= debt + amount, "drew {amount} and owes {} more", env.debt(&me) - debt);
        out += amount;

        let pay = 1 + round % 3;
        let (debt, wallet) = (env.debt(&me), env.balance(&usdc, &me));
        match env.send(&[env.repay_ix(&me, &me, pay)], &[&user]) {
            Ok(_) => {
                assert_eq!(env.balance(&usdc, &me), wallet - pay);
                assert!(env.debt(&me) + pay >= debt, "paid {pay} and owes {} less", debt - env.debt(&me));
                back += pay;
            }
            // A payment too small to retire a single debt share is refused outright
            res => {
                expect_err(res, PluribusError::ZeroAmount);
                assert_eq!((env.debt(&me), env.balance(&usdc, &me)), (debt, wallet));
            }
        }
        assert_books_balance(&env, &[me]);
    }

    let debt = env.debt(&me);
    assert!(debt > out - back);
    env.fund(&usdc, &me, debt);
    expect_ok(env.send(&[env.repay_ix(&me, &me, u64::MAX)], &[&user]));
    back += debt;
    assert_eq!(env.balance(&usdc, &me), 0);
    let pool = env.pool_state();
    assert_eq!(pool.debt_shares, [0; TIERS]);
    assert_eq!(pool.cash, supplied + back - out);
    assert!(back > out);
    assert_books_balance(&env, &[me]);
}

#[test]
fn collateral_value_rounds_down_and_dust_backs_nothing() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    let (sol, usdc) = (env.sol, env.usdc);

    // 19 lamports are worth 2.85 millionths of a dollar and back nothing after the shock and the cost round down
    let dusty = env.user();
    env.deposit(&dusty, &sol, 19);
    assert_eq!(env.health(&dusty.pubkey()).credit_limit, 0);
    expect_err(env.draw(&dusty, 1), PluribusError::ExceedsCreditLimit);
    env.deposit(&dusty, &sol, 1);
    assert_eq!(env.health(&dusty.pubkey()).credit_limit, 1);
    expect_ok(env.draw(&dusty, 1));
    expect_err(env.draw(&dusty, 1), PluribusError::ExceedsCreditLimit);

    let user = env.user();
    let me = user.pubkey();
    env.deposit(&user, &sol, 10 * SOL);
    expect_ok(env.draw(&user, 997_500_000));
    // At the limit not even one lamport can leave
    expect_err(env.send(&[env.withdraw_token_ix(&me, &sol, 1)], &[&user]), PluribusError::ExceedsCreditLimit);
    // One base unit repaid frees 9 lamports, worth 0.9 of that unit after the shock and the cost, and not a 10th
    expect_ok(env.send(&[env.repay_ix(&me, &me, 1)], &[&user]));
    for _ in 0..9 {
        expect_ok(env.send(&[env.withdraw_token_ix(&me, &sol, 1)], &[&user]));
    }
    expect_err(env.send(&[env.withdraw_token_ix(&me, &sol, 1)], &[&user]), PluribusError::ExceedsCreditLimit);
    expect_err(env.draw(&user, 1), PluribusError::ExceedsCreditLimit);

    // Dust in and out moves exactly what was asked for
    env.fund(&usdc, &me, 1_000 * USDC);
    expect_ok(env.send(&[env.repay_ix(&me, &me, 500 * USDC)], &[&user]));
    let held = env.credit(&me).positions[0].amount;
    env.fund(&sol, &me, 100);
    for _ in 0..10 {
        expect_ok(env.send(&[env.deposit_token_ix(&me, &sol, 1)], &[&user]));
        expect_ok(env.send(&[env.withdraw_token_ix(&me, &sol, 1)], &[&user]));
    }
    assert_eq!((env.credit(&me).positions[0].amount, env.balance(&sol, &me)), (held, 100));
    assert_books_balance(&env, &[dusty.pubkey(), me]);
}

#[test]
fn lender_round_trips_never_take_from_the_pool() {
    let mut env = Env::new();
    let first = env.lender(1_000 * USDC);
    let user = env.user();
    let (sol, usdc, shares) = (env.sol, env.usdc, env.share_mint);
    env.deposit(&user, &sol, 100 * SOL);
    expect_ok(env.draw(&user, 600 * USDC));
    env.warp(100 * DAY);
    expect_ok(env.send(&[env.accrue_ix()], &[&first]));

    let trader = env.wallet();
    let t = trader.pubkey();
    env.fund(&shares, &t, 0);
    // Assets behind each share, as a fraction, must never fall
    let share_price = |env: &Env| (env.pool_state().lender_assets().unwrap(), env.svm.get_account(&shares).map(|a| u64::from_le_bytes(a.data[36..44].try_into().unwrap())).unwrap() as u128);
    let (assets, supply) = share_price(&env);
    assert!(assets > supply);
    for amount in [1, 2, 3, 7, 999, 1_000_003, 250 * USDC + 1] {
        env.fund(&usdc, &t, amount);
        let (assets, supply) = share_price(&env);
        match env.send(&[env.lend_deposit_ix(&t, amount)], &[&trader]) {
            Ok(_) => {
                let minted = env.balance(&shares, &t);
                expect_ok(env.send(&[env.lend_withdraw_ix(&t, minted)], &[&trader]));
                assert!(env.balance(&usdc, &t) <= amount, "put in {amount} and took out {}", env.balance(&usdc, &t));
            }
            // Too little to mint a single share
            res => expect_err(res, PluribusError::ZeroAmount),
        }
        let (assets_after, supply_after) = share_price(&env);
        assert!(assets_after * supply >= assets * supply_after);
        assert_eq!(env.pool_state().cash, env.token_amount(&env.usdc_vault));
    }
    assert_eq!(env.balance(&shares, &t), 0);
}

// Rule 5: interest accrues, then the full health check runs

#[test]
fn draw_to_exactly_the_limit_works_and_one_base_unit_more_fails() {
    let mut env = Env::new();
    env.lender(1_000_000 * USDC);
    let user = env.user();
    let me = user.pubkey();
    let (sol, stock, usdc) = (env.sol, env.stock, env.usdc);
    env.deposit(&user, &sol, 10 * SOL);
    env.deposit(&user, &stock, 10 * STOCK);
    env.deposit(&user, &usdc, 500 * USDC);
    let nft = env.deposit_lp(&user, 120.0, 180.0, liquidity_for(1_000, 120.0, 180.0, 150));

    let limit = env.health(&me).credit_limit;
    expect_err(env.draw(&user, limit + 1), PluribusError::ExceedsCreditLimit);
    // Each instruction is checked on its own, so a draw and a withdrawal sharing a transaction both have to pass
    let bundled = [env.draw_ix(&me, limit), env.withdraw_token_ix(&me, &usdc, 1)];
    expect_err(env.send(&bundled, &[&user]), PluribusError::ExceedsCreditLimit);
    assert_eq!(env.debt(&me), 0);
    expect_ok(env.draw(&user, limit));
    assert_eq!(env.debt(&me), limit);
    expect_err(env.draw(&user, 1), PluribusError::ExceedsCreditLimit);

    // At the limit no collateral of any kind can leave
    for mint in [sol, stock, usdc] {
        expect_err(env.send(&[env.withdraw_token_ix(&me, &mint, 1)], &[&user]), PluribusError::ExceedsCreditLimit);
    }
    expect_err(env.send(&[env.withdraw_lp_ix(&me, &nft)], &[&user]), PluribusError::ExceedsCreditLimit);

    // USDC collateral counts at par, so paying 1000 base units frees exactly 1000 of it
    expect_ok(env.send(&[env.repay_ix(&me, &me, 1_000)], &[&user]));
    expect_err(env.send(&[env.withdraw_token_ix(&me, &usdc, 1_001)], &[&user]), PluribusError::ExceedsCreditLimit);
    expect_ok(env.send(&[env.withdraw_token_ix(&me, &usdc, 1_000)], &[&user]));
    expect_err(env.draw(&user, 1), PluribusError::ExceedsCreditLimit);
    assert_books_balance(&env, &[me]);
}

#[test]
fn interest_is_accrued_before_the_limit_is_checked() {
    let mut env = Env::new();
    env.lender(1_000_000 * USDC);
    let user = env.user();
    let me = user.pubkey();
    let (sol, usdc) = (env.sol, env.usdc);
    env.deposit(&user, &sol, 10 * SOL);
    env.deposit(&user, &usdc, 500 * USDC);
    let limit = env.health(&me).credit_limit;
    expect_ok(env.draw(&user, limit - 1_000));

    env.warp(DAY);
    env.set_price(&sol, 150 * USDC);
    // Nothing has accrued on chain yet, so the stored debt still sits 1000 base units under the limit
    assert_eq!(env.debt(&me), limit - 1_000);
    assert_eq!(env.pool_state().last_accrual, env.now() - DAY);
    expect_err(env.draw(&user, 1), PluribusError::ExceedsCreditLimit);
    expect_err(env.send(&[env.withdraw_token_ix(&me, &usdc, 1)], &[&user]), PluribusError::ExceedsCreditLimit);
    expect_err(env.send(&[env.withdraw_token_ix(&me, &sol, 1)], &[&user]), PluribusError::ExceedsCreditLimit);
    let h = env.health(&me);
    assert_eq!(h.credit_limit, limit);
    assert!(h.debt > limit);

    // Paying the day's interest restores the room
    expect_ok(env.send(&[env.repay_ix(&me, &me, h.debt - limit + 1_000)], &[&user]));
    expect_ok(env.draw(&user, 1));
    assert_books_balance(&env, &[me]);
}

// Rule 6: only USDC is lent

#[test]
fn only_usdc_can_be_drawn_or_supplied() {
    let mut env = Env::new();
    let lender = env.lender(100_000 * USDC);
    let (user, other) = (env.user(), env.user());
    let (me, l) = (user.pubkey(), lender.pubkey());
    let (sol, stock, usdc) = (env.sol, env.stock, env.usdc);
    env.deposit(&user, &sol, 100 * SOL);
    env.deposit(&other, &stock, 100 * STOCK);
    env.fund(&stock, &me, 0);
    env.fund(&usdc, &me, 0);
    env.fund(&stock, &l, 100 * STOCK);

    // Borrowing the stock other users posted as collateral, straight out of its vault
    let draw = env.draw_ix(&me, STOCK);
    let from_collateral = swap(swap(swap(draw.clone(), usdc, stock), env.usdc_vault, env.vault_pda(&stock)), ata(&me, &usdc, &TOKEN), ata(&me, &stock, &TOKEN));
    expect_anchor(env.send(&[from_collateral], &[&user]), ErrorCode::ConstraintHasOne);
    expect_anchor(env.send(&[swap(draw, usdc, stock)], &[&user]), ErrorCode::ConstraintHasOne);

    // Supplying the stock for lender shares
    let supply = swap(swap(swap(env.lend_deposit_ix(&l, STOCK), usdc, stock), env.usdc_vault, env.vault_pda(&stock)), ata(&l, &usdc, &TOKEN), ata(&l, &stock, &TOKEN));
    expect_anchor(env.send(&[supply], &[&lender]), ErrorCode::ConstraintHasOne);

    assert_eq!((env.balance(&stock, &me), env.debt(&me)), (0, 0));
    assert_books_balance(&env, &[me, other.pubkey()]);
}

// Rule 7: at most 5 positions

#[test]
fn a_sixth_position_is_rejected() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let user = env.user();
    let me = user.pubkey();
    let (sol, stock, usdc, whirlpool) = (env.sol, env.stock, env.usdc, env.whirlpool);
    let extra = [(); 2].map(|_| {
        let mint = env.new_mint(6, &TOKEN);
        expect_ok(env.send(&[env.init_asset_ix(&mint, asset_params(GROUP_STOCK, ORACLE_PYTH, [1; 32], 1000))], &[&admin]));
        mint
    });
    let open_slots = |env: &Env| env.credit(&me).positions.iter().filter(|p| p.kind == KIND_EMPTY).count();

    for mint in [sol, stock, usdc, extra[0]] {
        env.deposit(&user, &mint, 1_000_000);
    }
    let first = env.deposit_lp(&user, 120.0, 180.0, 1_000_000);
    assert_eq!(open_slots(&env), 0);

    env.fund(&extra[1], &me, 1_000_000);
    let sixth_token = env.deposit_token_ix(&me, &extra[1], 1_000_000);
    let second = env.lp(&me, &whirlpool, 120.0, 180.0, 1_000_000, &TOKEN);
    let sixth_lp = env.deposit_lp_ix(&me, &whirlpool, &second);
    expect_err(env.send(&[sixth_token.clone()], &[&user]), PluribusError::TooManyPositions);
    expect_err(env.send(&[sixth_lp.clone()], &[&user]), PluribusError::TooManyPositions);
    assert_eq!((env.balance(&extra[1], &me), env.balance(&second, &me)), (1_000_000, 1));

    // Adding to an asset that already has a slot is not a new position
    env.deposit(&user, &sol, 1_000_000);

    // A freed slot can be taken once
    expect_ok(env.send(&[env.withdraw_lp_ix(&me, &first)], &[&user]));
    expect_ok(env.send(&[sixth_token], &[&user]));
    expect_err(env.send(&[sixth_lp], &[&user]), PluribusError::TooManyPositions);
    assert_eq!(open_slots(&env), 0);
}

// Rule 8: whitelist

#[test]
fn only_whitelisted_classic_tokens_and_pools_become_collateral() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let user = env.user();
    let me = user.pubkey();
    let (sol, stock, usdc, whirlpool) = (env.sol, env.stock, env.usdc, env.whirlpool);

    // No Asset account, no deposit
    let unlisted = env.new_mint(6, &TOKEN);
    env.fund(&unlisted, &me, 1_000_000);
    expect_anchor(env.send(&[env.deposit_token_ix(&me, &unlisted, 1_000_000)], &[&user]), ErrorCode::AccountNotInitialized);
    assert!(!env.credit(&me).has_collateral());

    // A Token-2022 mint is refused whichever token program comes with it
    let modern = env.new_mint(6, &TOKEN_2022);
    let init = env.init_asset_ix(&modern, asset_params(GROUP_STOCK, ORACLE_PYTH, STOCK_FEED, 1000));
    // The classic program will not make a vault for it, and the program's own check catches the other pairing
    assert!(env.send(&[init.clone()], &[&admin]).is_err());
    expect_err(env.send(&[swap(init, TOKEN, TOKEN_2022)], &[&admin]), PluribusError::UnsupportedMint);
    assert!(env.svm.get_account(&env.asset_pda(&modern)).is_none());

    // The valuer needs token A to be an oracle-priced asset and token B to be USDC
    let mut market_for = |a: &Pubkey, b: &Pubkey, base: &Pubkey| {
        let pool = Pubkey::new_unique();
        env.set_whirlpool(&pool, a, b);
        let res = env.send(&[env.init_lp_market_ix(&pool, base, 500)], &[&admin]);
        assert!(env.svm.get_account(&env.lp_market_pda(&pool)).is_none());
        res
    };
    expect_err(market_for(&sol, &stock, &sol), PluribusError::PoolNotWhitelisted);
    expect_err(market_for(&stock, &usdc, &sol), PluribusError::PoolNotWhitelisted);
    expect_err(market_for(&usdc, &sol, &sol), PluribusError::PoolNotWhitelisted);
    expect_err(market_for(&usdc, &usdc, &usdc), PluribusError::PoolNotWhitelisted);

    // A whirlpool look-alike under another owner, and an Orca account that is not a whirlpool
    let fake = Pubkey::new_unique();
    let data = env.svm.get_account(&whirlpool).unwrap().data;
    env.set_raw(fake, Pubkey::new_unique(), data);
    expect_err(env.send(&[env.init_lp_market_ix(&fake, &sol, 500)], &[&admin]), PluribusError::PoolNotWhitelisted);
    let nft = env.lp(&me, &whirlpool, 120.0, 180.0, 1_000_000, &TOKEN);
    expect_err(env.send(&[env.init_lp_market_ix(&orca_position(&nft), &sol, 500)], &[&admin]), PluribusError::PoolNotWhitelisted);
}

// Rule 9: per-asset pause

#[test]
fn a_paused_asset_takes_no_deposits_and_backs_no_new_debt_but_is_not_liquidatable() {
    let mut env = Env::new();
    env.lender(1_000_000 * USDC);
    let admin = env.admin.insecure_clone();
    let user = env.user();
    let me = user.pubkey();
    let (sol, stock, usdc, whirlpool) = (env.sol, env.stock, env.usdc, env.whirlpool);
    env.deposit(&user, &sol, 10 * SOL);
    env.deposit(&user, &stock, 10 * STOCK);
    env.deposit_lp(&user, 120.0, 180.0, liquidity_for(1_000, 120.0, 180.0, 150));
    let before = env.health(&me);
    expect_ok(env.draw(&user, before.credit_limit));

    pause_asset(&mut env, &sol, true);
    env.fund(&sol, &me, SOL);
    expect_err(env.send(&[env.deposit_token_ix(&me, &sol, SOL)], &[&user]), PluribusError::Paused);

    // Only the stock still backs new debt: 2000 * 0.65 * 0.90, since the LP is priced off the paused asset too
    let paused = env.health(&me);
    assert_eq!(paused.credit_limit, 1_170_000_000);
    assert_eq!(paused.liquidation_limit, before.liquidation_limit);
    assert!(paused.debt > paused.credit_limit && paused.debt < paused.liquidation_limit);
    expect_err(env.draw(&user, 1), PluribusError::ExceedsCreditLimit);
    expect_err(env.send(&[env.withdraw_token_ix(&me, &stock, 1)], &[&user]), PluribusError::ExceedsCreditLimit);

    let liquidator = env.wallet();
    env.fund(&usdc, &liquidator.pubkey(), 10_000 * USDC);
    env.fund(&sol, &liquidator.pubkey(), 0);
    expect_err(env.send(&[env.liquidate_ix(&liquidator.pubkey(), &me, &sol, 100 * USDC)], &[&liquidator]), PluribusError::NotLiquidatable);

    // Repaying still works, and lifting the pause brings the old limit back
    expect_ok(env.send(&[env.repay_ix(&me, &me, 100 * USDC)], &[&user]));
    pause_asset(&mut env, &sol, false);
    assert_eq!(env.health(&me).credit_limit, before.credit_limit);
    expect_ok(env.send(&[env.deposit_token_ix(&me, &sol, SOL)], &[&user]));

    // The same for a paused LP market
    let lp_only = env.user();
    let liquidity = liquidity_for(1_000, 120.0, 180.0, 150);
    env.deposit_lp(&lp_only, 120.0, 180.0, liquidity);
    let before = env.health(&lp_only.pubkey());
    expect_ok(env.draw(&lp_only, before.credit_limit));
    expect_ok(env.send(&[env.set_lp_market_ix(&whirlpool, 500, true)], &[&admin]));
    let more = env.lp(&lp_only.pubkey(), &whirlpool, 120.0, 180.0, liquidity, &TOKEN);
    expect_err(env.send(&[env.deposit_lp_ix(&lp_only.pubkey(), &whirlpool, &more)], &[&lp_only]), PluribusError::Paused);
    let paused = env.health(&lp_only.pubkey());
    assert_eq!((paused.credit_limit, paused.liquidation_limit), (0, before.liquidation_limit));
    assert!(paused.debt < paused.liquidation_limit);
    expect_err(env.draw(&lp_only, 1), PluribusError::ExceedsCreditLimit);
    assert_books_balance(&env, &[me, lp_only.pubkey()]);
}

#[test]
fn a_paused_pool_lends_nothing_but_still_takes_repayments() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    let admin = env.admin.insecure_clone();
    let user = env.user();
    let me = user.pubkey();
    let sol = env.sol;
    env.deposit(&user, &sol, 10 * SOL);
    expect_ok(env.draw(&user, 100 * USDC));
    expect_ok(env.send(&[env.set_flags_ix(&admin.pubkey(), true, true)], &[&admin]));
    expect_err(env.draw(&user, 1), PluribusError::Paused);
    expect_ok(env.send(&[env.repay_ix(&me, &me, 100 * USDC)], &[&user]));
    assert_eq!(env.debt(&me), 0);
}

// Rule 10: parameter validation

#[test]
fn nonsense_pool_params_are_rejected() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let base = default_params();
    let edits: &[(&str, fn(&mut PoolParams))] = &[
        ("close factor above 50%", |p| p.close_factor_bps = 5_001),
        ("close factor of zero", |p| p.close_factor_bps = 0),
        ("maint shock above init shock", |p| p.maint_shock_bps[0] = p.init_shock_bps[0] + 1),
        ("maint shock above init shock in an unused row", |p| p.maint_shock_bps[MAX_SCENARIOS * MAX_GROUPS - 1] = 1),
        ("init shock of 100%", |p| p.init_shock_bps[0] = 10_000),
        ("no scenarios", |p| p.num_scenarios = 0),
        ("more scenarios than the table holds", |p| p.num_scenarios = MAX_SCENARIOS as u8 + 1),
        ("liquidation bonus above 20%", |p| p.liq_bonus_bps = 2_001),
        ("warning level under 100% health", |p| p.warn_health_bps = 9_999),
        ("kink of zero", |p| p.kink_bps = 0),
        ("kink of 100%", |p| p.kink_bps = 10_000),
        ("reserve factor above 50%", |p| p.reserve_factor_bps = 5_001),
        ("protocol fee above 50%", |p| p.protocol_fee_bps = 5_001),
        ("reserve factor and protocol fee above 50% together", |p| p.reserve_factor_bps = 5_001 - p.protocol_fee_bps),
        ("discount on the base tier", |p| p.tier_discount_bps[0] = 1),
        ("waiting time on the base tier", |p| p.tier_min_healthy_secs[0] = 1),
        ("discounts that fall with tier", |p| p.tier_discount_bps = [0, 80, 40]),
        ("waiting times that fall with tier", |p| p.tier_min_healthy_secs = [0, 30 * DAY, 7 * DAY]),
        ("waiting times that do not rise", |p| p.tier_min_healthy_secs = [0, 7 * DAY, 7 * DAY]),
        ("negative waiting time", |p| p.tier_min_healthy_secs = [0, -1, 7 * DAY]),
    ];
    for (name, edit) in edits {
        let mut params = base;
        edit(&mut params);
        assert!(failed_with(&env.send(&[env.set_params_ix(&admin.pubkey(), params)], &[&admin]), PluribusError::InvalidParams), "{name}");

        // The same check guards the very first set of params
        let mut fresh = bare();
        let (boss, usdc) = (fresh.admin.insecure_clone(), fresh.new_mint(6, &TOKEN));
        assert!(failed_with(&fresh.send(&[initialize_ix(&fresh, &boss.pubkey(), &usdc, params)], &[&boss]), PluribusError::InvalidParams), "{name}");
    }
    assert_eq!(env.pool_state().params, base);

    // The smallest liquidation cost on the books is 5%, and a bonus of 5.27% on top of it would pay out more than is seized
    let mut edge = base;
    edge.liq_bonus_bps = 527;
    expect_err(env.send(&[env.set_params_ix(&admin.pubkey(), edge)], &[&admin]), PluribusError::InvalidParams);

    // The edges themselves are allowed
    edge.liq_bonus_bps = 526;
    edge.close_factor_bps = 5_000;
    edge.maint_shock_bps = edge.init_shock_bps;
    edge.reserve_factor_bps = 5_000 - edge.protocol_fee_bps;
    expect_ok(env.send(&[env.set_params_ix(&admin.pubkey(), edge)], &[&admin]));
}

#[test]
fn nonsense_asset_and_market_params_are_rejected() {
    let mut env = Env::new();
    let admin = env.admin.insecure_clone();
    let a = admin.pubkey();
    let (sol, usdc, whirlpool) = (env.sol, env.usdc, env.whirlpool);
    let sol_params = env.load::<Asset>(&env.asset_pda(&sol)).params;
    let usdc_params = env.load::<Asset>(&env.asset_pda(&usdc)).params;

    for (name, mint, params) in [
        ("liquidation cost of 100%", sol, AssetParams { liq_cost_bps: 10_000, ..sol_params }),
        ("unknown oracle kind", sol, AssetParams { oracle: ORACLE_PYTH + 1, ..sol_params }),
        ("liquidation cost too small to cover the liquidator bonus", sol, AssetParams { liq_cost_bps: 476, ..sol_params }),
        ("confidence band above 20%", sol, AssetParams { max_conf_bps: 2_001, ..sol_params }),
        ("confidence band of zero", sol, AssetParams { max_conf_bps: 0, ..sol_params }),
        ("price age limit of zero", sol, AssetParams { max_price_age_secs: 0, ..sol_params }),
        ("fixed price on a volatile asset", sol, AssetParams { oracle: ORACLE_FIXED, ..sol_params }),
        ("fixed price on a volatile asset dressed as usdc", sol, AssetParams { oracle: ORACLE_FIXED, ..usdc_params }),
    ] {
        assert!(failed_with(&env.send(&[env.set_asset_ix(&a, &mint, params)], &[&admin]), PluribusError::InvalidParams), "{name}");
    }
    assert_eq!(env.load::<Asset>(&env.asset_pda(&sol)).params, sol_params);
    assert_eq!(env.load::<Asset>(&env.asset_pda(&usdc)).params, usdc_params);

    let new_mint = env.new_mint(6, &TOKEN);
    for params in [AssetParams { liq_cost_bps: 10_000, ..sol_params }, AssetParams { oracle: ORACLE_FIXED, ..usdc_params }] {
        expect_err(env.send(&[env.init_asset_ix(&new_mint, params)], &[&admin]), PluribusError::InvalidParams);
    }
    assert!(env.svm.get_account(&env.asset_pda(&new_mint)).is_none());

    // With a 5% bonus the cost has to be at least 4.77%
    let new_pool = Pubkey::new_unique();
    env.set_whirlpool(&new_pool, &sol, &usdc);
    for liq_cost_bps in [10_000, 476] {
        expect_err(env.send(&[env.set_lp_market_ix(&whirlpool, liq_cost_bps, false)], &[&admin]), PluribusError::InvalidParams);
        expect_err(env.send(&[env.init_lp_market_ix(&new_pool, &sol, liq_cost_bps)], &[&admin]), PluribusError::InvalidParams);
    }
    expect_ok(env.send(&[env.set_asset_ix(&a, &sol, AssetParams { liq_cost_bps: 477, ..sol_params })], &[&admin]));
}

// Invariants

#[test]
fn books_balance_through_a_mixed_flow() {
    let mut env = Env::new();
    let lender = env.lender(500_000 * USDC);
    let admin = env.admin.insecure_clone();
    let (sol, stock, usdc, shares) = (env.sol, env.stock, env.usdc, env.share_mint);
    let (alice, bob) = (env.user(), env.user());
    let (a, b, l) = (alice.pubkey(), bob.pubkey(), lender.pubkey());
    let owners = [a, b];
    let fresh_prices = |env: &mut Env| {
        env.set_price(&sol, 150 * USDC);
        env.set_price(&stock, 200 * USDC);
    };

    env.deposit(&alice, &sol, 50 * SOL);
    let nft = env.deposit_lp(&alice, 120.0, 180.0, liquidity_for(5_000, 120.0, 180.0, 150));
    env.deposit(&bob, &stock, 40 * STOCK);
    env.deposit(&bob, &usdc, 300 * USDC);
    assert_books_balance(&env, &owners);
    expect_ok(env.draw(&alice, 4_000 * USDC));
    expect_ok(env.draw(&bob, 3_000 * USDC));
    assert_books_balance(&env, &owners);

    // Alice earns a tier while Bob stays on the base one, so two borrow indices are live
    env.warp(8 * DAY);
    fresh_prices(&mut env);
    expect_ok(env.send(&[env.refresh_tier_ix(&a)], &[&lender]));
    assert_eq!((env.credit(&a).tier, env.credit(&b).tier), (1, 0));
    assert_books_balance(&env, &owners);

    env.warp(3 * DAY);
    fresh_prices(&mut env);
    expect_ok(env.draw(&alice, 777));
    expect_ok(env.draw(&bob, 1));
    expect_ok(env.send(&[env.repay_ix(&a, &a, 1_234_567)], &[&alice]));
    expect_ok(env.send(&[env.repay_ix(&a, &b, 3)], &[&alice]));
    expect_ok(env.send(&[env.withdraw_token_ix(&a, &sol, 3 * SOL + 1)], &[&alice]));
    expect_ok(env.send(&[env.withdraw_token_ix(&b, &usdc, 100 * USDC)], &[&bob]));
    env.deposit(&bob, &stock, 5 * STOCK);
    expect_ok(env.send(&[env.lend_withdraw_ix(&l, env.balance(&shares, &l) / 3)], &[&lender]));
    env.fund(&usdc, &admin.pubkey(), 0);
    expect_ok(env.send(&[env.collect_protocol_fees_ix(&admin.pubkey(), u64::MAX)], &[&admin]));
    assert!(env.balance(&usdc, &admin.pubkey()) > 0);
    assert_books_balance(&env, &owners);

    env.warp(30 * DAY);
    fresh_prices(&mut env);
    for owner in owners {
        expect_ok(env.send(&[env.refresh_tier_ix(&owner)], &[&lender]));
    }
    assert_eq!((env.credit(&a).tier, env.credit(&b).tier), (2, 2));
    assert_books_balance(&env, &owners);

    for user in [&alice, &bob] {
        let who = user.pubkey();
        let debt = env.debt(&who);
        env.fund(&usdc, &who, debt);
        expect_ok(env.send(&[env.repay_ix(&who, &who, u64::MAX)], &[user]));
        assert_eq!((env.debt(&who), env.balance(&usdc, &who)), (0, 0));
    }
    expect_ok(env.send(&[env.withdraw_lp_ix(&a, &nft)], &[&alice]));
    expect_ok(env.send(&[env.withdraw_token_ix(&a, &sol, 47 * SOL - 1)], &[&alice]));
    expect_ok(env.send(&[env.withdraw_token_ix(&b, &stock, 45 * STOCK)], &[&bob]));
    expect_ok(env.send(&[env.withdraw_token_ix(&b, &usdc, 200 * USDC)], &[&bob]));
    assert!(!env.credit(&a).has_collateral() && !env.credit(&b).has_collateral());
    let (held, wallet) = (env.balance(&shares, &l), env.balance(&usdc, &l));
    expect_ok(env.send(&[env.lend_withdraw_ix(&l, held)], &[&lender]));
    let out = env.balance(&usdc, &l) - wallet;
    assert_books_balance(&env, &owners);

    let pool = env.pool_state();
    assert_eq!(pool.debt_shares, [0; TIERS]);
    assert!(env.balance(&usdc, &l) > 500_000 * USDC);
    // All that stays behind is the reserve, the uncollected protocol fees and the one virtual share's part of the interest
    let claims = pool.reserves + pool.protocol_fees;
    let virtual_part = (out - held) * pluribus::constants::VIRTUAL_SHARES as u64 / held;
    assert!(pool.cash >= claims && pool.cash - claims <= virtual_part + 3);
}

#[test]
fn stray_tokens_in_a_vault_do_not_move_the_share_price_or_add_credit() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    let user = env.user();
    let me = user.pubkey();
    let (sol, usdc) = (env.sol, env.usdc);
    env.deposit(&user, &sol, 10 * SOL);
    env.deposit(&user, &usdc, 10 * USDC);
    expect_ok(env.draw(&user, 100 * USDC));
    let (pool, limit) = (env.pool_state(), env.health(&me).credit_limit);

    // A vault named as its own payout account is refused
    let to_self = swap(env.draw_ix(&me, USDC), ata(&me, &usdc, &TOKEN), env.usdc_vault);
    expect_anchor(env.send(&[to_self], &[&user]), ErrorCode::ConstraintDuplicateMutableAccount);
    let to_self = swap(env.withdraw_token_ix(&me, &sol, SOL), ata(&me, &sol, &TOKEN), env.vault_pda(&sol));
    expect_anchor(env.send(&[to_self], &[&user]), ErrorCode::ConstraintDuplicateMutableAccount);

    // Plain token transfers into the lending vault and a collateral vault, behind the program's back
    for vault in [env.usdc_vault, env.vault_pda(&usdc)] {
        let transfer = [&[3u8][..], &(50 * USDC).to_le_bytes()].concat();
        let metas = vec![AccountMeta::new(ata(&me, &usdc, &TOKEN), false), AccountMeta::new(vault, false), AccountMeta::new_readonly(me, true)];
        expect_ok(env.send(&[Instruction::new_with_bytes(TOKEN, &transfer, metas)], &[&user]));
    }
    let after = env.pool_state();
    assert_eq!((after.cash, after.lender_assets().unwrap()), (pool.cash, pool.lender_assets().unwrap()));
    assert_eq!(env.token_amount(&env.usdc_vault), after.cash + 50 * USDC);
    assert_eq!(env.health(&me).credit_limit, limit);
    assert_eq!(env.load::<Asset>(&env.asset_pda(&usdc)).total_deposited, 10 * USDC);
}

// Tier clock, protocol fees and worthless shares

#[test]
fn the_loyalty_clock_only_runs_while_something_is_owed() {
    let mut env = Env::new();
    env.lender(100_000 * USDC);
    let (user, keeper) = (env.user(), env.wallet());
    let me = user.pubkey();
    let (sol, usdc) = (env.sol, env.usdc);
    env.deposit(&user, &sol, 10 * SOL);
    let refresh = |env: &mut Env| {
        env.set_price(&sol, 150 * USDC);
        expect_ok(env.send(&[env.refresh_tier_ix(&me)], &[&keeper]));
        env.credit(&me).tier
    };

    // Idle for longer than the top tier asks, and still on the base tier
    env.warp(60 * DAY);
    assert_eq!(refresh(&mut env), 0);
    expect_ok(env.draw(&user, 100 * USDC));
    assert_eq!(env.credit(&me).healthy_since, env.now());
    assert_eq!(refresh(&mut env), 0);
    env.warp(7 * DAY - 1);
    assert_eq!(refresh(&mut env), 0);
    env.warp(1);
    assert_eq!(refresh(&mut env), 1);

    // With the loan paid off the clock stops counting, and the next draw starts it again
    env.fund(&usdc, &me, 200 * USDC);
    expect_ok(env.send(&[env.repay_ix(&me, &me, u64::MAX)], &[&user]));
    env.warp(60 * DAY);
    assert_eq!(refresh(&mut env), 1);
    expect_ok(env.draw(&user, 100 * USDC));
    assert_eq!(env.credit(&me).healthy_since, env.now());
    env.warp(30 * DAY - 1);
    assert_eq!(refresh(&mut env), 1);
    env.warp(1);
    assert_eq!(refresh(&mut env), 2);
}

#[test]
fn protocol_fee_collection_takes_only_accrued_fees_and_idle_cash() {
    let mut env = Env::new();
    let lender = env.lender(1_000 * USDC);
    let admin = env.admin.insecure_clone();
    let user = env.user();
    let (me, boss) = (user.pubkey(), admin.pubkey());
    let (sol, usdc) = (env.sol, env.usdc);
    env.deposit(&user, &sol, 100 * SOL);
    expect_ok(env.draw(&user, 900 * USDC));
    env.fund(&usdc, &boss, 0);
    // Returns what reached the admin, after checking it came out of cash and fees and nothing else
    let collect = |env: &mut Env, amount: u64| {
        let (before, held) = (env.pool_state(), env.balance(&usdc, &boss));
        let res = env.send(&[env.collect_protocol_fees_ix(&boss, amount)], &[&admin]);
        let (after, paid) = (env.pool_state(), env.balance(&usdc, &boss) - held);
        assert_eq!((after.cash, after.protocol_fees), (before.cash - paid, before.protocol_fees - paid));
        assert_eq!((after.reserves, after.lender_assets().unwrap()), (before.reserves, before.lender_assets().unwrap()));
        (res, paid)
    };
    expect_err(collect(&mut env, u64::MAX).0, PluribusError::ZeroAmount);

    env.warp(365 * DAY);
    env.set_price(&sol, 150 * USDC);
    expect_ok(env.send(&[env.accrue_ix()], &[&lender]));
    let pool = env.pool_state();
    assert!(pool.protocol_fees > 5 * USDC && pool.reserves > 0);

    // With only 5 USDC idle, that is all a collection can take
    expect_ok(env.draw(&user, pool.cash - 5 * USDC));
    assert_eq!(collect(&mut env, u64::MAX).1, 5 * USDC);
    expect_err(collect(&mut env, 1).0, PluribusError::ZeroAmount);

    // With cash back in the pool the rest of the fees can go, and nothing beyond them
    expect_ok(env.send(&[env.repay_ix(&me, &me, 500 * USDC)], &[&user]));
    assert_eq!(collect(&mut env, 1).1, 1);
    assert_eq!(collect(&mut env, u64::MAX).1, pool.protocol_fees - 5 * USDC - 1);
    expect_err(collect(&mut env, 1).0, PluribusError::ZeroAmount);
    assert_eq!(env.pool_state().protocol_fees, 0);
    assert_books_balance(&env, &[me]);
}

#[test]
fn shares_worth_less_than_a_base_unit_cannot_be_redeemed() {
    let mut env = Env::new();
    let lender = env.lender(2_000 * USDC);
    let (user, liquidator) = (env.user(), env.wallet());
    let (me, l) = (user.pubkey(), lender.pubkey());
    let (sol, usdc, shares) = (env.sol, env.usdc, env.share_mint);
    env.deposit(&user, &sol, 10 * SOL);
    expect_ok(env.draw(&user, 997_500_000));

    // A crash leaves the collateral worth less than the loan, and the shortfall is written off against lenders
    env.set_price(&sol, 50 * USDC);
    env.fund(&usdc, &liquidator.pubkey(), 1_000 * USDC);
    env.fund(&sol, &liquidator.pubkey(), 0);
    expect_ok(env.send(&[env.liquidate_ix(&liquidator.pubkey(), &me, &sol, u64::MAX)], &[&liquidator]));
    let pool = env.pool_state();
    assert!(pool.bad_debt > 0 && pool.lender_assets().unwrap() < 2_000 * USDC as u128);

    let held = env.balance(&shares, &l);
    expect_err(env.send(&[env.lend_withdraw_ix(&l, 1)], &[&lender]), PluribusError::ZeroAmount);
    assert_eq!(env.balance(&shares, &l), held);
    expect_ok(env.send(&[env.lend_withdraw_ix(&l, 2)], &[&lender]));
    assert_eq!((env.balance(&shares, &l), env.balance(&usdc, &l)), (held - 2, 1));
}

// Orca position bundles

/// Runs the real Whirlpool program to mint a position bundle NFT to `owner` and open two bundled positions under it
/// Returns None when the Whirlpool binary has not been fetched, since it is too large to commit
fn orca_bundle(env: &mut Env, owner: &Keypair) -> Option<(Pubkey, [Pubkey; 2])> {
    let Ok(program) = std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/orca/whirlpool.so")) else {
        eprintln!("Skipped: run `npm run orca:snapshot` to fetch whirlpool.so");
        return None;
    };
    env.svm.add_program(WHIRLPOOL_PROGRAM_ID, &program).unwrap();
    // Orca refuses to open positions in a pool with no tick spacing
    let whirlpool = env.whirlpool;
    let mut data = env.svm.get_account(&whirlpool).unwrap().data;
    data[41..43].copy_from_slice(&64u16.to_le_bytes());
    env.set_raw(whirlpool, WHIRLPOOL_PROGRAM_ID, data);

    let mint = Keypair::new();
    let (me, nft) = (owner.pubkey(), mint.pubkey());
    let bundle = Pubkey::find_program_address(&[b"position_bundle", nft.as_ref()], &WHIRLPOOL_PROGRAM_ID).0;
    let token_account = ata(&me, &nft, &TOKEN);
    // Account order and discriminators come from the Whirlpool IDL
    let init = Instruction::new_with_bytes(
        WHIRLPOOL_PROGRAM_ID,
        &[117, 45, 241, 149, 24, 18, 194, 65],
        vec![
            AccountMeta::new(bundle, false),
            AccountMeta::new(nft, true),
            AccountMeta::new(token_account, false),
            AccountMeta::new_readonly(me, false),
            AccountMeta::new(me, true),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(RENT_SYSVAR, false),
            AccountMeta::new_readonly(ATA_PROGRAM, false),
        ],
    );
    expect_ok(env.send(&[init], &[owner, &mint]));

    let positions = [0u16, 1].map(|index| {
        let position = Pubkey::find_program_address(&[b"bundled_position", nft.as_ref(), index.to_string().as_bytes()], &WHIRLPOOL_PROGRAM_ID).0;
        let data = [&[169, 113, 126, 171, 213, 172, 212, 49][..], &index.to_le_bytes(), &(-21184i32).to_le_bytes(), &(-17152i32).to_le_bytes()].concat();
        let open = Instruction::new_with_bytes(
            WHIRLPOOL_PROGRAM_ID,
            &data,
            vec![
                AccountMeta::new(position, false),
                AccountMeta::new(bundle, false),
                AccountMeta::new_readonly(token_account, false),
                AccountMeta::new_readonly(me, true),
                AccountMeta::new_readonly(whirlpool, false),
                AccountMeta::new(me, true),
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new_readonly(RENT_SYSVAR, false),
            ],
        );
        expect_ok(env.send(&[open], &[owner]));
        position
    });
    Some((nft, positions))
}

#[test]
fn a_bundled_orca_position_cannot_be_deposited() {
    let mut env = Env::new();
    let user = env.user();
    let me = user.pubkey();
    let whirlpool = env.whirlpool;
    let Some((nft, siblings)) = orca_bundle(&mut env, &user) else { return };

    // Orca itself made two position accounts that both name the one bundle NFT as their mint
    // Whoever chose which to show the valuer could pass off an empty one for a full one
    for position in siblings {
        let mut account = env.svm.get_account(&position).unwrap();
        assert_eq!(account.owner, WHIRLPOOL_PROGRAM_ID);
        assert_eq!(account.data[40..72], nft.to_bytes());
        // Stands in for Orca's increase_liquidity, which needs the pool's tick arrays
        account.data[72..88].copy_from_slice(&liquidity_for(10_000, 120.0, 180.0, 150).to_le_bytes());
        env.svm.set_account(position, account).unwrap();
        let deposit = swap(env.deposit_lp_ix(&me, &whirlpool, &nft), orca_position(&nft), position);
        expect_anchor(env.send(&[deposit], &[&user]), ErrorCode::ConstraintSeeds);
    }
    assert!(!env.credit(&me).has_collateral());
    assert_eq!(env.balance(&nft, &me), 1);
}

#[test]
fn a_second_position_account_naming_a_deposited_nft_is_not_valued_in_its_place() {
    let mut env = Env::new();
    env.lender(1_000_000 * USDC);
    let user = env.user();
    let me = user.pubkey();
    let (usdc, whirlpool) = (env.usdc, env.whirlpool);
    let liquidity = liquidity_for(1_000, 120.0, 180.0, 150);
    let nft = env.deposit_lp(&user, 120.0, 180.0, liquidity);
    let limit = env.health(&me).credit_limit;

    let sibling = Pubkey::new_unique();
    env.set_raw(sibling, WHIRLPOOL_PROGRAM_ID, position_bytes(&whirlpool, &nft, liquidity * 100, tick(120.0), tick(180.0)));
    env.fund(&usdc, &me, 0);
    let res = env.send(&[swap(env.draw_ix(&me, limit * 50), orca_position(&nft), sibling)], &[&user]);
    assert!(res.is_err(), "drew {} USDC against a limit of {}", env.debt(&me) / USDC, limit / USDC);
}
