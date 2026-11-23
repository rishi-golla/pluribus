# Using Pluribus

Pluribus lends USDC against one account holding SOL, staked SOL, tokenized stocks, a memecoin and liquidity positions together. Lenders supply the USDC through a senior or a junior tranche.

The settings in force are in [Numbers on devnet](#numbers-on-devnet), and the hosted demo's differences in [The hosted demo](#the-hosted-demo).

## Status

- The program runs on Solana devnet and on a separate test chain behind the hosted demo at [pluribus.finance](https://www.pluribus.finance). Both use mock tokens.
- On devnet the admin sets the prices of SOL, NVDAx, AAPLx and BONK. JitoSOL and JupSOL read live Pyth feeds.
- On the hosted demo, a script copies real mainnet prices onto the chain every 10 seconds: from Pyth for SOL, JitoSOL and JupSOL, and from Orca pools for NVDAx, AAPLx and BONK, whose Pyth feeds go stale on-chain.
- The program has not been audited.
- On each chain, one key is both the admin and the upgrade authority.

## Borrowing

### Collateral

A credit account holds up to 16 positions, and you borrow against all of them together.

| Collateral | In the web app |
|---|---|
| SOL, USDC | yes |
| NVDAx and AAPLx, mock tokenized stocks (AAPLx is Token-2022) | yes |
| JitoSOL and JupSOL, mock staked SOL | yes |
| BONK, a mock memecoin, priced per million tokens | yes |
| Orca SOL/USDC liquidity position | yes |
| Meteora DLMM SOL/USDC liquidity position | yes, opened through the app |
| Raydium SOL/USDC liquidity position | SDK only |

### Meteora DLMM

A Meteora position can't change owner, so you can't deposit one you already hold. You open a new one through Pluribus, which owns it.

- **Opening:** **Deposit** on the Borrow page, then pick the Meteora pair. Enter SOL and USDC, pick a strategy (Spot, Curve or Bid Ask) and set the range, up to 70 bins. Opening and funding is one transaction. It costs about 0.06 SOL of rent, returned on close, plus about 0.07 SOL for each new bin array, which Meteora keeps.
- **Adding:** **Add** puts more SOL and USDC into the same range. A range wholly above or below the price takes only one of the two.
- **Withdrawing:** **Withdraw** takes back any share, as long as the debt stays within the credit limit.
- **Closing:** **Close** an empty position to collect its fees and rent and free the slot.
- **Value:** from the position's liquidity at the oracle price, never the pair's price. Each bin counts as whichever token is worth less.
- **Liquidation:** sold in part. The liquidator repays part of the debt and receives that share of every bin plus the bonus. A position taken whole is closed and its rent returns to you.
- A paused market, a pair Meteora has disabled or a listing still in its activation delay takes no new liquidity.

### Credit limit

Under each crash scenario the program:

1. prices each position at the low end of the oracle's confidence band,
2. cuts the price by the scenario's shock for the asset's group,
3. cuts the value by the asset's liquidation cost,
4. adds up the positions.

The lowest total is the credit limit. Because positions are added before the worst scenario is picked, a mixed account borrows more than the same assets held separately.

A liquidity position is revalued at each crash price from its range, and its USDC side takes the USDC shock. Each asset's shock is the larger of the table value and `z × σ × √T` from its recent volatility.

These back no new debt but still count against liquidation:

- an asset paused by the admin or the guardian
- a listing still in its activation delay
- a price older than `max_price_age_secs`
- a Token-2022 token that is paused, has a frozen or short vault, or has an unclear price around a split

### Interest

- The rate follows utilization: gentle up to the kink, steep above it. It accrues every second, with no maturity.
- An account that stays above the warning health long enough moves to a cheaper tier. Health is the liquidation limit divided by the debt.
- Falling under the warning health, or a liquidation, returns it to the base tier.
- Apart from a liquidation, tiers change only through `refresh_tier`, which the keeper sends.

### Risk premium

- Risky collateral adds a yearly premium: 15% for BONK, 3% for NVDAx and AAPLx. Everything else adds none.
- Your premium is each position's premium weighted by its share of your credit limit in a crash.
- You pay all of it at the base tier, 60% after 7 healthy days and 30% after 30.
- It is charged as debt and paid to junior lenders.
- It is recalculated when you draw or withdraw, and by the keeper about every 10 minutes.

### Autopay

Anyone can collect the trading fees of a deposited Orca, Raydium or Meteora position and keep the pool's bounty, 2% of the fees. The USDC repays your debt. The SOL, and any USDC beyond the debt, stays in the account as collateral. Fees are collected through the SDK or the **Collect fees** button on the Overview page, which collects every position worth it and pays the bounty to your wallet. Autopay can't be switched off, but a position can compound instead.

#### Compounding

The **Fees** button on a collateral row chooses between **repay debt** (the default) and **compound within** a tolerance.

- Anyone can compound the position: its fees go back into it, minus the same bounty. Whatever the range can't take stays in your account as collateral.
- It only runs while the pool's price is within your tolerance of the oracle's: 0.5%, 1%, 2% or a custom value up to 10%.
- Orca, Raydium and Meteora positions all compound. A Meteora position's price moves in bin steps, so a tolerance tighter than the bin step can leave it waiting.

### Repaying and withdrawing

- Anyone can repay any amount on any account at any time.
- `repay_from_collateral` pays debt with USDC already in the account.
- A withdrawal goes through if the debt stays within the credit limit.
- `close_account` (**Close account** on the Borrow page) closes an empty account with no debt and returns its rent.

### Statements

The Statements page lists each month's draws, repayments, autopay, interest and risk premium, with the opening and closing debt. **Lending activity** below it lists your deposits, conversions, withdrawals and exit queue moves when an indexer is connected.

### Liquidation

An account can be liquidated once its debt is above its liquidation limit, which is worked out like the credit limit with smaller shocks.

- A liquidator repays up to the close factor of your debt per transaction and takes collateral worth that plus the bonus. An asset's own bonus can only be lower than the pool's.
- The program picks the order: first the position worth least, per dollar of market value, in the scenario that sets your liquidation limit. Once the debt is more than 10% over the limit, any position can be taken.
- An Orca or Raydium position is sold whole. What the close factor doesn't let through to your debt stays in your account as USDC.
- Anyone can pay your debt with USDC in your account, with no bonus.
- A liquidation returns the account to the base tier.
- A stock with an unclear price around a split can't be taken until it is clear.
- Debt left after the collateral runs out is written off as a loss.

## Lending

### Tranches

| | Senior | Junior |
|---|---|---|
| Takes losses | last | first |
| Rate | the senior rate | senior rate × (1 + premium × senior ÷ junior) |
| Exit | at once from idle USDC, otherwise the withdrawal queue | through the exit queue |

Lenders get the interest left after the reserve factor and the protocol fee. The fewer juniors there are, the more each junior dollar earns, up to the multiple at a tenth of the target share.

On devnet, interest collects in a buffer and each weekly epoch pays out what the buffer held when it opened, less a margin. The hosted demo pays lenders as interest accrues.

### Loss order

Debt left with no collateral is taken from, in order:

1. interest in the buffer not yet paid out
2. the insurance reserve
3. uncollected protocol fees
4. junior lenders
5. senior lenders

### Leaving

**Senior.** `lend_withdraw` pays at once from idle USDC. When the pool is lent out it fails with `InsufficientLiquidity`, and the queue takes over:

1. `request_senior_exit` escrows your shares, fixes their value and takes the next ticket.
2. Idle USDC up to what the queue is owed is held back from draws, withdrawals, junior claims and fee collection.
3. `settle_senior_exit` pays the head of the queue in full once the pool's cash covers it. Anyone can send it, and the keeper does. Tickets are paid in order.
4. `cancel_senior_exit` returns shares worth what you queued.

Queued shares earn nothing and still take losses, so an exit pays the lower of its queued value and its value when settled.

**Junior.**

1. `request_junior_exit` escrows your shares and fixes their value. One exit per wallet at a time.
2. Wait out the exit delay.
3. Claim inside the claim window, in USDC if the pool has it idle, or in senior shares. The exit fee stays with the remaining juniors.

- Queued shares earn nothing and still take losses.
- You can cancel at any time. An unclaimed exit lapses, and anyone can then cancel it, returning the shares to you.
- The admin can pause junior exits. During a pause you can cancel but not queue or claim.

`convert_to_junior` turns senior shares into junior shares.

### Rule changes

- Tightening applies at once: raising a shock or a liquidation cost, lowering a deposit cap, pausing.
- Everything else, new listings included, waits out the activation delay, which is at least the junior exit delay plus the claim window.
- The guardian can cancel a waiting change or pause an asset, nothing more.
- On devnet the admin sets prices directly, which bypasses every delay.

## Numbers on devnet

As read on 23 Nov 2026. `doc_and_refs/TUNES.md` lists every setting with its allowed range and wins where it disagrees with this page.

### Shocks

Draw shock / liquidation shock.

| Scenario | SOL | Stocks | USDC | Staked SOL | Memecoins |
|---|---|---|---|---|---|
| Crypto crash | 30% / 20% | 15% / 10% | 3% / 1% | 35% / 23% | 60% / 45% |
| Equity crash | 15% / 10% | 35% / 25% | 3% / 1% | 20% / 13% | 30% / 20% |
| Broad selloff | 25% / 17% | 25% / 17% | 3% / 1% | 30% / 20% | 50% / 38% |

### What $10,000 of collateral supports

| Collateral | Liquidation cost | Credit limit | Liquidation limit |
|---|---|---|---|
| SOL | 5% | $6,650 | $7,600 |
| JitoSOL or JupSOL | 6% | $6,110 | $7,238 |
| NVDAx or AAPLx | 10% | $5,850 | $6,750 |
| USDC | 0% | $9,700 | $9,900 |
| BONK | 15% | $3,400 | $4,675 |
| $5,000 SOL + $5,000 NVDAx | | $6,937.50 | $7,650 |

In two separate accounts, the last row's credit limit would be $6,250.

### Borrowing

| Setting | Value |
|---|---|
| Rate at 0%, 90% and 100% utilization | 2%, 10%, 70% |
| Kink | 90% utilization |
| Interest to the reserve, the protocol, lenders | 10%, 10%, 80% |
| Tier discounts | 0.40% after 7 healthy days, 0.80% after 30 |
| Risk premiums | BONK 15%, NVDAx and AAPLx 3%, others 0% |
| Premium charged per tier | 100%, 60%, 30% |
| Warning health | 1.10 |
| Liquidation bonus | 5%, or an asset's own lower one |
| Close factor | 50% of the debt per transaction |
| Oldest price | 1 day for JitoSOL and JupSOL; the other prices don't expire |
| LP fee bounty | 2% |

### Lending

| Setting | Value |
|---|---|
| Junior premium | 15% |
| Junior target share | 10% of the pool |
| Junior rate at 1% of the pool or less | 15.85 × the senior rate |
| Junior rate at 5% of the pool | 3.85 × the senior rate |
| Junior rate at the target share | 2.35 × the senior rate |
| Junior rate at 50% of the pool | 1.15 × the senior rate |
| At 90% utilization, juniors at 10% | senior 6.34%, junior 14.91% |
| Epoch | 7 days, from Friday 00:00 UTC |
| Margin held back each epoch | 10% of the buffer |
| Junior exit delay | 6 days |
| Claim window | 2 days |
| Exit fee | 0.05% |
| Longest pause of junior exits | 90 days, 14 days between pauses |
| Activation delay | 8 days |

## The hosted demo

[pluribus.finance](https://www.pluribus.finance) runs the same program on its own test chain, with addresses in `deployments/macmini.json`. A keeper, the indexer and a price feed run beside it. As read on 23 Nov 2026, it differs from devnet only in:

| Setting | Devnet | Hosted demo |
|---|---|---|
| Prices | set by the admin, live Pyth for JitoSOL and JupSOL | real mainnet prices, copied every 10 seconds |
| Oldest price | 1 day for JitoSOL and JupSOL, the others don't expire | 1 day, 4 days for AAPLx liquidations |
| Interest to lenders | weekly epochs | as it accrues |
| Junior exit delay | 6 days | 5 seconds |
| Claim window | 2 days | 60 seconds |
| Activation delay | 8 days | 70 seconds |
| Time between pauses of junior exits | 14 days | about 3 days |
| Raydium pool | listed | not listed |

The wallet menu's **Get test tokens** and **Get 50,000 USDC** work there. The demo price controls are off.

## Try it

On a local chain, on Linux, macOS or WSL, with Rust 1.89.0, Solana CLI 4.1.2, Anchor 1.2.2 and Node 22. The scripts sign with `~/.config/solana/id.json`.

```sh
npm install
anchor build --ignore-keys
npm run localnet   # keep it running
npm run dev        # in a second terminal, then open http://localhost:3000
```

1. Open **Borrow** and connect a wallet. "Demo wallet" needs no extension.
2. Press **Get test tokens** in the wallet menu: 10 SOL, 50 NVDAx, 5,000 USDC, 10 JitoSOL, 10 JupSOL, 20 AAPLx, 100,000,000 BONK and an Orca position. **Get 50,000 USDC** tops up USDC. If the faucet skips the newer tokens, run `npm run faucet:stock`.
3. Deposit collateral and draw USDC.
4. Lend on **Earn**.

Without a local chain, `npm run dev` uses the hosted demo's chain, and `NEXT_PUBLIC_CLUSTER=devnet npm run dev` uses devnet. **Get test tokens** needs the faucet key in `FAUCET_SECRET`. On devnet it sends 0.05 SOL instead of 10.
