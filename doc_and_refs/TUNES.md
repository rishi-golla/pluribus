# Tunes

Every setting worth revisiting before mainnet, with the value deployed on devnet and the limits the program enforces.

## How a change lands

- Pool settings change with `set_params`, asset settings with `set_asset`, LP markets with `set_lp_market` (admin key).
- Only pure tightening applies at once:
  - Pool: raising shocks or adding scenarios.
  - Asset: raising the liquidation cost, lowering the deposit cap, pausing.
  - LP market: raising the cost, pausing.
- Everything else waits out `activation_delay_secs`, then anyone sends `apply_params` / `apply_asset` / `apply_lp_market`.
- Nothing waiting can apply during a junior exit pause, nor until a full activation delay after it ends.
- The guardian (`scripts/.keys/devnet/guardian.json`) can drop a waiting change or pause an asset or market. It cannot loosen anything or pause exits.
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
| `junior_premium_bps` | 1500 | ≤ 5000 | Yuzu-style risk premium: junior rate = senior rate × (1 + premium × senior / junior). At 15% and juniors at 10% of the pool, juniors earn 2.35× the senior rate. Main lever for junior APY. |
| `junior_target_bps` | 1000 | 100 to 10000 | Junior share of the pool at which the premium is paid in full; below it the premium scales down. |
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
| `liq_bonus_bps` | 500 | ≤ 2000, and each asset's cost must cover it | Liquidator reward. Too low and nobody liquidates; too high and borrowers lose more. |
| `close_factor_bps` | 5000 | 1 to 5000 | Most of the debt one liquidation can repay. |
| `warn_health_bps` | 11000 | ≥ 10000 | Health below this drops the account to the base rate tier. |

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
| Asset `vol_horizon_secs` (T) | SOL and LSTs 1d, stock and xStock 3d, USDC 0 | ≤ 30d, 0 = off | Time to liquidate. Stocks need a weekend. Memecoins should be longer than SOL, since selling takes more time. |
| `sigma_seed_bps` at listing | SOL 8000, LSTs 8000, stock 5000, xStock 4000 | ≤ 100000 | Starting annual volatility until the crank has history. Seed high; it only fades as fast as `vol_tau_slow_secs`. |
| Keeper vol crank interval | `keeper/index.ts` | | One sample per asset per minimum interval. A crank that stops leaves the last shock in place, so watch for a stalled keeper. |

## Liquid staking tokens

| Setting | Devnet | Allowed | Tuning notes |
|---|---|---|---|
| `group` | 3 (LST column) | a column with a non-zero shock | Shares SOL's crash plus a depeg margin. |
| `liq_cost_bps` | 600 | as for assets | One point more than SOL for thinner LST markets. Should follow each LST's depth. |
| `rate_source` | FIXED on devnet (mock mints), STAKE_POOL for real SPL pools | NONE / STAKE_POOL / FIXED | Price = min(own Pyth price, backing × SOL). Backing is read from the SPL stake pool (Jito, Sanctum multi-validator) or a fixed rate. mSOL and INF need their own readers and are not supported. |
| `fixed_rate` | JitoSOL 1.31, JupSOL 1.22 SOL | > 0 | Devnet mocks only. A real LST's rate grows each epoch, so a fixed rate goes stale. |
| Stake pool staleness | one epoch | constant in `oracle.rs` | The pool must have been updated this epoch or the last. |

## Tokenized stocks (xStocks, Token-2022)

| Setting | Devnet | Allowed | Tuning notes |
|---|---|---|---|
| `liq_price_age_secs` | 4d for the xStock, 1d for others | ≥ `max_price_age_secs` | Oldest price that still counts for liquidations and the liquidation line. Draws keep the short age. Four days covers a long weekend. Longer = bad debt can still be cleared after a long close, but on an older price. |
| `ui_multiplier` | on for the xStock | | Multiply a per-share price by the mint's corporate-action multiplier. Turn off if the feed already quotes per token. |
| `MULTIPLIER_GUARD_SECS` | 1h | constant in `token2022.rs` | Around a multiplier change the token backs no new debt, and of the two bases the one that keeps the token's price nearest the last volatility sample is used. A change the issuer applies at once is dated when `sync_mint` (or the volatility crank) first sees it, so the guard runs from then. Widen it if real feeds lag the multiplier by more than an hour. |
| Multiplier bounds | 0.0001 to 10000 | constant in `token2022.rs` | A multiplier in effect outside this halts only that token (no new debt, valued at the last synced multiplier). One scheduled outside it changes nothing until it applies. |
| Jump band | 1.5x either way | `token2022::far` | A multiplier token's price this far from the last volatility sample is unclear: it backs no new debt, counts toward the liquidation line at the lower of its price and that sample, and can't be seized. Narrow it for calmer stocks, widen it for volatile ones. |
| `jump_hold_secs` | xStock 1d | 1h to 7d, multiplier tokens only | How long a jump must hold, with no multiplier change, before the crank accepts it as a real move and the token can be seized again. Must exceed the longest an issuer could lag the feed in applying a split; it also widens the window around a recorded or scheduled change. While it runs, a crashed xStock that is an account's only collateral can't be liquidated. An unscheduled split where the feed reprices first looks exactly like a crash: the line takes the lower price and other collateral can be sold at the bonus until the issuer applies it. |
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

## Per asset and LP market

| Setting | Devnet | Allowed | Tuning notes |
|---|---|---|---|
| `group` | SOL 0, stock 1, USDC 2 | column in the shock tables | Which crash column the asset falls with. |
| `liq_cost_bps` | SOL 500, stock 1000, USDC 0 | < 10000; ≥ about 476 at a 5% bonus | Haircut for the cost of liquidating. Should grow with position size and thin liquidity (memecoins). |
| `max_price_age_secs` | 1 day | > 0 | Oldest accepted price. A day is demo-only; mainnet Pyth needs seconds to minutes. |
| `max_conf_bps` | 200 | 1 to 2000 | Widest accepted Pyth confidence band. |
| `deposit_cap` | 0 (no cap) | 0 = uncapped | Cap per asset. Should follow on-chain depth for risky assets. |
| `oracle`, `pyth_feed_id` | SOL Pyth feed, stock placeholder | | The stock needs a real feed before demo mode goes off. |
| LP market `liq_cost_bps` | 500 | same rule as assets | Haircut on Orca and Raydium positions. A Raydium pool for the same pair can be thinner than Orca's, so give each market its own cost from its depth. |
| `RAYDIUM_CLMM_PROGRAMS` | mainnet `CAMMCzo5…`, devnet `DRayAUg…` | constant in `constants.rs` | The only programs besides Orca whose pools can list. Raydium can upgrade its program, so recheck the position and pool layouts (offsets in `clmm.rs`) after each Raydium upgrade. |
| Demo prices (setup.ts) | SOL at the pool price, stock $180 | | Starting demo feed. |

## Hard caps in `programs/pluribus/src/constants.rs`

These need a program upgrade to change.

| Constant | Value | What it bounds |
|---|---|---|
| `MAX_JUNIOR_PAUSE_SECS` | 90d | Any single pause |
| `MAX_JUNIOR_DELAY_SECS` | 30d | The exit wait |
| `MAX_ACTIVATION_DELAY_SECS` | 30d | How long the admin can lock itself out of loosening |
| `MIN_JUNIOR_EXIT_WINDOW_SECS` / `MAX_JUNIOR_EXIT_WINDOW_SECS` | 60s / 3d | The claim window; the max also sets the minimum pause gap |
| `MAX_JUNIOR_EXIT_FEE_BPS` | 100 | The exit fee |
| `MAX_POSITIONS` / `MAX_SCENARIOS` / `MAX_GROUPS` / `TIERS` | 5 / 4 / 6 / 3 | Account and table sizes (changing these is a migration) |
| `VIRTUAL_SHARES` | 1 USDC | First-depositor protection per tranche |

## Off-chain services and demo

| Setting | Where | Default | Notes |
|---|---|---|---|
| `INTERVAL_MS` | keeper env | 5000 | How often the keeper checks for liquidations and tiers. |
| `AUTOPAY_INTERVAL_MS` | keeper env | 600000 | How often each LP position's fees are harvested. |
| `GRANT` | `web/src/app/api/faucet/route.ts` | 0.05 SOL (10 on localnet), 50 stock, 5000 USDC | Test tokens per wallet. |
| Faucet stock | `scripts/faucet-stock.ts` flags | 0.4 SOL, 5 positions of $20 on devnet | What the faucet wallet holds to hand out. |
| `MAX_MOVE` | `web/src/app/api/demo/price/route.ts` | 20x | Largest demo price move per request. |
| `SWAP_USD` | `web/src/app/api/demo/harvest/route.ts` | $1000 | Trade size used to generate LP fees in the demo. |
| Lookup table | `deployments/<cluster>.json` `lookupTable` | made by setup | v0 transactions through it keep liquidations of accounts with many Token-2022, staking or LP positions under the 1232-byte limit. Setup extends it when assets or markets are added; rerun setup after listing anything. |
| `demo_mode` | pool flag | on | The admin sets prices, which gets around every delay. Turn it off (one way) before real money. |

## Not yet settings

Planned in the earlier research and plans, not implemented:

- **Per-asset risk premium** for memecoins and thin stocks, routed to juniors. Today `junior_premium_bps` is one flat rate on senior yield.
- **Coverage gate:** block risky draws when junior deposits fall below X% of risky debt.
- **Depth-based limits:** cap liquidation size and deposits at the Orca depth within the bonus (`D(m)`), and size haircuts with it.
- **Fee-implied σ (Panoptic)** for pool tokens without a feed. Left out on purpose for now: it needs a volume crank and can be wash-traded to push σ around.
- **An emergency switch for a broken LST backing.** If a stake pool account stops reading (for example after an upstream migration), that LST's health checks fail, and the fix (`rate_source` → NONE or FIXED) waits out the activation delay. Liquidations of that LST are frozen meanwhile. Options: let the guardian switch to FIXED at or below the last rate at once, or fall back to the own price with an extra haircut.
- **Close publish times for the LST's two prices.** The SOL leg is accepted anywhere inside the LST's own age window, so a liquidator can pick the lowest SOL print in that window.
- **SDK reads the deployment file, not the chain,** for LST backing accounts and the xStock multiplier. A timelocked on-chain change needs a regenerated deployment JSON.
- **Fee harvesting for Raydium positions.** Autopay only collects Orca fees; Raydium positions keep their fees until the owner withdraws the NFT.
- **One Raydium program per cluster.** Both Raydium ids are accepted everywhere; listing is admin-only, but a build flag could pin each cluster to its own id.
- **Raydium's admin can turn off `decrease_liquidity` for a pool**, which would leave a liquidator holding an NFT it can't redeem. Watch Raydium pool status for listed markets.
- **Very large LP sides overflow.** A position whose token side would exceed u64 at a shocked price fails every health check for that account (Orca too). Only plausible for base tokens with many decimals; cap decimals at listing or saturate.
- **Meteora DLMM positions.** Deferred: positions can't be handed over like an NFT, so custody would need CPI for every action and a new liquidation path.
- **A cap on each instant shock raise**, so one tightening cannot make every borrower liquidatable at once.
- **Reopening a wiped tranche with a fresh share mint (a bug to fix before mainnet).** After a 100% junior loss, the dead shares still count in the share price, so every new dollar mints about `dead_supply` shares. Token supply is a u64, so the tranche can then never hold more than about `$18.4T / dead_supply_in_USDC` (10M dead caps it near $1.8M; the 100k devnet seed near $184M). Deposits and `convert_to_junior` past that cap fail with `MathOverflow`. The senior tranche has the same maths. Fix: an admin instruction allowed only when junior assets are 0 that opens a new junior mint and escrow (seeded by an epoch counter), so new money starts again at $1 a share and the old mint is retired. Exits still queued on the old mint close out at $0.
