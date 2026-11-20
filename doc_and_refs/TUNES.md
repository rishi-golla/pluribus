# Tunes

Every setting worth revisiting before mainnet, with the value deployed on devnet and the limits the program enforces.

## How a change lands

- Pool settings change with `set_params`, asset settings with `set_asset`, LP markets with `set_lp_market` (admin key).
- Only pure tightening applies at once:
  - Pool: raising shocks (keeping each group's shape across scenarios) or adding scenarios.
  - Asset: raising the liquidation cost, lowering the deposit cap, lengthening the volatility horizon, pausing.
  - LP market: raising the cost, pausing.
- Everything else waits out `activation_delay_secs`, then anyone sends `apply_params` / `apply_asset` / `apply_lp_market`.
- Nothing waiting can apply during a junior exit pause, nor until a full activation delay after it ends.
- Risk premiums follow their own rule: `set_asset_premium` and `set_premium_tiers` apply a cut at once and drop a waiting raise; a raise waits out `activation_delay_secs`, then anyone sends `apply_asset_premium` / `apply_premium_tiers`. Borrowers get the delay to repay or move collateral before they pay more.
- The guardian (`scripts/.keys/devnet/guardian.json`) can drop a waiting change or pause an asset or market. It cannot loosen anything or pause exits.
- In demo mode the admin can end every wait at once with `demo_activate`: the pool's waiting settings and premium tiers, plus the waiting changes, premiums and listing delays of the assets and LP markets passed in. The admin already writes the prices, so the delays protect nobody there. It is gone for good once demo mode is off.
- After an upgrade that appends account fields, run `npm run migrate:accounts` straight away. `migrate_pool` (admin) and `migrate_account` (anyone, for assets and credit accounts) grow old accounts with the new fields at zero. Until then an instruction that touches an old account fails because it can't be read; nothing is misread.
- On localnet `scripts/setup.ts` runs the same rules on seconds (`WAITS`), so the e2e scripts finish in minutes.

## Junior tranche

| Setting | Devnet | Allowed | Tuning notes |
|---|---|---|---|
| `junior_min_delay_secs` | 6d | > 0 if max > 0 | Shortest exit wait. Longer stops juniors fleeing a coming loss; shorter makes the tranche easier to sell. |
| `junior_max_delay_secs` | 6d | ≤ 30d, ≥ min | Equal to min means a fixed wait. Above min, the wait grows as the queue fills (jrDOLA uses 1 to 10 days). |
| `junior_delay_threshold_bps` | 10000 | 1 to 10000 | Share of junior supply in the queue at which the wait reaches max. Only matters when min < max. |
| `junior_exit_window_secs` | 2d | 60s to 3d | Time to claim after the wait; unclaimed exits lapse. |
| `junior_exit_fee_bps` | 5 | ≤ 100 | Kept by the juniors who stay. Discourages churn. |
| `junior_max_pause_secs` | 90d | ≤ 90d | Longest single governance pause. |
| `junior_pause_gap_secs` | 14d | ≥ max wait + 3d, ≥ activation delay | Unpaused time between two pauses. |
| `activation_delay_secs` | 8d | ≥ max wait + claim window, ≤ 30d | How long new collateral and loosening changes wait. Must leave juniors time to queue, wait and claim first. |
| `junior_premium_bps` | 1500 | ≤ 5000 | Yuzu-style risk premium on every senior dollar juniors cover: junior rate = senior rate × (1 + premium × senior / junior), the junior share counted as at least a tenth of the target. At 15% with a 10% target, juniors earn 15.85× the senior rate at 1% of the pool or less, 3.85× at 5%, 2.35× at 10%, 1.6× at 20% and 1.15× at 50%. Whenever juniors hold more than a tenth of the target they take an extra 15% of what seniors earn. Main lever for junior APY. |
| `junior_target_bps` | 1000 | 100 to 10000 | Junior share of the pool the premium is sized for. Below a tenth of it the junior multiple stops rising, which caps what a sliver of junior money earns. |
| `SEED_USDC` (setup.ts) | 1M senior, 100k junior | | Initial deposits from the admin on a fresh deployment. |

The pause length is chosen per pause (`pause_junior_exits(duration_secs)`), up to `junior_max_pause_secs`.

## Weekly yield

| Setting | Devnet | Allowed | Tuning notes |
|---|---|---|---|
| `epoch_secs` | 7d (Friday 00:00 UTC) | 0, or 60s to 30d | Lenders' interest collects in a buffer and is paid out evenly over the next epoch, each moment's slice split by the tranches' weights. 0 pays interest as it accrues (used on localnet); a leftover buffer still pays out on its schedule. Lengths that don't divide a week aren't Friday-aligned. A new length only applies once the buffer is empty: go through 0 first and the buffer drains on its old schedule. |
| `yield_margin_bps` | 1000 | ≤ 5000 | Share of the buffer held back when an epoch opens. It carries into the next week, smoothing the yield and taking losses before the reserve. Higher = steadier yield and a bigger loss cushion, lower = lenders paid sooner. |

## Crash scenarios and liquidation

| Setting | Devnet | Allowed | Tuning notes |
|---|---|---|---|
| `num_scenarios` | 3 | 1 to 4 | Crypto crash, equity crash, broad selloff. |
| `init_shock_bps` (SOL, stock, USDC, LST per scenario) | 3000/1500/300/3500, 1500/3500/300/2000, 2500/2500/300/3000 | ≤ `max_shock_bps` | Sets the credit limit. The biggest single lever on how much users can borrow. A group's dynamic shock rescales its column, so the table now sets the shape across scenarios and the floor. |
| `maint_shock_bps` | 2000/1000/100/2300, 1000/2500/100/1300, 1700/1700/100/2000 | ≤ the init shock | Liquidation line. The gap to init is the buffer before liquidation. |
| LST depeg add-on | +500 draw / +300 liquidation on the SOL shock | | The LST column is SOL's plus a depeg margin. Should follow observed LST/SOL discounts in past crashes (stETH reached about 7%). |
| `liq_bonus_bps` | 500 | ≤ 2000, and each asset's cost must cover it | Liquidator reward, and the most any asset pays: an asset's own bonus can only be lower. Too low and nobody liquidates; too high and borrowers lose more. |
| `close_factor_bps` | 5000 | 1 to 5000 | Most of the debt one liquidation can repay. |
| `warn_health_bps` | 11000 | ≥ 10000 | Health below this drops the account to the base rate tier. |

### Proposed SOL column (not deployed)

Devnet runs the values in the table above. Backtest by aykk on 18 Nov 2026: hourly SOL prices from October 2020 to November 2026, accounts opened on every day and held 90 days.

| | Deployed | Proposed |
|---|---|---|
| `init_shock_bps`, SOL per scenario | 3000 / 1500 / 2500 | 2100 / 1050 / 1750 |
| `maint_shock_bps`, SOL per scenario | 2000 / 1000 / 1700 | 1400 / 700 / 1200 |
| SOL credit limit and liquidation line | 66.5% and 76.0% | 75.0% and 81.7% |
| $5,000 SOL + $5,000 stock | 69.4% and 76.5% | 71.8% and 77.9% |

Kamino takes SOL at 74% and 80%, Project 0 at 72.7% and 85.7% (read 17 Nov 2026).

Bad debt in bps of debt, SOL borrowed to the limit, by time from crossing the line to liquidation:

| Rules | 1 hour | 4 hours | 24 hours | 72 hours | Liquidated within 30 days |
|---|---|---|---|---|---|
| Deployed | 0.00 | 0.00 | 111.0 | 118.3 | 55.4% |
| Proposed | 0.03 | 2.33 | 96.2 | 184.1 | 63.0% |
| Kamino's limits | 0.53 | 3.11 | 102.2 | 157.5 | 71.5% |
| Project 0's limits | 3.58 | 22.26 | 212.2 | 317.2 | 51.5% |

- The deployed column left no bad debt at a 4 hour stall. The proposed one leaves 2.33 bps.
- The volatility term lowers the limit when SOL is volatile: 75.0% on the median day, 71.2% on average, 61.8% or less on the most volatile tenth of days.
- The LST column follows through the add-on: 2600 / 1550 / 2250 draw and 1700 / 1000 / 1500 liquidation. No LST price history was tested.
- The stock column stays. Since 2007 NVDA passed the 25% liquidation shock in one episode, 33.4% over three days from 1 July 2008. AAPL and TSLA never did.
- On the live pool this is a loosening, so it waits out `activation_delay_secs`. A fresh deployment takes it from the two `shocks(...)` lines in `scripts/setup.ts`.

### Liquidation bonus per asset, and the order positions go in

| Setting | Devnet | Allowed | Tuning notes |
|---|---|---|---|
| `liq_bonus_bps` (asset) | SOL 100, NVDAx and AAPLx 500, others 0, which takes the pool's 500 | 0, or 1 to the pool's `liq_bonus_bps` | The liquidator's bonus on that token. Applies at once either way: the pool's bonus is the ceiling, and a change to that waits out the activation delay. If the pool's is later cut below it, the pool's applies. |
| `lp_liq_bonus_bps` (asset) | SOL 200, others 0 | same | The bonus on a liquidity position whose base token is this asset, on any dex. |
| `ORDER_SLACK_BPS` | 1000 | constant in `constants.rs` | With debt more than this far above the liquidation limit the order stops binding, so a deep account never waits for a liquidator who can afford the first position. Lower = the order gives way sooner. |
| `ORDER_TIE` | 100, in millionths of a dollar per dollar | constant in `constants.rs` | Keys closer than this count as level, so rounding never decides between two positions of a kind. |

- The order: the position with the lowest key goes first, where key = its value in the scenario that sets the liquidation limit ÷ its market value × (1 + its bonus). That sale costs the limit least per dollar of debt repaid. USDC, a position worth nothing and one that can't be handed over (unclear price, halted mint, short or frozen vault) are outside it.
- `LIQ_BONUS_BPS` (`scripts/lib.ts`) holds the proposed values: SOL 100, positions in SOL 200 (Orca, Raydium and DLMM alike), NVDAx and AAPLx 500. `scripts/setup.ts` sets them on a fresh deployment and `npm run liq:bonus -- --url <rpc>` on a live one, signed by `DEMO_ADMIN_SECRET` from the root `.env`. Assets not named keep the pool's 500. Set on devnet 20 Nov 2026.

The values proposed and now set:

| Asset | Deployed | Proposed | Elsewhere (read 19 Nov 2026) |
|---|---|---|---|
| SOL | 100 | 100 | Jupiter Lend 1% on its SOL vaults. Kamino from 0.1% (1% before its cut), rising while a loan stays unhealthy. marginfi 5%. |
| NVDAx, AAPLx | 500 | 500 | Jupiter Lend 7% on NVDAx and TSLAx, 5% on SPYx and QQQx. |
| Orca SOL-USDC position | 200 | 200 | Revert Lend 2% to 10% on Uniswap v3 positions. |

- A stock's bonus pays the liquidator for a price that jumps at the open after a night or a weekend. Jupiter gives that as its reason for 7% on single stocks.
- A position is sold whole and the liquidator has to unwind it, so it pays more than SOL.
- `liq_cost_bps` has to cover the bonus: cost ≥ bonus / (1 + bonus), which is 99 at a 1% bonus, 196 at 2% and 476 at 5%. Lowering SOL's cost from 500 to 150 moves its credit limit from 66.5% to about 69% and its liquidation line from 76.0% to about 78.8%.
- JitoSOL, JupSOL and BONK have no proposal yet.
- Sources: Jupiter Lend's xStocks risk report (15 Apr 2026), Ethena's governance proposal on Jupiter's SOL vaults, SolanaFloor on Kamino's cut, Revert Lend's docs, marginfi's docs.

## Dynamic shocks (d = max(table, z·σ·√T), capped)

| Setting | Devnet | Allowed | Tuning notes |
|---|---|---|---|
| `z_init_x100` | 300 | ≤ 1000, ≥ the maint z | z for draws, about 99.9% one-sided. It uses the higher of the fast and slow variance, so a burst stops new debt at once. |
| `z_maint_x100` | 233 | ≤ the init z | z for the liquidation line, about 99%. It uses only the slow variance, so one sample can't make a healthy account liquidatable. |
| `vol_tau_fast_secs` | 1h | > 0, ≤ slow | How fast a volatility spike enters the draw shock. |
| `vol_tau_slow_secs` | 7d | ≥ fast | How slowly volatility fades from the liquidation line. Longer = steadier liquidation line, but slower to react to a regime change. |
| `vol_min_interval_secs` | 60 | > 0, ≤ fast tau | Minimum publish-time gap between samples. |
| `vol_max_age_secs` | 60 | > 0 | Oldest price a sample accepts. |
| `vol_conf_cap_bps` | 200 | 1 to 2000 | Widest Pyth band a sample accepts. The band itself is subtracted from each move, so noise doesn't count as volatility. |
| `max_shock_bps` | 9500 | < 10000 | Ceiling on any shock, table or dynamic. |
| Asset `vol_horizon_secs` (T) | SOL and LSTs 1d, BONK 2d, stock and xStock 3d, USDC 0 | ≤ 30d, 0 = off; non-zero needs non-zero draw and liquidation shocks in its group, and multiplier tokens must have one | Time to liquidate. Stocks need a weekend. Memecoins should be longer than SOL, since selling takes more time. |
| `sigma_seed_bps` at listing | SOL 8000, LSTs 8000, stock 5000, xStock 4000 | ≤ 100000 | Starting annual volatility until the crank has history. Seed high; it only fades as fast as `vol_tau_slow_secs`. |
| `demo_reset_vol` (demo mode only) | JitoSOL and JupSOL reset to 8000 on 20 Nov 2026 | sigma ≤ 100000 | Sets both variance averages back to a seed and restarts sampling. For a demo whose volatility a test or a source switch threw off: JitoSOL and JupSOL read 461% a year (shocks 72% / 56%, LTV 21%) after their switch from demo to live prices, back when the switch did not restart sampling. Gone with demo mode. |
| Keeper vol crank interval | `keeper/index.ts` | | One sample per asset per minimum interval. A crank that stops leaves the last shock in place, so watch for a stalled keeper. |

## Liquid staking tokens

| Setting | Devnet | Allowed | Tuning notes |
|---|---|---|---|
| `group` | 3 (LST column) | a column with a non-zero shock | Shares SOL's crash plus a depeg margin. |
| `liq_cost_bps` | 600 | as for assets | One point more than SOL for thinner LST markets. Should follow each LST's depth. |
| `rate_source` | FIXED on devnet (mock mints), STAKE_POOL for real SPL pools | NONE / STAKE_POOL / FIXED; a backing needs the SOL price's mint and feed, STAKE_POOL the pool account; a backing can't be added after listing, only changed or dropped | Price = min(own Pyth price, backing × SOL). Backing is read from the SPL stake pool (Jito, Sanctum multi-validator) or a fixed rate. mSOL and INF need their own readers and are not supported. |
| `fixed_rate` | JitoSOL 1.31, JupSOL 1.22 SOL | > 0 | Devnet mocks only. A real LST's rate grows each epoch, so a fixed rate goes stale. |
| Stake pool staleness | one epoch | constant in `oracle.rs` | The pool must have been updated this epoch or the last. |

## Tokenized stocks (xStocks, Token-2022)

| Setting | Devnet | Allowed | Tuning notes |
|---|---|---|---|
| `liq_price_age_secs` | 10 years for SOL, NVDAx, AAPLx and BONK (see `max_price_age_secs`), 1d for JitoSOL, JupSOL and USDC | ≥ `max_price_age_secs` | Oldest price that still counts for liquidations and the liquidation line. Draws keep the short age. Four days, the xStock's value before 20 Nov 2026, covers a long weekend. Longer = bad debt can still be cleared after a long close, but on an older price. |
| `ui_multiplier` | on for the xStock | | Multiply a per-share price by the mint's corporate-action multiplier. Turn off if the feed already quotes per token. |
| `MULTIPLIER_GUARD_SECS` | 1h | constant in `token2022.rs` | The shortest window around a multiplier change; the window actually used is the larger of this and the asset's `jump_hold_secs` (a day for the devnet xStock). Inside it the price is unclear (no new debt, line at the lower of the price and the last sample, not seized), and of the two bases the one that keeps the token's price nearest the last volatility sample is used, or the lower one before any sample. A change the issuer applies at once is dated when `sync_mint` (or the volatility crank) first sees it, so the window runs from then. A price older than the last two multipliers is valued at the lowest basis it could be on. |
| Multiplier bounds | 0.0001 to 10000 | constant in `token2022.rs` | A multiplier in effect outside this makes only that token unclear (no new debt, valued at the last synced multiplier, not seized). One scheduled outside it changes nothing until it applies. |
| Jump band | 1.5x either way | `token2022::far` | A multiplier token's price this far from the last volatility sample is unclear: it backs no new debt, counts toward the liquidation line at the lower of its price and that sample, and can't be seized. Narrow it for calmer stocks, widen it for volatile ones. |
| `jump_hold_secs` | xStock 1d | 1h to 7d, multiplier tokens only | How long a jump must hold, with no multiplier change, before the crank accepts it as a real move and the token can be seized again. A deeper fall of up to 1.8x per step keeps the hold, so a stock gapping down day after day becomes seizable; a rise or bounce past half again, a split-sized fall, a reversal, or a far price more than a hold after the last one (a weekend) starts it again. Left open: a 3-for-2 or 2-for-3 split (a 1.5x step) the feed reprices first fits inside these bands and can be taken as clear, mispricing by up to 1.5x; and a feed that keeps swinging more than these bands after a crash keeps restarting the hold, so the stock is never seized while it does. Must exceed the longest an issuer could lag the feed in applying a split; it also widens the window around a recorded or scheduled change. While it runs, a crashed xStock that is an account's only collateral can't be liquidated. An unscheduled split where the feed reprices first looks exactly like a crash: the line takes the lower price and other collateral can be sold at the bonus until the issuer applies it. |
| Vault shortfall | pro rata | `risk.rs`, `borrow.rs`, `liquidate.rs` | If the issuer's delegate takes tokens out of the vault, each booked token is worth vault / books, withdrawals and seizes pay that share, and deposits stop. A frozen vault backs no new debt. |
| Extension allow-list | delegate, pause, multiplier, metadata, groups, confidential transfer, an unset hook, default state Initialized | constant in `token2022.rs` | Fees, interest, a live hook and frozen default accounts are refused at listing. A pause or a hook switched on later halts the token: no new debt, still counts toward the liquidation line. |
| Issuer trust | | | The permanent delegate can move or burn tokens out of the vault, and the loss is shared by everyone holding that token here. Size `deposit_cap` for that issuer risk. |

## Interest and loyalty tiers

| Setting | Devnet | Allowed | Tuning notes |
|---|---|---|---|
| `base_rate_bps` | 200 | | Rate at 0% utilization. |
| `slope1_bps` | 800 | | Rate added up to the kink. |
| `slope2_bps` | 6000 | | Steep rate above the kink, which pulls repayments in when lenders can't exit. |
| `kink_bps` | 9000 | 1 to 9999 | Utilization where the steep slope starts. |
| `reserve_factor_bps` | 1000 | reserve + protocol ≤ 5000 | Feeds the insurance reserve, which takes losses after unpaid interest and before juniors. |
| `protocol_fee_bps` | 1000 | reserve + protocol ≤ 5000 | Protocol revenue; uncollected fees also take losses before juniors. |
| `tier_discount_bps` | 0 / 40 / 80 | starts at 0, never decreases | Rate discount per loyalty tier. |
| `tier_min_healthy_secs` | 0 / 7d / 30d | starts at 0, increasing | Healthy time needed for each tier. |

## Risk premium

Risky collateral pays an extra rate that goes to junior lenders, who take the first loss when it fails.

| Setting | Devnet | Allowed | Tuning notes |
|---|---|---|---|
| `premium_bps` (per asset) | NVDAx and AAPLx 300, BONK 1500, others 0 | ≤ `MAX_RISK_PREMIUM_BPS` (3000) | Extra yearly rate on debt the asset backs. An LP carries its base token's premium. Should follow how thin the asset's market is and how fast it can gap. |
| `premium_tier_bps` | 10000 / 6000 / 3000 | ≤ 10000, not rising with the tier | Share of the premium charged in each loyalty tier, so it fades while the account stays healthy. A liquidation, or health under `warn_health_bps`, drops the account to tier 0 and the full premium. 0 everywhere (a pool grown by `migrate_pool`) charges nothing. |
| Weighting | | | An account's premium is each position's premium weighted by its draw value in the scenario where the whole portfolio is worth least. A position that adds little in a crash adds little premium. Paused collateral still counts. |
| Booking | | | The premium is booked as new debt before anything reads or changes the account's debt or tier: draws, repays, withdrawals, liquidations, autopay and `refresh_tier`. Reserves and the protocol take their usual cuts and juniors the rest; with no junior money it stays with seniors. It goes straight to junior assets, not through the yield buffer. A junior who joins just before a booking still waits out the exit delay to take any of it. |
| Refresh | | | The rate in force is the one set at the account's last valuation (draw, withdrawal or `refresh_tier`). A new asset premium or a changed collateral mix takes effect at the next refresh. |
| `PREMIUM_INTERVAL_MS` | keeper env, 600000 | | How often the keeper refreshes an account that pays a premium. Shorter makes junior payouts smoother and puts changes into effect sooner, at a transaction per account per interval. |

## Compounding

Anyone may collect a deposited LP or Meteora position's fees: put back into the position when its owner opted in to compounding, autopaid otherwise. The caller is paid the same share of the fees either way, so the keeper leaves both to bounty callers, who use the SDK (`sdk/compound.ts` `findHarvestable`) or the Collect fees button on the app's Overview.

| Setting | Devnet | Allowed | Tuning notes |
|---|---|---|---|
| `compound_slippage_bps` (per position, set by its owner) | 0 for every position (fees repay debt) | 0, or 1 to `MAX_COMPOUND_SLIPPAGE_BPS` (1000) | 0 keeps autopay. Anything else lets anyone compound while the pool's price is within that many bps of the oracle's, and autopay then leaves the position alone. A looser tolerance compounds more often but lets a caller who moves the pool first take more of the fees; it can never touch the position's existing value or lower health, since fees never counted as collateral. Cleared whenever the slot is withdrawn, liquidated or reused. |
| `compound_bounty_bps` (pool) | 200 (2%) | ≤ `MAX_COMPOUND_BOUNTY_BPS` (500) | Share of each fee paid to the caller's recipient, by a compound and an autopay alike. Too low and nobody bothers, too high and borrowers lose more of their yield. Set with `set_compound_bounty`, which applies at once inside the cap. `scripts/setup.ts` sets `COMPOUND_BOUNTY_BPS` (`scripts/lib.ts`) on a fresh deployment. |
| Autopay bounty | 200 (2%), live since the upgrade of 20 Nov 2026 (slot 524258907) | the pool's `compound_bounty_bps` | Autopay pays the caller the same share a compound does, taken from both tokens before the USDC left repays debt, so a borrower's choice between the two costs the same and nobody has to be paid to run autopay. At 2% a caller covering twice its fee collects a $1,000 position about every 38 minutes, a $100 one about every 6 hours (backtest, Nov 2025 to Nov 2026). |


- The caller picks the recipient of the bounty, so a throwaway key can pay the transaction fees while the bounty goes to a wallet.
- A compound or an autopay needs no health check, so several fit in one transaction: about 5 to 7 Orca or Raydium positions, 2 to 4 Meteora ones (`sdk/compound.ts` `packHarvests`).
- What a position's range cannot take, for example the second token of an out-of-range position, is booked as collateral as autopay does.

## Senior withdrawals and accounts

No settings, only rules worth knowing before mainnet.

- A senior lender whose instant withdrawal finds too little idle cash queues with `request_senior_exit`. The exit's value is fixed then: it can lose value while it waits but never gains any.
- Idle cash up to the queued value is held back (`Pool::available_cash`) from draws, instant withdrawals, junior cash claims and fee collection, so repayments refill the queue first.
- `settle_senior_exit` is permissionless and pays the head of the queue once cash covers it. The keeper pays up to 10 exits a pass, after liquidations.
- `cancel_senior_exit` hands back shares worth the queued value. The yield earned while queued is burned into the senior share price, or goes to the reserve when the canceller is the only senior. A cancelled ticket stays in line, empty, until the queue reaches it.
- `close_account` closes an empty credit account (no debt, no positions) and returns its rent.

## Per asset and LP market

| Setting | Devnet | Allowed | Tuning notes |
|---|---|---|---|
| `group` | SOL 0, stock and xStock 1, USDC 2, LSTs 3, BONK 4 | column in the shock tables | Which crash column the asset falls with. Column 4 is the memecoin column: draws 60% / 30% / 50% and liquidations 45% / 20% / 38% for the crypto, equity and broad scenarios, which `list:meme` fills (an empty column is an instant tightening). |
| `liq_cost_bps` | SOL 500, LSTs 600, stock and xStock 1000, BONK 1500, USDC 0 | < 10000; ≥ about 476 at a 5% bonus | Haircut for the cost of liquidating. Should grow with position size and thin liquidity (memecoins). |
| `max_price_age_secs` | 10 years (315360000) for SOL, NVDAx, AAPLx and BONK since 20 Nov 2026; 1 day for JitoSOL, JupSOL and USDC | > 0 | Oldest accepted price. The four assets on admin-written demo prices were set to 10 years so those prices never go stale between demos. The keeper's heartbeat re-sends a demo price only past half its age, so it no longer touches them, and their volatility is sampled only when someone moves a price. A day is demo-only too; mainnet Pyth needs seconds to minutes. Undo with `set_asset` back to 86400 (345600 for AAPLx's liquidation age), then `demo_activate`. |
| `max_conf_bps` | 200 | 1 to 2000 | Widest accepted Pyth confidence band. |
| `deposit_cap` | 0 (no cap) | 0 = uncapped | Cap per asset. Should follow on-chain depth for risky assets. |
| `oracle`, `pyth_feed_id` | the real Pyth feed of each asset: SOL/USD, NVDA/USD, AAPL/USD, JITOSOL/USD, BONK/USD | | JupSOL reads JITOSOL/USD because Pyth has no JUPSOL/USD feed, and its fixed backing (1.22 x SOL) caps it. The LSTs' backing feed is SOL/USD. `list:meme` and `setup` point each asset at its feed, and the push-feed account the program reads is the PDA of the push oracle `pythWSnsw…` for shard 0 and the feed id (`deployments/<cluster>.json` `pythAccount`). |
| `live_price` | JitoSOL, JupSOL on; AAPLx, BONK off until their feeds are fresh; SOL, NVDAx off | demo mode only | With demo mode on an asset reads its admin-written demo price until `demo_set_live_price(true)` switches it to its Pyth feed. A switch either way restarts volatility sampling, so the gap between the demo price and the market never counts as a move. SOL and NVDAx stay on demo prices so the crash demo can move them. An LST's SOL backing follows the LST's own flag. `list:meme` flips an asset only while its feed is fresh within `max_price_age_secs` and its band fits `max_conf_bps` on the asset's priced unit. BONK's devnet push feed is days old, so it stays on its demo price until a Hermes token lets the keeper post it. JitoSOL and JupSOL read the feeds Pyth itself pushes on devnet, about every half hour; if those stop, accounts holding them fail health checks after a day, and the admin can switch them back to demo prices at once. |
| `price_exponent` | BONK 6, others 0 | 0 to 12; only with nothing deposited and before the listing is live, or in demo mode; never for staking or multiplier tokens | The asset is priced per 10^k whole tokens. At six decimals per token BONK's price would round to a couple of units, which wrecks valuation and fails the band check, so it is priced per million. Pyth prices are scaled up to the unit, band included, and demo prices are written in it. Setting it resets the volatility sample. |
| LP market `liq_cost_bps` | 500 on every market | same rule as assets | Haircut on Orca, Raydium and Meteora positions. A Raydium pool for the same pair can be thinner than Orca's, so give each market its own cost from its depth. Devnet lists the Orca SOL/USDC whirlpool, the Raydium SOL/USDC pool `5ZnKVi…` and the Meteora SOL/USDC pair `Em4nQA…` (`lpMarkets`). |
| `RAYDIUM_CLMM_PROGRAMS` | mainnet `CAMMCzo5…`, devnet `DRayAUg…` | constant in `constants.rs` | The only programs besides Orca whose pools can list. Raydium can upgrade its program, so recheck the position and pool layouts (offsets in `clmm.rs`) after each Raydium upgrade. `autopay_raydium` collects fees with `decrease_liquidity_v2` at zero liquidity; Raydium pays any pool rewards in the same call, so the program only lets them go to the account owner's own token accounts. |
| `METEORA_DLMM_PROGRAM_ID` | `LBUZKhRx…`; devnet lists the SOL/USDC pair `Em4nQA…` (10 bps bins, `npm run dlmm:market`) | constant in `constants.rs` | A DLMM pair lists as an LP market with its own `liq_cost_bps`. Its positions are owned by the pool PDA and valued from their shares alone, about 0.4% under what they pay out, so the cost need not cover pool manipulation. Meteora can upgrade its program: recheck the offsets in `dlmm.rs` and rerun `tests/dlmm.rs` on a fresh `npm run dlmm:snapshot` after each upgrade. A health check with five 70-bin positions needs more than the default compute limit. |
| Demo prices (setup.ts) | SOL at the pool price, stock $180, xStock $230, LSTs 0.1% under their backing, BONK $2.40 per million | | Starting demo feed. `scripts/price.ts` moves only SOL and the stock. |

## Hard caps in `programs/pluribus/src/constants.rs`

These need a program upgrade to change.

| Constant | Value | What it bounds |
|---|---|---|
| `MAX_JUNIOR_PAUSE_SECS` | 90d | Any single pause |
| `MAX_JUNIOR_DELAY_SECS` | 30d | The exit wait |
| `MAX_ACTIVATION_DELAY_SECS` | 30d | How long the admin can lock itself out of loosening |
| `MIN_JUNIOR_EXIT_WINDOW_SECS` / `MAX_JUNIOR_EXIT_WINDOW_SECS` | 60s / 3d | The claim window; the max also sets the minimum pause gap |
| `MAX_JUNIOR_EXIT_FEE_BPS` | 100 | The exit fee |
| `JUNIOR_FLOOR_DIVISOR` | 10 | The junior multiple stops rising below a tenth of the target share |
| `MAX_POSITIONS` / `MAX_SCENARIOS` / `MAX_GROUPS` / `TIERS` | 5 / 4 / 6 / 3 | Account and table sizes (changing these is a migration) |
| `VIRTUAL_SHARES` | 1 USDC | First-depositor protection per tranche |
| `MIN_EPOCH_SECS` / `MAX_EPOCH_SECS` | 60s / 30d | Yield epoch length when not 0 |
| `STAKE_POOL_PROGRAMS` | SPL stake pool, Sanctum multi-validator | Programs whose pools can back an LST |
| `MAX_RISK_PREMIUM_BPS` | 3000 | Any asset's risk premium |
| `MAX_PRICE_EXPONENT` | 12 | How many tokens one priced unit can hold (10^12) |
| `MAX_COMPOUND_SLIPPAGE_BPS` / `MAX_COMPOUND_BOUNTY_BPS` | 1000 / 500 | The loosest price tolerance a borrower can allow, and the largest compound bounty |

## Off-chain services and demo

| Setting | Where | Default | Notes |
|---|---|---|---|
| `INTERVAL_MS` | keeper env | 5000 | How often the keeper checks for liquidations and tiers. |
| `PREMIUM_INTERVAL_MS` | keeper env | 600000 | How often an account paying a risk premium is refreshed (see Risk premium). |
| `PYTH_INTERVAL_MS` | keeper env | 30000 | How often the feeds of live assets are posted again, and the keeper posts them again right before a volatility sample, which needs a price under `vol_max_age_secs` old. |
| `HERMES_ACCESS_TOKEN`, `HERMES_URL`, `PYTH_PUSH` | keeper env | none, `https://hermes.pyth.network`, on | The public Hermes serves price updates only with an access token, so without one the keeper posts nothing and logs it once. `PYTH_PUSH=0` leaves the feeds to someone else, and localnet never posts. |
| `GRANT`, `EXTRAS` | `web/src/app/api/faucet/route.ts` | 0.05 SOL (10 on localnet), 50 stock, 5000 USDC; 10 JitoSOL, 10 JupSOL, 20 AAPLx, 100M BONK | Test tokens per wallet. |
| Faucet stock | `scripts/faucet-stock.ts` flags | 0.4 SOL, 5 positions of $20 on devnet | What the faucet wallet holds to hand out. |
| `MAX_MOVE` | `web/src/app/api/demo/price/route.ts` | 20x | Largest demo price move per request. |
| `SWAP_USD` | `web/src/app/api/demo/harvest/route.ts` | $1000 | Trade size used to generate LP fees in the demo. |
| Lookup table | `deployments/<cluster>.json` `lookupTable` | made by setup | v0 transactions through it keep liquidations of accounts with many Token-2022, staking or LP positions under the 1232-byte limit. Setup extends it when assets or markets are added; rerun setup after listing anything. |
| `demo_mode` | pool flag | on | The admin sets prices, which gets around every delay. Turn it off (one way) before real money. |

## Not yet settings

Planned in the earlier research and plans, not implemented:

- **Depth-based limits:** cap liquidation size and deposits at the Orca depth within the bonus (`D(m)`), and size haircuts with it.
- **Fee-implied σ (Panoptic)** for pool tokens without a feed. Left out on purpose for now: it needs a volume crank and can be wash-traded to push σ around.
- **An emergency switch for a broken LST backing.** If a stake pool account stops reading (for example after an upstream migration), that LST's health checks fail, and the fix (`rate_source` → NONE or FIXED) waits out the activation delay. Liquidations of that LST are frozen meanwhile. In demo mode the admin can switch the token back to its demo price at once; with demo mode off there is no such switch. Options: let the guardian switch to FIXED at or below the last rate at once, or fall back to the own price with an extra haircut.
- **Close publish times for the LST's two prices.** The SOL leg is accepted anywhere inside the LST's own age window, so a liquidator can pick the lowest SOL print in that window.
- **SDK reads the deployment file, not the chain,** for LST backing accounts, token programs and extra LP markets. Which price account each asset reads (demo or Pyth) does come from the chain, and the price helper applies the xStock multiplier. A timelocked on-chain change needs a regenerated deployment JSON.
- **One Raydium program per cluster.** Both Raydium ids are accepted everywhere; listing is admin-only, but a build flag could pin each cluster to its own id.
- **Raydium's admin can turn off `decrease_liquidity` for a pool**, which would leave a liquidator holding an NFT it can't redeem. Watch Raydium pool status for listed markets.
- **Very large LP sides overflow.** A position whose token side would exceed u64 at a shocked price fails every health check for that account (Orca too). Only plausible for base tokens with many decimals; cap decimals at listing or saturate.
- **Meteora DLMM limits.** Positions wider than 70 bins, Token-2022 pairs and pairs with farming rewards are refused. Devnet runs an older DLMM build than mainnet; `DLMM_SO=lb_clmm_devnet.so cargo test --test dlmm` checks it against the same accounts, and should be rerun after either is upgraded.
- **No volatility sample yet:** an xStock listed and then changed twice before its first sample is valued at its lowest possible multiplier with nothing to cap it. Seed `vol_price` at listing (needs a price account at listing) if this matters.
- **A cap on each instant shock raise**, so one tightening cannot make every borrower liquidatable at once.
- **Premium refreshes are the keeper's job.** An account's premium rate only moves at a valuation, so with no keeper a borrower who deposits risky collateral after drawing pays the old rate until its next draw, withdrawal or refresh. Anyone can call `refresh_tier`.
- **Reopening a wiped tranche with a fresh share mint (a bug to fix before mainnet).** After a 100% junior loss, the dead shares still count in the share price, so every new dollar mints about `dead_supply` shares. Token supply is a u64, so the tranche can then never hold more than about `$18.4T / dead_supply_in_USDC` (10M dead caps it near $1.8M; the 100k devnet seed near $184M). Deposits and `convert_to_junior` past that cap fail with `MathOverflow`. The senior tranche has the same maths. Fix: an admin instruction allowed only when junior assets are 0 that opens a new junior mint and escrow (seeded by an epoch counter), so new money starts again at $1 a share and the old mint is retired. Exits still queued on the old mint close out at $0.

## Dropped

- **Coverage gate** (block risky draws when junior deposits fall below X% of risky debt). Dropped: the risk premium pays juniors for carrying risky debt instead, and the Earn page no longer shows it.
