use anchor_lang::prelude::*;
use orca_whirlpools_core::{tick_index_to_sqrt_price, try_get_amount_delta_a, try_get_amount_delta_b};

use crate::{constants::*, error::PluribusError};

fn overflow() -> Error {
    error!(PluribusError::MathOverflow)
}

pub fn mul_div_floor(a: u128, b: u128, d: u128) -> Result<u128> {
    a.checked_mul(b).and_then(|p| p.checked_div(d)).ok_or_else(overflow)
}

pub fn mul_div_ceil(a: u128, b: u128, d: u128) -> Result<u128> {
    let p = a.checked_mul(b).ok_or_else(overflow)?;
    let q = p.checked_div(d).ok_or_else(overflow)?;
    Ok(if p % d == 0 { q } else { q + 1 })
}

pub fn to_u64(v: u128) -> Result<u64> {
    u64::try_from(v).map_err(|_| overflow())
}

pub fn pow10(decimals: u8) -> Result<u128> {
    10u128.checked_pow(decimals as u32).ok_or_else(overflow)
}

/// Value minus `bps`, rounded down
pub fn cut(value: u128, bps: u128) -> Result<u128> {
    mul_div_floor(value, BPS.saturating_sub(bps), BPS)
}

/// USDC base units for `amount` base units of a token priced at `price` (6 decimals, per whole token)
pub fn token_value(amount: u64, price: u128, decimals: u8) -> Result<u128> {
    mul_div_floor(amount as u128, price, pow10(decimals)?)
}

/// Orca Q64.64 sqrt price for an oracle price, where the pool quotes the base token in USDC
/// Rounds down, which lowers every LP valuation
pub fn sqrt_price_x64(price: u128, base_decimals: u8) -> Result<u128> {
    require!(price > 0 && price < 1u128 << 64, PluribusError::MathOverflow);
    // Raw pool price is USDC base units per base-token base unit
    let q = (price << 64) / pow10(base_decimals)?;
    require!(q > 0, PluribusError::MathOverflow);
    // Shift up to an even power of two before the root so it keeps about 63 bits
    let k = q.leading_zeros() & !1;
    let r = (q << k).isqrt();
    Ok(if k / 2 <= 32 { r << (32 - k / 2) } else { r >> (k / 2 - 32) })
}

/// The two sqrt prices bounding a position's range
pub fn range_sqrt_prices(tick_lower: i32, tick_upper: i32) -> Result<(u128, u128)> {
    require!(tick_lower < tick_upper, PluribusError::InvalidLpPosition);
    Ok((tick_index_to_sqrt_price(tick_lower), tick_index_to_sqrt_price(tick_upper)))
}

/// What the position would pay out at `price`, in USDC base units, with fees left out
pub fn lp_value(liquidity: u128, sqrt_lower: u128, sqrt_upper: u128, price: u128, base_decimals: u8) -> Result<u128> {
    let s = sqrt_price_x64(price, base_decimals)?.clamp(sqrt_lower, sqrt_upper);
    let base = try_get_amount_delta_a(s, sqrt_upper, liquidity, false).map_err(|_| overflow())?;
    let usdc = try_get_amount_delta_b(sqrt_lower, s, liquidity, false).map_err(|_| overflow())?;
    token_value(base, price, base_decimals)?.checked_add(usdc as u128).ok_or_else(overflow)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SOL: u8 = 9;

    fn tick(price: f64) -> i32 {
        // Raw price is USDC per SOL scaled by 10^(6-9)
        ((price / 1000.0).ln() / 1.0001f64.ln()).round() as i32
    }

    /// Crash-tested LTV: value after a 30% drop and 5% liquidation cost over value at $150
    fn ltv(lower: i32, upper: i32) -> f64 {
        let (a, b) = range_sqrt_prices(lower, upper).unwrap();
        let l = 5_000_000_000_000u128;
        let now = lp_value(l, a, b, 150 * PRICE_ONE, SOL).unwrap();
        let crashed = cut(lp_value(l, a, b, 105 * PRICE_ONE, SOL).unwrap(), 500).unwrap();
        crashed as f64 / now as f64
    }

    fn close(got: f64, want: f64) {
        assert!((got - want).abs() < 0.001, "got {got}, want {want}");
    }

    #[test]
    fn reference_ltvs() {
        close(ltv(tick(145.5), tick(154.5)), 0.670);
        close(ltv(tick(120.0), tick(180.0)), 0.708);
        close(ltv(tick(75.0), tick(300.0)), 0.764);
        close(ltv(-443584, 443584), 0.795);
        close(ltv(tick(100.0), tick(140.0)), 0.840);
    }

    #[test]
    fn plain_sol_ltv() {
        let v = token_value(1_000_000_000, 150 * PRICE_ONE, SOL).unwrap();
        assert_eq!(v, 150 * PRICE_ONE);
        assert_eq!(cut(cut(v, 3000).unwrap(), 500).unwrap(), 99_750_000);
    }

    #[test]
    fn sqrt_price_matches_float() {
        for p in [0.01f64, 1.0, 71.46, 150.0, 99_999.0] {
            let got = sqrt_price_x64((p * 1e6) as u128, SOL).unwrap() as f64;
            let want = (p / 1000.0).sqrt() * 2f64.powi(64);
            assert!((got / want - 1.0).abs() < 1e-9, "{p}");
            assert!(got <= want * (1.0 + 1e-12));
        }
    }

    #[test]
    fn lp_value_three_regimes() {
        let (a, b) = range_sqrt_prices(tick(120.0), tick(180.0)).unwrap();
        let l = 1_000_000_000_000u128;
        let below = lp_value(l, a, b, 100 * PRICE_ONE, SOL).unwrap();
        let inside = lp_value(l, a, b, 150 * PRICE_ONE, SOL).unwrap();
        let above = lp_value(l, a, b, 200 * PRICE_ONE, SOL).unwrap();
        // Below the range it is all SOL, so value is linear in price
        close(lp_value(l, a, b, 50 * PRICE_ONE, SOL).unwrap() as f64 / below as f64, 0.5);
        // Above the range it is all USDC, so value stops moving
        assert_eq!(above, lp_value(l, a, b, 400 * PRICE_ONE, SOL).unwrap());
        assert!(below < inside && inside < above);
    }

    #[test]
    fn value_never_rises_when_price_falls() {
        let (a, b) = range_sqrt_prices(tick(120.0), tick(180.0)).unwrap();
        let mut last = 0;
        for p in (10..400).step_by(3) {
            let v = lp_value(777_777_777_777, a, b, p * PRICE_ONE, SOL).unwrap();
            assert!(v >= last);
            last = v;
        }
    }

    #[test]
    fn rounding_goes_against_the_borrower() {
        assert_eq!(mul_div_floor(10, 1, 3).unwrap(), 3);
        assert_eq!(mul_div_ceil(10, 1, 3).unwrap(), 4);
        assert_eq!(mul_div_ceil(9, 1, 3).unwrap(), 3);
        assert!(mul_div_floor(u128::MAX, 2, 1).is_err());
    }
}
