use anchor_lang::prelude::*;

use crate::{error::PluribusError, state::Asset};

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
        // The extensions whose values are read must have the exact size the Token-2022 program gives them
        let ok = match kind {
            CONFIDENTIAL_TRANSFER_MINT | METADATA_POINTER | TOKEN_METADATA | GROUP_POINTER | TOKEN_GROUP | GROUP_MEMBER_POINTER
            | TOKEN_GROUP_MEMBER => true,
            PERMANENT_DELEGATE => value.len() == 32,
            PAUSABLE => value.len() == 33,
            SCALED_UI_AMOUNT => value.len() == 56,
            TRANSFER_HOOK => value.len() == 64 && !hook_set(value),
            DEFAULT_ACCOUNT_STATE => value == [STATE_INITIALIZED],
            _ => false,
        };
        require!(ok, PluribusError::UnsupportedMint);
    }
    Ok(())
}

/// Tokens per share at a multiplier of exactly one
pub const MULTIPLIER_ONE: u128 = 1_000_000_000;

/// This close to a multiplier change, a price might be quoted against either multiplier
pub const MULTIPLIER_GUARD_SECS: i64 = 3_600;

/// Multipliers that can be priced: up to a 10000-for-1 split or reverse split
const MULTIPLIER_RANGE: std::ops::RangeInclusive<f64> = 1e-4..=1e4;

/// A corporate-action multiplier in tokens per share scaled by 1e9: `old` until `at`, `new` from then on,
/// each None when it is outside the range that can be priced
/// Token-2022 also applies an update at once when its time is not in the future, leaving `old == new`,
/// so only the asset's own record of what it last saw dates such a change
#[derive(Clone, Copy)]
pub struct Scaled {
    pub old: Option<u128>,
    pub new: Option<u128>,
    pub at: i64,
}

impl Scaled {
    pub fn in_effect(&self, now: i64) -> Option<u128> {
        if now >= self.at {
            self.new
        } else {
            self.old
        }
    }
}

/// The multiplier for a price published at `t`, whether that basis is certain, or None when no basis is known
/// The asset remembers two multipliers, so a price from before the one before is too old to place
/// Uncertain near a change, or when the mint's multiplier moved without the asset seeing it: the token then backs no
/// new debt, and of the two bases the one that leaves the token's worth nearest the last sampled price is used
pub fn multiplier(asset: &Asset, s: &Scaled, now: i64, t: i64, price: u128) -> Option<(u128, bool)> {
    let (prev, cur) = (asset.mult_prev as u128, asset.mult as u128);
    let guard = MULTIPLIER_GUARD_SECS;
    if asset.mult_prev_since != 0 && t < asset.mult_prev_since + guard {
        return None;
    }
    // A price from before the current multiplier took effect
    if asset.mult_since != 0 && t < asset.mult_since + guard {
        if asset.mult_exact && t + guard <= asset.mult_since {
            return Some((prev, true));
        }
        return Some((closest(asset, price, prev, cur), false));
    }
    let in_effect = s.in_effect(now);
    if in_effect != Some(cur) {
        // A change scheduled from the asset's multiplier still says exactly when it applied
        if let Some(m) = in_effect.filter(|m| s.old == Some(cur) && s.new == Some(*m) && s.at <= now) {
            if t.abs_diff(s.at) < guard as u64 {
                return Some((closest(asset, price, cur, m), false));
            }
            return Some((if t >= s.at { m } else { cur }, true));
        }
        // Applied at once some time since the asset last looked, so either basis is possible
        return Some((closest(asset, price, cur, in_effect.unwrap_or(cur)), false));
    }
    // A change still ahead might already be in a price quoted shortly before it
    if let Some(next) = s.new.filter(|n| s.at > now && s.old != Some(*n) && t + guard > s.at) {
        return Some((closest(asset, price, cur, next), false));
    }
    Some((cur, true))
}

/// Whether a token price is far from the last sample, more than half again either way
pub fn far(asset: &Asset, token_price: u128) -> bool {
    let r = asset.vol_price as u128;
    r > 0 && (token_price * 2 > r * 3 || token_price * 3 < r * 2)
}

/// The token price for a per-share `price` published at `t`, and whether it is clear
/// Unclear when the basis is uncertain or unknown, or when the price jumped far from the last sample and the volatility
/// crank has not yet seen that hold for the asset's `jump_hold_secs`, which may be the feed repricing for a split the
/// mint has not applied. An unclear token backs no new debt, is not seized, and counts toward the liquidation line at
/// the lower of its price and the last sample, so a real crash shows at once and a jump up lifts nothing
pub fn token_price(asset: &Asset, s: &Scaled, now: i64, t: i64, price: u128) -> Result<(u128, bool)> {
    let (m, sure) = multiplier(asset, s, now, t, price).unwrap_or_else(|| {
        // Too old to place: the lowest basis it could be on
        let low = (asset.mult_prev as u128).min(asset.mult as u128).min(s.in_effect(now).unwrap_or(u128::MAX));
        (low, false)
    });
    let token = crate::math::mul_div_floor(price, m, MULTIPLIER_ONE)?;
    let held = asset.jump_since != 0 && t >= asset.jump_since + asset.params.jump_hold_secs as i64;
    if sure && (held || !far(asset, token)) {
        return Ok((token, true));
    }
    let sample = asset.vol_price as u128;
    Ok((if sample > 0 { token.min(sample) } else { token }, false))
}

/// Of two multipliers, the one that puts the token's price nearer the last sampled token price
/// A split leaves a token's worth about where it was, so the wrong basis is off by the split's ratio
/// With no sample to go by, the higher one, so no one is liquidated over the mix-up
fn closest(asset: &Asset, price: u128, a: u128, b: u128) -> u128 {
    if a == b {
        return a;
    }
    if asset.vol_price == 0 {
        return a.max(b);
    }
    // Comparison only, never a payout, so floating point is fine here
    let off = |m: u128| {
        let r = price as f64 * m as f64 / MULTIPLIER_ONE as f64 / asset.vol_price as f64;
        r.max(1.0 / r)
    };
    if off(a) <= off(b) {
        a
    } else {
        b
    }
}

/// Records the multiplier in effect now when it differs from the asset's, and says whether it did
/// A change scheduled from the asset's multiplier keeps its exact time, any other is dated when first seen
pub fn sync(asset: &mut Asset, s: &Scaled, now: i64) -> bool {
    let Some(m) = s.in_effect(now) else { return false };
    let cur = asset.mult as u128;
    if m == cur {
        return false;
    }
    let exact = s.old == Some(cur) && s.new == Some(m) && s.at <= now;
    asset.mult_prev_since = asset.mult_since;
    asset.mult_prev = asset.mult;
    asset.mult = m as u64;
    asset.mult_since = if exact { s.at } else { now };
    asset.mult_exact = exact;
    // Sampling starts over on the new basis, and the last price stays as the reference that tells the bases apart
    asset.vol_time = 0;
    asset.jump_since = 0;
    true
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
            SCALED_UI_AMOUNT if value.len() == 56 => {
                let parse = |raw: &[u8]| {
                    let m = f64::from_le_bytes(raw.try_into().unwrap());
                    (m.is_finite() && MULTIPLIER_RANGE.contains(&m)).then(|| (m * 1e9) as u128)
                };
                let at = i64::from_le_bytes(value[40..48].try_into().unwrap());
                state.scaled = Some(Scaled { old: parse(&value[32..40]), new: parse(&value[48..56]), at });
            }
            _ => {}
        }
    }
    Ok(state)
}

/// The multiplier a newly listed asset starts from: the one in effect, or one for a mint without the extension
pub fn listing_multiplier(acc: &AccountInfo, now: i64) -> Result<u128> {
    Ok(match read_state(acc)?.scaled {
        Some(s) => s.in_effect(now).ok_or_else(|| error!(PluribusError::UnsupportedMint))?,
        None => MULTIPLIER_ONE,
    })
}

/// A Token-2022 vault's balance and whether it is frozen
/// The issuer's permanent delegate can move tokens out and its freeze authority can freeze the vault, neither of
/// which the program's books see
pub fn read_vault(acc: &AccountInfo) -> Result<(u64, bool)> {
    require_keys_eq!(*acc.owner, anchor_spl::token_2022::ID, PluribusError::AccountMismatch);
    let d = acc.try_borrow_data()?;
    // Layout: mint 32 | owner 32 | amount u64 | delegate 36 | state u8 at 108, where 2 is frozen
    require!(d.len() >= 165, PluribusError::AccountMismatch);
    Ok((u64::from_le_bytes(d[64..72].try_into().unwrap()), d[108] == 2))
}
