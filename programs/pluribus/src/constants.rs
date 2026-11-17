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

pub const MAX_POSITIONS: usize = 5;
pub const MAX_GROUPS: usize = 4;
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
/// Scale at which fractions of a base unit are carried between interest accruals
pub const DUST: u128 = 1_000_000_000;
pub const USDC_DECIMALS: u8 = 6;

pub const KIND_EMPTY: u8 = 0;
pub const KIND_TOKEN: u8 = 1;
pub const KIND_LP: u8 = 2;

pub const ORACLE_FIXED: u8 = 0;
pub const ORACLE_PYTH: u8 = 1;

pub const WHIRLPOOL_PROGRAM_ID: Pubkey = pubkey!("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
pub const PYTH_RECEIVER_ID: Pubkey = pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
