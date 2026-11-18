# Using Pluribus

Pluribus lends USDC against one account that can hold SOL, staked SOL, tokenized stocks and concentrated-liquidity positions together. Lenders supply the USDC through a senior or a junior tranche.

Every figure the rules below depend on is a setting. The values in force are in [Numbers on devnet](#numbers-on-devnet).

## Status

- The only deployment is on Solana devnet. Its tokens are mocks with no value.
- Devnet prices are written by the admin key, not read from a market.
- The program has not been audited.
- One key is both the admin and the program's upgrade authority.
- There is no hosted app. You run the web app yourself, see [Try it](#try-it).

## Borrowing

### Collateral

A credit account holds up to 5 positions. You borrow USDC against all of them together.

| Collateral | In the web app |
|---|---|
| SOL | yes |
| NVDAx, a mock tokenized stock | yes |
| Orca SOL/USDC liquidity position | yes |
| USDC | SDK only |
| JitoSOL and JupSOL, mock staked SOL | SDK only |
| AAPLx, a mock Token-2022 stock | SDK only |
| Raydium liquidity position | no market is listed on devnet |

### Credit limit

The program values the whole account under each crash scenario and takes the worst result:

1. Each position is priced at the low end of the oracle's confidence band.
2. The price is cut by the scenario's shock for that asset's group.
3. The value is cut again by the asset's liquidation cost.
4. The positions are added up. The lowest total across the scenarios is the credit limit.

The totals are added before the worst one is picked, so a mixed account borrows more than the same assets held in separate accounts.

A liquidity position is revalued at each crash price from its range and liquidity, and its USDC side takes the USDC shock. Only the oracle price is used, never the pool's own price.

Each asset's shock is the larger of the table value and a value from its recent volatility, `z × σ × √T`. In a volatile market the limit falls below the table figures.

Some collateral backs no new debt while still protecting debt already drawn:

- an asset paused by the admin or the guardian
- a listing still inside the activation delay
- a price older than `max_price_age_secs`
- a Token-2022 token that its issuer has paused, whose vault is frozen or short of tokens, or whose price is unclear around a split

### Interest

- The rate follows pool utilization: it rises gently up to the kink and steeply above it.
- It is variable and accrues every second. There is no maturity and no repayment schedule.
- An account with debt that stays above the warning health long enough moves to a cheaper tier. Health is the liquidation limit divided by the debt.
- Falling under the warning health, or being liquidated, returns the account to the base tier.
- A tier changes only when someone sends `refresh_tier`. The keeper does this.

### Autopay

Anyone can collect the trading fees of a deposited Orca position in the main SOL/USDC pool. The USDC part repays your debt. The SOL part, and any USDC beyond the debt, stays in the account as collateral. The keeper does this every 10 minutes by default. It cannot be switched off. Raydium positions keep their fees until you withdraw them.

### Repaying and withdrawing

- You can repay any amount at any time. Anyone can repay any account.
- `repay_from_collateral` pays debt with USDC already in the account.
- A withdrawal goes through when the debt is still within the credit limit afterwards.
- There is no instruction to close a credit account.

### Liquidation

An account can be liquidated when its debt is above its liquidation limit. That limit is worked out like the credit limit, with smaller shocks.

- A liquidator repays part of your debt, up to the close factor per transaction, and takes collateral worth that amount plus the bonus.
- A liquidity position is sold whole. The liquidator pays its value less the bonus, and what the close factor does not let through to your debt stays in your account as USDC.
- Anyone can pay your debt down with USDC that is in your account. No bonus is charged for that.
- The account returns to the base rate tier.
- Liquidations repeat while the debt is above the limit.
- A stock whose price is unclear around a split cannot be taken until it is clear. Your other collateral can.
- If the collateral runs out with debt left, the rest is written off as a loss to lenders.

## Lending

### Tranches

| | Senior | Junior |
|---|---|---|
| Takes losses | last | first |
| Rate | the senior rate | senior rate × (1 + premium × senior ÷ junior) |
| Exit | at once, up to the idle USDC in the pool | through the exit queue |

Lenders receive the borrower interest left after the reserve factor and the protocol fee. The junior premium is paid in full once juniors hold the target share of the pool and scales down below it.

Interest is not paid as it arrives. It collects in a buffer, and each epoch pays out the buffer it opened with, less a margin, evenly over its length. The yield you see this week comes from last week's interest.

### Loss order

A loss is booked when a borrower's account has debt and no collateral left. It is taken from, in order:

1. interest in the buffer that has not been paid out
2. the insurance reserve
3. protocol fees not yet collected
4. junior lenders
5. senior lenders

### Leaving

**Senior.** `lend_withdraw` pays at once from idle USDC. When the pool is lent out it fails with `InsufficientLiquidity`, and there is no queue. The steep rate above the kink is what brings repayments in.

**Junior.**

1. `request_junior_exit` moves your shares into escrow and fixes their value. One exit per wallet at a time.
2. You wait out the exit delay.
3. You claim inside the claim window, in USDC if the pool has it idle, or in senior shares.
4. The exit fee stays with the juniors who remain.

- Queued shares earn nothing and still take losses.
- You can cancel at any time and get back shares worth what you queued.
- An exit not claimed in its window lapses. Anyone can then cancel it, which returns the shares to you.
- The admin can pause junior exits. During a pause nobody can queue or claim. Cancelling still works.

`convert_to_junior` turns senior shares into junior shares with no USDC moving.

### Rule changes

- Tightening applies at once: raising a shock or a liquidation cost, lowering a deposit cap, pausing.
- Everything else, including a new collateral listing, waits out the activation delay. That delay is at least the junior exit delay plus the claim window, so juniors can leave before new risk arrives.
- The guardian can cancel a waiting change or pause an asset. It cannot loosen anything or pause exits.
- On devnet the admin sets prices directly, which gets around every delay.

## Numbers on devnet

As deployed on 18 Nov 2026. `doc_and_refs/TUNES.md` lists every setting with its allowed range. If this page and that file disagree, the file is right.

### Shocks

Draw shock, then liquidation shock, per scenario.

| Scenario | SOL | Stocks | USDC | Staked SOL |
|---|---|---|---|---|
| Crypto crash | 30% / 20% | 15% / 10% | 3% / 1% | 35% / 23% |
| Equity crash | 15% / 10% | 35% / 25% | 3% / 1% | 20% / 13% |
| Broad selloff | 25% / 17% | 25% / 17% | 3% / 1% | 30% / 20% |

### What $10,000 of collateral supports

| Collateral | Liquidation cost | Credit limit | Liquidation limit |
|---|---|---|---|
| SOL | 5% | $6,650 | $7,600 |
| JitoSOL or JupSOL | 6% | $6,110 | $7,238 |
| NVDAx or AAPLx | 10% | $5,850 | $6,750 |
| USDC | 0% | $9,700 | $9,900 |
| $5,000 SOL + $5,000 NVDAx | | $6,937.50 | $7,650 |

Held in two separate accounts, the last row would have a credit limit of $6,250.

### Borrowing

| Setting | Value |
|---|---|
| Rate at 0%, 90% and 100% utilization | 2%, 10%, 70% |
| Kink | 90% utilization |
| Share of interest to the reserve, the protocol, lenders | 10%, 10%, 80% |
| Tier discounts | 0.40% after 7 healthy days, 0.80% after 30 |
| Warning health | 1.10 |
| Liquidation bonus | 5% |
| Close factor | 50% of the debt per transaction |
| Oldest price for a draw | 1 day |
| Oldest price for a liquidation | 1 day, 4 days for AAPLx |

### Lending

| Setting | Value |
|---|---|
| Junior premium | 15% |
| Junior target share | 10% of the pool |
| Junior rate at the target share | 2.35 × the senior rate |
| Example at 90% utilization, juniors at 10% | senior 6.34%, junior 14.91% |
| Epoch | 7 days, from Friday 00:00 UTC |
| Margin held back each epoch | 10% of the buffer |
| Junior exit delay | 6 days |
| Claim window | 2 days |
| Exit fee | 0.05% |
| Longest pause of junior exits | 90 days, with 14 days between pauses |
| Activation delay | 8 days |

## Try it

On a local chain, from a clone on Linux, macOS or WSL. Tested with Rust 1.89.0, Solana CLI 4.1.2, Anchor 1.2.2 and Node 22. The scripts sign with `~/.config/solana/id.json`.

```sh
npm install
anchor build --ignore-keys
npm run localnet   # keep it running; the first run downloads the Orca program from devnet
npm run dev        # in a second terminal, then open http://localhost:3000
```

1. Open **Borrow** and connect a wallet. "Demo wallet" needs no browser extension.
2. Press **Get test tokens**. It sends 10 SOL, 50 NVDAx, 5,000 USDC and one Orca position.
3. Deposit collateral, then draw USDC.
4. Open **Earn** to lend into either tranche.

With no local chain running, `npm run dev` points at devnet. **Get test tokens** shows there only when the server holds the faucet key in `FAUCET_SECRET`.
