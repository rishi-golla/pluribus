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

/// Which limits a caller needs, so the health check never values a position more often than it has to
#[derive(Clone, Copy, PartialEq)]
pub enum Scope {
    Draw,
    Liquidation,
    All,
}

enum Valuer {
    Token { amount: u64, decimals: u8 },
    Lp { liquidity: u128, lower: u128, upper: u128, decimals: u8 },
}

/// Square roots of the prices already seen in this health check
/// The root is the costly step, and every LP on the same asset asks for the same few crash prices
#[derive(Default)]
struct Roots {
    seen: [(u128, u8, u128); 2 * MAX_SCENARIOS + 1],
    len: usize,
}

impl Roots {
    fn of(&mut self, price: u128, decimals: u8) -> Result<u128> {
        // A crash can round a near-worthless token to zero, which sits under every range
        if price == 0 {
            return Ok(0);
        }
        if let Some(hit) = self.seen[..self.len].iter().find(|r| r.0 == price && r.1 == decimals) {
            return Ok(hit.2);
        }
        let root = sqrt_price_x64(price, decimals)?;
        if self.len < self.seen.len() {
            self.seen[self.len] = (price, decimals, root);
            self.len += 1;
        }
        Ok(root)
    }
}

impl Valuer {
    /// Value at `price`, with the USDC side of an LP position marked down by `usdc_shock`
    /// A position that has gone all USDC would otherwise sail through every crash untouched
    fn at(&self, price: u128, usdc_shock: u128, roots: &mut Roots) -> Result<u128> {
        match *self {
            Valuer::Token { amount, decimals } => token_value(amount, price, decimals),
            Valuer::Lp { liquidity, lower, upper, decimals } => {
                let (base, usdc) = lp_parts(liquidity, lower, upper, price, roots.of(price, decimals)?, decimals)?;
                Ok(base + cut(usdc, usdc_shock)?)
            }
        }
    }
}

/// Values every position, reading its accounts from `rem` in slot order
/// Token: asset, then its price account unless the asset is fixed at $1
/// LP: LP market, Orca position, base asset, base price account
pub fn evaluate(pool: &Pool, credit: &CreditAccount, rem: &[AccountInfo], now: i64, scope: Scope) -> Result<Health> {
    let params = &pool.params;
    let n = params.num_scenarios as usize;
    let (want_init, want_maint) = (scope != Scope::Liquidation, scope != Scope::Draw);
    let mut h = Health { scenarios: n, ..Default::default() };
    let mut roots = Roots::default();
    let mut accs = rem.iter();
    let mut next = || accs.next().ok_or_else(|| error!(PluribusError::MissingAccount));

    for (i, pos) in credit.positions.iter().enumerate() {
        let (valuer, group, cost, paused) = match pos.kind {
            KIND_TOKEN => {
                let asset: Asset = load(next()?)?;
                require_keys_eq!(asset.mint, pos.mint, PluribusError::AccountMismatch);
                h.price[i] = match asset.params.oracle {
                    ORACLE_FIXED => PRICE_ONE,
                    _ => read_price(pool, &asset, next()?, now)?,
                };
                let valuer = Valuer::Token { amount: pos.amount, decimals: asset.decimals };
                (valuer, asset.params.group, asset.params.liq_cost_bps as u128, asset.params.paused || now < pool.effective_at(asset.active_at))
            }
            KIND_LP => {
                let market: LpMarket = load(next()?)?;
                let account = next()?;
                // Only the position at Orca's own address for this NFT counts, never another account naming the mint
                let expected = Pubkey::create_program_address(&[b"position", pos.mint.as_ref(), &[pos.bump]], &WHIRLPOOL_PROGRAM_ID)
                    .map_err(|_| error!(PluribusError::AccountMismatch))?;
                require_keys_eq!(account.key(), expected, PluribusError::AccountMismatch);
                let orca = read_position(account)?;
                require_keys_eq!(orca.position_mint, pos.mint, PluribusError::AccountMismatch);
                require_keys_eq!(orca.whirlpool, market.whirlpool, PluribusError::PoolNotWhitelisted);
                let asset: Asset = load(next()?)?;
                require_keys_eq!(asset.mint, market.base_mint, PluribusError::AccountMismatch);
                // Oracle price only: the pool's own price can be pushed around inside one transaction
                h.price[i] = read_price(pool, &asset, next()?, now)?;
                let (lower, upper) = range_sqrt_prices(orca.tick_lower, orca.tick_upper)?;
                let valuer = Valuer::Lp { liquidity: orca.liquidity, lower, upper, decimals: asset.decimals };
                let waiting = now < pool.effective_at(market.active_at) || now < pool.effective_at(asset.active_at);
                (valuer, asset.params.group, market.liq_cost_bps as u128, market.paused || asset.params.paused || waiting)
            }
            _ => continue,
        };

        if want_maint {
            h.market[i] = valuer.at(h.price[i], 0, &mut roots)?;
        }
        for s in 0..n {
            if want_maint {
                let shocked = cut(h.price[i], params.shock(false, s, group))?;
                let maint = cut(valuer.at(shocked, params.shock(false, s, pool.usdc_group), &mut roots)?, cost)?;
                h.pos_maint[i][s] = maint;
                h.maint[s] += maint;
            }
            // Paused collateral, and a listing still in its activation delay, backs no new debt but keeps protecting what is already drawn
            if want_init && !paused {
                let shocked = cut(h.price[i], params.shock(true, s, group))?;
                h.init[s] += cut(valuer.at(shocked, params.shock(true, s, pool.usdc_group), &mut roots)?, cost)?;
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
    require!(debt <= evaluate(pool, credit, rem, now, Scope::Draw)?.credit_limit(), PluribusError::ExceedsCreditLimit);
    Ok(())
}
