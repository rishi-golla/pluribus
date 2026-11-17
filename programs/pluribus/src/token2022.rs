use anchor_lang::prelude::*;

use crate::error::PluribusError;

// Token-2022 mints keep extensions after the base mint and the account type byte, as type u16 | length u16 | value
const ACCOUNT_TYPE_AT: usize = 165;
const ACCOUNT_TYPE_MINT: u8 = 1;
const TLV_START: usize = 166;

const CONFIDENTIAL_TRANSFER_MINT: u16 = 4;
const DEFAULT_ACCOUNT_STATE: u16 = 6;
const PERMANENT_DELEGATE: u16 = 12;
const TRANSFER_HOOK: u16 = 14;
const METADATA_POINTER: u16 = 18;
const TOKEN_METADATA: u16 = 19;
const GROUP_POINTER: u16 = 20;
const TOKEN_GROUP: u16 = 21;
const GROUP_MEMBER_POINTER: u16 = 22;
const TOKEN_GROUP_MEMBER: u16 = 23;
const SCALED_UI_AMOUNT: u16 = 25;
const PAUSABLE: u16 = 26;

/// Account state an issuer can set as every new account's default: anything but Initialized would freeze our vault
const STATE_INITIALIZED: u8 = 1;

/// The extensions a mint carries, in order
fn extensions(d: &[u8]) -> Result<Vec<(u16, &[u8])>> {
    let mut out = vec![];
    // A mint with no extensions is the plain 82-byte layout
    if d.len() <= ACCOUNT_TYPE_AT {
        return Ok(out);
    }
    require!(d[ACCOUNT_TYPE_AT] == ACCOUNT_TYPE_MINT, PluribusError::UnsupportedMint);
    let mut i = TLV_START;
    while i + 4 <= d.len() {
        let kind = u16::from_le_bytes([d[i], d[i + 1]]);
        let len = u16::from_le_bytes([d[i + 2], d[i + 3]]) as usize;
        // Space past the last extension is left uninitialized
        if kind == 0 {
            break;
        }
        require!(i + 4 + len <= d.len(), PluribusError::UnsupportedMint);
        out.push((kind, &d[i + 4..i + 4 + len]));
        i += 4 + len;
    }
    Ok(out)
}

fn hook_set(value: &[u8]) -> bool {
    // Authority 32 | program id 32, where an all-zero id means no hook
    value.len() >= 64 && value[32..64].iter().any(|b| *b != 0)
}

/// Checked when a Token-2022 mint is listed, since a mint's extensions are fixed once it exists
/// Accepted: what tokenized stocks carry, an issuer's delegate, pause and corporate-action multiplier included
/// Refused: anything that takes a fee, earns interest, blocks transfers or runs code on them
pub fn check_listable(acc: &AccountInfo) -> Result<()> {
    let d = acc.try_borrow_data()?;
    for (kind, value) in extensions(&d)? {
        let ok = match kind {
            CONFIDENTIAL_TRANSFER_MINT | PERMANENT_DELEGATE | METADATA_POINTER | TOKEN_METADATA | GROUP_POINTER | TOKEN_GROUP
            | GROUP_MEMBER_POINTER | TOKEN_GROUP_MEMBER | SCALED_UI_AMOUNT | PAUSABLE => true,
            TRANSFER_HOOK => !hook_set(value),
            DEFAULT_ACCOUNT_STATE => value.first() == Some(&STATE_INITIALIZED),
            _ => false,
        };
        require!(ok, PluribusError::UnsupportedMint);
    }
    Ok(())
}

/// Tokens per share at a multiplier of exactly one
pub const MULTIPLIER_ONE: u128 = 1_000_000_000;

/// This close to a multiplier change, a price might be quoted against either multiplier
pub const MULTIPLIER_GUARD_SECS: u64 = 3_600;

/// A corporate-action multiplier in tokens per share scaled by 1e9: `old` until `at`, `new` from then on
#[derive(Clone, Copy)]
pub struct Scaled {
    pub old: u128,
    pub new: u128,
    pub at: i64,
}

impl Scaled {
    /// The multiplier for a price published at `t`, chosen by that publish time rather than the clock, so a Friday price
    /// is never paired with a split that applied over the weekend
    /// Within the guard of a change the price could be on either basis: the larger multiplier is used, so no one is
    /// liquidated over the mix-up, and `true` says the token should back no new debt meanwhile
    pub fn multiplier_for(&self, t: i64) -> (u128, bool) {
        if self.old != self.new && t.abs_diff(self.at) < MULTIPLIER_GUARD_SECS {
            return (self.old.max(self.new), true);
        }
        (if t >= self.at { self.new } else { self.old }, false)
    }

    /// Whether a change takes effect after `from` and by `to`
    pub fn changes_between(&self, from: i64, to: i64) -> bool {
        self.old != self.new && from < self.at && self.at <= to
    }
}

/// What a listed Token-2022 mint says right now: whether transfers are stopped, and its multiplier if it has one
pub struct MintState {
    /// Paused by its issuer, or a transfer hook switched on since listing, either of which stops liquidations moving it
    pub halted: bool,
    pub scaled: Option<Scaled>,
}

pub fn read_state(acc: &AccountInfo) -> Result<MintState> {
    let d = acc.try_borrow_data()?;
    let mut state = MintState { halted: false, scaled: None };
    for (kind, value) in extensions(&d)? {
        match kind {
            // Authority 32 | paused bool
            PAUSABLE => state.halted |= value.get(32).is_some_and(|b| *b != 0),
            TRANSFER_HOOK => state.halted |= hook_set(value),
            // Authority 32 | multiplier f64 | when the new one applies i64 | new multiplier f64
            SCALED_UI_AMOUNT => {
                require!(value.len() >= 56, PluribusError::InvalidPriceAccount);
                let scaled = |raw: &[u8]| -> Result<u128> {
                    let m = f64::from_le_bytes(raw.try_into().unwrap());
                    require!(m.is_finite() && (0.01..=100.0).contains(&m), PluribusError::InvalidPriceAccount);
                    Ok((m * 1e9) as u128)
                };
                let at = i64::from_le_bytes(value[40..48].try_into().unwrap());
                state.scaled = Some(Scaled { old: scaled(&value[32..40])?, new: scaled(&value[48..56])?, at });
            }
            _ => {}
        }
    }
    Ok(state)
}
