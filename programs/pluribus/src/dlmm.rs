use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::PluribusError,
    math::*,
    state::{LpMarket, Pool},
};

/// First 8 bytes of sha256("account:LbPair")
const PAIR_DISCRIMINATOR: [u8; 8] = [0x21, 0x0b, 0x31, 0x62, 0xb5, 0x65, 0xb1, 0x0d];
/// First 8 bytes of sha256("account:PositionV2")
const POSITION_DISCRIMINATOR: [u8; 8] = [0x75, 0xb0, 0xd4, 0xc7, 0xf5, 0xb4, 0x85, 0xb6];
const PAIR_LEN: usize = 904;
/// A position of at most 70 bins, the size every position starts at and the only one the pool opens
const POSITION_LEN: usize = 8120;
pub const MAX_BINS: i32 = 70;
/// Meteora's widest bin step, in bps
const MAX_BIN_STEP: u16 = 400;
/// A pair that also fills limit orders out of its bins, whose bookkeeping the valuation below was not checked against
const FUNCTION_LIMIT_ORDER: u8 = 2;
/// One in Q64.64, the fixed point every DLMM price and liquidity share is kept in
const ONE: u128 = 1 << 64;

pub struct Pair {
    pub bin_step: u16,
    pub mint_x: Pubkey,
    pub mint_y: Pubkey,
}

/// A position the pool holds, with the pair it is in and its first and last bin
pub struct Held {
    pub pair: Pubkey,
    pub lower: i32,
    pub upper: i32,
}

fn key(d: &[u8], at: usize) -> Pubkey {
    Pubkey::new_from_array(d[at..at + 32].try_into().unwrap())
}

/// Reads a DLMM pair
/// Only the DLMM program can create an account that passes the owner and discriminator checks, which is why the fields can be trusted
pub fn read_pair(acc: &AccountInfo) -> Result<Pair> {
    require_keys_eq!(*acc.owner, METEORA_DLMM_PROGRAM_ID, PluribusError::PoolNotWhitelisted);
    let d = acc.try_borrow_data()?;
    // Layout: disc 8 | static parameters 32 | variable parameters 32 | seeds and type 4 | active id i32 | bin step u16 at 80 |
    // status u8 at 82 | token X mint at 88 | token Y mint at 120
    require!(d.len() >= PAIR_LEN && d[..8] == PAIR_DISCRIMINATOR, PluribusError::PoolNotWhitelisted);
    let bin_step = u16::from_le_bytes([d[80], d[81]]);
    require!((1..=MAX_BIN_STEP).contains(&bin_step), PluribusError::PoolNotWhitelisted);
    Ok(Pair { bin_step, mint_x: key(&d, 88), mint_y: key(&d, 120) })
}

/// Reads a pair that is fit to list
pub fn read_listing(acc: &AccountInfo) -> Result<Pair> {
    let pair = read_pair(acc)?;
    let d = acc.try_borrow_data()?;
    // Both tokens on the classic token program, so no hook or transfer fee stands between a liquidator and the tokens
    let classic = d[880] == 0 && d[881] == 0;
    // Enabled, and a plain market-making pair: function type at 35
    let plain = d[82] == 0 && d[35] != FUNCTION_LIMIT_ORDER;
    // No farming rewards at 264 and 408, which a position might have to claim before it can be closed
    let unfarmed = key(&d, 264) == Pubkey::default() && key(&d, 408) == Pubkey::default();
    require!(classic && plain && unfarmed, PluribusError::PoolNotWhitelisted);
    Ok(pair)
}

/// The pool PDA, which owns every DLMM position the protocol holds
pub fn custodian(pool: &Pool) -> Result<Pubkey> {
    Pubkey::create_program_address(&pool.signer_seeds(), &crate::ID).map_err(|_| error!(PluribusError::AccountMismatch))
}

/// Reads a position and checks the pool alone controls it
/// A position cannot change owner, so the pool PDA has to be the owner from the start, with no operator who could
/// pull liquidity out from under the debt and no lock that would leave a liquidator with nothing to take
pub fn read_position(acc: &AccountInfo, custodian: &Pubkey) -> Result<Held> {
    require_keys_eq!(*acc.owner, METEORA_DLMM_PROGRAM_ID, PluribusError::InvalidDlmmPosition);
    let d = acc.try_borrow_data()?;
    // Layout: disc 8 | pair 32 | owner 32 at 40 | 70 liquidity shares u128 at 72 | reward and fee records |
    // lower bin i32 at 7912 | upper bin i32 at 7916 | operator 32 at 7960 | lock release u64 at 7992 | fee owner 32 at 8001
    // A position grown past 70 bins is a longer account and is not accepted
    require!(d.len() == POSITION_LEN && d[..8] == POSITION_DISCRIMINATOR, PluribusError::InvalidDlmmPosition);
    let bin = |at: usize| i32::from_le_bytes(d[at..at + 4].try_into().unwrap());
    let (lower, upper) = (bin(7912), bin(7916));
    let ours = key(&d, 40) == *custodian && key(&d, 7960) == Pubkey::default() && key(&d, 8001) == Pubkey::default();
    let unlocked = d[7992..8000] == [0; 8];
    let sized = upper.checked_sub(lower).is_some_and(|span| (0..MAX_BINS).contains(&span));
    require!(ours && unlocked && sized, PluribusError::InvalidDlmmPosition);
    Ok(Held { pair: key(&d, 8), lower, upper })
}

/// A bin's price as the pair itself computes it: (1 + step / 10000) ^ id in Q64.64, by repeated squaring
/// DLMM inverts the base first so every product fits 128 bits, and inverts back for a positive id
pub fn bin_price(id: i32, bin_step: u16) -> Result<u128> {
    let mut exp = id.unsigned_abs();
    require!(exp < 1 << 19 && bin_step > 0, PluribusError::MathOverflow);
    let mut squared = u128::MAX / (ONE + (u128::from(bin_step) << 64) / BPS);
    let mut result = ONE;
    // Both factors stay at or under one, so no product passes 128 bits and none needs an overflow check
    while exp != 0 {
        if exp & 1 != 0 {
            result = result.wrapping_mul(squared) >> 64;
        }
        exp >>= 1;
        if exp != 0 {
            squared = squared.wrapping_mul(squared) >> 64;
        }
    }
    require!(result > 0, PluribusError::MathOverflow);
    Ok(if id > 0 { u128::MAX / result } else { result })
}

/// a * b / 2^64 rounded down for a 64-bit `b`, in two half-width products that cannot overflow
/// A health check does this twice per bin, where a full-width multiply and divide would cost several times more
fn mul_shr(a: u128, b: u64) -> u128 {
    let (high, low, b) = (a >> 64, a & (ONE - 1), u128::from(b));
    high.wrapping_mul(b).wrapping_add(low.wrapping_mul(b) >> 64)
}

/// What a position is worth at any price, built once per health check and read once per scenario
///
/// A bin trades at one fixed price P and keeps `P * x + y` constant, and a liquidity share is a claim on that sum:
/// the pair mints one share per unit of it and rounds every deposit, withdrawal and swap in the bin's favour,
/// so a share is always backed by at least one unit. Whatever mix of the two tokens a bin holds right now,
/// that mix is worth the least when it is all the token the market values less at that bin's price:
/// all token X when the price is under P, all token Y when it is over. That is also what arbitrage leaves there
/// So the shares, the bin prices and the oracle price give a value the position can always pay, without reading the
/// pair's active bin or its reserves, which a swap can move inside one transaction
pub struct Curve {
    /// Bin prices from the lowest up, in Q64.64 base units of token Y per base unit of token X
    prices: Vec<u128>,
    /// Token Y paid by the bins under each index once the price is above them
    y_below: Vec<u64>,
    /// Shares of the bins from each index up, each discounted to that index's price, so dividing by the price gives their token X
    x_shares: Vec<u128>,
    base_first: bool,
    decimals: u8,
    /// Base units in one whole base token
    unit: u128,
}

/// Builds the curve of the position at `position` in the listed pair `pair`, whose base token has `decimals`
pub fn curve(pool: &Pool, market: &LpMarket, pair: &AccountInfo, position: &AccountInfo, decimals: u8) -> Result<Curve> {
    require_keys_eq!(market.dex_program, METEORA_DLMM_PROGRAM_ID, PluribusError::NotDlmmMarket);
    require_keys_eq!(pair.key(), market.whirlpool, PluribusError::PoolNotWhitelisted);
    let step = read_pair(pair)?.bin_step;
    let held = read_position(position, &custodian(pool)?)?;
    require_keys_eq!(held.pair, market.whirlpool, PluribusError::PoolNotWhitelisted);

    let d = position.try_borrow_data()?;
    let share = |i: usize| u128::from_le_bytes(d[72 + 16 * i..88 + 16 * i].try_into().unwrap());
    Curve::new(held.lower, step, (held.upper - held.lower + 1) as usize, share, market.base_first, decimals)
}

/// a * num / den rounded down, through 256 bits only when the product needs them
fn scale(a: u128, num: u128, den: u128) -> Result<u128> {
    match a.checked_mul(num) {
        Some(product) => Ok(product / den),
        None => mul_div_wide(a, num, den),
    }
}

impl Curve {
    /// From the liquidity share held in each of `n` bins, the first of them bin `lower`
    fn new(lower: i32, bin_step: u16, n: usize, share: impl Fn(usize) -> u128, base_first: bool, decimals: u8) -> Result<Curve> {
        let overflow = || error!(PluribusError::MathOverflow);
        let step = u128::from(bin_step);
        // One bin step as a fraction of 2^64 rounded up, and the factor that undoes a step rounded down
        let (grow, shrink) = ((step << 64).div_ceil(BPS) as u64, ((BPS << 64) / (BPS + step)) as u64);

        let (mut prices, mut y_below) = (Vec::with_capacity(n), Vec::with_capacity(n + 1));
        let (mut price, mut y) = (bin_price(lower, bin_step)?, 0u64);
        for i in 0..n {
            prices.push(price);
            y_below.push(y);
            // A withdrawal rounds each token down, which can cost a unit of token Y and a unit of token X worth `price` more
            let rounding = ((price >> 64) as u64).saturating_add(2);
            y = y.checked_add(((share(i) >> 64) as u64).saturating_sub(rounding)).ok_or_else(overflow)?;
            // Stepped up from the bin before and rounded up, which can only lower the value
            price = mul_shr(price, grow).checked_add(price).and_then(|p| p.checked_add(1)).ok_or_else(overflow)?;
        }
        y_below.push(y);

        let (mut x_shares, mut carry) = (vec![0u128; n], 0u128);
        for i in (0..n).rev() {
            carry = mul_shr(carry, shrink).checked_add(share(i)).ok_or_else(overflow)?;
            x_shares[i] = carry;
        }
        Ok(Curve { prices, y_below, x_shares, base_first, decimals, unit: pow10(decimals)? })
    }

    /// Value in USDC base units at `price`, with the USDC side marked down by `usdc_shock`
    pub fn value(&self, price: u128, usdc_shock: u128) -> Result<u128> {
        // A base token worth nothing leaves the position worth nothing, since the worst mix is all of that token
        if price == 0 {
            return Ok(0);
        }
        require!(price < ONE && self.unit < ONE, PluribusError::MathOverflow);
        // The oracle price the way the pair quotes it: base units of token Y per base unit of token X
        let quoted = if self.base_first { (price << 64) / self.unit } else { (self.unit << 64) / price };
        // Each bin counts as whichever of its two tokens is worth less in this scenario
        // With USDC at par that is token Y under the price and token X over it, and marking USDC down moves the line
        // between the two by the same factor, so a bin is never counted as base tokens worth more than its marked-down USDC
        let kept = BPS.saturating_sub(usdc_shock);
        let line = match (self.base_first, kept) {
            (true, 0) => u128::MAX,
            (true, _) => scale(quoted, BPS, kept).unwrap_or(u128::MAX),
            (false, _) => scale(quoted, kept, BPS)?,
        };
        let k = self.prices.partition_point(|p| *p <= line);
        let y = self.y_below[k] as u128;
        // One unit per bin for the rounding of its own withdrawal
        let x = match self.prices.get(k) {
            Some(p) => (self.x_shares[k] / p).saturating_sub((self.prices.len() - k) as u128),
            None => 0,
        };
        let (base, usdc) = if self.base_first { (x, y) } else { (y, x) };
        let value = token_value(to_u64(base)?, price, self.decimals)?.checked_add(cut(usdc, usdc_shock)?);
        Ok(under_payout(value.ok_or(PluribusError::MathOverflow)?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOL: u8 = 9;

    /// A curve over bins of `step` starting at `lower`, holding these liquidity shares
    fn flat(lower: i32, step: u16, shares: &[u128], base_first: bool) -> Curve {
        Curve::new(lower, step, shares.len(), |i| shares[i], base_first, SOL).unwrap()
    }

    #[test]
    fn bin_prices_match_the_ones_stored_in_mainnet_bins() {
        // Read from bin arrays of the SOL/USDC pairs with bin steps 4, 10 and 1
        assert_eq!(bin_price(-6517, 4).unwrap(), 1361530048397449266);
        assert_eq!(bin_price(-2607, 10).unwrap(), 1362321886622002812);
        assert_eq!(bin_price(-26069, 1).unwrap(), 1360861858141829454);
        assert_eq!(bin_price(0, 4).unwrap(), ONE);
        assert_eq!(bin_price(300, 25).unwrap(), 39015224491048514752);
        assert!(bin_price(1 << 19, 1).is_err());
    }

    #[test]
    fn a_position_is_all_usdc_above_its_range_and_all_base_below_it() {
        // Ten bins of $100 each around $73.80, where SOL is token X and one bin is 4 bps wide
        let usd = 100 * PRICE_ONE;
        let c = flat(-6520, 4, &[usd << 64; 10], true);
        let above = c.value(80 * PRICE_ONE, 0).unwrap();
        // Over the range every bin has sold its SOL, so the value is the USDC and no longer moves with the price
        assert!(above <= 10 * usd && above > 10 * usd - 100);
        assert_eq!(above, c.value(500 * PRICE_ONE, 0).unwrap());
        // Under the range it is all SOL, so the value is linear in the price
        let (low, lower) = (c.value(60 * PRICE_ONE, 0).unwrap(), c.value(30 * PRICE_ONE, 0).unwrap());
        assert!(low < above && low.abs_diff(2 * lower) < 100, "{low} vs {lower}");
        // The USDC shock marks down only the USDC side
        assert!(c.value(80 * PRICE_ONE, 1000).unwrap().abs_diff(above * 9 / 10) <= 2);
        assert_eq!(c.value(30 * PRICE_ONE, 1000).unwrap(), lower);
        assert_eq!(c.value(0, 0).unwrap(), 0);
    }

    #[test]
    fn value_never_rises_when_the_price_falls_in_either_token_order() {
        for base_first in [true, false] {
            // With USDC as token X the pair quotes lamports per USDC unit, about 13.5 at $74
            let (lower, liquidity) = if base_first { (-6550, 100_000_000u128 << 64) } else { (6480, 1_350_000_000u128 << 64) };
            let c = flat(lower, 4, &[liquidity; 70], base_first);
            let mut last = 0;
            for cents in (5_000..10_000).step_by(7) {
                let v = c.value(cents * PRICE_ONE / 100, 300).unwrap();
                // But for the few base units a bin's rounding allowance changes by as the price passes it
                assert!(v + 100 >= last, "{base_first} at {cents}: {v} < {last}");
                last = v;
            }
            // Either way round it is worth about 70 x $100 once the price is far above the range
            let top = c.value(200 * PRICE_ONE, 0).unwrap();
            assert!(top.abs_diff(7_000 * PRICE_ONE) < 30 * PRICE_ONE, "{base_first}: {top}");
        }
    }

    #[test]
    fn no_mix_of_the_two_tokens_a_bin_could_hold_is_worth_less_than_its_value() {
        // One bin of 1000 USDC of liquidity near $73.80, which can hold anything from all SOL to all USDC
        let (id, liquidity) = (-6517, 1_000 * PRICE_ONE);
        let c = flat(id, 4, &[liquidity << 64], true);
        let bin = bin_price(id, 4).unwrap();
        for (cents, usdc_shock) in [(6_000u128, 0u128), (7_380, 0), (7_381, 0), (9_000, 0), (7_000, 300), (7_300, 300), (7_500, 300), (9_000, 300)] {
            let price = cents * PRICE_ONE / 100;
            let value = c.value(price, usdc_shock).unwrap();
            let mut least = u128::MAX;
            for sold in 0..=100 {
                // `sold` percent of the liquidity is still USDC, the rest is the SOL it buys at the bin's price
                let usdc = liquidity * sold / 100;
                let sol = ((liquidity - usdc) << 64) / bin;
                let worth = token_value(sol as u64, price, SOL).unwrap() + cut(usdc, usdc_shock).unwrap();
                assert!(value <= worth, "at {cents} with {sold}% USDC: {value} > {worth}");
                least = least.min(worth);
            }
            // And it is that least value, not something far under it
            assert!(least - value < 100, "at {cents}: {value} vs {least}");
        }
    }
}
