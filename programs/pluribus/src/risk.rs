use anchor_lang::prelude::*;

use crate::{clmm, constants::*, dlmm, error::PluribusError, events::PremiumBooked, math::*, oracle::*, state::*, token2022};

/// An account's collateral valued under every scenario
/// The per-position fields live on the heap, one entry per slot, since at 16 slots they would overflow the 4 KiB stack frame
pub struct Health {
    scenarios: usize,
    /// Portfolio value per scenario after shocks and liquidation costs
    pub init: [u128; MAX_SCENARIOS],
    pub maint: [u128; MAX_SCENARIOS],
    /// Each position's share of `maint`, kept so a liquidation can be re-checked without a second pass
    pub pos_maint: Vec<[u128; MAX_SCENARIOS]>,
    /// Unshocked value per position
    pub market: Vec<u128>,
    /// Price of the token, or of the LP base token
    pub price: Vec<u128>,
    /// A token whose price is unclear right now, around a corporate action, which can't be seized until it is clear
    pub unclear: Vec<bool>,
    /// A token no liquidator can be handed right now, unclear or halted, which the liquidation order steps over
    pub stuck: Vec<bool>,
    /// The liquidator's bonus in bps on each position
    pub bonus: Vec<u16>,
    /// Draw value per scenario of every position, paused or not, and the same with each position weighted by its risk premium
    /// Sums rather than a table per position, which keeps the heap small
    pub all_init: [u128; MAX_SCENARIOS],
    pub premium_weighted: [u128; MAX_SCENARIOS],
}

impl Default for Health {
    fn default() -> Self {
        Health {
            scenarios: 0,
            init: [0; MAX_SCENARIOS],
            maint: [0; MAX_SCENARIOS],
            pos_maint: vec![[0; MAX_SCENARIOS]; MAX_POSITIONS],
            market: vec![0; MAX_POSITIONS],
            price: vec![0; MAX_POSITIONS],
            unclear: vec![false; MAX_POSITIONS],
            stuck: vec![false; MAX_POSITIONS],
            bonus: vec![0; MAX_POSITIONS],
            all_init: [0; MAX_SCENARIOS],
            premium_weighted: [0; MAX_SCENARIOS],
        }
    }
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

    /// Whether a liquidation may take position `i` now
    /// The order is the protocol's: first goes the position whose sale costs the liquidation limit least per dollar of debt repaid,
    /// which is its value in the scenario that sets the limit, per dollar of market value, times one plus its bonus
    /// So each sale closes as much of the shortfall as any could, and the collateral the crash test counts on most is kept longest
    /// USDC is outside the order, since it is netted against debt at no bonus, and so is a position worth nothing
    /// Only filled by a health check that values liquidations
    pub fn first_in_order(&self, i: usize, positions: &[Position], usdc: &Pubkey, debt: u128) -> Result<bool> {
        let limit = self.liquidation_limit();
        if self.market[i] == 0 || debt * BPS > limit * (BPS + ORDER_SLACK_BPS) {
            return Ok(true);
        }
        let Some(s) = (0..self.scenarios).min_by_key(|&s| self.maint[s]) else { return Ok(true) };
        let key = |j: usize| mul_div_floor(self.pos_maint[j][s] * (BPS + self.bonus[j] as u128), ORDER_SCALE, self.market[j] * BPS);
        let mine = key(i)?;
        for (j, pos) in positions.iter().enumerate() {
            let outside = pos.kind == KIND_EMPTY || j == i || self.stuck[j] || self.market[j] == 0 || (pos.kind == KIND_TOKEN && pos.mint == *usdc);
            if !outside && key(j)? + ORDER_TIE < mine {
                return Ok(false);
            }
        }
        Ok(true)
    }

    /// The collateral's risk premium in bps a year: each position's premium weighted by its draw value
    /// in the scenario where the whole portfolio is worth least, so collateral worth little in a crash adds little
    /// Only filled by a health check that values draws
    pub fn premium_bps(&self) -> u16 {
        let Some(s) = (0..self.scenarios).min_by_key(|&s| self.all_init[s]) else { return 0 };
        if self.all_init[s] == 0 {
            return 0;
        }
        (self.premium_weighted[s] / self.all_init[s]).min(MAX_RISK_PREMIUM_BPS as u128) as u16
    }
}

/// Which limits a caller needs, so the health check never values a position more often than it has to
#[derive(Clone, Copy, PartialEq)]
pub enum Scope {
    Draw,
    Liquidation,
    All,
}

enum Valuer<'a> {
    Token { amount: u64, decimals: u8 },
    Lp { liquidity: u128, lower: u128, upper: u128, decimals: u8 },
    /// The one curve the health check refills for each Meteora position
    Dlmm(&'a dlmm::Curve),
}

/// Square roots of the prices already seen in this health check
/// The root is the costly step, and every LP on the same asset asks for the same few crash prices
/// Kept on the heap, since the health check's stack frame is nearly full
#[derive(Default)]
struct Roots {
    seen: Vec<(u128, u8, u128)>,
}

impl Roots {
    fn of(&mut self, price: u128, decimals: u8) -> Result<u128> {
        // A crash can round a near-worthless token to zero, which sits under every range
        if price == 0 {
            return Ok(0);
        }
        if let Some(hit) = self.seen.iter().find(|r| r.0 == price && r.1 == decimals) {
            return Ok(hit.2);
        }
        let root = sqrt_price_x64(price, decimals)?;
        // The spot price and each scenario's two crash prices, which is all one asset ever asks for
        if self.seen.len() < 2 * MAX_SCENARIOS + 1 {
            self.seen.push((price, decimals, root));
        }
        Ok(root)
    }
}

impl Valuer<'_> {
    /// Value at `price`, with the USDC side of an LP position marked down by `usdc_shock`
    /// A position that has gone all USDC would otherwise sail through every crash untouched
    fn at(&self, price: u128, usdc_shock: u128, roots: &mut Roots) -> Result<u128> {
        match *self {
            Valuer::Token { amount, decimals } => token_value(amount, price, decimals),
            Valuer::Lp { liquidity, lower, upper, decimals } => {
                let (base, usdc) = lp_parts(liquidity, lower, upper, price, roots.of(price, decimals)?, decimals)?;
                // Kept at or under the payout on either dex
                Ok(under_payout(base + cut(usdc, usdc_shock)?))
            }
            Valuer::Dlmm(curve) => curve.value(price, usdc_shock),
        }
    }
}

/// Values every position, reading its accounts from `rem` in slot order
/// Token: asset, its mint and vault if it is a Token-2022 token, then its price account unless the asset is fixed at $1,
/// then for a staking token the SOL price account and, for an SPL stake pool, the pool account
/// LP: LP market, the dex's position, base asset, base price account
/// Meteora position: LP market, the pair, the position, base asset, base price account
pub fn evaluate(pool: &Pool, credit: &CreditAccount, rem: &[AccountInfo], now: i64, scope: Scope) -> Result<Health> {
    let params = &pool.params;
    let n = params.num_scenarios as usize;
    let (want_init, want_maint) = (scope != Scope::Liquidation, scope != Scope::Draw);
    let mut h = Health { scenarios: n, ..Default::default() };
    let mut roots = Roots::default();
    let mut curve = dlmm::Curve::default();
    let mut accs = rem.iter();
    let mut next = || accs.next().ok_or_else(|| error!(PluribusError::MissingAccount));

    for (i, pos) in credit.positions.iter().enumerate() {
        let (valuer, group, cost, paused, d, premium) = match pos.kind {
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
                                let (token, clear) = token2022::token_price(&asset, &s, now, own.publish_time, price)?;
                                moving = !clear;
                                token
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
                let valuer = Valuer::Token { amount: pos.amount, decimals: asset.price_decimals() };
                // A halted mint can't be seized, a price only fresh enough for liquidations backs no new debt,
                // and neither does a token whose multiplier basis is unclear or whose vault is short or frozen
                let short = vault.is_some_and(|(held, frozen)| frozen || held < asset.total_deposited);
                let halted = mint.is_some_and(|m| m.halted) || short;
                let paused = asset.params.paused || now < pool.effective_at(asset.active_at) || halted || moving || !fresh;
                h.unclear[i] = moving;
                h.stuck[i] = moving || halted;
                h.bonus[i] = asset.liq_bonus(params, false);
                let d = asset.dynamic_shocks(params);
                (valuer, asset.params.group, asset.params.liq_cost_bps as u128, paused, d, asset.premium_bps)
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
                let valuer = Valuer::Lp { liquidity: lp.liquidity, lower, upper, decimals: asset.price_decimals() };
                let waiting = now < pool.effective_at(market.active_at) || now < pool.effective_at(asset.active_at) || !priced.fresh;
                h.bonus[i] = asset.liq_bonus(params, true);
                let d = asset.dynamic_shocks(params);
                // An LP carries its base token's premium, since that is the side a crash takes down
                (valuer, asset.params.group, market.liq_cost_bps as u128, market.paused || asset.params.paused || waiting, d, asset.premium_bps)
            }
            KIND_DLMM => {
                let market: LpMarket = load(next()?)?;
                let pair = next()?;
                let account = next()?;
                // A Meteora position has no NFT, so the slot names the position account itself
                require_keys_eq!(account.key(), pos.mint, PluribusError::AccountMismatch);
                let asset: Asset = load(next()?)?;
                require_keys_eq!(asset.mint, market.base_mint, PluribusError::AccountMismatch);
                // Oracle price only, and the pair's active bin and reserves are never read
                let priced = read_price(pool, &asset, next()?, now)?;
                h.price[i] = priced.price;
                dlmm::read_curve(&mut curve, pool, &market, pair, account, asset.price_decimals())?;
                let valuer = Valuer::Dlmm(&curve);
                let waiting = now < pool.effective_at(market.active_at) || now < pool.effective_at(asset.active_at) || !priced.fresh;
                h.bonus[i] = asset.liq_bonus(params, true);
                let d = asset.dynamic_shocks(params);
                // Like any LP, it carries its base token's premium
                (valuer, asset.params.group, market.liq_cost_bps as u128, market.paused || asset.params.paused || waiting, d, asset.premium_bps)
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
            // Paused collateral, and a listing still in its activation delay, backs no new debt but keeps protecting what is already drawn,
            // so it still weighs the premium
            if want_init {
                let shocked = cut(h.price[i], init_shocks[s])?;
                let init = cut(valuer.at(shocked, params.shock(true, s, pool.usdc_group), &mut roots)?, cost)?;
                h.all_init[s] = h.all_init[s].saturating_add(init);
                h.premium_weighted[s] = h.premium_weighted[s].saturating_add(init.saturating_mul(premium as u128));
                if !paused {
                    h.init[s] += init;
                }
            }
        }
    }
    Ok(h)
}

/// Runs after anything that can lower health, and resets the account's risk premium to its collateral as valued here
/// No debt means nothing to check, so prices are not needed
pub fn require_within_limit(pool: &Pool, credit: &mut CreditAccount, rem: &[AccountInfo], now: i64) -> Result<()> {
    let debt = pool.debt_of(credit)?;
    if debt == 0 {
        return Ok(());
    }
    let h = evaluate(pool, credit, rem, now, Scope::Draw)?;
    require!(debt <= h.credit_limit(), PluribusError::ExceedsCreditLimit);
    credit.premium_bps = h.premium_bps();
    Ok(())
}

/// Books the account's risk premium as debt before anything reads or changes its debt or tier
pub fn book_premium(pool: &mut Pool, credit: &mut Account<CreditAccount>, now: i64) -> Result<()> {
    let amount = pool.book_premium(credit, now)?;
    if amount > 0 {
        let rate_bps = pool.premium_rate_bps(credit).min(u16::MAX as u128) as u16;
        emit!(PremiumBooked { account: credit.key(), amount, rate_bps, debt: to_u64(pool.debt_of(credit)?)? });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Two tokens worth $100 each that one scenario values at $78.85 and $74.70, with debt just over the limit
    fn order(bonus: [u16; 2], stuck: bool, debt: u128) -> [bool; 2] {
        let mut h = Health { scenarios: 1, ..Default::default() };
        for (i, maint) in [78_850_000u128, 74_700_000].into_iter().enumerate() {
            (h.market[i], h.pos_maint[i][0], h.bonus[i]) = (100_000_000, maint, bonus[i]);
            h.maint[0] += maint;
        }
        h.stuck[1] = stuck;
        let token = Position { kind: KIND_TOKEN, mint: Pubkey::new_unique(), ..Default::default() };
        let positions = [token, Position { mint: Pubkey::new_unique(), ..token }];
        let usdc = Pubkey::new_unique();
        [0, 1].map(|i| h.first_in_order(i, &positions, &usdc, debt).unwrap())
    }

    #[test]
    fn the_order_follows_value_under_the_limits_scenario_times_one_plus_the_bonus() {
        let over = 153_550_001;
        // 0.7885 x 1.05 against 0.747 x 1.05: the second costs the limit less
        assert_eq!(order([500, 500], false, over), [false, true]);
        // 0.7885 x 1.00 against 0.747 x 1.10: the bonus turns it around
        assert_eq!(order([0, 1000], false, over), [true, false]);
        // 0.7885 x 1.00 against 0.747 x 1.0556: level within the tie
        assert_eq!(order([0, 556], false, over), [true, true]);
        // A position that can't be handed over is stepped over
        assert_eq!(order([500, 500], true, over), [true, true]);
        // More than a tenth over the limit, any position can go
        assert_eq!(order([500, 500], false, 153_550_000 * 11 / 10 + 1), [true, true]);
    }
}
