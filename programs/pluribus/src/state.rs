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
    /// Share of the senior lenders' interest paid to junior lenders for taking losses first
    pub protection_fee_bps: u16,
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
            && self.protection_fee_bps <= 5_000
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
    /// Share mint of the junior tranche, unset until the admin opens it
    pub junior_mint: Pubkey,
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
    /// Shock group of the USDC asset, applied to the USDC side of LP positions as well
    pub usdc_group: u8,
    /// Part of the lender assets that belongs to junior lenders, who absorb losses before senior ones
    pub junior_assets: u64,
    /// Fractions of a base unit still owed to reserves, protocol fees and junior lenders
    pub dust: [u32; 3],
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

    /// Which tranche a share mint stands for
    pub fn is_junior(&self, share_mint: &Pubkey) -> Result<bool> {
        if *share_mint == self.share_mint {
            return Ok(false);
        }
        require!(self.junior_mint != Pubkey::default() && *share_mint == self.junior_mint, PluribusError::AccountMismatch);
        Ok(true)
    }

    /// What one tranche's shares are backed by
    pub fn tranche_assets(&self, junior: bool) -> Result<u128> {
        let all = self.lender_assets()?;
        let junior_assets = (self.junior_assets as u128).min(all);
        Ok(if junior { junior_assets } else { all - junior_assets })
    }

    /// Takes a lender's USDC into a tranche and returns the shares to mint
    pub fn lend(&mut self, junior: bool, supply: u64, amount: u64) -> Result<u64> {
        let shares = if supply == 0 {
            amount
        } else {
            let assets = self.tranche_assets(junior)?;
            // A wiped-out tranche has shares but nothing behind them, so no price to join at
            require!(assets > 0, PluribusError::PoolInsolvent);
            to_u64(mul_div_floor(amount as u128, supply as u128, assets)?)?
        };
        require!(shares > 0, PluribusError::ZeroAmount);
        self.cash = self.cash.checked_add(amount).ok_or(PluribusError::MathOverflow)?;
        if junior {
            self.junior_assets = self.junior_assets.checked_add(amount).ok_or(PluribusError::MathOverflow)?;
        }
        Ok(shares)
    }

    /// Redeems a tranche's shares and returns the USDC to pay out
    pub fn redeem(&mut self, junior: bool, supply: u64, shares: u64) -> Result<u64> {
        require!(shares > 0 && shares <= supply, PluribusError::ZeroAmount);
        let amount = to_u64(mul_div_floor(shares as u128, self.tranche_assets(junior)?, supply as u128)?)?;
        require!(amount > 0, PluribusError::ZeroAmount);
        // Lent-out USDC cannot leave, and the rate kink is what pulls it back
        require!(amount <= self.cash, PluribusError::InsufficientLiquidity);
        self.cash -= amount;
        if junior {
            self.junior_assets = self.junior_assets.saturating_sub(amount);
        }
        Ok(amount)
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
        let (lenders, junior, debt) = (self.lender_assets()?, self.tranche_assets(true)?, self.total_debt()?);
        for t in 0..TIERS {
            let rate = base.saturating_sub(self.params.tier_discount_bps[t] as u128);
            let growth = mul_div_ceil(self.borrow_index[t], rate * dt as u128, BPS * SECONDS_PER_YEAR)?;
            self.borrow_index[t] = self.borrow_index[t].checked_add(growth).ok_or(PluribusError::MathOverflow)?;
        }
        // Interest is whatever the debt grew by, split at a finer scale than a base unit
        // A keeper accruing every few seconds would otherwise round the small cuts away
        let interest = (self.total_debt()? - debt) * DUST;
        let to_reserves = interest * self.params.reserve_factor_bps as u128 / BPS;
        let to_protocol = interest * self.params.protocol_fee_bps as u128 / BPS;
        self.reserves = Self::carry(self.reserves, &mut self.dust[0], to_reserves)?;
        self.protocol_fees = Self::carry(self.protocol_fees, &mut self.dust[1], to_protocol)?;
        if junior > 0 {
            // Junior lenders earn their own share of the interest plus a cut of the senior share
            let to_lenders = interest - to_reserves - to_protocol;
            let own = mul_div_wide(to_lenders, junior, lenders)?;
            // A thin junior tranche covers little, so it earns the fee only in proportion to how much of the target it fills
            // Otherwise one unit of junior money would collect the whole fee from every senior lender
            let filled = (junior * BPS).min(lenders * JUNIOR_TARGET_BPS);
            let fee = mul_div_wide(to_lenders - own, self.params.protection_fee_bps as u128 * filled, BPS * lenders * JUNIOR_TARGET_BPS)?;
            self.junior_assets = Self::carry(self.junior_assets, &mut self.dust[2], own + fee)?;
        }
        self.last_accrual = now;
        Ok(())
    }

    /// Adds a scaled amount to a balance, keeping the part under one base unit for the next accrual
    fn carry(balance: u64, dust: &mut u32, scaled: u128) -> Result<u64> {
        let total = scaled + *dust as u128;
        *dust = (total % DUST) as u32;
        balance.checked_add(to_u64(total / DUST)?).ok_or_else(|| error!(PluribusError::MathOverflow))
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

    /// Drops debt that no collateral backs and returns the loss with what reserves, protocol fees and junior lenders absorbed
    /// Reserves pay first, then the protocol's uncollected cut, then junior lenders, and senior lenders take what is left
    pub fn write_off(&mut self, credit: &mut CreditAccount) -> Result<(u64, u64, u64, u64)> {
        let loss = to_u64(self.debt_of(credit)?)?;
        self.debt_shares[credit.tier as usize] -= credit.debt_shares;
        credit.debt_shares = 0;
        let from_reserves = loss.min(self.reserves);
        self.reserves -= from_reserves;
        // Interest that was never paid is not revenue, so it goes before lenders take a loss
        let from_fees = (loss - from_reserves).min(self.protocol_fees);
        self.protocol_fees -= from_fees;
        let from_junior = (loss - from_reserves - from_fees).min(self.junior_assets);
        self.junior_assets -= from_junior;
        self.bad_debt = self.bad_debt.saturating_add(loss);
        Ok((loss, from_reserves, from_fees, from_junior))
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
    /// Bump of Orca's address for an LP position, so the health check can confirm it cheaply
    pub bump: u8,
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
        *p = Position { kind: KIND_TOKEN, mint: *mint, amount: p.amount.checked_add(amount).ok_or(PluribusError::MathOverflow)?, bump: 0 };
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

    pub fn add_lp(&mut self, mint: &Pubkey, bump: u8) -> Result<()> {
        let i = self.free_slot()?;
        self.positions[i] = Position { kind: KIND_LP, mint: *mint, amount: 1, bump };
        Ok(())
    }

    pub fn remove_lp(&mut self, mint: &Pubkey) -> Result<()> {
        let i = self.find(KIND_LP, mint)?;
        self.positions[i] = Position::default();
        Ok(())
    }
}
