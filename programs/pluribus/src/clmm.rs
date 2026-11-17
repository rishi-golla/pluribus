use anchor_lang::prelude::*;

use crate::{constants::*, error::PluribusError, orca, state::LpMarket};

/// First 8 bytes of sha256("account:PersonalPositionState")
const RAYDIUM_POSITION_DISCRIMINATOR: [u8; 8] = [0x46, 0x6f, 0x96, 0x7e, 0xe6, 0x0f, 0x19, 0x75];
/// First 8 bytes of sha256("account:PoolState")
const RAYDIUM_POOL_DISCRIMINATOR: [u8; 8] = [0xf7, 0xed, 0xe3, 0xf5, 0xd7, 0xc3, 0xde, 0x46];

/// A concentrated liquidity position from Orca or Raydium, with its range turned so it prices the market's base token in USDC
pub struct LpPosition {
    pub mint: Pubkey,
    pub liquidity: u128,
    pub tick_lower: i32,
    pub tick_upper: i32,
}

fn key(d: &[u8], at: usize) -> Pubkey {
    Pubkey::new_from_array(d[at..at + 32].try_into().unwrap())
}

/// The program a whitelisted pool belongs to and its two mints, in the pool's own order
/// Orca and Raydium both sort the mints, so which one is USDC depends on the addresses
pub fn read_pool(acc: &AccountInfo) -> Result<(Pubkey, Pubkey, Pubkey)> {
    if *acc.owner == WHIRLPOOL_PROGRAM_ID {
        let (a, b) = orca::read_whirlpool_mints(acc)?;
        return Ok((WHIRLPOOL_PROGRAM_ID, a, b));
    }
    require!(RAYDIUM_CLMM_PROGRAMS.contains(acc.owner), PluribusError::PoolNotWhitelisted);
    let d = acc.try_borrow_data()?;
    // Layout (packed): disc 8 | bump 1 | amm config 32 | creator 32 | token mint 0 at 73 | token mint 1 at 105
    require!(d.len() >= 137 && d[..8] == RAYDIUM_POOL_DISCRIMINATOR, PluribusError::PoolNotWhitelisted);
    Ok((*acc.owner, key(&d, 73), key(&d, 105)))
}

/// Where the market's dex keeps the one position an NFT controls
pub fn position_address(market: &LpMarket, mint: &Pubkey, bump: u8) -> Result<Pubkey> {
    Pubkey::create_program_address(&[b"position", mint.as_ref(), &[bump]], &market.dex_program).map_err(|_| error!(PluribusError::AccountMismatch))
}

/// Reads a position of the market's dex and checks it is in the market's pool
/// Only that program can create an account that passes its owner and discriminator checks, which is why the fields can be trusted
pub fn read_position(market: &LpMarket, acc: &AccountInfo) -> Result<LpPosition> {
    let (pool, mint, liquidity, lower, upper) = if market.dex_program == WHIRLPOOL_PROGRAM_ID {
        let p = orca::read_position(acc)?;
        (p.whirlpool, p.position_mint, p.liquidity, p.tick_lower, p.tick_upper)
    } else {
        require_keys_eq!(*acc.owner, market.dex_program, PluribusError::InvalidLpPosition);
        let d = acc.try_borrow_data()?;
        // Layout: disc 8 | bump 1 | nft mint 32 | pool 32 | tick lower i32 | tick upper i32 | liquidity u128
        require!(d.len() >= 97 && d[..8] == RAYDIUM_POSITION_DISCRIMINATOR, PluribusError::InvalidLpPosition);
        let tick = |at: usize| i32::from_le_bytes(d[at..at + 4].try_into().unwrap());
        (key(&d, 41), key(&d, 9), u128::from_le_bytes(d[81..97].try_into().unwrap()), tick(73), tick(77))
    };
    require_keys_eq!(pool, market.whirlpool, PluribusError::PoolNotWhitelisted);
    // Ticks price the second token in the first, so with USDC first the range is turned around:
    // a price p at tick t is 1/p at tick -t, and the same liquidity then holds the base token as the first token
    let (tick_lower, tick_upper) = if market.base_first {
        (lower, upper)
    } else {
        let flip = |t: i32| t.checked_neg().ok_or_else(|| error!(PluribusError::InvalidLpPosition));
        (flip(upper)?, flip(lower)?)
    };
    Ok(LpPosition { mint, liquidity, tick_lower, tick_upper })
}
