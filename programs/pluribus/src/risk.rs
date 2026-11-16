use anchor_lang::prelude::*;

use crate::{constants::*, error::PluribusError, math::*, oracle::*, orca::*, state::*};

/// An account's collateral valued under every scenario
#[derive(Default)]
pub struct Health {
    scenarios: usize,
    /// Portfolio value per scenario after shocks and liquidation costs
    pub init: [u128; MAX_SCENARIOS],
    pub maint: [u128; MAX_SCENARIOS],
    /// Each position's share of `maint`, kept so a liquidation can be re-checked without a second pass
    pub pos_maint: [[u128; MAX_SCENARIOS]; MAX_POSITIONS],
    /// Unshocked value per position
    pub market: [u128; MAX_POSITIONS],
    /// Price of the token, or of the LP base token
    pub price: [u128; MAX_POSITIONS],
}

/// The worst scenario for the whole portfolio
/// Taking the minimum after summing is what lets spare value in one asset cover a drop in another
pub fn worst(values: &[u128; MAX_SCENARIOS], scenarios: usize) -> u128 {
    values[..scenarios].iter().copied().min().unwrap_or(0)
}

impl Health {
    /// Most the account may owe after a draw or withdrawal
    pub fn credit_limit(&self) -> u128 {
        worst(&self.init, self.scenarios)
    }

    /// Debt above this can be liquidated
    pub fn liquidation_limit(&self) -> u128 {
        worst(&self.maint, self.scenarios)
    }

    pub fn scenarios(&self) -> usize {
        self.scenarios
    }
}

/// Values every position, reading its accounts from `rem` in slot order
/// Token: asset, then its price account unless the asset is fixed at $1
/// LP: LP market, Orca position, base asset, base price account
pub fn evaluate(pool: &Pool, credit: &CreditAccount, rem: &[AccountInfo], now: i64) -> Result<Health> {
    let params = &pool.params;
    let n = params.num_scenarios as usize;
    let mut h = Health { scenarios: n, ..Default::default() };
    let mut accs = rem.iter();
    let mut next = || accs.next().ok_or_else(|| error!(PluribusError::MissingAccount));

    for (i, pos) in credit.positions.iter().enumerate() {
        // Value at a given price, risk group, liquidation cost, paused
        let (value_at, group, cost, paused): (Box<dyn Fn(u128) -> Result<u128>>, u8, u128, bool) = match pos.kind {
            KIND_TOKEN => {
                let asset: Asset = load(next()?)?;
                require_keys_eq!(asset.mint, pos.mint, PluribusError::AccountMismatch);
                h.price[i] = match asset.params.oracle {
                    ORACLE_FIXED => PRICE_ONE,
                    _ => read_price(pool, &asset, next()?, now)?,
                };
                let (amount, decimals) = (pos.amount, asset.decimals);
                (
                    Box::new(move |price| token_value(amount, price, decimals)),
                    asset.params.group,
                    asset.params.liq_cost_bps as u128,
                    asset.params.paused,
                )
            }
            KIND_LP => {
                let market: LpMarket = load(next()?)?;
                let orca = read_position(next()?)?;
                // The NFT in the vault must be this exact position, in the pool the market whitelists
                require_keys_eq!(orca.position_mint, pos.mint, PluribusError::AccountMismatch);
                require_keys_eq!(orca.whirlpool, market.whirlpool, PluribusError::PoolNotWhitelisted);
                let asset: Asset = load(next()?)?;
                require_keys_eq!(asset.mint, market.base_mint, PluribusError::AccountMismatch);
                // Oracle price only: the pool's own price can be pushed around inside one transaction
                h.price[i] = read_price(pool, &asset, next()?, now)?;
                let (lower, upper) = range_sqrt_prices(orca.tick_lower, orca.tick_upper)?;
                let (liquidity, decimals) = (orca.liquidity, asset.decimals);
                (
                    Box::new(move |price| lp_value(liquidity, lower, upper, price, decimals)),
                    asset.params.group,
                    market.liq_cost_bps as u128,
                    market.paused || asset.params.paused,
                )
            }
            _ => continue,
        };

        h.market[i] = value_at(h.price[i])?;
        for s in 0..n {
            let maint = cut(value_at(cut(h.price[i], params.shock(false, s, group))?)?, cost)?;
            h.pos_maint[i][s] = maint;
            h.maint[s] += maint;
            // Paused collateral stops backing new debt but keeps protecting what is already drawn
            if !paused {
                h.init[s] += cut(value_at(cut(h.price[i], params.shock(true, s, group))?)?, cost)?;
            }
        }
    }
    Ok(h)
}

/// Runs after anything that can lower health
/// No debt means nothing to check, so prices are not needed
pub fn require_within_limit(pool: &Pool, credit: &CreditAccount, rem: &[AccountInfo], now: i64) -> Result<()> {
    let debt = pool.debt_of(credit)?;
    if debt == 0 {
        return Ok(());
    }
    require!(debt <= evaluate(pool, credit, rem, now)?.credit_limit(), PluribusError::ExceedsCreditLimit);
    Ok(())
}
