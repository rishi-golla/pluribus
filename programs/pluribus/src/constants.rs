use anchor_lang::prelude::*;

#[constant]
pub const POOL_SEED: &[u8] = b"pool";
#[constant]
pub const USDC_VAULT_SEED: &[u8] = b"usdc_vault";
#[constant]
pub const SHARE_MINT_SEED: &[u8] = b"share_mint";
#[constant]
pub const JUNIOR_MINT_SEED: &[u8] = b"junior_mint";
#[constant]
pub const ASSET_SEED: &[u8] = b"asset";
#[constant]
pub const VAULT_SEED: &[u8] = b"vault";
#[constant]
pub const LP_MARKET_SEED: &[u8] = b"lp_market";
#[constant]
pub const CREDIT_SEED: &[u8] = b"credit";
#[constant]
pub const DEMO_PRICE_SEED: &[u8] = b"demo_price";
#[constant]
pub const JUNIOR_ESCROW_SEED: &[u8] = b"junior_escrow";
#[constant]
pub const JUNIOR_EXIT_SEED: &[u8] = b"junior_exit";
#[constant]
pub const SENIOR_ESCROW_SEED: &[u8] = b"senior_escrow";
#[constant]
pub const SENIOR_EXIT_SEED: &[u8] = b"senior_exit";

pub const MAX_POSITIONS: usize = 5;
pub const MAX_GROUPS: usize = 6;
pub const MAX_SCENARIOS: usize = 4;
pub const TIERS: usize = 3;

pub const BPS: u128 = 10_000;
/// Prices and values carry 6 decimals, the same as USDC base units
pub const PRICE_ONE: u128 = 1_000_000;
pub const INDEX_ONE: u128 = 1_000_000_000_000_000_000;
pub const SECONDS_PER_YEAR: u128 = 31_536_000;
/// Shares and assets that every tranche counts but nobody owns
/// They pin a tranche's opening price at one and make pushing it up cost more than it can take from the next lender
pub const VIRTUAL_SHARES: u128 = 1_000_000;
/// Hard ceilings no parameter can pass, so the admin can never hold junior money indefinitely
pub const MAX_JUNIOR_PAUSE_SECS: u32 = 90 * 86_400;
pub const MAX_JUNIOR_DELAY_SECS: u32 = 30 * 86_400;
pub const MAX_JUNIOR_EXIT_FEE_BPS: u16 = 100;
/// Also caps how long the admin can lock itself out of loosening anything
pub const MAX_ACTIVATION_DELAY_SECS: u32 = 30 * 86_400;
/// Shortest claim window, so a queued exit can always be claimed
pub const MIN_JUNIOR_EXIT_WINDOW_SECS: u32 = 60;
/// Longest claim window, which the pause gap is measured against so no pause can cut a window short
pub const MAX_JUNIOR_EXIT_WINDOW_SECS: u32 = 3 * 86_400;
/// Payout epochs start on Fridays at 00:00 UTC: 1970-01-02, the first Friday, is this many seconds into Unix time
pub const EPOCH_ANCHOR: i64 = 86_400;
pub const MIN_EPOCH_SECS: u32 = 60;
pub const MAX_EPOCH_SECS: u32 = 30 * 86_400;
/// Scale of an asset's variance per second, so a return of 1% over a second reads as 1e14
pub const VOL_SCALE: u128 = 1_000_000_000_000_000_000;
/// Scale at which fractions of a base unit are carried between interest accruals
pub const DUST: u128 = 1_000_000_000;
pub const USDC_DECIMALS: u8 = 6;

pub const KIND_EMPTY: u8 = 0;
pub const KIND_TOKEN: u8 = 1;
pub const KIND_LP: u8 = 2;

pub const ORACLE_FIXED: u8 = 0;
pub const ORACLE_PYTH: u8 = 1;

/// How a liquid staking token's SOL backing is read, which caps its price at what that SOL is worth
pub const RATE_NONE: u8 = 0;
/// From an SPL stake pool account: total lamports over pool token supply
pub const RATE_STAKE_POOL: u8 = 1;
/// A fixed SOL per token set by the admin, for devnet stand-ins with no real pool behind them
pub const RATE_FIXED: u8 = 2;
/// Programs whose stake pool accounts share the SPL layout: the SPL program and Sanctum's multi-validator deploy (JupSOL)
pub const STAKE_POOL_PROGRAMS: [Pubkey; 2] =
    [pubkey!("SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy"), pubkey!("SPMBzsVUuoHA4Jm6KunbsotaahvVikZs1JyTW6iJvbn")];
pub const LAMPORTS_PER_SOL: u128 = 1_000_000_000;

pub const WHIRLPOOL_PROGRAM_ID: Pubkey = pubkey!("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
/// Raydium CLMM on mainnet and on devnet, the only other programs whose positions can back debt
pub const RAYDIUM_CLMM_PROGRAMS: [Pubkey; 2] =
    [pubkey!("CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"), pubkey!("DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH")];
pub const PYTH_RECEIVER_ID: Pubkey = pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
/// Ceiling on an asset's risk premium, the extra yearly rate charged on debt it backs: 30%
pub const MAX_RISK_PREMIUM_BPS: u16 = 3_000;
/// Largest price exponent: a price per 10^12 whole tokens covers anything worth more than 10^-18 dollars
pub const MAX_PRICE_EXPONENT: u8 = 12;
