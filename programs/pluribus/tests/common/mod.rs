#![allow(dead_code, unused_imports)]

use {
    anchor_lang::{
        prelude::*,
        solana_program::{instruction::Instruction, program_option::COption, program_pack::Pack, system_program},
        AccountDeserialize, AnchorSerialize, Discriminator, InstructionData, ToAccountMetas,
    },
    anchor_spl::{
        associated_token::{get_associated_token_address_with_program_id, ID as ATA_PROGRAM},
        token::spl_token::state::{Account as TokenState, AccountState, Mint as MintState},
    },
    litesvm::{
        types::{FailedTransactionMetadata, TransactionMetadata},
        LiteSVM,
    },
    pluribus::{constants::*, error::PluribusError, instructions::HealthView, math, state::*},
    solana_account::Account,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
};

pub use anchor_spl::{token::ID as TOKEN, token_2022::ID as TOKEN_2022};

pub type TxResult = std::result::Result<TransactionMetadata, FailedTransactionMetadata>;

pub const USDC: u64 = 1_000_000;
pub const SOL: u64 = 1_000_000_000;
pub const STOCK: u64 = 1_000_000;
pub const DAY: i64 = 86_400;
pub const GROUP_SOL: u8 = 0;
pub const GROUP_STOCK: u8 = 1;
pub const SOL_FEED: [u8; 32] = [7; 32];
pub const STOCK_FEED: [u8; 32] = [9; 32];

pub fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &pluribus::ID).0
}

/// Where the upgradeable loader keeps the program's code and upgrade authority
pub fn program_data_address() -> Pubkey {
    Pubkey::find_program_address(&[pluribus::ID.as_ref()], &anchor_lang::solana_program::bpf_loader_upgradeable::ID).0
}

pub fn ata(owner: &Pubkey, mint: &Pubkey, program: &Pubkey) -> Pubkey {
    get_associated_token_address_with_program_id(owner, mint, program)
}

/// Where Orca keeps the position account for a position NFT
pub fn orca_position(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"position", mint.as_ref()], &WHIRLPOOL_PROGRAM_ID).0
}

pub fn tick(price: f64) -> i32 {
    ((price / 1000.0).ln() / 1.0001f64.ln()).round() as i32
}

/// Liquidity that makes a position over `lower..upper` worth `usd` dollars at `price`
pub fn liquidity_for(usd: u64, lower: f64, upper: f64, price: u64) -> u128 {
    let (a, b) = math::range_sqrt_prices(tick(lower), tick(upper)).unwrap();
    let probe = 1_000_000_000_000u128;
    let v = math::lp_value(probe, a, b, price as u128 * PRICE_ONE, 9).unwrap();
    probe * (usd as u128 * PRICE_ONE) / v
}

pub fn default_params() -> PoolParams {
    let mut init = [0u16; MAX_SCENARIOS * MAX_GROUPS];
    let mut maint = [0u16; MAX_SCENARIOS * MAX_GROUPS];
    // Scenarios are crypto crash, equity crash and broad selloff, columns are the SOL group and the stock group
    for (s, (i, m)) in [([3000, 1500], [2000, 1000]), ([1500, 3500], [1000, 2500]), ([2500, 2500], [1700, 1700])].iter().enumerate() {
        init[s * MAX_GROUPS..s * MAX_GROUPS + 2].copy_from_slice(i);
        maint[s * MAX_GROUPS..s * MAX_GROUPS + 2].copy_from_slice(m);
    }
    PoolParams {
        num_scenarios: 3,
        init_shock_bps: init,
        maint_shock_bps: maint,
        liq_bonus_bps: 500,
        close_factor_bps: 5000,
        warn_health_bps: 11_000,
        base_rate_bps: 200,
        slope1_bps: 800,
        slope2_bps: 6000,
        kink_bps: 9000,
        reserve_factor_bps: 1000,
        protocol_fee_bps: 1000,
        // Interest reaches lenders as it accrues unless a test opts into weekly epochs
        yield_margin_bps: 0,
        epoch_secs: 0,
        tier_discount_bps: [0, 40, 80],
        tier_min_healthy_secs: [0, 7 * DAY, 30 * DAY],
        junior_target_bps: 1000,
        junior_premium_bps: 1500,
        // No waits by default so most tests can act at once, the junior and timelock tests set their own
        junior_min_delay_secs: 0,
        junior_max_delay_secs: 0,
        junior_delay_threshold_bps: 10_000,
        junior_exit_window_secs: 2 * DAY as u32,
        junior_exit_fee_bps: 0,
        junior_max_pause_secs: 90 * DAY as u32,
        junior_pause_gap_secs: 3 * DAY as u32,
        activation_delay_secs: 0,
        z_init_x100: 300,
        z_maint_x100: 233,
        vol_tau_fast_secs: 3_600,
        vol_tau_slow_secs: 7 * DAY as u32,
        vol_min_interval_secs: 60,
        vol_max_dt_secs: 3_600,
        vol_max_age_secs: 60,
        vol_conf_cap_bps: 200,
        max_shock_bps: 9_500,
    }
}

/// Realistic waits: six-day junior exits with a two-day claim window, an eight-day activation delay, pauses two weeks apart
pub fn timed_params() -> PoolParams {
    PoolParams {
        junior_min_delay_secs: 6 * DAY as u32,
        junior_max_delay_secs: 6 * DAY as u32,
        junior_pause_gap_secs: 14 * DAY as u32,
        junior_exit_fee_bps: 5,
        activation_delay_secs: 8 * DAY as u32,
        ..default_params()
    }
}

pub fn asset_params(group: u8, oracle: u8, feed: [u8; 32], liq_cost_bps: u16) -> AssetParams {
    // No dynamic shock unless a test asks for one, so the tables alone decide
    AssetParams {
        group,
        oracle,
        pyth_feed_id: feed,
        liq_cost_bps,
        max_price_age_secs: 60,
        max_conf_bps: 200,
        deposit_cap: 0,
        paused: false,
        vol_horizon_secs: 0,
    }
}

pub struct Env {
    pub svm: LiteSVM,
    pub admin: Keypair,
    pub usdc: Pubkey,
    pub sol: Pubkey,
    pub stock: Pubkey,
    pub whirlpool: Pubkey,
    pub pool: Pubkey,
    pub usdc_vault: Pubkey,
    pub share_mint: Pubkey,
}

impl Env {
    /// Program deployed and pool initialized in demo mode
    /// SOL, stock, USDC and one Whirlpool are whitelisted, with SOL at $150 and the stock at $200
    pub fn new() -> Self {
        Self::with(default_params(), true)
    }

    pub fn with(params: PoolParams, demo_mode: bool) -> Self {
        Self::on(LiteSVM::new(), params, demo_mode, None)
    }

    /// The same setup on `timed_params`, with the clock moved past the listings' activation delay
    pub fn timed() -> Self {
        let mut env = Self::with(timed_params(), true);
        env.warp(timed_params().activation_delay_secs as i64);
        let (sol, stock) = (env.sol, env.stock);
        env.set_price(&sol, 150 * USDC);
        env.set_price(&stock, 200 * USDC);
        env
    }

    /// Same setup on a chain that may already hold a real Orca pool
    /// `real` names that pool's USDC mint, SOL mint and Whirlpool so they are used instead of stand-ins
    pub fn on(mut svm: LiteSVM, params: PoolParams, demo_mode: bool, real: Option<(Pubkey, Pubkey, Pubkey)>) -> Self {
        svm.add_program(pluribus::ID, include_bytes!(concat!(env!("CARGO_TARGET_TMPDIR"), "/../deploy/pluribus.so"))).unwrap();
        let mut clock: Clock = svm.get_sysvar();
        clock.unix_timestamp = 1_800_000_000;
        svm.set_sysvar(&clock);

        let admin = Keypair::new();
        svm.airdrop(&admin.pubkey(), 1000 * SOL).unwrap();
        // The loader records no upgrade authority for a test program, so name the admin as a real deploy would
        let mut program_data = svm.get_account(&program_data_address()).unwrap();
        program_data.data[12] = 1;
        program_data.data[13..45].copy_from_slice(admin.pubkey().as_ref());
        svm.set_account(program_data_address(), program_data).unwrap();
        let mut env = Env {
            svm,
            admin,
            usdc: Pubkey::default(),
            sol: Pubkey::default(),
            stock: Pubkey::default(),
            whirlpool: Pubkey::new_unique(),
            pool: pda(&[POOL_SEED]),
            usdc_vault: pda(&[USDC_VAULT_SEED]),
            share_mint: pda(&[SHARE_MINT_SEED]),
        };
        match real {
            Some((usdc, sol, whirlpool)) => (env.usdc, env.sol, env.whirlpool) = (usdc, sol, whirlpool),
            None => {
                env.usdc = env.new_mint(6, &TOKEN);
                env.sol = env.new_mint(9, &TOKEN);
                let (whirlpool, sol, usdc) = (env.whirlpool, env.sol, env.usdc);
                env.set_whirlpool(&whirlpool, &sol, &usdc);
            }
        }
        env.stock = env.new_mint(6, &TOKEN);

        let admin = env.admin.insecure_clone();
        let init = Instruction::new_with_bytes(
            pluribus::ID,
            &pluribus::instruction::Initialize { params, demo_mode }.data(),
            pluribus::accounts::Initialize {
                admin: admin.pubkey(),
                program_data: program_data_address(),
                pool: env.pool,
                usdc_mint: env.usdc,
                usdc_vault: env.usdc_vault,
                share_mint: env.share_mint,
                token_program: TOKEN,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        );
        env.send(&[init], &[&admin]).expect("initialize");
        let (usdc, sol, stock) = (env.usdc, env.sol, env.stock);
        env.send(&[env.init_asset_ix(&usdc, asset_params(u8::MAX, ORACLE_FIXED, [0; 32], 0))], &[&admin]).expect("usdc asset");
        env.send(&[env.init_asset_ix(&sol, asset_params(GROUP_SOL, ORACLE_PYTH, SOL_FEED, 500))], &[&admin]).expect("sol asset");
        env.send(&[env.init_asset_ix(&stock, asset_params(GROUP_STOCK, ORACLE_PYTH, STOCK_FEED, 1000))], &[&admin]).expect("stock asset");
        let whirlpool = env.whirlpool;
        env.send(&[env.init_lp_market_ix(&whirlpool, &sol, 500)], &[&admin]).expect("lp market");
        if demo_mode {
            env.set_price(&sol, 150 * USDC);
            env.set_price(&stock, 200 * USDC);
        }
        env
    }

    // Chain plumbing

    pub fn send(&mut self, ixs: &[Instruction], signers: &[&Keypair]) -> TxResult {
        // A fresh blockhash each time so identical instructions are not rejected as duplicates
        self.svm.expire_blockhash();
        let msg = Message::new_with_blockhash(ixs, Some(&signers[0].pubkey()), &self.svm.latest_blockhash());
        self.svm.send_transaction(VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap())
    }

    pub fn now(&self) -> i64 {
        self.svm.get_sysvar::<Clock>().unix_timestamp
    }

    pub fn warp(&mut self, secs: i64) {
        let mut clock: Clock = self.svm.get_sysvar();
        clock.unix_timestamp += secs;
        self.svm.set_sysvar(&clock);
    }

    pub fn set_raw(&mut self, address: Pubkey, owner: Pubkey, data: Vec<u8>) {
        let lamports = self.svm.minimum_balance_for_rent_exemption(data.len());
        self.svm.set_account(address, Account { lamports, data, owner, executable: false, rent_epoch: 0 }).unwrap();
    }

    pub fn load<T: AccountDeserialize>(&self, address: &Pubkey) -> T {
        let account = self.svm.get_account(address).expect("account exists");
        T::try_deserialize(&mut &account.data[..]).unwrap()
    }

    // Tokens

    pub fn new_mint(&mut self, decimals: u8, program: &Pubkey) -> Pubkey {
        let mint = Pubkey::new_unique();
        let state = MintState { mint_authority: COption::None, supply: u64::MAX / 2, decimals, is_initialized: true, freeze_authority: COption::None };
        let mut data = vec![0; MintState::LEN];
        MintState::pack(state, &mut data).unwrap();
        self.set_raw(mint, *program, data);
        mint
    }

    /// Sets `owner`'s associated token account for `mint` to hold exactly `amount`
    pub fn fund(&mut self, mint: &Pubkey, owner: &Pubkey, amount: u64) -> Pubkey {
        let program = self.svm.get_account(mint).unwrap().owner;
        let state = TokenState {
            mint: *mint,
            owner: *owner,
            amount,
            delegate: COption::None,
            state: AccountState::Initialized,
            is_native: COption::None,
            delegated_amount: 0,
            close_authority: COption::None,
        };
        let mut data = vec![0; TokenState::LEN];
        TokenState::pack(state, &mut data).unwrap();
        let address = ata(owner, mint, &program);
        self.set_raw(address, program, data);
        address
    }

    pub fn balance(&self, mint: &Pubkey, owner: &Pubkey) -> u64 {
        let program = self.svm.get_account(mint).unwrap().owner;
        self.token_amount(&ata(owner, mint, &program))
    }

    pub fn token_amount(&self, token_account: &Pubkey) -> u64 {
        self.svm.get_account(token_account).map_or(0, |a| TokenState::unpack(&a.data[..TokenState::LEN]).map_or(0, |t| t.amount))
    }

    /// A funded wallet with an open credit account
    pub fn user(&mut self) -> Keypair {
        let user = Keypair::new();
        self.svm.airdrop(&user.pubkey(), 100 * SOL).unwrap();
        let ix = Instruction::new_with_bytes(
            pluribus::ID,
            &pluribus::instruction::OpenAccount {}.data(),
            pluribus::accounts::OpenAccount { owner: user.pubkey(), credit: self.credit_pda(&user.pubkey()), system_program: system_program::ID }
                .to_account_metas(None),
        );
        self.send(&[ix], &[&user]).expect("open account");
        user
    }

    /// A wallet with no credit account, for lenders and liquidators
    pub fn wallet(&mut self) -> Keypair {
        let wallet = Keypair::new();
        self.svm.airdrop(&wallet.pubkey(), 100 * SOL).unwrap();
        wallet
    }

    // Oracle and Orca stand-ins

    pub fn set_price(&mut self, mint: &Pubkey, price: u64) {
        self.set_price_conf(mint, price, 0).expect("set price");
    }

    pub fn set_price_conf(&mut self, mint: &Pubkey, price: u64, conf: u64) -> TxResult {
        let admin = self.admin.insecure_clone();
        self.send(&[self.set_demo_price_ix(&admin.pubkey(), mint, price, conf)], &[&admin])
    }

    pub fn set_demo_price_ix(&self, admin: &Pubkey, mint: &Pubkey, price: u64, conf: u64) -> Instruction {
        Instruction::new_with_bytes(
            pluribus::ID,
            &pluribus::instruction::SetDemoPrice { price, conf }.data(),
            pluribus::accounts::SetDemoPrice {
                admin: *admin,
                pool: self.pool,
                asset: self.asset_pda(mint),
                demo_price: pda(&[DEMO_PRICE_SEED, mint.as_ref()]),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        )
    }

    /// Writes a Pyth receiver PriceUpdateV2 account, fully verified, as the pull oracle would
    pub fn set_pyth(&mut self, address: Pubkey, feed: [u8; 32], price: i64, conf: u64, expo: i32, publish_time: i64) {
        let data = pyth_bytes(1, feed, price, conf, expo, publish_time);
        self.set_raw(address, PYTH_RECEIVER_ID, data);
    }

    pub fn set_whirlpool(&mut self, address: &Pubkey, mint_a: &Pubkey, mint_b: &Pubkey) {
        let mut data = vec![0u8; 653];
        data[..8].copy_from_slice(&[0x3f, 0x95, 0xd1, 0x0c, 0xe1, 0x80, 0x63, 0x09]);
        data[101..133].copy_from_slice(mint_a.as_ref());
        data[181..213].copy_from_slice(mint_b.as_ref());
        self.set_raw(*address, WHIRLPOOL_PROGRAM_ID, data);
    }

    /// An Orca position in `whirlpool` over a price range, with its NFT in `owner`'s wallet, returning the NFT mint
    pub fn lp(&mut self, owner: &Pubkey, whirlpool: &Pubkey, lower: f64, upper: f64, liquidity: u128, nft_program: &Pubkey) -> Pubkey {
        let mint = self.new_mint(0, nft_program);
        self.fund(&mint, owner, 1);
        let data = position_bytes(whirlpool, &mint, liquidity, tick(lower), tick(upper));
        self.set_raw(orca_position(&mint), WHIRLPOOL_PROGRAM_ID, data);
        mint
    }

    // Addresses

    pub fn credit_pda(&self, owner: &Pubkey) -> Pubkey {
        pda(&[CREDIT_SEED, owner.as_ref()])
    }

    pub fn asset_pda(&self, mint: &Pubkey) -> Pubkey {
        pda(&[ASSET_SEED, mint.as_ref()])
    }

    pub fn vault_pda(&self, mint: &Pubkey) -> Pubkey {
        pda(&[VAULT_SEED, mint.as_ref()])
    }

    pub fn lp_market_pda(&self, whirlpool: &Pubkey) -> Pubkey {
        pda(&[LP_MARKET_SEED, whirlpool.as_ref()])
    }

    pub fn price_account(&self, mint: &Pubkey) -> Pubkey {
        pda(&[DEMO_PRICE_SEED, mint.as_ref()])
    }

    pub fn credit(&self, owner: &Pubkey) -> CreditAccount {
        self.load(&self.credit_pda(owner))
    }

    pub fn pool_state(&self) -> Pool {
        self.load(&self.pool)
    }

    pub fn debt(&self, owner: &Pubkey) -> u64 {
        self.pool_state().debt_of(&self.credit(owner)).unwrap() as u64
    }

    /// The accounts a health check reads, in the order the program expects
    pub fn health_metas(&self, owner: &Pubkey) -> Vec<AccountMeta> {
        let mut keys = vec![];
        for p in self.credit(owner).positions.iter() {
            match p.kind {
                KIND_TOKEN => {
                    keys.push(self.asset_pda(&p.mint));
                    if p.mint != self.usdc {
                        keys.push(self.price_account(&p.mint));
                    }
                }
                KIND_LP => {
                    let position = orca_position(&p.mint);
                    let data = self.svm.get_account(&position).unwrap().data;
                    let whirlpool = Pubkey::new_from_array(data[8..40].try_into().unwrap());
                    let market: LpMarket = self.load(&self.lp_market_pda(&whirlpool));
                    keys.extend([self.lp_market_pda(&whirlpool), position, self.asset_pda(&market.base_mint), self.price_account(&market.base_mint)]);
                }
                _ => {}
            }
        }
        keys.into_iter().map(|k| AccountMeta::new_readonly(k, false)).collect()
    }

    fn ix(&self, data: Vec<u8>, mut metas: Vec<AccountMeta>, health_of: Option<&Pubkey>) -> Instruction {
        if let Some(owner) = health_of {
            metas.extend(self.health_metas(owner));
        }
        Instruction::new_with_bytes(pluribus::ID, &data, metas)
    }

    // Instructions

    pub fn init_asset_ix(&self, mint: &Pubkey, params: AssetParams) -> Instruction {
        self.init_asset_seeded_ix(mint, params, 0)
    }

    /// Lists an asset whose dynamic shock starts from `sigma_seed_bps` of annual volatility
    pub fn init_asset_seeded_ix(&self, mint: &Pubkey, params: AssetParams, sigma_seed_bps: u32) -> Instruction {
        self.ix(
            pluribus::instruction::InitAsset { params, sigma_seed_bps }.data(),
            pluribus::accounts::InitAsset {
                admin: self.admin.pubkey(),
                pool: self.pool,
                mint: *mint,
                asset: self.asset_pda(mint),
                vault: self.vault_pda(mint),
                token_program: TOKEN,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            None,
        )
    }

    pub fn update_vol_ix(&self, mint: &Pubkey) -> Instruction {
        self.ix(
            pluribus::instruction::UpdateVol {}.data(),
            pluribus::accounts::UpdateVol { pool: self.pool, asset: self.asset_pda(mint), price: self.price_account(mint) }.to_account_metas(None),
            None,
        )
    }

    pub fn set_asset_ix(&self, admin: &Pubkey, mint: &Pubkey, params: AssetParams) -> Instruction {
        self.ix(
            pluribus::instruction::SetAsset { params }.data(),
            pluribus::accounts::SetAsset { admin: *admin, pool: self.pool, asset: self.asset_pda(mint) }.to_account_metas(None),
            None,
        )
    }

    pub fn set_params_ix(&self, admin: &Pubkey, params: PoolParams) -> Instruction {
        self.ix(
            pluribus::instruction::SetParams { params }.data(),
            pluribus::accounts::AdminPool { admin: *admin, pool: self.pool }.to_account_metas(None),
            None,
        )
    }

    pub fn set_flags_ix(&self, admin: &Pubkey, paused: bool, demo_mode: bool) -> Instruction {
        self.ix(
            pluribus::instruction::SetFlags { paused, demo_mode }.data(),
            pluribus::accounts::AdminPool { admin: *admin, pool: self.pool }.to_account_metas(None),
            None,
        )
    }

    pub fn init_lp_market_ix(&self, whirlpool: &Pubkey, base_mint: &Pubkey, liq_cost_bps: u16) -> Instruction {
        self.ix(
            pluribus::instruction::InitLpMarket { liq_cost_bps }.data(),
            pluribus::accounts::InitLpMarket {
                admin: self.admin.pubkey(),
                pool: self.pool,
                whirlpool: *whirlpool,
                base_asset: self.asset_pda(base_mint),
                lp_market: self.lp_market_pda(whirlpool),
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            None,
        )
    }

    pub fn set_lp_market_ix(&self, whirlpool: &Pubkey, liq_cost_bps: u16, paused: bool) -> Instruction {
        self.ix(
            pluribus::instruction::SetLpMarket { liq_cost_bps, paused }.data(),
            pluribus::accounts::SetLpMarket { admin: self.admin.pubkey(), pool: self.pool, lp_market: self.lp_market_pda(whirlpool) }
                .to_account_metas(None),
            None,
        )
    }

    fn lend_metas(&self, lender: &Pubkey) -> Vec<AccountMeta> {
        pluribus::accounts::Lend {
            lender: *lender,
            pool: self.pool,
            usdc_mint: self.usdc,
            usdc_vault: self.usdc_vault,
            share_mint: self.share_mint,
            lender_usdc: ata(lender, &self.usdc, &TOKEN),
            lender_shares: ata(lender, &self.share_mint, &TOKEN),
            token_program: TOKEN,
        }
        .to_account_metas(None)
    }

    pub fn collect_protocol_fees_ix(&self, admin: &Pubkey, amount: u64) -> Instruction {
        self.ix(
            pluribus::instruction::CollectProtocolFees { amount }.data(),
            pluribus::accounts::CollectProtocolFees {
                admin: *admin,
                pool: self.pool,
                usdc_mint: self.usdc,
                usdc_vault: self.usdc_vault,
                treasury_usdc: ata(admin, &self.usdc, &TOKEN),
                token_program: TOKEN,
            }
            .to_account_metas(None),
            None,
        )
    }

    pub fn lend_deposit_ix(&self, lender: &Pubkey, amount: u64) -> Instruction {
        self.ix(pluribus::instruction::LendDeposit { amount }.data(), self.lend_metas(lender), None)
    }

    pub fn junior_mint(&self) -> Pubkey {
        pda(&[JUNIOR_MINT_SEED])
    }

    pub fn junior_escrow(&self) -> Pubkey {
        pda(&[JUNIOR_ESCROW_SEED])
    }

    pub fn junior_exit_pda(&self, owner: &Pubkey) -> Pubkey {
        pda(&[JUNIOR_EXIT_SEED, owner.as_ref()])
    }

    pub fn init_junior_ix(&self, admin: &Pubkey) -> Instruction {
        self.ix(
            pluribus::instruction::InitJunior {}.data(),
            pluribus::accounts::InitJunior {
                admin: *admin,
                pool: self.pool,
                junior_mint: self.junior_mint(),
                junior_escrow: self.junior_escrow(),
                token_program: TOKEN,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            None,
        )
    }

    /// Lend into or redeem from the tranche that `share_mint` stands for
    pub fn tranche_ix(&self, lender: &Pubkey, share_mint: &Pubkey, amount: u64, deposit: bool) -> Instruction {
        let mut metas = self.lend_metas(lender);
        // Slots 4 and 6 hold the share mint and the lender's share account
        metas[4].pubkey = *share_mint;
        metas[6].pubkey = ata(lender, share_mint, &TOKEN);
        let data = if deposit {
            pluribus::instruction::LendDeposit { amount }.data()
        } else {
            pluribus::instruction::LendWithdraw { shares: amount }.data()
        };
        self.ix(data, metas, None)
    }

    pub fn lend_withdraw_ix(&self, lender: &Pubkey, shares: u64) -> Instruction {
        self.ix(pluribus::instruction::LendWithdraw { shares }.data(), self.lend_metas(lender), None)
    }

    /// Redeems shares for USDC: senior shares directly, junior shares by queueing and claiming in one go
    /// The junior path only lands in one transaction while the exit delay is zero
    pub fn redeem_ixs(&self, lender: &Pubkey, share_mint: &Pubkey, shares: u64) -> Vec<Instruction> {
        if *share_mint == self.junior_mint() {
            vec![self.request_exit_ix(lender, shares), self.claim_exit_ix(lender, &self.usdc.clone())]
        } else {
            vec![self.tranche_ix(lender, share_mint, shares, false)]
        }
    }

    pub fn convert_ix(&self, lender: &Pubkey, shares: u64) -> Instruction {
        self.ix(
            pluribus::instruction::ConvertToJunior { shares }.data(),
            pluribus::accounts::ConvertToJunior {
                lender: *lender,
                pool: self.pool,
                share_mint: self.share_mint,
                junior_mint: self.junior_mint(),
                lender_shares: ata(lender, &self.share_mint, &TOKEN),
                lender_junior: ata(lender, &self.junior_mint(), &TOKEN),
                token_program: TOKEN,
            }
            .to_account_metas(None),
            None,
        )
    }

    pub fn request_exit_ix(&self, owner: &Pubkey, shares: u64) -> Instruction {
        self.ix(
            pluribus::instruction::RequestJuniorExit { shares }.data(),
            pluribus::accounts::RequestJuniorExit {
                owner: *owner,
                pool: self.pool,
                junior_mint: self.junior_mint(),
                owner_junior: ata(owner, &self.junior_mint(), &TOKEN),
                junior_escrow: self.junior_escrow(),
                exit: self.junior_exit_pda(owner),
                token_program: TOKEN,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            None,
        )
    }

    /// `payout_mint` is USDC to be paid in cash, or the senior share mint to be paid in senior shares
    pub fn claim_exit_ix(&self, owner: &Pubkey, payout_mint: &Pubkey) -> Instruction {
        self.ix(
            pluribus::instruction::ClaimJuniorExit {}.data(),
            pluribus::accounts::ClaimJuniorExit {
                owner: *owner,
                pool: self.pool,
                exit: self.junior_exit_pda(owner),
                junior_mint: self.junior_mint(),
                junior_escrow: self.junior_escrow(),
                share_mint: self.share_mint,
                usdc_mint: self.usdc,
                usdc_vault: self.usdc_vault,
                payout: ata(owner, payout_mint, &TOKEN),
                token_program: TOKEN,
            }
            .to_account_metas(None),
            None,
        )
    }

    pub fn cancel_exit_ix(&self, caller: &Pubkey, owner: &Pubkey) -> Instruction {
        self.ix(
            pluribus::instruction::CancelJuniorExit {}.data(),
            pluribus::accounts::CancelJuniorExit {
                caller: *caller,
                pool: self.pool,
                owner: *owner,
                exit: self.junior_exit_pda(owner),
                junior_mint: self.junior_mint(),
                junior_escrow: self.junior_escrow(),
                owner_junior: ata(owner, &self.junior_mint(), &TOKEN),
                token_program: TOKEN,
            }
            .to_account_metas(None),
            None,
        )
    }

    pub fn pause_exits_ix(&self, admin: &Pubkey, duration_secs: u32) -> Instruction {
        self.ix(
            pluribus::instruction::PauseJuniorExits { duration_secs }.data(),
            pluribus::accounts::AdminPool { admin: *admin, pool: self.pool }.to_account_metas(None),
            None,
        )
    }

    pub fn unpause_exits_ix(&self, admin: &Pubkey) -> Instruction {
        self.ix(
            pluribus::instruction::UnpauseJuniorExits {}.data(),
            pluribus::accounts::AdminPool { admin: *admin, pool: self.pool }.to_account_metas(None),
            None,
        )
    }

    pub fn set_guardian_ix(&self, admin: &Pubkey, guardian: Pubkey) -> Instruction {
        self.ix(
            pluribus::instruction::SetGuardian { guardian }.data(),
            pluribus::accounts::AdminPool { admin: *admin, pool: self.pool }.to_account_metas(None),
            None,
        )
    }

    pub fn apply_params_ix(&self) -> Instruction {
        self.ix(pluribus::instruction::ApplyParams {}.data(), pluribus::accounts::ApplyParams { pool: self.pool }.to_account_metas(None), None)
    }

    pub fn apply_asset_ix(&self, mint: &Pubkey) -> Instruction {
        self.ix(
            pluribus::instruction::ApplyAsset {}.data(),
            pluribus::accounts::ApplyAsset { pool: self.pool, asset: self.asset_pda(mint) }.to_account_metas(None),
            None,
        )
    }

    pub fn apply_lp_market_ix(&self, whirlpool: &Pubkey) -> Instruction {
        self.ix(
            pluribus::instruction::ApplyLpMarket {}.data(),
            pluribus::accounts::ApplyLpMarket { pool: self.pool, lp_market: self.lp_market_pda(whirlpool) }.to_account_metas(None),
            None,
        )
    }

    pub fn cancel_pending_params_ix(&self, guard: &Pubkey) -> Instruction {
        self.ix(
            pluribus::instruction::CancelPendingParams {}.data(),
            pluribus::accounts::Guard { guard: *guard, pool: self.pool }.to_account_metas(None),
            None,
        )
    }

    pub fn guard_asset_ix(&self, guard: &Pubkey, mint: &Pubkey) -> Instruction {
        self.ix(
            pluribus::instruction::GuardAsset {}.data(),
            pluribus::accounts::GuardAsset { guard: *guard, pool: self.pool, asset: self.asset_pda(mint) }.to_account_metas(None),
            None,
        )
    }

    pub fn guard_lp_market_ix(&self, guard: &Pubkey, whirlpool: &Pubkey) -> Instruction {
        self.ix(
            pluribus::instruction::GuardLpMarket {}.data(),
            pluribus::accounts::GuardLpMarket { guard: *guard, pool: self.pool, lp_market: self.lp_market_pda(whirlpool) }.to_account_metas(None),
            None,
        )
    }

    fn move_token_metas(&self, owner: &Pubkey, mint: &Pubkey) -> Vec<AccountMeta> {
        pluribus::accounts::MoveToken {
            owner: *owner,
            credit: self.credit_pda(owner),
            pool: self.pool,
            asset: self.asset_pda(mint),
            mint: *mint,
            vault: self.vault_pda(mint),
            owner_token: ata(owner, mint, &TOKEN),
            token_program: TOKEN,
        }
        .to_account_metas(None)
    }

    pub fn deposit_token_ix(&self, owner: &Pubkey, mint: &Pubkey, amount: u64) -> Instruction {
        self.ix(pluribus::instruction::DepositToken { amount }.data(), self.move_token_metas(owner, mint), None)
    }

    /// Health accounts are listed for the positions as they will be once the withdrawal lands
    pub fn withdraw_token_ix(&self, owner: &Pubkey, mint: &Pubkey, amount: u64) -> Instruction {
        let mut metas = self.move_token_metas(owner, mint);
        let credit = self.credit(owner);
        let emptied = credit.positions.iter().any(|p| p.kind == KIND_TOKEN && p.mint == *mint && p.amount == amount);
        let skip = self.asset_pda(mint);
        let mut health = self.health_metas(owner);
        if emptied {
            // The slot will be empty by the time health is checked, so its accounts must not be listed
            let at = health.iter().position(|m| m.pubkey == skip).unwrap();
            health.drain(at..at + if *mint == self.usdc { 1 } else { 2 });
        }
        metas.extend(health);
        Instruction::new_with_bytes(pluribus::ID, &pluribus::instruction::WithdrawToken { amount }.data(), metas)
    }

    pub fn deposit_lp_ix(&self, owner: &Pubkey, whirlpool: &Pubkey, nft: &Pubkey) -> Instruction {
        let program = self.svm.get_account(nft).unwrap().owner;
        self.deposit_lp_from_ix(owner, whirlpool, nft, &ata(owner, nft, &program))
    }

    /// For an NFT held in a token account that is not the owner's associated one
    pub fn deposit_lp_from_ix(&self, owner: &Pubkey, whirlpool: &Pubkey, nft: &Pubkey, owner_nft: &Pubkey) -> Instruction {
        let program = self.svm.get_account(nft).unwrap().owner;
        // The market's base token, or SOL for a market that does not exist so the program can refuse it
        let base = self
            .svm
            .get_account(&self.lp_market_pda(whirlpool))
            .and_then(|a| LpMarket::try_deserialize(&mut &a.data[..]).ok())
            .map_or(self.sol, |m| m.base_mint);
        self.ix(
            pluribus::instruction::DepositLp {}.data(),
            pluribus::accounts::DepositLp {
                owner: *owner,
                credit: self.credit_pda(owner),
                pool: self.pool,
                lp_market: self.lp_market_pda(whirlpool),
                base_asset: self.asset_pda(&base),
                position: orca_position(nft),
                position_mint: *nft,
                owner_nft: *owner_nft,
                vault_nft: ata(&self.pool, nft, &program),
                token_program: program,
                associated_token_program: ATA_PROGRAM,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
            None,
        )
    }

    pub fn withdraw_lp_ix(&self, owner: &Pubkey, nft: &Pubkey) -> Instruction {
        let program = self.svm.get_account(nft).unwrap().owner;
        let mut metas = pluribus::accounts::WithdrawLp {
            owner: *owner,
            credit: self.credit_pda(owner),
            pool: self.pool,
            position_mint: *nft,
            vault_nft: ata(&self.pool, nft, &program),
            owner_nft: ata(owner, nft, &program),
            token_program: program,
        }
        .to_account_metas(None);
        let mut health = self.health_metas(owner);
        let at = health.iter().position(|m| m.pubkey == orca_position(nft)).unwrap() - 1;
        health.drain(at..at + 4);
        metas.extend(health);
        Instruction::new_with_bytes(pluribus::ID, &pluribus::instruction::WithdrawLp {}.data(), metas)
    }

    pub fn draw_ix(&self, owner: &Pubkey, amount: u64) -> Instruction {
        self.ix(
            pluribus::instruction::Draw { amount }.data(),
            pluribus::accounts::Draw {
                owner: *owner,
                credit: self.credit_pda(owner),
                pool: self.pool,
                usdc_mint: self.usdc,
                usdc_vault: self.usdc_vault,
                owner_usdc: ata(owner, &self.usdc, &TOKEN),
                token_program: TOKEN,
            }
            .to_account_metas(None),
            Some(owner),
        )
    }

    pub fn repay_ix(&self, payer: &Pubkey, owner: &Pubkey, amount: u64) -> Instruction {
        self.ix(
            pluribus::instruction::Repay { amount }.data(),
            pluribus::accounts::Repay {
                payer: *payer,
                credit: self.credit_pda(owner),
                pool: self.pool,
                usdc_mint: self.usdc,
                usdc_vault: self.usdc_vault,
                payer_usdc: ata(payer, &self.usdc, &TOKEN),
                token_program: TOKEN,
            }
            .to_account_metas(None),
            None,
        )
    }

    pub fn repay_from_collateral_ix(&self, caller: &Pubkey, owner: &Pubkey, amount: u64) -> Instruction {
        self.ix(
            pluribus::instruction::RepayFromCollateral { amount }.data(),
            pluribus::accounts::RepayFromCollateral {
                caller: *caller,
                credit: self.credit_pda(owner),
                pool: self.pool,
                usdc_mint: self.usdc,
                usdc_vault: self.usdc_vault,
                usdc_asset: self.asset_pda(&self.usdc),
                usdc_collateral_vault: self.vault_pda(&self.usdc),
                token_program: TOKEN,
            }
            .to_account_metas(None),
            Some(owner),
        )
    }

    pub fn liquidate_ix(&self, liquidator: &Pubkey, owner: &Pubkey, mint: &Pubkey, repay_amount: u64) -> Instruction {
        self.ix(
            pluribus::instruction::Liquidate { repay_amount }.data(),
            pluribus::accounts::Liquidate {
                liquidator: *liquidator,
                credit: self.credit_pda(owner),
                pool: self.pool,
                usdc_mint: self.usdc,
                usdc_vault: self.usdc_vault,
                liquidator_usdc: ata(liquidator, &self.usdc, &TOKEN),
                asset: self.asset_pda(mint),
                collateral_mint: *mint,
                vault: self.vault_pda(mint),
                liquidator_collateral: ata(liquidator, mint, &TOKEN),
                token_program: TOKEN,
            }
            .to_account_metas(None),
            Some(owner),
        )
    }

    pub fn liquidate_lp_ix(&self, liquidator: &Pubkey, owner: &Pubkey, nft: &Pubkey) -> Instruction {
        let program = self.svm.get_account(nft).unwrap().owner;
        self.ix(
            pluribus::instruction::LiquidateLp {}.data(),
            pluribus::accounts::LiquidateLp {
                liquidator: *liquidator,
                credit: self.credit_pda(owner),
                pool: self.pool,
                usdc_mint: self.usdc,
                usdc_vault: self.usdc_vault,
                liquidator_usdc: ata(liquidator, &self.usdc, &TOKEN),
                usdc_asset: self.asset_pda(&self.usdc),
                usdc_collateral_vault: self.vault_pda(&self.usdc),
                position_mint: *nft,
                vault_nft: ata(&self.pool, nft, &program),
                liquidator_nft: ata(liquidator, nft, &program),
                owner: *owner,
                token_program: TOKEN,
                nft_token_program: program,
            }
            .to_account_metas(None),
            Some(owner),
        )
    }

    pub fn refresh_tier_ix(&self, owner: &Pubkey) -> Instruction {
        self.ix(
            pluribus::instruction::RefreshTier {}.data(),
            pluribus::accounts::RefreshTier { credit: self.credit_pda(owner), pool: self.pool }.to_account_metas(None),
            Some(owner),
        )
    }

    /// `orca` lists the Whirlpool's accounts for this position: tick array lower, tick array upper, token vault A, token vault B
    pub fn autopay_ix(&self, caller: &Pubkey, owner: &Pubkey, whirlpool: &Pubkey, nft: &Pubkey, orca: [Pubkey; 4]) -> Instruction {
        let program = self.svm.get_account(nft).unwrap().owner;
        let market: LpMarket = self.load(&self.lp_market_pda(whirlpool));
        self.ix(
            pluribus::instruction::Autopay {}.data(),
            pluribus::accounts::Autopay {
                caller: *caller,
                credit: self.credit_pda(owner),
                pool: self.pool,
                lp_market: self.lp_market_pda(whirlpool),
                whirlpool: *whirlpool,
                position: orca_position(nft),
                position_mint: *nft,
                vault_nft: ata(&self.pool, nft, &program),
                tick_array_lower: orca[0],
                tick_array_upper: orca[1],
                base_asset: self.asset_pda(&market.base_mint),
                base_vault: self.vault_pda(&market.base_mint),
                whirlpool_vault_a: orca[2],
                usdc_asset: self.asset_pda(&self.usdc),
                usdc_collateral_vault: self.vault_pda(&self.usdc),
                whirlpool_vault_b: orca[3],
                usdc_mint: self.usdc,
                usdc_vault: self.usdc_vault,
                token_program: TOKEN,
                whirlpool_program: WHIRLPOOL_PROGRAM_ID,
            }
            .to_account_metas(None),
            None,
        )
    }

    pub fn accrue_ix(&self) -> Instruction {
        self.ix(pluribus::instruction::Accrue {}.data(), pluribus::accounts::Accrue { pool: self.pool }.to_account_metas(None), None)
    }

    /// The program's own view of an account, read by simulating the `health` instruction
    pub fn health(&mut self, owner: &Pubkey) -> HealthView {
        let ix = self.ix(
            pluribus::instruction::Health {}.data(),
            pluribus::accounts::ViewHealth { credit: self.credit_pda(owner), pool: self.pool }.to_account_metas(None),
            Some(owner),
        );
        let payer = self.admin.insecure_clone();
        self.svm.expire_blockhash();
        // The view values every position under both limits, which five LP positions push past the default budget
        // It only ever runs in simulation, where asking for more compute costs nothing
        let budget = Instruction::new_with_bytes(
            pubkey!("ComputeBudget111111111111111111111111111111"),
            &[&[2u8][..], &1_400_000u32.to_le_bytes()].concat(),
            vec![],
        );
        let msg = Message::new_with_blockhash(&[budget, ix], Some(&payer.pubkey()), &self.svm.latest_blockhash());
        let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&payer]).unwrap();
        let sim = self.svm.simulate_transaction(tx).expect("health view");
        HealthView::try_from_slice(&sim.meta.return_data.data).unwrap()
    }

    // Shortcuts used by most tests

    /// Funds the wallet and deposits a token as collateral
    pub fn deposit(&mut self, user: &Keypair, mint: &Pubkey, amount: u64) {
        self.fund(mint, &user.pubkey(), amount);
        self.send(&[self.deposit_token_ix(&user.pubkey(), mint, amount)], &[user]).expect("deposit");
    }

    pub fn deposit_lp(&mut self, user: &Keypair, lower: f64, upper: f64, liquidity: u128) -> Pubkey {
        let whirlpool = self.whirlpool;
        let nft = self.lp(&user.pubkey(), &whirlpool, lower, upper, liquidity, &TOKEN);
        self.send(&[self.deposit_lp_ix(&user.pubkey(), &whirlpool, &nft)], &[user]).expect("deposit lp");
        nft
    }

    pub fn draw(&mut self, user: &Keypair, amount: u64) -> TxResult {
        if self.svm.get_account(&ata(&user.pubkey(), &self.usdc, &TOKEN)).is_none() {
            let usdc = self.usdc;
            self.fund(&usdc, &user.pubkey(), 0);
        }
        self.send(&[self.draw_ix(&user.pubkey(), amount)], &[user])
    }

    /// A lender who has supplied `amount` USDC to the pool
    pub fn lender(&mut self, amount: u64) -> Keypair {
        let lender = self.wallet();
        let (usdc, shares) = (self.usdc, self.share_mint);
        self.fund(&usdc, &lender.pubkey(), amount);
        self.fund(&shares, &lender.pubkey(), 0);
        self.send(&[self.lend_deposit_ix(&lender.pubkey(), amount)], &[&lender]).expect("lend");
        lender
    }
}

pub fn position_bytes(whirlpool: &Pubkey, mint: &Pubkey, liquidity: u128, lower: i32, upper: i32) -> Vec<u8> {
    let mut data = vec![0u8; 216];
    data[..8].copy_from_slice(&[0xaa, 0xbc, 0x8f, 0xe4, 0x7a, 0x40, 0xf7, 0xd0]);
    data[8..40].copy_from_slice(whirlpool.as_ref());
    data[40..72].copy_from_slice(mint.as_ref());
    data[72..88].copy_from_slice(&liquidity.to_le_bytes());
    data[88..92].copy_from_slice(&lower.to_le_bytes());
    data[92..96].copy_from_slice(&upper.to_le_bytes());
    data
}

pub fn pyth_bytes(verification: u8, feed: [u8; 32], price: i64, conf: u64, expo: i32, publish_time: i64) -> Vec<u8> {
    let mut data = vec![0u8; 134];
    data[..8].copy_from_slice(&[0x22, 0xf1, 0x23, 0x63, 0x9d, 0x7e, 0xf4, 0xcd]);
    data[40] = verification;
    data[41..73].copy_from_slice(&feed);
    data[73..81].copy_from_slice(&price.to_le_bytes());
    data[81..89].copy_from_slice(&conf.to_le_bytes());
    data[89..93].copy_from_slice(&expo.to_le_bytes());
    data[93..101].copy_from_slice(&publish_time.to_le_bytes());
    data
}

/// True when the transaction failed with exactly this program error
pub fn failed_with(res: &TxResult, err: PluribusError) -> bool {
    failed_with_code(res, err.into())
}

pub fn failed_with_code(res: &TxResult, code: u32) -> bool {
    matches!(res, Err(f) if format!("{:?}", f.err).contains(&format!("Custom({code})")))
}

#[track_caller]
pub fn expect_err(res: TxResult, err: PluribusError) {
    let code: u32 = err.into();
    assert!(failed_with_code(&res, code), "expected error {code}, got {:#?}", res.map(|m| m.logs).map_err(|f| (f.err, f.meta.logs)));
}

#[track_caller]
pub fn expect_ok(res: TxResult) -> TransactionMetadata {
    match res {
        Ok(meta) => meta,
        Err(f) => panic!("transaction failed: {:?}\n{}", f.err, f.meta.logs.join("\n")),
    }
}

pub fn discriminator<T: Discriminator>() -> &'static [u8] {
    T::DISCRIMINATOR
}

pub fn borsh<T: AnchorSerialize>(value: &T) -> Vec<u8> {
    let mut out = vec![];
    value.serialize(&mut out).unwrap();
    out
}
