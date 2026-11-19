mod common;

use {
    anchor_lang::{
        prelude::{pubkey, rent, Pubkey},
        solana_program::{
            instruction::{AccountMeta, Instruction},
            program_option::COption,
            program_pack::Pack,
            system_program,
        },
    },
    anchor_spl::{associated_token::ID as ATA_PROGRAM, token::spl_token::state::Mint as MintState},
    base64::{engine::general_purpose::STANDARD, Engine},
    common::*,
    litesvm::LiteSVM,
    pluribus::{constants::*, error::PluribusError, state::*},
    serde_json::Value,
    solana_account::Account,
    solana_keypair::Keypair,
    solana_signer::Signer,
    std::{fs, path::PathBuf, str::FromStr},
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
fn the_orca_autopay_does_not_take_a_raydium_market() {
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

#[test]
fn the_raydium_autopay_does_not_take_an_orca_market() {
    let mut env = Env::new();
    let whirlpool = env.whirlpool;
    let (user, keeper) = (env.user(), env.wallet());
    let me = user.pubkey();
    let nft = env.lp(&me, &whirlpool, 120.0, 180.0, liquidity_for(1_000, 120.0, 180.0, 150), &TOKEN);
    expect_ok(env.send(&[env.deposit_lp_ix(&me, &whirlpool, &nft)], &[&user]));
    let dummies = [Pubkey::new_unique(); 5];
    expect_err(env.send(&[env.autopay_raydium_ix(&keeper.pubkey(), &me, &whirlpool, &nft, dummies, &[])], &[&keeper]), PluribusError::NotRaydiumMarket);
}

// The tests below run on mainnet's Raydium program with pools and positions it creates itself, and so each swap pays real fees

const COMPUTE_BUDGET: Pubkey = pubkey!("ComputeBudget111111111111111111111111111111");
/// First 8 bytes of sha256("global:create_pool")
const CREATE_POOL: [u8; 8] = [0xe9, 0x92, 0xd1, 0x8e, 0xcf, 0x68, 0x40, 0xbc];
/// First 8 bytes of sha256("global:open_position_with_token22_nft")
const OPEN_POSITION_WITH_TOKEN22_NFT: [u8; 8] = [0x4d, 0xff, 0xae, 0x52, 0x7d, 0x1d, 0xc9, 0x2e];
/// First 8 bytes of sha256("global:swap_v2")
const SWAP_V2: [u8; 8] = [0x2b, 0x04, 0xed, 0x0b, 0x1a, 0xc9, 0x1e, 0x62];
/// Where a pool keeps its reward infos, and how far into one its mint and vault lie
const REWARD_INFOS: usize = 397;
const REWARD_MINT: usize = 57;
const REWARD_VAULT: usize = 89;
/// Tokens a wallet is funded with when it has to trade or provide, far more than any test spends
const PLENTY: u64 = 1 << 50;

/// A Raydium pool of the test chain, listed as a market
struct Clmm {
    program: Pubkey,
    pool: Pubkey,
    config: Pubkey,
    usdc_first: bool,
    mint_0: Pubkey,
    mint_1: Pubkey,
    vault_0: Pubkey,
    vault_1: Pubkey,
    observation: Pubkey,
    /// Ticks between initialized ticks
    spacing: i32,
}

/// A position of a `Clmm`, over ticks the pool can hold
struct Lp {
    nft: Pubkey,
    lower: i32,
    upper: i32,
}

fn budget() -> Instruction {
    Instruction::new_with_bytes(COMPUTE_BUDGET, &[&[2u8][..], &1_400_000u32.to_le_bytes()].concat(), vec![])
}

fn find(program: &Pubkey, seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, program).0
}

/// Every chain the tests run on: each of the two Raydium programs the protocol accepts, with USDC as either token of its pool
/// A program whose binary has not been fetched is left out, since they are too large to commit
fn chains() -> Vec<(Env, Clmm)> {
    let mut all = vec![];
    for program in RAYDIUM_CLMM_PROGRAMS {
        for usdc_first in [false, true] {
            all.extend(chain(program, usdc_first));
        }
    }
    all
}

/// A chain holding the real Raydium CLMM program with Pluribus set up beside it, and a SOL/USDC pool of Raydium's made at $150
fn chain(program: Pubkey, usdc_first: bool) -> Option<(Env, Clmm)> {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/raydium");
    let file = if program == RAYDIUM_CLMM_PROGRAMS[0] { "raydium_clmm.so" } else { "raydium_clmm_devnet.so" };
    let Ok(binary) = fs::read(dir.join(file)) else {
        eprintln!("Skipped: run `npm run raydium:snapshot` to fetch {file}");
        return None;
    };
    let mut svm = LiteSVM::new();
    svm.add_program(program, &binary).unwrap();
    let file: Value = serde_json::from_str(&fs::read_to_string(dir.join("amm_config.json")).unwrap()).unwrap();
    let (config, a) = (Pubkey::from_str(file["pubkey"].as_str().unwrap()).unwrap(), &file["account"]);
    let data = STANDARD.decode(a["data"][0].as_str().unwrap()).unwrap();
    // Layout: disc 8 | bump 1 | index 2 | owner 32 | protocol fee rate 4 | trade fee rate 4 | tick spacing 2
    let spacing = u16::from_le_bytes(data[51..53].try_into().unwrap()) as i32;
    svm.set_account(config, Account { lamports: a["lamports"].as_u64().unwrap(), data, owner: program, executable: false, rent_epoch: 0 }).unwrap();

    // The pool sorts its mints, so the two come in the order that puts USDC where the test wants it
    let (x, y) = (Pubkey::new_unique(), Pubkey::new_unique());
    let (low, high) = if x < y { (x, y) } else { (y, x) };
    let (usdc, sol) = if usdc_first { (low, high) } else { (high, low) };
    for (mint, decimals) in [(usdc, 6), (sol, 9)] {
        let state = MintState { mint_authority: COption::None, supply: u64::MAX / 2, decimals, is_initialized: true, freeze_authority: COption::None };
        let mut data = vec![0; MintState::LEN];
        MintState::pack(state, &mut data).unwrap();
        let lamports = svm.minimum_balance_for_rent_exemption(data.len());
        svm.set_account(mint, Account { lamports, data, owner: TOKEN, executable: false, rent_epoch: 0 }).unwrap();
    }
    // Pluribus lists its main Orca market first, which only needs an account that looks like a whirlpool of the two mints
    let whirlpool = Pubkey::new_unique();
    let mut data = vec![0u8; 653];
    data[..8].copy_from_slice(&[0x3f, 0x95, 0xd1, 0x0c, 0xe1, 0x80, 0x63, 0x09]);
    data[101..133].copy_from_slice(sol.as_ref());
    data[181..213].copy_from_slice(usdc.as_ref());
    let lamports = svm.minimum_balance_for_rent_exemption(data.len());
    svm.set_account(whirlpool, Account { lamports, data, owner: WHIRLPOOL_PROGRAM_ID, executable: false, rent_epoch: 0 }).unwrap();
    let mut env = Env::on(svm, default_params(), true, Some((usdc, sol, whirlpool)));

    let (mint_0, mint_1) = if usdc_first { (usdc, sol) } else { (sol, usdc) };
    let pool = find(&program, &[b"pool", config.as_ref(), mint_0.as_ref(), mint_1.as_ref()]);
    let clmm = Clmm {
        program,
        pool,
        config,
        usdc_first,
        mint_0,
        mint_1,
        vault_0: find(&program, &[b"pool_vault", pool.as_ref(), mint_0.as_ref()]),
        vault_1: find(&program, &[b"pool_vault", pool.as_ref(), mint_1.as_ref()]),
        observation: find(&program, &[b"observation", pool.as_ref()]),
        spacing,
    };
    // Raydium prices token 1 in token 0 in raw units, so with 9 and 6 decimals $150 is 0.15 USDC per SOL lamport
    let raw: f64 = if usdc_first { 1e9 / 150e6 } else { 150e6 / 1e9 };
    let sqrt_price = (raw.sqrt() * 18446744073709551616.0) as u128;
    let creator = env.wallet();
    let mut data = CREATE_POOL.to_vec();
    data.extend_from_slice(&sqrt_price.to_le_bytes());
    // The pool may be traded from the start
    data.extend_from_slice(&0u64.to_le_bytes());
    let metas = vec![
        AccountMeta::new(creator.pubkey(), true),
        AccountMeta::new_readonly(config, false),
        AccountMeta::new(pool, false),
        AccountMeta::new_readonly(mint_0, false),
        AccountMeta::new_readonly(mint_1, false),
        AccountMeta::new(clmm.vault_0, false),
        AccountMeta::new(clmm.vault_1, false),
        AccountMeta::new(clmm.observation, false),
        AccountMeta::new(clmm.bitmap_extension(), false),
        AccountMeta::new_readonly(TOKEN, false),
        AccountMeta::new_readonly(TOKEN, false),
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new_readonly(rent::ID, false),
    ];
    expect_ok(env.send(&[budget(), Instruction::new_with_bytes(program, &data, metas)], &[&creator]));
    // The pool account is read at fixed offsets by the SDK: its mints, then its vaults, and the tick spacing at 235
    let made = env.svm.get_account(&pool).unwrap();
    assert_eq!((&made.data[73..105], &made.data[105..137]), (mint_0.as_ref(), mint_1.as_ref()));
    assert_eq!((&made.data[137..169], &made.data[169..201]), (clmm.vault_0.as_ref(), clmm.vault_1.as_ref()));
    assert_eq!(u16::from_le_bytes(made.data[235..237].try_into().unwrap()) as i32, spacing);
    let admin = env.admin.insecure_clone();
    expect_ok(env.send(&[env.init_lp_market_ix(&pool, &sol, 500)], &[&admin]));
    Some((env, clmm))
}

impl Clmm {
    fn tick_array(&self, start: i32) -> Pubkey {
        find(&self.program, &[b"tick_array", self.pool.as_ref(), &start.to_be_bytes()])
    }

    /// What a position outside the range the pool's own bitmap covers needs as well
    fn bitmap_extension(&self) -> Pubkey {
        find(&self.program, &[b"pool_tick_array_bitmap_extension", self.pool.as_ref()])
    }

    /// Where the tick array holding `tick` starts: an array spans 60 ticks of the pool's spacing
    fn start(&self, tick: i32) -> i32 {
        tick.div_euclid(60 * self.spacing) * 60 * self.spacing
    }

    /// Opens a position over a price range worth `usd` dollars at $150, funded by `owner`, who gets its Token-2022 NFT
    fn open(&self, env: &mut Env, owner: &Keypair, low: f64, high: f64, usd: u64) -> Lp {
        let (lower, upper) = ticks(low, high, self.usdc_first);
        // The range rounds outward to the pool's spacing
        let (lower, upper) = (lower.div_euclid(self.spacing) * self.spacing, (upper + self.spacing - 1).div_euclid(self.spacing) * self.spacing);
        let liquidity = liquidity_for(usd, low, high, 150);
        let (me, nft) = (owner.pubkey(), Keypair::new());
        for mint in [self.mint_0, self.mint_1] {
            env.fund(&mint, &me, PLENTY);
        }
        let mut data = OPEN_POSITION_WITH_TOKEN22_NFT.to_vec();
        for tick in [lower, upper, self.start(lower), self.start(upper)] {
            data.extend_from_slice(&tick.to_le_bytes());
        }
        data.extend_from_slice(&liquidity.to_le_bytes());
        data.extend_from_slice(&u64::MAX.to_le_bytes());
        data.extend_from_slice(&u64::MAX.to_le_bytes());
        // No metadata, and no base flag since the liquidity is given
        data.extend_from_slice(&[0, 0]);
        let metas = vec![
            AccountMeta::new(me, true),
            AccountMeta::new_readonly(me, false),
            AccountMeta::new(nft.pubkey(), true),
            AccountMeta::new(ata(&me, &nft.pubkey(), &TOKEN_2022), false),
            AccountMeta::new(self.pool, false),
            AccountMeta::new_readonly(self.protocol_position(lower, upper), false),
            AccountMeta::new(self.tick_array(self.start(lower)), false),
            AccountMeta::new(self.tick_array(self.start(upper)), false),
            AccountMeta::new(find(&self.program, &[b"position", nft.pubkey().as_ref()]), false),
            AccountMeta::new(ata(&me, &self.mint_0, &TOKEN), false),
            AccountMeta::new(ata(&me, &self.mint_1, &TOKEN), false),
            AccountMeta::new(self.vault_0, false),
            AccountMeta::new(self.vault_1, false),
            AccountMeta::new_readonly(rent::ID, false),
            AccountMeta::new_readonly(system_program::ID, false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(ATA_PROGRAM, false),
            AccountMeta::new_readonly(TOKEN_2022, false),
            AccountMeta::new_readonly(self.mint_0, false),
            AccountMeta::new_readonly(self.mint_1, false),
        ];
        expect_ok(env.send(&[budget(), Instruction::new_with_bytes(self.program, &data, metas)], &[owner, &nft]));
        Lp { nft: nft.pubkey(), lower, upper }
    }

    /// Raydium's own account for a range, which the version the tests run on no longer creates
    fn protocol_position(&self, lower: i32, upper: i32) -> Pubkey {
        find(&self.program, &[b"position", self.pool.as_ref(), &lower.to_be_bytes(), &upper.to_be_bytes()])
    }

    /// Sells `amount` of `input` into the pool from a fresh wallet, so the pool's liquidity earns a fee in that token
    /// `lp` is the pool's only liquidity, whose tick arrays are all a small swap can touch
    fn swap(&self, env: &mut Env, lp: &Lp, input: &Pubkey, amount: u64) {
        let trader = env.wallet();
        let me = trader.pubkey();
        let (output, vault_in, vault_out) = if *input == self.mint_0 { (self.mint_1, self.vault_0, self.vault_1) } else { (self.mint_0, self.vault_1, self.vault_0) };
        env.fund(input, &me, amount);
        env.fund(&output, &me, 0);
        let mut data = SWAP_V2.to_vec();
        data.extend_from_slice(&amount.to_le_bytes());
        data.extend_from_slice(&0u64.to_le_bytes());
        // No price limit, and the amount given is what goes in
        data.extend_from_slice(&0u128.to_le_bytes());
        data.push(1);
        let mut metas = vec![
            AccountMeta::new_readonly(me, true),
            AccountMeta::new_readonly(self.config, false),
            AccountMeta::new(self.pool, false),
            AccountMeta::new(ata(&me, input, &TOKEN), false),
            AccountMeta::new(ata(&me, &output, &TOKEN), false),
            AccountMeta::new(vault_in, false),
            AccountMeta::new(vault_out, false),
            AccountMeta::new(self.observation, false),
            AccountMeta::new_readonly(TOKEN, false),
            AccountMeta::new_readonly(TOKEN_2022, false),
            AccountMeta::new_readonly(MEMO_PROGRAM_ID, false),
            AccountMeta::new_readonly(*input, false),
            AccountMeta::new_readonly(output, false),
        ];
        // The tick arrays the swap may walk, the one the price sits in first
        let pool = env.svm.get_account(&self.pool).unwrap();
        let current = self.start(i32::from_le_bytes(pool.data[269..273].try_into().unwrap()));
        let mut arrays = vec![current];
        for start in [self.start(lp.lower), self.start(lp.upper)] {
            if !arrays.contains(&start) {
                arrays.push(start);
            }
        }
        metas.extend(arrays.into_iter().map(|start| AccountMeta::new(self.tick_array(start), false)));
        expect_ok(env.send(&[budget(), Instruction::new_with_bytes(self.program, &data, metas)], &[&trader]));
    }

    /// Trades a little each way, so the position earns fees in both tokens
    fn trade(&self, env: &mut Env, lp: &Lp) {
        let (usdc, sol) = if self.usdc_first { (self.mint_0, self.mint_1) } else { (self.mint_1, self.mint_0) };
        self.swap(env, lp, &usdc, 30 * USDC);
        self.swap(env, lp, &sol, SOL / 5);
    }

    /// The accounts autopay passes Raydium for a position
    fn accounts(&self, lp: &Lp) -> [Pubkey; 5] {
        [self.vault_0, self.vault_1, self.tick_array(self.start(lp.lower)), self.tick_array(self.start(lp.upper)), self.protocol_position(lp.lower, lp.upper)]
    }

    /// What the pool's two vaults hold, which falls by what a harvest collects
    fn held(&self, env: &Env) -> (u64, u64) {
        (env.token_amount(&self.vault_0), env.token_amount(&self.vault_1))
    }

    /// The fees a harvest took out of the vaults between `before` and now, as (base token, USDC)
    fn collected(&self, env: &Env, before: (u64, u64)) -> (u64, u64) {
        let now = self.held(env);
        let (first, second) = (before.0 - now.0, before.1 - now.1);
        if self.usdc_first {
            (second, first)
        } else {
            (first, second)
        }
    }

    /// A position with its NFT deposited as collateral, after the pool has traded
    fn deposited(&self, env: &mut Env, owner: &Keypair) -> Lp {
        let lp = self.open(env, owner, 120.0, 180.0, 1_000);
        self.trade(env, &lp);
        expect_ok(env.send(&[env.deposit_lp_ix(&owner.pubkey(), &self.pool, &lp.nft)], &[owner]));
        lp
    }
}

fn assert_books_match_vaults(env: &Env) {
    let pool = env.pool_state();
    assert_eq!(pool.cash, env.token_amount(&env.usdc_vault));
    for mint in [env.usdc, env.sol, env.stock] {
        let asset: Asset = env.load(&env.asset_pda(&mint));
        assert_eq!(asset.total_deposited, env.token_amount(&env.vault_pda(&mint)));
    }
}

/// Points an account of the instruction at another one
fn swap_account(ix: &mut Instruction, old: &Pubkey, new: Pubkey) {
    let at = ix.accounts.iter().position(|m| m.pubkey == *old).unwrap();
    ix.accounts[at].pubkey = new;
}

#[test]
fn autopay_collects_real_raydium_fees_and_repays_debt() {
    for (mut env, clmm) in chains() {
        env.lender(1_000_000 * USDC);
        let (user, keeper) = (env.user(), env.wallet());
        let (me, sol, usdc) = (user.pubkey(), env.sol, env.usdc);
        let lp = clmm.deposited(&mut env, &user);
        expect_ok(env.draw(&user, 100 * USDC));

        let before = clmm.held(&env);
        let autopay = env.autopay_raydium_ix(&keeper.pubkey(), &me, &clmm.pool, &lp.nft, clmm.accounts(&lp), &[]);
        let meta = expect_ok(env.send(&[autopay.clone()], &[&keeper]));
        println!("autopay_raydium: {} compute units", meta.compute_units_consumed);
        let (fee_sol, fee_usdc) = clmm.collected(&env, before);
        assert!(fee_sol > 0 && fee_usdc > 0, "fees {fee_sol} SOL and {fee_usdc} USDC");

        // The USDC part paid debt down and the SOL part became collateral
        assert_eq!(env.debt(&me), 100 * USDC - fee_usdc);
        let credit = env.credit(&me);
        assert_eq!(credit.positions[credit.find(KIND_TOKEN, &sol).unwrap()].amount, fee_sol);
        assert!(credit.find(KIND_TOKEN, &usdc).is_err());
        assert_eq!(env.balance(&lp.nft, &env.pool), 1);
        assert_books_match_vaults(&env);

        // Nothing is left to collect, so a second run changes nothing
        expect_ok(env.send(&[autopay], &[&keeper]));
        assert_eq!(env.debt(&me), 100 * USDC - fee_usdc);
        assert_eq!(env.credit(&me).positions[credit.find(KIND_TOKEN, &sol).unwrap()].amount, fee_sol);
        assert_books_match_vaults(&env);
    }
}

#[test]
fn autopay_raydium_keeps_fees_as_collateral_when_nothing_is_owed() {
    for (mut env, clmm) in chains() {
        let (user, keeper) = (env.user(), env.wallet());
        let (me, sol, usdc) = (user.pubkey(), env.sol, env.usdc);
        let lp = clmm.deposited(&mut env, &user);

        let before = clmm.held(&env);
        expect_ok(env.send(&[env.autopay_raydium_ix(&keeper.pubkey(), &me, &clmm.pool, &lp.nft, clmm.accounts(&lp), &[])], &[&keeper]));
        let (fee_sol, fee_usdc) = clmm.collected(&env, before);
        assert!(fee_sol > 0 && fee_usdc > 0);
        let credit = env.credit(&me);
        assert_eq!(credit.positions[credit.find(KIND_TOKEN, &sol).unwrap()].amount, fee_sol);
        assert_eq!(credit.positions[credit.find(KIND_TOKEN, &usdc).unwrap()].amount, fee_usdc);
        assert_books_match_vaults(&env);
    }
}

#[test]
fn autopay_raydium_repays_what_is_owed_and_keeps_the_rest() {
    for (mut env, clmm) in chains() {
        env.lender(1_000_000 * USDC);
        let (user, keeper) = (env.user(), env.wallet());
        let (me, usdc) = (user.pubkey(), env.usdc);
        let lp = clmm.deposited(&mut env, &user);
        // Less debt than the USDC fees
        let debt = 20_000;
        expect_ok(env.draw(&user, debt));
        let before = clmm.held(&env);
        expect_ok(env.send(&[env.autopay_raydium_ix(&keeper.pubkey(), &me, &clmm.pool, &lp.nft, clmm.accounts(&lp), &[])], &[&keeper]));
        let (_, fee_usdc) = clmm.collected(&env, before);
        assert!(fee_usdc > debt);
        assert_eq!(env.debt(&me), 0);
        let credit = env.credit(&me);
        assert_eq!(credit.positions[credit.find(KIND_TOKEN, &usdc).unwrap()].amount, fee_usdc - debt);
        assert_books_match_vaults(&env);
    }
}

#[test]
fn autopay_raydium_rejects_a_position_the_account_does_not_hold() {
    for (mut env, clmm) in chains() {
        let (user, other, keeper) = (env.user(), env.user(), env.wallet());
        let lp = clmm.deposited(&mut env, &user);
        let steal = env.autopay_raydium_ix(&keeper.pubkey(), &other.pubkey(), &clmm.pool, &lp.nft, clmm.accounts(&lp), &[]);
        expect_err(env.send(&[steal], &[&keeper]), PluribusError::PositionNotFound);
    }
}

#[test]
fn autopay_raydium_pays_only_into_the_programs_own_vaults() {
    for (mut env, clmm) in chains() {
        wrong_recipients_are_refused(&mut env, &clmm);
    }
}

fn wrong_recipients_are_refused(env: &mut Env, clmm: &Clmm) {
    env.lender(1_000_000 * USDC);
    let (user, keeper) = (env.user(), env.wallet());
    let (me, sol, usdc) = (user.pubkey(), env.sol, env.usdc);
    let lp = clmm.deposited(env, &user);
    expect_ok(env.draw(&user, 100 * USDC));
    // The keeper's own accounts, where a harvest could be sent to skim the fees
    let (mine_sol, mine_usdc) = (env.fund(&sol, &keeper.pubkey(), 0), env.fund(&usdc, &keeper.pubkey(), 0));
    let (base_vault, usdc_vault) = (env.vault_pda(&sol), env.vault_pda(&usdc));
    let ix = env.autopay_raydium_ix(&keeper.pubkey(), &me, &clmm.pool, &lp.nft, clmm.accounts(&lp), &[]);
    let address: u32 = anchor_lang::error::ErrorCode::ConstraintAddress.into();

    let mut skim_base = ix.clone();
    swap_account(&mut skim_base, &base_vault, mine_sol);
    assert!(failed_with_code(&env.send(&[skim_base], &[&keeper]), address));
    let mut skim_usdc = ix.clone();
    swap_account(&mut skim_usdc, &usdc_vault, mine_usdc);
    assert!(failed_with_code(&env.send(&[skim_usdc], &[&keeper]), address));
    // The vaults in each other's places
    let mut crossed = ix.clone();
    swap_account(&mut crossed, &base_vault, Pubkey::default());
    swap_account(&mut crossed, &usdc_vault, base_vault);
    swap_account(&mut crossed, &Pubkey::default(), usdc_vault);
    assert!(failed_with_code(&env.send(&[crossed], &[&keeper]), address));
    // A pool vault that is not the pool's own, or tick arrays of another pool, are Raydium's to refuse
    let mut wrong_vault = ix.clone();
    swap_account(&mut wrong_vault, &clmm.vault_0, mine_sol);
    assert!(env.send(&[wrong_vault], &[&keeper]).is_err());
    // The other Raydium program in the market's program's place
    let other = RAYDIUM_CLMM_PROGRAMS.into_iter().find(|p| *p != clmm.program).unwrap();
    let mut wrong_program = ix.clone();
    swap_account(&mut wrong_program, &clmm.program, other);
    assert!(failed_with_code(&env.send(&[wrong_program], &[&keeper]), address));

    assert_eq!(env.debt(&me), 100 * USDC);
    assert_eq!(env.token_amount(&mine_sol) + env.token_amount(&mine_usdc), 0);
    // And the untouched instruction still works
    expect_ok(env.send(&[ix], &[&keeper]));
}

#[test]
fn autopay_raydium_pays_a_pools_rewards_only_to_the_accounts_owner() {
    for (mut env, clmm) in chains() {
        rewards_go_to_the_owner(&mut env, &clmm);
    }
}

fn rewards_go_to_the_owner(env: &mut Env, clmm: &Clmm) {
    env.lender(1_000_000 * USDC);
    let (user, keeper) = (env.user(), env.wallet());
    let me = user.pubkey();
    let lp = clmm.deposited(env, &user);
    expect_ok(env.draw(&user, 100 * USDC));
    // The pool runs a reward, which Raydium wants three accounts for: its vault, a recipient and its mint
    let reward = env.new_mint(6, &TOKEN);
    let vault = env.fund(&reward, &Pubkey::new_unique(), 0);
    let mut pool = env.svm.get_account(&clmm.pool).unwrap();
    pool.data[REWARD_INFOS + REWARD_MINT..REWARD_INFOS + REWARD_MINT + 32].copy_from_slice(reward.as_ref());
    pool.data[REWARD_INFOS + REWARD_VAULT..REWARD_INFOS + REWARD_VAULT + 32].copy_from_slice(vault.as_ref());
    env.svm.set_account(clmm.pool, pool).unwrap();
    let group = |recipient: Pubkey| [AccountMeta::new(vault, false), AccountMeta::new(recipient, false), AccountMeta::new_readonly(reward, false)];
    let harvest = |env: &Env, extra: &[AccountMeta]| env.autopay_raydium_ix(&keeper.pubkey(), &me, &clmm.pool, &lp.nft, clmm.accounts(&lp), extra);

    // Without the reward's accounts Raydium refuses the collect
    assert!(env.send(&[harvest(&env, &[])], &[&keeper]).is_err());
    // A reward paid to the keeper, or to any account but the owner's, would be the owner's money skimmed
    let keepers = env.fund(&reward, &keeper.pubkey(), 0);
    expect_err(env.send(&[harvest(&env, &group(keepers))], &[&keeper]), PluribusError::AccountMismatch);
    assert_eq!(env.debt(&me), 100 * USDC);

    // The owner's account takes it, and the bitmap extension among the accounts is not mistaken for a reward group
    let owners = env.fund(&reward, &me, 0);
    let extension = AccountMeta::new(clmm.bitmap_extension(), false);
    let extra = [&[extension][..], &group(owners)].concat();
    expect_ok(env.send(&[harvest(&env, &extra)], &[&keeper]));
    assert!(env.debt(&me) < 100 * USDC);
    assert_books_match_vaults(&env);
}

// Compounding puts a position's fees back into it for a bounty, on the same chains

/// The bounty hunter's transaction: compounding runs Raydium's collect and its add, which a bare transaction's compute does
/// not cover
fn hunt(env: &mut Env, hunter: &Keypair, compound: Instruction) -> TxResult {
    env.send(&[budget(), compound], &[hunter])
}

/// The liquidity a Raydium position holds, at offset 81 of its account
fn liquidity_of(env: &Env, clmm: &Clmm, lp: &Lp) -> u128 {
    let d = env.svm.get_account(&position_pda(&clmm.program, &lp.nft).0).unwrap().data;
    u128::from_le_bytes(d[81..97].try_into().unwrap())
}

/// A 2% bounty, the position set to compound within `tolerance_bps` (off when 0), and a bounty hunter with token accounts
/// for both of the pool's tokens
fn set_up_compounding(env: &mut Env, user: &Keypair, nft: &Pubkey, tolerance_bps: u16) -> Keypair {
    let admin = env.admin.insecure_clone();
    let hunter = env.wallet();
    let (sol, usdc) = (env.sol, env.usdc);
    expect_ok(env.send(&[env.set_compound_bounty_ix(&admin.pubkey(), 200)], &[&admin]));
    if tolerance_bps > 0 {
        expect_ok(env.send(&[env.set_compound_ix(&user.pubkey(), nft, tolerance_bps)], &[user]));
    }
    env.fund(&sol, &hunter.pubkey(), 0);
    env.fund(&usdc, &hunter.pubkey(), 0);
    hunter
}

/// A deposited position that has earned fees in both tokens, with compounding set up as above
fn compounding(env: &mut Env, clmm: &Clmm, tolerance_bps: u16) -> (Keypair, Keypair, Lp) {
    let user = env.user();
    let lp = clmm.deposited(env, &user);
    let hunter = set_up_compounding(env, &user, &lp.nft, tolerance_bps);
    (user, hunter, lp)
}

/// What a position's fees are on a chain like `clmm`'s, as (base token, USDC)
/// They are found by collecting them with autopay on a twin chain with the same pool, liquidity and trades, which earns the
/// same fees to the unit and leaves the chain under test untouched
fn fees_on_a_twin(clmm: &Clmm) -> (u64, u64) {
    let (mut env, twin) = chain(clmm.program, clmm.usdc_first).unwrap();
    let (user, keeper) = (env.user(), env.wallet());
    let lp = twin.deposited(&mut env, &user);
    let before = twin.held(&env);
    expect_ok(env.send(&[env.autopay_raydium_ix(&keeper.pubkey(), &user.pubkey(), &twin.pool, &lp.nft, twin.accounts(&lp), &[])], &[&keeper]));
    twin.collected(&env, before)
}

#[test]
fn compound_puts_real_raydium_fees_back_into_the_position_and_pays_the_bounty() {
    for (mut env, clmm) in chains() {
        let (fee_sol, fee_usdc) = fees_on_a_twin(&clmm);
        assert!(fee_sol > 0 && fee_usdc > 0, "fees {fee_sol} SOL and {fee_usdc} USDC");
        let (user, hunter, lp) = compounding(&mut env, &clmm, 100);
        let (me, sol, usdc) = (user.pubkey(), env.sol, env.usdc);
        let (held, liquidity, value) = (clmm.held(&env), liquidity_of(&env, &clmm, &lp), env.health(&me).collateral_value);

        let compound = env.compound_raydium_ix(&hunter.pubkey(), &me, &clmm.pool, &lp.nft, clmm.accounts(&lp), &hunter.pubkey(), &[]);
        let meta = expect_ok(hunt(&mut env, &hunter, compound));
        println!("compound_raydium: {} compute units", meta.compute_units_consumed);

        // The caller got 2% of each fee, exactly, and the position grew
        let bounty = (fee_sol * 200 / 10_000, fee_usdc * 200 / 10_000);
        assert!(bounty.0 > 0 && bounty.1 > 0);
        assert_eq!(env.balance(&sol, &hunter.pubkey()), bounty.0);
        assert_eq!(env.balance(&usdc, &hunter.pubkey()), bounty.1);
        assert!(liquidity_of(&env, &clmm, &lp) > liquidity);

        // What the pool's vaults gained besides the fees that left them is what went into the position
        let (now, fees) = (clmm.held(&env), if clmm.usdc_first { (fee_usdc, fee_sol) } else { (fee_sol, fee_usdc) });
        let added = (now.0 + fees.0 - held.0, now.1 + fees.1 - held.1);
        let (added_sol, added_usdc) = if clmm.usdc_first { (added.1, added.0) } else { added };
        assert!(added_sol > 0 && added_usdc > 0);
        // The rest of the fees stayed as the account's collateral, and one side of the range took nearly all of its share
        let credit = env.credit(&me);
        let kept = |mint: &Pubkey| credit.find(KIND_TOKEN, mint).map_or(0, |i| credit.positions[i].amount);
        assert_eq!(kept(&sol), fee_sol - bounty.0 - added_sol);
        assert_eq!(kept(&usdc), fee_usdc - bounty.1 - added_usdc);
        assert!(kept(&sol).min(kept(&usdc)) <= 4, "kept {} SOL and {} USDC", kept(&sol), kept(&usdc));
        assert!(env.health(&me).collateral_value > value);
        assert_eq!(env.balance(&lp.nft, &env.pool), 1);
        assert_books_match_vaults(&env);
    }
}

#[test]
fn compound_raydium_waits_for_the_pool_price_to_sit_near_the_oracle() {
    for (mut env, clmm) in chains() {
        let (user, hunter, lp) = compounding(&mut env, &clmm, 100);
        let (me, sol) = (user.pubkey(), env.sol);
        let compound = env.compound_raydium_ix(&hunter.pubkey(), &me, &clmm.pool, &lp.nft, clmm.accounts(&lp), &hunter.pubkey(), &[]);
        let liquidity = liquidity_of(&env, &clmm, &lp);
        // The pool sits near $150, so an oracle 3% above or below it is outside a 1% tolerance and inside 5%
        for oracle in [150 * USDC * 103 / 100, 150 * USDC * 97 / 100] {
            env.set_price(&sol, oracle);
            expect_err(hunt(&mut env, &hunter, compound.clone()), PluribusError::PoolPriceOff);
        }
        assert_eq!(liquidity_of(&env, &clmm, &lp), liquidity);
        expect_ok(env.send(&[env.set_compound_ix(&me, &lp.nft, 500)], &[&user]));
        expect_ok(hunt(&mut env, &hunter, compound));
        assert_books_match_vaults(&env);
    }
}

#[test]
fn raydium_compounding_is_the_owners_choice_and_autopay_steps_aside_for_it() {
    for (mut env, clmm) in chains() {
        let (user, hunter, lp) = compounding(&mut env, &clmm, 0);
        let me = user.pubkey();
        let compound = env.compound_raydium_ix(&hunter.pubkey(), &me, &clmm.pool, &lp.nft, clmm.accounts(&lp), &hunter.pubkey(), &[]);
        expect_err(hunt(&mut env, &hunter, compound.clone()), PluribusError::CompoundOff);

        // Capped, and set only through the owner's own account
        expect_err(env.send(&[env.set_compound_ix(&me, &lp.nft, MAX_COMPOUND_SLIPPAGE_BPS + 1)], &[&user]), PluribusError::InvalidParams);
        assert!(env.send(&[env.set_compound_ix(&hunter.pubkey(), &lp.nft, 100)], &[&hunter]).is_err());
        expect_ok(env.send(&[env.set_compound_ix(&me, &lp.nft, 100)], &[&user]));
        let autopay = env.autopay_raydium_ix(&hunter.pubkey(), &me, &clmm.pool, &lp.nft, clmm.accounts(&lp), &[]);
        expect_err(env.send(&[autopay.clone()], &[&hunter]), PluribusError::CompoundOn);

        // Off again, and autopay takes the fees as before
        expect_ok(env.send(&[env.set_compound_ix(&me, &lp.nft, 0)], &[&user]));
        expect_ok(env.send(&[autopay], &[&hunter]));
        expect_err(hunt(&mut env, &hunter, compound), PluribusError::CompoundOff);
        assert_books_match_vaults(&env);
    }
}

#[test]
fn compound_raydium_pays_its_bounty_only_into_accounts_that_are_not_the_programs_vaults() {
    for (mut env, clmm) in chains() {
        let (user, hunter, lp) = compounding(&mut env, &clmm, 100);
        let (me, sol, usdc) = (user.pubkey(), env.sol, env.usdc);
        let (mine_sol, mine_usdc) = (ata(&hunter.pubkey(), &sol, &TOKEN), ata(&hunter.pubkey(), &usdc, &TOKEN));
        let (base_vault, usdc_vault) = (env.vault_pda(&sol), env.vault_pda(&usdc));
        let ix = env.compound_raydium_ix(&hunter.pubkey(), &me, &clmm.pool, &lp.nft, clmm.accounts(&lp), &hunter.pubkey(), &[]);

        // The protocol's own vaults as the recipients would only move its money around, and Anchor refuses a writable account
        // that comes twice before the program's own check of it is reached
        let duplicate: u32 = anchor_lang::error::ErrorCode::ConstraintDuplicateMutableAccount.into();
        let mut to_base_vault = ix.clone();
        swap_account(&mut to_base_vault, &mine_sol, base_vault);
        assert!(failed_with_code(&hunt(&mut env, &hunter, to_base_vault), duplicate));
        let mut to_usdc_vault = ix.clone();
        swap_account(&mut to_usdc_vault, &mine_usdc, usdc_vault);
        assert!(failed_with_code(&hunt(&mut env, &hunter, to_usdc_vault), duplicate));
        // Each recipient must hold its own token
        let mint: u32 = anchor_lang::error::ErrorCode::ConstraintTokenMint.into();
        let mut crossed = ix.clone();
        swap_account(&mut crossed, &mine_sol, Pubkey::default());
        swap_account(&mut crossed, &mine_usdc, mine_sol);
        swap_account(&mut crossed, &Pubkey::default(), mine_usdc);
        assert!(failed_with_code(&hunt(&mut env, &hunter, crossed), mint));
        // A pool vault that is not the pool's own is Raydium's to refuse
        let elsewhere = env.fund(&sol, &Pubkey::new_unique(), 0);
        let mut wrong_vault = ix.clone();
        swap_account(&mut wrong_vault, &clmm.vault_0, elsewhere);
        assert!(hunt(&mut env, &hunter, wrong_vault).is_err());
        // A position the account does not hold
        let stranger = env.user();
        let steal = env.compound_raydium_ix(&hunter.pubkey(), &stranger.pubkey(), &clmm.pool, &lp.nft, clmm.accounts(&lp), &hunter.pubkey(), &[]);
        expect_err(hunt(&mut env, &hunter, steal), PluribusError::PositionNotFound);

        assert_eq!(env.balance(&sol, &hunter.pubkey()) + env.balance(&usdc, &hunter.pubkey()), 0);
        // And the untouched instruction still works
        expect_ok(hunt(&mut env, &hunter, ix));
        assert_books_match_vaults(&env);
    }
}

#[test]
fn compound_raydium_with_no_fees_changes_nothing() {
    for (mut env, clmm) in chains() {
        let user = env.user();
        let me = user.pubkey();
        // No trades, so the position has earned nothing
        let lp = clmm.open(&mut env, &user, 120.0, 180.0, 1_000);
        expect_ok(env.send(&[env.deposit_lp_ix(&me, &clmm.pool, &lp.nft)], &[&user]));
        let hunter = set_up_compounding(&mut env, &user, &lp.nft, 100);
        let (held, liquidity) = (clmm.held(&env), liquidity_of(&env, &clmm, &lp));

        let compound = env.compound_raydium_ix(&hunter.pubkey(), &me, &clmm.pool, &lp.nft, clmm.accounts(&lp), &hunter.pubkey(), &[]);
        expect_ok(hunt(&mut env, &hunter, compound));
        assert_eq!((clmm.held(&env), liquidity_of(&env, &clmm, &lp)), (held, liquidity));
        assert_eq!(env.balance(&env.sol, &hunter.pubkey()) + env.balance(&env.usdc, &hunter.pubkey()), 0);
        assert!(env.credit(&me).positions.iter().all(|p| p.kind != KIND_TOKEN));
        assert_books_match_vaults(&env);
    }
}

#[test]
fn compound_raydium_pays_a_pools_rewards_only_to_the_accounts_owner() {
    for (mut env, clmm) in chains() {
        let (user, hunter, lp) = compounding(&mut env, &clmm, 100);
        let me = user.pubkey();
        // The pool runs a reward, which Raydium wants three accounts for: its vault, a recipient and its mint
        let reward = env.new_mint(6, &TOKEN);
        let vault = env.fund(&reward, &Pubkey::new_unique(), 0);
        let mut pool = env.svm.get_account(&clmm.pool).unwrap();
        pool.data[REWARD_INFOS + REWARD_MINT..REWARD_INFOS + REWARD_MINT + 32].copy_from_slice(reward.as_ref());
        pool.data[REWARD_INFOS + REWARD_VAULT..REWARD_INFOS + REWARD_VAULT + 32].copy_from_slice(vault.as_ref());
        env.svm.set_account(clmm.pool, pool).unwrap();
        let group = |recipient: Pubkey| [AccountMeta::new(vault, false), AccountMeta::new(recipient, false), AccountMeta::new_readonly(reward, false)];
        let compound = |env: &Env, extra: &[AccountMeta]| env.compound_raydium_ix(&hunter.pubkey(), &me, &clmm.pool, &lp.nft, clmm.accounts(&lp), &hunter.pubkey(), extra);

        // A reward paid to the hunter, or to any account but the owner's, would be the owner's money skimmed
        let hunters = env.fund(&reward, &hunter.pubkey(), 0);
        let skim = compound(&env, &group(hunters));
        expect_err(hunt(&mut env, &hunter, skim), PluribusError::AccountMismatch);

        // The owner's account takes it, and the bitmap extension among the accounts is not mistaken for a reward group
        let owners = env.fund(&reward, &me, 0);
        let extension = AccountMeta::new(clmm.bitmap_extension(), false);
        let extra = [&[extension][..], &group(owners)].concat();
        let paid = compound(&env, &extra);
        expect_ok(hunt(&mut env, &hunter, paid));
        assert!(env.balance(&env.sol, &hunter.pubkey()) > 0);
        assert_books_match_vaults(&env);
    }
}
