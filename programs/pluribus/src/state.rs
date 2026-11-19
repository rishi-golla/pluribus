use anchor_lang::prelude::*;

use crate::{constants::*, error::PluribusError, events::EpochOpened, math::*};

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
    /// Share of the yield buffer held back when an epoch opens, so it carries into the next one
    /// It smooths the yield from week to week and takes losses before anyone else
    pub yield_margin_bps: u16,
    /// Length of a payout epoch, aligned to Fridays at 00:00 UTC, or 0 to pay lenders' interest out as it accrues
    pub epoch_secs: u32,
    pub tier_discount_bps: [u16; TIERS],
    pub tier_min_healthy_secs: [i64; TIERS],
    /// Junior share of lender assets at which junior lenders earn the whole premium, below it the premium scales down
    pub junior_target_bps: u16,
    /// Risk premium: junior lenders earn the senior rate plus this share of the senior yield on every senior dollar they cover
    /// Junior rate = senior rate x (1 + premium x senior / junior), the premium scaled down below the target share
    pub junior_premium_bps: u16,
    /// Wait before a queued junior exit can be claimed, from the min with an empty queue up to the max
    pub junior_min_delay_secs: u32,
    pub junior_max_delay_secs: u32,
    /// Queued share of the junior supply at which the wait reaches its max
    pub junior_delay_threshold_bps: u16,
    /// Time after the wait in which an exit must be claimed, or it lapses and the shares go back to work
    /// Between MIN_JUNIOR_EXIT_WINDOW_SECS and MAX_JUNIOR_EXIT_WINDOW_SECS
    pub junior_exit_window_secs: u32,
    /// Taken from a junior claim and left with the junior lenders who stay
    pub junior_exit_fee_bps: u16,
    /// Longest governance pause of junior exits, never above MAX_JUNIOR_PAUSE_SECS
    pub junior_max_pause_secs: u32,
    /// Unpaused time required between two pauses: at least the longest wait plus MAX_JUNIOR_EXIT_WINDOW_SECS,
    /// and at least the activation delay
    pub junior_pause_gap_secs: u32,
    /// Wait before new collateral, or any change that is not a pure tightening, takes effect
    /// At least the longest junior wait plus the claim window, so juniors who disagree can leave first
    pub activation_delay_secs: u32,
    /// Dynamic shock d = z x sigma x sqrt(T) per asset, with z in hundredths for the draw and liquidation tables
    pub z_init_x100: u16,
    pub z_maint_x100: u16,
    /// Two averages of each asset's variance: the fast one lets a rise in volatility in quickly, the slow one makes it fade slowly
    pub vol_tau_fast_secs: u32,
    pub vol_tau_slow_secs: u32,
    /// A volatility sample needs a price this much newer than the last one, at most this old and this certain
    pub vol_min_interval_secs: u32,
    pub vol_max_age_secs: u32,
    pub vol_conf_cap_bps: u16,
    /// Largest shock any scenario can apply, dynamic or not
    pub max_shock_bps: u16,
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
            // An epoch always pays out at least half of what the buffer holds
            && self.yield_margin_bps <= 5_000
            && (self.epoch_secs == 0 || (MIN_EPOCH_SECS..=MAX_EPOCH_SECS).contains(&self.epoch_secs))
            && self.tier_discount_bps[0] == 0
            && self.tier_min_healthy_secs[0] == 0
            && self.tier_discount_bps.windows(2).all(|w| w[0] <= w[1])
            && self.tier_min_healthy_secs.windows(2).all(|w| w[0] < w[1])
            // A tiny target with a large premium would hand most of the yield to a sliver of junior money
            && (100..=BPS).contains(&(self.junior_target_bps as u128))
            && self.junior_premium_bps <= 5_000
            && self.junior_min_delay_secs <= self.junior_max_delay_secs
            // A queue that waits at all waits for every exit, or small exits would round their way past it
            && (self.junior_min_delay_secs > 0 || self.junior_max_delay_secs == 0)
            && self.junior_max_delay_secs <= MAX_JUNIOR_DELAY_SECS
            && (1..=BPS).contains(&(self.junior_delay_threshold_bps as u128))
            && (MIN_JUNIOR_EXIT_WINDOW_SECS..=MAX_JUNIOR_EXIT_WINDOW_SECS).contains(&self.junior_exit_window_secs)
            && self.junior_exit_fee_bps <= MAX_JUNIOR_EXIT_FEE_BPS
            && self.junior_max_pause_secs <= MAX_JUNIOR_PAUSE_SECS
            // Between two pauses any junior can queue, wait out the longest delay and use the longest claim window,
            // and every waiting change gets its full activation delay, so pauses can never be chained past the cap
            && self.junior_pause_gap_secs as u64 >= self.junior_max_delay_secs as u64 + MAX_JUNIOR_EXIT_WINDOW_SECS as u64
            && self.junior_pause_gap_secs >= self.activation_delay_secs
            && self.activation_delay_secs <= MAX_ACTIVATION_DELAY_SECS
            && self.z_maint_x100 <= self.z_init_x100
            && self.z_init_x100 <= 1_000
            && 0 < self.vol_tau_fast_secs
            && self.vol_tau_fast_secs <= self.vol_tau_slow_secs
            && 0 < self.vol_min_interval_secs
            && self.vol_min_interval_secs <= self.vol_tau_fast_secs
            && self.vol_max_age_secs > 0
            && (1..=2_000).contains(&self.vol_conf_cap_bps)
            && (self.max_shock_bps as u128) < BPS
            && self.init_shock_bps.iter().all(|s| *s <= self.max_shock_bps)
            // A junior who queues the moment a change is announced can wait out the longest delay and still claim
            // before it applies, so applying it and pausing in one go never traps them; with no queue they leave at once
            && (self.junior_max_delay_secs == 0
                || self.activation_delay_secs as u64 >= self.junior_max_delay_secs as u64 + self.junior_exit_window_secs as u64);
        require!(ok, PluribusError::InvalidParams);
        Ok(())
    }

    /// True when `next` only raises shocks or adds scenarios, the one kind of change that applies at once
    /// Anything else waits out the activation delay
    pub fn only_tightens(&self, next: &PoolParams) -> bool {
        let raised = |old: &[u16], new: &[u16]| old.iter().zip(new).all(|(o, n)| n >= o);
        let rest_same = PoolParams {
            num_scenarios: self.num_scenarios,
            init_shock_bps: self.init_shock_bps,
            maint_shock_bps: self.maint_shock_bps,
            ..*next
        } == *self;
        rest_same
            && next.num_scenarios >= self.num_scenarios
            && raised(&self.init_shock_bps, &next.init_shock_bps)
            && raised(&self.maint_shock_bps, &next.maint_shock_bps)
            && self.keeps_dynamic_share(next, true)
            && self.keeps_dynamic_share(next, false)
    }

    /// A dynamic shock reaches each scenario as table / worst of the group, so raising a group's worst entry alone
    /// would lower it everywhere else: a tightening must keep that share in every scenario that already existed
    fn keeps_dynamic_share(&self, next: &PoolParams, init: bool) -> bool {
        let worst = |p: &PoolParams, g: u8| (0..p.num_scenarios as usize).map(|s| p.shock(init, s, g)).max().unwrap_or(0);
        (0..MAX_GROUPS as u8).all(|g| {
            let (old_worst, new_worst) = (worst(self, g), worst(next, g));
            (0..self.num_scenarios as usize).all(|s| next.shock(init, s, g) * old_worst >= self.shock(init, s, g) * new_worst)
        })
    }

    /// Wait for a junior exit queued when `queued` of `supply` junior shares are in the queue, this one included
    pub fn junior_exit_delay(&self, queued: u64, supply: u64) -> i64 {
        let (min, max) = (self.junior_min_delay_secs as u128, self.junior_max_delay_secs as u128);
        let threshold = self.junior_delay_threshold_bps as u128;
        // Rounded up, so even the smallest exit moves the wait
        let share = if supply == 0 { threshold } else { (queued as u128 * BPS).div_ceil(supply as u128).min(threshold) };
        (min + ((max - min) * share).div_ceil(threshold)) as i64
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

    /// An asset's shock in every scenario, with its dynamic shock `d` (bps) laid over the table
    /// The scenario where the asset's group falls hardest takes all of `d`, the others the same fraction of it as in the table,
    /// so a volatile asset falls further without breaking the joint scenarios. Never below the table, never above the cap
    pub fn shocks_for(&self, init: bool, group: u8, d: u128) -> [u128; MAX_SCENARIOS] {
        let n = self.num_scenarios as usize;
        let mut out = [0u128; MAX_SCENARIOS];
        let worst = (0..n).map(|s| self.shock(init, s, group)).max().unwrap_or(0);
        for (s, slot) in out.iter_mut().enumerate().take(n) {
            let table = self.shock(init, s, group);
            let scaled = if worst == 0 { 0 } else { d.saturating_mul(table) / worst };
            *slot = table.max(scaled).min(self.max_shock_bps as u128);
        }
        out
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
    /// May only tighten risk: pause collateral and drop waiting changes, never pause junior exits
    pub guardian: Pubkey,
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
    /// Junior shares waiting in the exit queue
    pub junior_queued: u64,
    /// The latest governance pause of junior exits, from start until end
    pub junior_pause_start: i64,
    pub junior_pause_end: i64,
    /// Earliest start of the next pause, fixed when a pause starts or is lifted so a later cut to the gap cannot bring it forward
    pub junior_next_pause_at: i64,
    /// Looser parameters waiting out the activation delay, live from `pending_at`, which is 0 when nothing waits
    pub pending_params: PoolParams,
    pub pending_at: i64,
    /// Lenders' interest not yet paid out: it collects here and is paid out evenly over the next epoch
    /// It belongs to no lender until paid, so it takes losses first
    pub yield_buffer: u64,
    /// The current payout epoch and the budget it pays out evenly, fixed when it opened
    pub epoch_start: i64,
    pub epoch_end: i64,
    pub epoch_budget: u64,
    pub epoch_paid: u64,
    /// Senior shares waiting in the withdrawal queue, held in the senior escrow
    /// Added after launch: `migrate_pool` grows a pool created before them, and the new bytes start at zero
    pub senior_queued: u64,
    /// The most the queued senior exits can be owed, held back from idle cash so nothing else spends it first
    pub senior_reserved: u64,
    /// Ticket the next queued senior exit gets, and the ticket the queue pays next
    pub senior_next_ticket: u64,
    pub senior_head: u64,
    /// Share of each asset's risk premium charged in each loyalty tier, so the premium fades while an account stays healthy
    /// Added after launch: a pool grown by `migrate_pool` charges no premium until these are set
    pub premium_tier_bps: [u16; TIERS],
    /// Higher shares waiting out the activation delay, live from `premium_tier_pending_at` when that is not 0
    pub pending_premium_tier_bps: [u16; TIERS],
    pub premium_tier_pending_at: i64,
    /// Risk premium booked as debt to date
    pub premium_booked: u64,
}

impl Pool {
    pub fn signer_seeds(&self) -> [&[u8]; 2] {
        [POOL_SEED, std::slice::from_ref(&self.bump)]
    }

    /// Idle USDC that draws, instant withdrawals, junior cash claims and fee collection may use:
    /// cash held back for queued senior exits is spent on the queue first
    pub fn available_cash(&self) -> u64 {
        self.cash.saturating_sub(self.senior_reserved)
    }

    pub fn total_debt(&self) -> Result<u128> {
        let mut total = 0u128;
        for t in 0..TIERS {
            total += mul_div_wide_ceil(self.debt_shares[t], self.borrow_index[t], INDEX_ONE)?;
        }
        Ok(total)
    }

    /// What lender shares are backed by, interest still waiting in the yield buffer left out
    pub fn lender_assets(&self) -> Result<u128> {
        let claims = self.reserves as u128 + self.protocol_fees as u128 + self.yield_buffer as u128;
        Ok((self.cash as u128 + self.total_debt()?).saturating_sub(claims))
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

    /// Shares that `amount` of value buys in a tranche, rounded down
    pub fn shares_for(&self, junior: bool, supply: u64, amount: u64) -> Result<u64> {
        let assets = self.tranche_assets(junior)?;
        to_u64(mul_div_wide(amount as u128, supply as u128 + VIRTUAL_SHARES, assets + VIRTUAL_SHARES)?)
    }

    /// What `shares` of a tranche are worth, rounded down
    pub fn value_of(&self, junior: bool, supply: u64, shares: u64) -> Result<u64> {
        require!(shares > 0 && shares <= supply, PluribusError::ZeroAmount);
        let assets = self.tranche_assets(junior)?;
        let with_virtual = mul_div_wide(shares as u128, assets + VIRTUAL_SHARES, supply as u128 + VIRTUAL_SHARES)?;
        // After a loss the virtual assets would promise money the tranche does not hold, so the plain price caps the payout
        to_u64(with_virtual.min(mul_div_wide(shares as u128, assets, supply as u128)?))
    }

    /// Takes a lender's USDC into a tranche and returns the shares to mint
    pub fn lend(&mut self, junior: bool, supply: u64, amount: u64) -> Result<u64> {
        let shares = self.shares_for(junior, supply, amount)?;
        require!(shares > 0, PluribusError::ZeroAmount);
        self.cash = self.cash.checked_add(amount).ok_or(PluribusError::MathOverflow)?;
        if junior {
            self.junior_assets = self.junior_assets.checked_add(amount).ok_or(PluribusError::MathOverflow)?;
        }
        Ok(shares)
    }

    /// Redeems a tranche's shares and returns the USDC to pay out
    pub fn redeem(&mut self, junior: bool, supply: u64, shares: u64) -> Result<u64> {
        let amount = self.value_of(junior, supply, shares)?;
        require!(amount > 0, PluribusError::ZeroAmount);
        // Lent-out USDC cannot leave, and the rate kink is what pulls it back; cash held for the queue is not idle
        require!(amount <= self.available_cash(), PluribusError::InsufficientLiquidity);
        self.cash -= amount;
        if junior {
            self.junior_assets = self.junior_assets.saturating_sub(amount);
        }
        Ok(amount)
    }

    /// Moves senior shares into the junior tranche at both share prices, with no USDC changing hands
    /// Returns the value moved and the junior shares to mint
    pub fn to_junior(&mut self, senior_supply: u64, shares: u64, junior_supply: u64) -> Result<(u64, u64)> {
        let value = self.value_of(false, senior_supply, shares)?;
        let minted = self.shares_for(true, junior_supply, value)?;
        require!(value > 0 && minted > 0, PluribusError::ZeroAmount);
        self.junior_assets = self.junior_assets.checked_add(value).ok_or(PluribusError::MathOverflow)?;
        Ok((value, minted))
    }

    pub fn junior_exits_paused(&self, now: i64) -> bool {
        now < self.junior_pause_end
    }

    /// When something set to take effect at `at` really does
    /// A pause of junior exits that began before then moves it to a full activation delay after the pause ends,
    /// so juniors always get that long, unpaused, to leave before new risk or looser settings apply
    pub fn effective_at(&self, at: i64) -> i64 {
        if self.junior_pause_end > self.junior_pause_start && self.junior_pause_start <= at {
            at.max(self.junior_pause_end.saturating_add(self.params.activation_delay_secs as i64))
        } else {
            at
        }
    }

    /// What a queued exit pays before the fee: never more than the shares were worth when queued,
    /// so a queued exit earns nothing while it waits but still takes any loss
    pub fn junior_exit_value(&self, junior_supply: u64, exit: &JuniorExit) -> Result<u64> {
        Ok(self.value_of(true, junior_supply, exit.shares)?.min(exit.value))
    }

    /// Last moment a queued junior exit can be claimed
    /// A pause that overlaps the claim window moves it to a full window after the pause ends
    pub fn junior_exit_deadline(&self, exit: &JuniorExit) -> i64 {
        let window = (exit.window_secs.max(self.params.junior_exit_window_secs)) as i64;
        let end = exit.unlock_at.saturating_add(window);
        if self.junior_pause_end > exit.unlock_at && self.junior_pause_start < end {
            self.junior_pause_end.saturating_add(window)
        } else {
            end
        }
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
        let debt = self.total_debt()?;
        // Taken before the interest lands, so one long accrual and many short ones split it the same way
        let weights = self.split_weights()?;
        for t in 0..TIERS {
            let rate = base.saturating_sub(self.params.tier_discount_bps[t] as u128);
            let growth = mul_div_wide_ceil(self.borrow_index[t], rate * dt as u128, BPS * SECONDS_PER_YEAR)?;
            // Every instruction accrues first, so nothing here may fail however far the index has run
            self.borrow_index[t] = self.borrow_index[t].saturating_add(growth);
        }
        // Interest is whatever the debt grew by, split at a finer scale than a base unit
        // A keeper accruing every few seconds would otherwise round the small cuts away
        let interest = self.total_debt()?.saturating_sub(debt).saturating_mul(DUST);
        let to_reserves = mul_div_wide(interest, self.params.reserve_factor_bps as u128, BPS)?;
        let to_protocol = mul_div_wide(interest, self.params.protocol_fee_bps as u128, BPS)?;
        self.reserves = Self::carry(self.reserves, &mut self.dust[0], to_reserves);
        self.protocol_fees = Self::carry(self.protocol_fees, &mut self.dust[1], to_protocol);
        let to_lenders = interest - to_reserves - to_protocol;
        if self.params.epoch_secs == 0 {
            // No epochs: lenders are paid as interest accrues, seniors by the rise in lender assets and juniors here,
            // with the junior part carried at the fine scale so frequent accruals round none of it away
            let (senior, junior) = weights;
            if junior > 0 {
                let to_junior = mul_div_wide(to_lenders, junior, senior + junior)?;
                self.junior_assets = Self::carry(self.junior_assets, &mut self.dust[2], to_junior);
            }
            self.drain(now, weights)?;
        } else {
            self.collect(to_lenders, now, weights)?;
        }
        self.last_accrual = now;
        Ok(())
    }

    /// Puts the lenders' part of the interest in the buffer and pays out what the epochs owe up to `now`
    /// When an epoch boundary passed since the last accrual, only the interest earned before it funds the new epoch's budget,
    /// the rest arrives after it opens, so a late accrual never pays out a week's interest in the week it was earned
    fn collect(&mut self, to_lenders: u128, now: i64, weights: (u128, u128)) -> Result<()> {
        if now < self.epoch_end {
            self.yield_buffer = Self::carry(self.yield_buffer, &mut self.dust[2], to_lenders);
            return self.pay_epoch(now, weights);
        }
        let len = self.params.epoch_secs as i64;
        let aligned = EPOCH_ANCHOR + (now - EPOCH_ANCHOR).div_euclid(len) * len;
        // After a change of length the aligned start can fall inside the old epoch, which is never paid twice
        let start = aligned.max(self.epoch_end);
        // Interest accrues evenly over the gap, so it splits at the boundary by time
        let last = self.last_accrual;
        let gap = (now - last).max(1);
        let after = (now - start.max(last)).clamp(0, gap);
        let later = mul_div_wide(to_lenders, after as u128, gap as u128)?;
        self.yield_buffer = Self::carry(self.yield_buffer, &mut self.dust[2], to_lenders - later);
        let end = self.epoch_end;
        self.pay_epoch(end, weights)?;
        // Whole epochs went by with no transaction: their payouts would all have gone to the same lenders in the same ratio,
        // since nobody can enter or leave without accruing, so everything but the last epoch's interest is paid to them now
        // That leaves the new epoch funded by one epoch of interest, never a pile collected over a long gap
        if start - len >= end {
            let window = (start - (start - len).max(last)).clamp(0, gap);
            let recent = to_u64(mul_div_wide(to_lenders, window as u128, gap as u128)? / DUST)?;
            let stale = self.yield_buffer.saturating_sub(recent);
            let (senior, junior) = weights;
            if stale > 0 && senior + junior > 0 {
                let to_junior = to_u64(mul_div_wide(stale as u128, junior, senior + junior)?)?;
                self.pay(stale - to_junior, to_junior);
            }
        }
        let budget = to_u64(mul_div_floor(self.yield_buffer as u128, BPS - self.params.yield_margin_bps as u128, BPS)?)?;
        self.open_epoch(start, aligned + len, budget);
        self.yield_buffer = Self::carry(self.yield_buffer, &mut self.dust[2], later);
        self.pay_epoch(now, weights)
    }

    /// With epochs off, a buffer left from a time with epochs keeps paying on its schedule:
    /// the open epoch runs to its end, then whatever remains is paid over one more epoch of the same length,
    /// so switching epochs off never pays out early
    fn drain(&mut self, now: i64, weights: (u128, u128)) -> Result<()> {
        if self.yield_buffer == 0 {
            return Ok(());
        }
        if now >= self.epoch_end {
            let end = self.epoch_end;
            self.pay_epoch(end, weights)?;
            let len = (end - self.epoch_start).max(1);
            // Time with nobody lending pays nothing, so the next stretch never starts further back than the last accrual
            let start = end.max(self.last_accrual);
            let rest = self.yield_buffer;
            self.open_epoch(start, start + len, rest);
        }
        self.pay_epoch(now, weights)
    }

    /// How a payout splits between the tranches, as senior and junior weights
    /// Juniors earn the senior rate per dollar plus the premium on every senior dollar they cover
    /// A thin junior tranche covers little, so the premium scales down until juniors hold the target share
    pub fn split_weights(&self) -> Result<(u128, u128)> {
        let lenders = self.lender_assets()?;
        let junior = self.tranche_assets(true)?;
        let senior = lenders - junior;
        if junior == 0 {
            return Ok((senior, 0));
        }
        let target = self.params.junior_target_bps as u128;
        // Saturating, since nothing here may fail and these products are far past any real pool
        let filled = junior.saturating_mul(BPS).min(lenders.saturating_mul(target));
        let scale = BPS.saturating_mul(lenders).saturating_mul(target);
        let premium = mul_div_wide(senior.saturating_mul(self.params.junior_premium_bps as u128), filled, scale)?;
        Ok((senior, junior.saturating_add(premium)))
    }

    /// Moves a payout from the yield buffer into the tranches; seniors gain theirs as lender assets rise
    fn pay(&mut self, senior: u64, junior: u64) {
        self.yield_buffer -= senior + junior;
        self.junior_assets = self.junior_assets.saturating_add(junior);
    }

    /// Pays the epoch's budget out evenly over its length, up to `until`
    /// Each slice splits by the weights over the time it covers, the same ones every accrual takes before anything moves,
    /// so a tranche's share follows how long money sat in it and a deposit around the epoch's opening gains nothing
    fn pay_epoch(&mut self, until: i64, weights: (u128, u128)) -> Result<()> {
        let span = (self.epoch_end - self.epoch_start).max(1) as u128;
        let elapsed = (until - self.epoch_start).clamp(0, span as i64) as u128;
        let due = to_u64(mul_div_floor(self.epoch_budget as u128, elapsed, span)?)?;
        // A loss can leave the buffer short of the budget, and then it pays what it holds
        let amount = due.saturating_sub(self.epoch_paid).min(self.yield_buffer);
        self.epoch_paid = self.epoch_paid.max(due);
        let (senior, junior) = weights;
        // With nobody to pay the slice stays in the buffer for the next epoch
        if amount > 0 && senior + junior > 0 {
            let to_junior = to_u64(mul_div_wide(amount as u128, junior, senior + junior)?)?;
            self.pay(amount - to_junior, to_junior);
        }
        Ok(())
    }

    /// Opens an epoch that pays `budget` from the buffer evenly from `start` to `end`
    /// The budget is fixed for the epoch, so the yield a lender sees moves only as money enters or leaves the pool
    fn open_epoch(&mut self, start: i64, end: i64, budget: u64) {
        self.epoch_start = start;
        self.epoch_end = end;
        self.epoch_budget = budget;
        self.epoch_paid = 0;
        emit!(EpochOpened { start, end, budget, buffer: self.yield_buffer });
    }

    /// Adds a scaled amount to a balance, keeping the part under one base unit for the next accrual
    fn carry(balance: u64, dust: &mut u32, scaled: u128) -> u64 {
        let total = scaled.saturating_add(*dust as u128);
        *dust = (total % DUST) as u32;
        balance.saturating_add(u64::try_from(total / DUST).unwrap_or(u64::MAX))
    }

    pub fn debt_of(&self, credit: &CreditAccount) -> Result<u128> {
        mul_div_wide_ceil(credit.debt_shares, self.borrow_index[credit.tier as usize], INDEX_ONE)
    }

    pub fn borrow(&mut self, credit: &mut CreditAccount, amount: u64) -> Result<()> {
        require!(self.available_cash() >= amount, PluribusError::InsufficientLiquidity);
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
        credit.debt_shares = mul_div_wide_ceil(debt, INDEX_ONE, self.borrow_index[to as usize])?;
        self.debt_shares[to as usize] += credit.debt_shares;
        credit.tier = to;
        Ok(())
    }

    /// Yearly premium rate the account pays now: its collateral's premium times its tier's share
    pub fn premium_rate_bps(&self, credit: &CreditAccount) -> u128 {
        credit.premium_bps as u128 * self.premium_tier_bps[credit.tier as usize] as u128 / BPS
    }

    /// Premium owed since the last booking, not yet part of the debt
    pub fn premium_due(&self, credit: &CreditAccount, now: i64) -> Result<u128> {
        let elapsed = now.saturating_sub(credit.premium_since);
        let rate = self.premium_rate_bps(credit);
        if credit.premium_since == 0 || elapsed <= 0 || rate == 0 || credit.debt_shares == 0 {
            return Ok(0);
        }
        mul_div_wide(self.debt_of(credit)?, rate * elapsed as u128, BPS * SECONDS_PER_YEAR)
    }

    /// Books the account's risk premium as new debt, at the rate in force since the last booking, and returns it
    /// Reserves and the protocol take their usual cut and junior lenders the rest, since they lose first when risky collateral fails;
    /// with no junior money behind the pool it stays with senior lenders
    /// It bypasses the yield buffer, so a junior who joins just before a booking still waits out the exit delay to take any of it
    /// Runs before anything reads or changes the account's debt or tier
    pub fn book_premium(&mut self, credit: &mut CreditAccount, now: i64) -> Result<u64> {
        if now <= credit.premium_since {
            return Ok(0);
        }
        let due = u64::try_from(self.premium_due(credit, now)?).unwrap_or(u64::MAX);
        if due == 0 {
            // A stretch that owes nothing restarts the clock, while one owing under a base unit keeps running until it adds up,
            // so booking often rounds nothing away
            if credit.premium_since == 0 || credit.debt_shares == 0 || self.premium_rate_bps(credit) == 0 {
                credit.premium_since = now;
            }
            return Ok(0);
        }
        credit.premium_since = now;
        let t = credit.tier as usize;
        // Rounded against the borrower, like every other debt share
        let shares = mul_div_wide_ceil(due as u128, INDEX_ONE, self.borrow_index[t])?;
        credit.debt_shares = credit.debt_shares.saturating_add(shares);
        self.debt_shares[t] = self.debt_shares[t].saturating_add(shares);
        let to_reserves = to_u64(mul_div_floor(due as u128, self.params.reserve_factor_bps as u128, BPS)?)?;
        let to_protocol = to_u64(mul_div_floor(due as u128, self.params.protocol_fee_bps as u128, BPS)?)?;
        self.reserves = self.reserves.saturating_add(to_reserves);
        self.protocol_fees = self.protocol_fees.saturating_add(to_protocol);
        // A wiped-out junior tranche has nothing to protect, so the premium goes to senior lenders instead of its dead shares
        if self.junior_assets > 0 {
            self.junior_assets = self.junior_assets.saturating_add(due - to_reserves - to_protocol);
        }
        self.premium_booked = self.premium_booked.saturating_add(due);
        Ok(due)
    }

    /// Drops debt that no collateral backs and returns the loss with what the yield buffer, reserves, protocol fees and junior lenders absorbed
    /// Interest not yet paid out goes first, then reserves, then the protocol's uncollected cut, then junior lenders,
    /// and senior lenders take what is left
    pub fn write_off(&mut self, credit: &mut CreditAccount) -> Result<(u64, u64, u64, u64, u64)> {
        let loss = to_u64(self.debt_of(credit)?)?;
        self.debt_shares[credit.tier as usize] -= credit.debt_shares;
        credit.debt_shares = 0;
        let from_buffer = loss.min(self.yield_buffer);
        self.yield_buffer -= from_buffer;
        let loss_left = loss - from_buffer;
        let from_reserves = loss_left.min(self.reserves);
        self.reserves -= from_reserves;
        // Interest that was never paid is not revenue, so it goes before lenders take a loss
        let from_fees = (loss_left - from_reserves).min(self.protocol_fees);
        self.protocol_fees -= from_fees;
        let from_junior = (loss_left - from_reserves - from_fees).min(self.junior_assets);
        self.junior_assets -= from_junior;
        self.bad_debt = self.bad_debt.saturating_add(loss);
        Ok((loss, from_buffer, from_reserves, from_fees, from_junior))
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
    /// Liquidation horizon T for the dynamic shock, about a day for crypto and three for stocks so a weekend fits, 0 for none
    pub vol_horizon_secs: u32,
    /// For a liquid staking token: where its SOL backing is read, and the price is the lower of its own and that SOL's worth
    pub rate_source: u8,
    /// The stake pool account for RATE_STAKE_POOL
    pub rate_account: Pubkey,
    /// SOL per whole token, scaled by 1e9, for RATE_FIXED
    pub fixed_rate: u64,
    /// The SOL price to value the backing with: the SOL mint for demo prices, its Pyth feed otherwise
    pub rate_base_mint: Pubkey,
    pub rate_feed_id: [u8; 32],
    /// Oldest price that still counts for liquidations and the liquidation line, at least `max_price_age_secs`
    /// Longer for stocks so a weekend's last price still lets bad debt be liquidated, while draws keep the short limit
    pub liq_price_age_secs: u32,
    /// Multiply the per-share price by the mint's corporate-action multiplier, for a per-share feed on a scaled token
    pub ui_multiplier: bool,
    /// How long a multiplier token's price jump must hold, with no multiplier change, before it counts as a real move:
    /// longer than the issuer could lag the feed in applying a split
    pub jump_hold_secs: u32,
}

impl AssetParams {
    /// True when `next` can only make the asset safer: a higher liquidation cost, a smaller cap, a longer horizon or a pause
    /// Oracle limits always wait, since a stricter one can stop liquidations as surely as a looser one adds risk
    pub fn only_tightens(&self, next: &AssetParams) -> bool {
        // A cap of zero means uncapped
        let cap_ok = next.deposit_cap == self.deposit_cap || (next.deposit_cap != 0 && (self.deposit_cap == 0 || next.deposit_cap < self.deposit_cap));
        let rest_same = AssetParams {
            liq_cost_bps: self.liq_cost_bps,
            deposit_cap: self.deposit_cap,
            paused: self.paused,
            vol_horizon_secs: self.vol_horizon_secs,
            ..*next
        } == *self;
        rest_same
            && cap_ok
            && next.liq_cost_bps >= self.liq_cost_bps
            && (next.paused || !self.paused)
            && next.vol_horizon_secs >= self.vol_horizon_secs
    }
}

impl AssetParams {
    pub fn validate(&self) -> Result<()> {
        require!(
            (self.liq_cost_bps as u128) < BPS
                && self.oracle <= ORACLE_PYTH
                // A zero age or band would make the asset unusable, and a band near 100% lets the price reach zero
                && self.max_price_age_secs > 0
                && (1..=2_000).contains(&self.max_conf_bps)
                // A fixed price has no volatility to measure
                && (self.oracle != ORACLE_FIXED || self.vol_horizon_secs == 0)
                && self.vol_horizon_secs <= 30 * 86_400
                // A staking token has a market price of its own to compare with its backing
                && self.rate_source <= RATE_FIXED
                && (self.rate_source == RATE_NONE || self.oracle == ORACLE_PYTH)
                && (self.rate_source != RATE_FIXED || self.fixed_rate > 0)
                // A backing is valued with a SOL price, by its demo account or its Pyth feed
                && (self.rate_source == RATE_NONE || (self.rate_base_mint != Pubkey::default() && self.rate_feed_id != [0; 32]))
                && (self.rate_source != RATE_STAKE_POOL || self.rate_account != Pubkey::default())
                && self.liq_price_age_secs >= self.max_price_age_secs,
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
    /// Backs new debt only from here, so juniors can leave before a new listing adds risk
    pub active_at: i64,
    /// Looser parameters waiting out the activation delay, live from `pending_at`, which is 0 when nothing waits
    pub pending: AssetParams,
    pub pending_at: i64,
    /// Fast and slow averages of the price's variance per second, scaled by VOL_SCALE
    pub var_fast: u128,
    pub var_slow: u128,
    /// The price and publish time of the last volatility sample
    pub vol_price: u64,
    pub vol_time: i64,
    /// Classic SPL Token or Token-2022, which every transfer of this asset must go through
    pub token_program: Pubkey,
    /// For a Token-2022 token with a corporate-action multiplier: the one in effect when last synced and the one before,
    /// in tokens per share scaled by 1e9
    pub mult: u64,
    pub mult_prev: u64,
    /// When `mult` took effect: exactly for a change scheduled ahead, otherwise when it was first seen; 0 before any change
    pub mult_since: i64,
    pub mult_exact: bool,
    /// When `mult_prev` took effect, so a price older than that is known to be on neither basis
    pub mult_prev_since: i64,
    /// Publish time of the first sample that jumped far from the last one with no multiplier change, 0 when none
    pub jump_since: i64,
    /// The latest far token price of that jump and its publish time
    pub jump_price: u64,
    pub jump_seen: i64,
    /// In demo mode, read the Pyth feed instead of the admin's demo price, for assets that should show real prices
    pub live_price: bool,
    /// Room for fields added later without moving the ones above
    pub reserved: [u8; 6],
    /// Extra yearly rate on debt this asset backs, paid to junior lenders, who lose first if it fails
    /// Added after launch: `migrate_account` grows an asset listed before it, and the new bytes start at zero
    pub premium_bps: u16,
    /// A higher premium waiting out the activation delay, live from `premium_pending_at` when that is not 0
    pub pending_premium_bps: u16,
    pub premium_pending_at: i64,
}

impl Asset {
    /// The dynamic shock z x sigma x sqrt(T) in bps for a variance per second
    pub fn dynamic_shock(&self, var: u128, z_x100: u16) -> u128 {
        let spread = var.saturating_mul(self.params.vol_horizon_secs as u128).isqrt();
        // sqrt(var x T) carries a scale of 1e9, so z / 100 x that / 1e9 x 1e4 bps
        (z_x100 as u128).saturating_mul(spread) / 10_000_000
    }

    /// Dynamic shocks for draws and liquidations
    /// Draws take the higher of both averages, so a burst of volatility stops new debt at once
    /// The liquidation line follows only the slow average, so no single sample can make a healthy account liquidatable
    pub fn dynamic_shocks(&self, p: &PoolParams) -> (u128, u128) {
        let init = self.dynamic_shock(self.var_fast.max(self.var_slow), p.z_init_x100);
        let maint = self.dynamic_shock(self.var_slow, p.z_maint_x100);
        (init, maint.min(init))
    }

    /// Variance per second for an annual volatility in bps, used to seed a new listing
    pub fn seed_variance(sigma_bps: u32) -> u128 {
        let s = sigma_bps as u128;
        s * s * (VOL_SCALE / BPS / BPS) / SECONDS_PER_YEAR
    }

    /// Folds one price sample into both averages, each an average of realized variance per second over its span:
    /// the old value fades with the real time elapsed, and the move adds its squared return spread over the span
    /// Only the part of the move beyond the price's own uncertainty counts, measured against the midpoint so up and down weigh alike
    pub fn record_vol(&mut self, price: u64, conf: u64, publish_time: i64, p: &PoolParams) -> Result<()> {
        if self.vol_time != 0 && self.vol_price > 0 {
            require!(publish_time >= self.vol_time + p.vol_min_interval_secs as i64, PluribusError::VolTooSoon);
            let elapsed = (publish_time - self.vol_time) as u128;
            let (p0, p1) = (self.vol_price as u128, price as u128);
            let moved = p1.abs_diff(p0).saturating_sub(conf as u128);
            let mid = (p0 + p1) / 2;
            let overflow = || error!(PluribusError::MathOverflow);
            let r2 = mul_div_wide(moved.checked_mul(moved).ok_or_else(overflow)?, VOL_SCALE, mid.checked_mul(mid).ok_or_else(overflow)?)?;
            let fold = |v: u128, tau: u32| -> Result<u128> {
                let tau = tau as u128;
                let kept = if elapsed >= tau { 0 } else { mul_div_floor(v, tau - elapsed, tau)? };
                Ok(kept.saturating_add(r2 / tau))
            };
            self.var_fast = fold(self.var_fast, p.vol_tau_fast_secs)?;
            self.var_slow = fold(self.var_slow, p.vol_tau_slow_secs)?;
        }
        self.vol_price = price;
        self.vol_time = publish_time;
        Ok(())
    }

}

/// A whitelisted Orca Whirlpool or Raydium CLMM pool whose positions count as collateral, always quoted in USDC
#[account]
#[derive(InitSpace)]
pub struct LpMarket {
    /// The pool, Orca or Raydium
    pub whirlpool: Pubkey,
    pub base_mint: Pubkey,
    pub bump: u8,
    pub liq_cost_bps: u16,
    pub paused: bool,
    /// Backs new debt only from here, so juniors can leave before a new listing adds risk
    pub active_at: i64,
    /// A lower liquidation cost or an unpause waiting out the activation delay, live from `pending_at` when that is not 0
    pub pending_liq_cost_bps: u16,
    pub pending_paused: bool,
    pub pending_at: i64,
    /// The program that owns the pool and its positions
    pub dex_program: Pubkey,
    /// Whether the base token is the pool's first token and USDC its second, which turns the range around when it is not
    pub base_first: bool,
}

/// A junior lender's shares in the exit queue, held in the pool's escrow until claimed or cancelled
/// They stay junior money until then: they keep earning and keep taking losses
#[account]
#[derive(InitSpace)]
pub struct JuniorExit {
    pub owner: Pubkey,
    pub shares: u64,
    /// What the shares were worth when queued, the most the exit can pay
    pub value: u64,
    pub unlock_at: i64,
    /// Terms fixed when the exit was queued, so later parameter changes can only improve them
    pub window_secs: u32,
    pub fee_bps: u16,
    pub bump: u8,
}

/// A senior lender's shares in the withdrawal queue, one account per ticket, held in the senior escrow until settled
/// Queued shares earn nothing but still take losses, and the queue pays tickets strictly in order
#[account]
#[derive(InitSpace)]
pub struct SeniorExit {
    pub owner: Pubkey,
    pub ticket: u64,
    pub shares: u64,
    /// What the shares were worth when queued, the most the exit can pay
    pub value: u64,
    /// Cancelled exits keep their ticket until the queue reaches it, so the head can always move on
    pub cancelled: bool,
    pub bump: u8,
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
    /// Token mint, or the position NFT mint of an LP
    pub mint: Pubkey,
    /// Token base units, or 1 for an LP position
    pub amount: u64,
    /// Bump of the dex's address for an LP position, so the health check can confirm it cheaply
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
    /// Risk premium of the collateral when last valued, before the tier's share, in bps a year
    /// Added after launch: `migrate_account` grows an account opened before it, and the new bytes start at zero
    pub premium_bps: u16,
    /// When the premium was last booked as debt, 0 until the first booking starts the clock
    pub premium_since: i64,
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
