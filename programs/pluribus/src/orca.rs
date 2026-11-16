use anchor_lang::prelude::*;

use crate::{constants::*, error::PluribusError};

/// First 8 bytes of sha256("account:Position")
const POSITION_DISCRIMINATOR: [u8; 8] = [0xaa, 0xbc, 0x8f, 0xe4, 0x7a, 0x40, 0xf7, 0xd0];
/// First 8 bytes of sha256("account:Whirlpool")
const WHIRLPOOL_DISCRIMINATOR: [u8; 8] = [0x3f, 0x95, 0xd1, 0x0c, 0xe1, 0x80, 0x63, 0x09];

pub struct OrcaPosition {
    pub whirlpool: Pubkey,
    pub position_mint: Pubkey,
    pub liquidity: u128,
    pub tick_lower: i32,
    pub tick_upper: i32,
}

fn key(d: &[u8], at: usize) -> Pubkey {
    Pubkey::new_from_array(d[at..at + 32].try_into().unwrap())
}

/// Reads a Whirlpool position
/// Only the Whirlpool program can create an account that passes the owner and discriminator checks
/// That is why the fields can be trusted
pub fn read_position(acc: &AccountInfo) -> Result<OrcaPosition> {
    require_keys_eq!(*acc.owner, WHIRLPOOL_PROGRAM_ID, PluribusError::InvalidLpPosition);
    let d = acc.try_borrow_data()?;
    // Layout: disc 8 | whirlpool 32 | position mint 32 | liquidity u128 | tick lower i32 | tick upper i32
    require!(d.len() >= 96 && d[..8] == POSITION_DISCRIMINATOR, PluribusError::InvalidLpPosition);
    Ok(OrcaPosition {
        whirlpool: key(&d, 8),
        position_mint: key(&d, 40),
        liquidity: u128::from_le_bytes(d[72..88].try_into().unwrap()),
        tick_lower: i32::from_le_bytes(d[88..92].try_into().unwrap()),
        tick_upper: i32::from_le_bytes(d[92..96].try_into().unwrap()),
    })
}

/// Token mints A and B of a Whirlpool
pub fn read_whirlpool_mints(acc: &AccountInfo) -> Result<(Pubkey, Pubkey)> {
    require_keys_eq!(*acc.owner, WHIRLPOOL_PROGRAM_ID, PluribusError::PoolNotWhitelisted);
    let d = acc.try_borrow_data()?;
    require!(d.len() >= 213 && d[..8] == WHIRLPOOL_DISCRIMINATOR, PluribusError::PoolNotWhitelisted);
    Ok((key(&d, 101), key(&d, 181)))
}
