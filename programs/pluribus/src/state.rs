use anchor_lang::prelude::*;

use crate::{constants::*, error::PluribusError, math::*};

/// Admin-set risk and rate parameters
/// Shocks are a scenario-by-group table in bps: row = scenario, column = risk group
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, InitSpace)]
pub struct PoolParams {
    pub num_scenarios: u8,
    /// Applied when debt grows or collateral leaves
    pub init_shock_bps: [u16; MAX_SCENARIOS * MAX_GROUPS],
    /// Applied when deciding whether an account can be liquidated
    pub maint_shock_bps: [u16; MAX_SCENARIOS * MAX_GROUPS],
    pub liq_bonus_bps: u16,
    pub close_factor_bps: u16,
    /// Health under this drops the account to the base rate tier
    pub warn_health_bps: u16,
    pub base_rate_bps: u16,
    pub slope1_bps: u16,
    pub slope2_bps: u16,
    pub kink_bps: u16,
    /// Share of borrower interest kept as the insurance reserve
    pub reserve_factor_bps: u16,
    /// Share of borrower interest the protocol keeps as revenue
    pub protocol_fee_bps: u16,
    pub tier_discount_bps: [u16; TIERS],
    pub tier_min_healthy_secs: [i64; TIERS],
}

impl PoolParams {
    pub fn validate(&self) -> Result<()> {
        let n = self.num_scenarios as usize;
        let ok = (1..=MAX_SCENARIOS).contains(&n)
            && self
                .init_shock_bps
                .iter()
                .zip(self.maint_shock_bps.iter())
                // A liquidation line looser than the draw limit would let draws land already liquidatable
                .all(|(init, maint)| maint <= init && (*init as u128) < BPS)
            && self.liq_bonus_bps <= 2_000
            // One liquidation may repay at most half the debt
            && (1..=5_000).contains(&self.close_factor_bps)
            && self.warn_health_bps as u128 >= BPS
            && (1..BPS).contains(&(self.kink_bps as u128))
            // Lenders always keep at least half the interest
            && self.reserve_factor_bps as u32 + self.protocol_fee_bps as u32 <= 5_000
            && self.tier_discount_bps[0] == 0
            && self.tier_min_healthy_secs[0] == 0
            && self.tier_discount_bps.windows(2).all(|w| w[0] <= w[1])
            && self.tier_min_healthy_secs.windows(2).all(|w| w[0] < w[1]);
        require!(ok, PluribusError::InvalidParams);
        Ok(())
    }

    /// A liquidator's bonus must be smaller than the haircut on what is seized
    /// Otherwise taking collateral would deepen the shortfall and every liquidation would be refused
    pub fn bonus_fits(&self, liq_cost_bps: u16) -> bool {
        (BPS + self.liq_bonus_bps as u128) * BPS.saturating_sub(liq_cost_bps as u128) <= BPS * BPS
    }

    pub fn shock(&self, init: bool, scenario: usize, group: u8) -> u128 {
        let table = if init { &self.init_shock_bps } else { &self.maint_shock_bps };
        // Assets outside every group (USDC) are never shocked
        table.get(scenario * MAX_GROUPS + group as usize).filter(|_| (group as usize) < MAX_GROUPS).map_or(0, |b| *b as u128)
    }
}

/// The single USDC lending pool plus protocol config
#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub admin: Pubkey,
    pub usdc_mint: Pubkey,
    pub usdc_vault: Pubkey,
    pub share_mint: Pubkey,
    pub bump: u8,
    /// When set, prices come from admin-written demo accounts instead of Pyth
    pub demo_mode: bool,
    pub paused: bool,
    pub params: PoolParams,
    /// USDC held for lenders and reserves, tracked here so stray transfers cannot move the share price
    pub cash: u64,
    /// Insurance fund: a claim on pool assets that absorbs bad debt before lenders
    pub reserves: u64,
    /// Protocol revenue the admin can collect, also a claim on pool assets
    pub protocol_fees: u64,
    pub bad_debt: u64,
    pub last_accrual: i64,
    /// Lowest liquidation cost any priced asset or LP market has been given, which caps the liquidation bonus
    pub min_liq_cost_bps: u16,
    /// One borrow index per loyalty tier, since a shared index cannot charge different rates
    pub borrow_index: [u128; TIERS],
    pub debt_shares: [u128; TIERS],
}

impl Pool {
    pub fn signer_seeds(&self) -> [&[u8]; 2] {
        [POOL_SEED, std::slice::from_ref(&self.bump)]
    }

    pub fn total_debt(&self) -> Result<u128> {
        let mut total = 0u128;
        for t in 0..TIERS {
            total += mul_div_ceil(self.debt_shares[t], self.borrow_index[t], INDEX_ONE)?;
        }
        Ok(total)
    }

    /// What lender shares are backed by
    pub fn lender_assets(&self) -> Result<u128> {
        Ok((self.cash as u128 + self.total_debt()?).saturating_sub(self.reserves as u128 + self.protocol_fees as u128))
    }

    pub fn utilization_bps(&self) -> Result<u128> {
        let debt = self.total_debt()?;
        let assets = self.cash as u128 + debt;
        if assets == 0 {
            return Ok(0);
        }
        mul_div_floor(debt, BPS, assets)
    }

    /// Kinked curve: gentle up to the kink, steep after it to pull repayments in
    pub fn base_rate_bps(&self) -> Result<u128> {
        let p = &self.params;
        let (util, kink) = (self.utilization_bps()?, p.kink_bps as u128);
        let base = p.base_rate_bps as u128;
        if util <= kink {
            return Ok(base + mul_div_floor(p.slope1_bps as u128, util, kink)?);
        }
        Ok(base + p.slope1_bps as u128 + mul_div_floor(p.slope2_bps as u128, util - kink, BPS - kink)?)
    }

    pub fn tier_rate_bps(&self, tier: usize) -> Result<u128> {
        Ok(self.base_rate_bps()?.saturating_sub(self.params.tier_discount_bps[tier] as u128))
    }

    pub fn accrue(&mut self, now: i64) -> Result<()> {
        let dt = now.saturating_sub(self.last_accrual);
        if dt <= 0 {
            return Ok(());
        }
        let base = self.base_rate_bps()?;
        let mut interest = 0u128;
        for t in 0..TIERS {
            let rate = base.saturating_sub(self.params.tier_discount_bps[t] as u128);
            let growth = mul_div_ceil(self.borrow_index[t], rate * dt as u128, BPS * SECONDS_PER_YEAR)?;
            interest += mul_div_floor(self.debt_shares[t], growth, INDEX_ONE)?;
            self.borrow_index[t] = self.borrow_index[t].checked_add(growth).ok_or(PluribusError::MathOverflow)?;
        }
        let reserve_cut = to_u64(mul_div_floor(interest, self.params.reserve_factor_bps as u128, BPS)?)?;
        let protocol_cut = to_u64(mul_div_floor(interest, self.params.protocol_fee_bps as u128, BPS)?)?;
        self.reserves = self.reserves.checked_add(reserve_cut).ok_or(PluribusError::MathOverflow)?;
        self.protocol_fees = self.protocol_fees.checked_add(protocol_cut).ok_or(PluribusError::MathOverflow)?;
        self.last_accrual = now;
        Ok(())
    }

    pub fn debt_of(&self, credit: &CreditAccount) -> Result<u128> {
        mul_div_ceil(credit.debt_shares, self.borrow_index[credit.tier as usize], INDEX_ONE)
    }

    pub fn borrow(&mut self, credit: &mut CreditAccount, amount: u64) -> Result<()> {
        require!(self.cash >= amount, PluribusError::InsufficientLiquidity);
        let t = credit.tier as usize;
        let shares = mul_div_ceil(amount as u128, INDEX_ONE, self.borrow_index[t])?;
        credit.debt_shares += shares;
        self.debt_shares[t] += shares;
        self.cash -= amount;
        Ok(())
    }

    /// Whether paying `amount` would retire any of the account's debt shares
    pub fn retires_debt(&self, credit: &CreditAccount, amount: u64) -> Result<bool> {
        let whole = credit.debt_shares > 0 && amount as u128 >= self.debt_of(credit)?;
        Ok(whole || mul_div_floor(amount as u128, INDEX_ONE, self.borrow_index[credit.tier as usize])? > 0)
    }

    /// Applies up to `amount` to the account's debt and returns what was used
    /// A payment too small to retire a share is still taken, which rounds against the borrower
    pub fn repay(&mut self, credit: &mut CreditAccount, amount: u64) -> Result<u64> {
        let t = credit.tier as usize;
        let debt = self.debt_of(credit)?;
        let (paid, shares) = if amount as u128 >= debt {
            (to_u64(debt)?, credit.debt_shares)
        } else {
            (amount, mul_div_floor(amount as u128, INDEX_ONE, self.borrow_index[t])?)
        };
        credit.debt_shares -= shares;
        self.debt_shares[t] -= shares;
        self.cash = self.cash.checked_add(paid).ok_or(PluribusError::MathOverflow)?;
        Ok(paid)
    }

    pub fn move_tier(&mut self, credit: &mut CreditAccount, to: u8) -> Result<()> {
        let debt = self.debt_of(credit)?;
        self.debt_shares[credit.tier as usize] -= credit.debt_shares;
        credit.debt_shares = mul_div_ceil(debt, INDEX_ONE, self.borrow_index[to as usize])?;
        self.debt_shares[to as usize] += credit.debt_shares;
        credit.tier = to;
        Ok(())
    }

    /// Drops debt that no collateral backs and returns the loss with what reserves and protocol fees absorbed
    /// Reserves pay first, then the protocol's uncollected cut, and only the rest lowers the share price
    pub fn write_off(&mut self, credit: &mut CreditAccount) -> Result<(u64, u64, u64)> {
        let loss = to_u64(self.debt_of(credit)?)?;
        self.debt_shares[credit.tier as usize] -= credit.debt_shares;
        credit.debt_shares = 0;
        let from_reserves = loss.min(self.reserves);
        self.reserves -= from_reserves;
        // Interest that was never paid is not revenue, so it goes before lenders take a loss
        let from_fees = (loss - from_reserves).min(self.protocol_fees);
        self.protocol_fees -= from_fees;
        self.bad_debt = self.bad_debt.saturating_add(loss);
        Ok((loss, from_reserves, from_fees))
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, InitSpace)]
pub struct AssetParams {
    /// Column in the shock tables, where anything >= MAX_GROUPS is never shocked
    pub group: u8,
    pub oracle: u8,
    pub pyth_feed_id: [u8; 32],
    pub liq_cost_bps: u16,
    pub max_price_age_secs: u32,
    pub max_conf_bps: u16,
    pub deposit_cap: u64,
    pub paused: bool,
}

impl AssetParams {
    pub fn validate(&self) -> Result<()> {
        require!(
            (self.liq_cost_bps as u128) < BPS
                && self.oracle <= ORACLE_PYTH
                // A zero age or band would make the asset unusable, and a band near 100% lets the price reach zero
                && self.max_price_age_secs > 0
                && (1..=2_000).contains(&self.max_conf_bps),
            PluribusError::InvalidParams
        );
        Ok(())
    }
}

/// A whitelisted collateral token
#[account]
#[derive(InitSpace)]
pub struct Asset {
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub bump: u8,
    pub decimals: u8,
    pub total_deposited: u64,
    pub params: AssetParams,
}

/// A whitelisted Orca Whirlpool whose positions count as collateral, always quoted in USDC
#[account]
#[derive(InitSpace)]
pub struct LpMarket {
    pub whirlpool: Pubkey,
    pub base_mint: Pubkey,
    pub bump: u8,
    pub liq_cost_bps: u16,
    pub paused: bool,
}

/// Admin-written price that replaces Pyth while `Pool::demo_mode` is on
#[account]
#[derive(InitSpace)]
pub struct DemoPrice {
    pub mint: Pubkey,
    pub price: u64,
    pub conf: u64,
    pub publish_time: i64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, InitSpace)]
pub struct Position {
    pub kind: u8,
    /// Token mint, or the Orca position NFT mint
    pub mint: Pubkey,
    /// Token base units, or 1 for an LP position
    pub amount: u64,
}

#[account]
#[derive(InitSpace)]
pub struct CreditAccount {
    pub owner: Pubkey,
    pub bump: u8,
    pub tier: u8,
    pub healthy_since: i64,
    pub debt_shares: u128,
    pub positions: [Position; MAX_POSITIONS],
}

impl CreditAccount {
    pub fn find(&self, kind: u8, mint: &Pubkey) -> Result<usize> {
        self.positions
            .iter()
            .position(|p| p.kind == kind && p.mint == *mint)
            .ok_or_else(|| error!(PluribusError::PositionNotFound))
    }

    pub fn has_collateral(&self) -> bool {
        self.positions.iter().any(|p| p.kind != KIND_EMPTY)
    }

    fn free_slot(&self) -> Result<usize> {
        self.positions
            .iter()
            .position(|p| p.kind == KIND_EMPTY)
            .ok_or_else(|| error!(PluribusError::TooManyPositions))
    }

    pub fn add_token(&mut self, mint: &Pubkey, amount: u64) -> Result<()> {
        let i = match self.find(KIND_TOKEN, mint) {
            Ok(i) => i,
            Err(_) => self.free_slot()?,
        };
        let p = &mut self.positions[i];
        *p = Position { kind: KIND_TOKEN, mint: *mint, amount: p.amount.checked_add(amount).ok_or(PluribusError::MathOverflow)? };
        Ok(())
    }

    pub fn remove_token(&mut self, mint: &Pubkey, amount: u64) -> Result<()> {
        let p = &mut self.positions[self.find(KIND_TOKEN, mint)?];
        p.amount = p.amount.checked_sub(amount).ok_or(PluribusError::InsufficientCollateral)?;
        if p.amount == 0 {
            *p = Position::default();
        }
        Ok(())
    }

    pub fn add_lp(&mut self, mint: &Pubkey) -> Result<()> {
        let i = self.free_slot()?;
        self.positions[i] = Position { kind: KIND_LP, mint: *mint, amount: 1 };
        Ok(())
    }

    pub fn remove_lp(&mut self, mint: &Pubkey) -> Result<()> {
        let i = self.find(KIND_LP, mint)?;
        self.positions[i] = Position::default();
        Ok(())
    }
}
