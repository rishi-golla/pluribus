use anchor_lang::prelude::*;

use crate::{clmm, constants::*, error::PluribusError, math::*, oracle::*, state::*, token2022};

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
                // Orca's tick table can price a Raydium range a hair above what Raydium would pay out, so a part per
                // billion and a base unit come off, keeping the value at or under the payout on either dex
                let v = base + cut(usdc, usdc_shock)?;
                Ok(v.saturating_sub(v / 1_000_000_000 + 1))
            }
        }
    }
}

/// Values every position, reading its accounts from `rem` in slot order
/// Token: asset, its mint and vault if it is a Token-2022 token, then its price account unless the asset is fixed at $1,
/// then for a staking token the SOL price account and, for an SPL stake pool, the pool account
/// LP: LP market, the dex's position, base asset, base price account
pub fn evaluate(pool: &Pool, credit: &CreditAccount, rem: &[AccountInfo], now: i64, scope: Scope) -> Result<Health> {
    let params = &pool.params;
    let n = params.num_scenarios as usize;
    let (want_init, want_maint) = (scope != Scope::Liquidation, scope != Scope::Draw);
    let mut h = Health { scenarios: n, ..Default::default() };
    let mut roots = Roots::default();
    let mut accs = rem.iter();
    let mut next = || accs.next().ok_or_else(|| error!(PluribusError::MissingAccount));

    for (i, pos) in credit.positions.iter().enumerate() {
        let (valuer, group, cost, paused, d) = match pos.kind {
            KIND_TOKEN => {
                let asset: Asset = load(next()?)?;
                require_keys_eq!(asset.mint, pos.mint, PluribusError::AccountMismatch);
                // A Token-2022 asset's mint and vault follow: its issuer can pause it, scale every balance,
                // and move tokens out of or freeze the vault
                let (mint, vault) = if asset.token_program == anchor_spl::token_2022::ID {
                    let acc = next()?;
                    require_keys_eq!(acc.key(), asset.mint, PluribusError::AccountMismatch);
                    require_keys_eq!(*acc.owner, anchor_spl::token_2022::ID, PluribusError::AccountMismatch);
                    let vault = next()?;
                    require_keys_eq!(vault.key(), asset.vault, PluribusError::AccountMismatch);
                    (Some(token2022::read_state(acc)?), Some(token2022::read_vault(vault)?))
                } else {
                    (None, None)
                };
                let (mut fresh, mut moving) = (true, false);
                h.price[i] = match asset.params.oracle {
                    ORACLE_FIXED => PRICE_ONE,
                    _ => {
                        let own = read_price(pool, &asset, next()?, now)?;
                        fresh = own.fresh;
                        // A staking token is worth no more than the SOL behind it, so a thin market cannot lift it above that
                        let price = match asset.params.rate_source {
                            RATE_NONE => own.price,
                            source => {
                                let sol = next()?;
                                let stake_pool = if source == RATE_STAKE_POOL { Some(next()?) } else { None };
                                let backing = backing_price(pool, &asset, sol, stake_pool, now)?;
                                fresh &= backing.fresh;
                                own.price.min(backing.price)
                            }
                        };
                        // A per-share price for a token whose balances carry a corporate-action multiplier
                        let price = match mint.as_ref().and_then(|m| m.scaled).filter(|_| asset.params.ui_multiplier) {
                            Some(s) => {
                                let (m, sure) = token2022::multiplier(&asset, &s, now, own.publish_time, price);
                                moving = !sure;
                                mul_div_floor(price, m, token2022::MULTIPLIER_ONE)?
                            }
                            None => price,
                        };
                        // A vault holding less than its books say pays each holder pro rata, so each booked token is worth that share
                        match vault {
                            Some((held, _)) if (held as u128) < asset.total_deposited as u128 => {
                                mul_div_floor(price, held as u128, asset.total_deposited as u128)?
                            }
                            _ => price,
                        }
                    }
                };
                let valuer = Valuer::Token { amount: pos.amount, decimals: asset.decimals };
                // A halted mint can't be seized, a price only fresh enough for liquidations backs no new debt,
                // and neither does a token whose multiplier basis is unclear or whose vault is short or frozen
                let short = vault.is_some_and(|(held, frozen)| frozen || held < asset.total_deposited);
                let halted = mint.is_some_and(|m| m.halted) || short;
                let paused = asset.params.paused || now < pool.effective_at(asset.active_at) || halted || moving || !fresh;
                let d = asset.dynamic_shocks(params);
                (valuer, asset.params.group, asset.params.liq_cost_bps as u128, paused, d)
            }
            KIND_LP => {
                let market: LpMarket = load(next()?)?;
                let account = next()?;
                // Only the position at the dex's own address for this NFT counts, never another account naming the mint
                require_keys_eq!(account.key(), clmm::position_address(&market, &pos.mint, pos.bump)?, PluribusError::AccountMismatch);
                let lp = clmm::read_position(&market, account)?;
                require_keys_eq!(lp.mint, pos.mint, PluribusError::AccountMismatch);
                let asset: Asset = load(next()?)?;
                require_keys_eq!(asset.mint, market.base_mint, PluribusError::AccountMismatch);
                // Oracle price only: the pool's own price can be pushed around inside one transaction
                let priced = read_price(pool, &asset, next()?, now)?;
                h.price[i] = priced.price;
                let (lower, upper) = range_sqrt_prices(lp.tick_lower, lp.tick_upper)?;
                let valuer = Valuer::Lp { liquidity: lp.liquidity, lower, upper, decimals: asset.decimals };
                let waiting = now < pool.effective_at(market.active_at) || now < pool.effective_at(asset.active_at) || !priced.fresh;
                let d = asset.dynamic_shocks(params);
                (valuer, asset.params.group, market.liq_cost_bps as u128, market.paused || asset.params.paused || waiting, d)
            }
            _ => continue,
        };

        if want_maint {
            h.market[i] = valuer.at(h.price[i], 0, &mut roots)?;
        }
        // The table's shocks with the asset's own volatility laid over them
        // A liquidation line never sits below the draw limit, so each liquidation shock is capped at the draw shock
        let init_shocks = params.shocks_for(true, group, d.0);
        let maint_shocks = params.shocks_for(false, group, d.1);
        for s in 0..n {
            if want_maint {
                let shocked = cut(h.price[i], maint_shocks[s].min(init_shocks[s]))?;
                let maint = cut(valuer.at(shocked, params.shock(false, s, pool.usdc_group), &mut roots)?, cost)?;
                h.pos_maint[i][s] = maint;
                h.maint[s] += maint;
            }
            // Paused collateral, and a listing still in its activation delay, backs no new debt but keeps protecting what is already drawn
            if want_init && !paused {
                let shocked = cut(h.price[i], init_shocks[s])?;
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
