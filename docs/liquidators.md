# Liquidating on Pluribus

Anyone can liquidate. The program runs on Solana devnet and on the hosted demo's test chain (`deployments/macmini.json`), both with mock tokens. On devnet the admin sets prices, except JitoSOL and JupSOL, which read live Pyth feeds. On the demo chain a script copies real mainnet prices onto the chain every 10 seconds.

The settings in force are in [Numbers on devnet](#numbers-on-devnet).

## When an account can be liquidated

When its debt is above its liquidation limit: the account's value in its worst crash scenario, after liquidation shocks and liquidation costs.

The program's `health` view returns both. The SDK simulates it, so nothing is signed:

```ts
const health = await fetchHealth(program, d, owner);
const liquidatable = health.debt.gt(health.liquidationLimit);
```

| Field | Meaning |
|---|---|
| `debt` | owed, with interest to now |
| `liquidationLimit` | debt above this can be liquidated |
| `creditLimit` | the most the owner may draw to |
| `collateralValue` | the positions at the oracle price, unshocked |
| `positionValue[16]`, `positionPrice[16]` | per slot of `credit.positions` |
| `positionUnclear[16]` | true while that position can't be taken |

Amounts are USDC with 6 decimals. `fetchAllCredits(program)` lists every credit account.

## The four instructions

| Collateral | Instruction | You pay | You receive |
|---|---|---|---|
| A token other than USDC | `liquidate(repay_amount)` | USDC, up to the close factor × debt | tokens worth your payment × (1 + bonus) |
| An Orca or Raydium position | `liquidate_lp()` | its value ÷ (1 + bonus) | the position NFT |
| A Meteora DLMM position | `dlmm_liquidate(repay_amount, bin_arrays)` | USDC, up to the close factor × debt | that share of every bin, worth your payment × (1 + bonus) |
| USDC in the account | `repay_from_collateral(amount)` | nothing | nothing |

The bonus is the asset's `liq_bonus_bps`, or `lp_liq_bonus_bps` on the base token for a liquidity position. Where it is 0 or above the pool's `liq_bonus_bps`, the pool's applies.

## The order

The program sets the order. An instruction for a position that isn't first fails with `NotFirstInOrder`, so simulate and try the next one.

- Each position's key is its value in the scenario that sets the liquidation limit ÷ its market value × (1 + its bonus). The lowest goes first.
- Keys within 0.0001 count as level.
- USDC is outside the order.
- Positions that can't be handed over (a stock around a split, a paused mint, a frozen or short vault) or are worth nothing are skipped.
- With the debt more than 10% above the limit, any position can be taken.

### liquidate

- `repay_amount` is in USDC base units and is capped at the close factor × debt, so `u64::MAX` works.
- You receive `repay × (1 + bonus) ÷ price` tokens, rounded down, at the low end of the oracle's band.
- If the position holds less, you get all of it and pay its value ÷ (1 + bonus), rounded up.
- A position priced at 0 is handed over free.
- A short Token-2022 vault pays its share: `seized × vault ÷ booked`.
- SOL arrives as wSOL. The USDC mint is refused with `InvalidParams`.

### liquidate_lp

- The payment is the position's oracle value ÷ (1 + bonus), rounded up.
- Up to the close factor × debt repays debt. The rest goes into the borrower's account as USDC. You pay both.
- You receive the NFT. The vault account's rent goes to the borrower.
- Raydium's admin can disable `decrease_liquidity` on a pool, which would leave the NFT unredeemable.

### dlmm_liquidate

- `repay_amount` is capped at the close factor × debt, so `u64::MAX` works.
- `bin_arrays` is the number of bin arrays leading the remaining accounts, 0 for a position that never held liquidity.
- The share taken is `repay × (1 + bonus) ÷ value`, at most 100%. You pay value × share ÷ (1 + bonus), rounded up.
- That share of every bin goes straight to your two token accounts.
- Taken whole, the position is closed with its fees, and its rent returns to the borrower.
- A position valued at nothing is handed over free.
- It works on a pair Meteora has disabled.

### repay_from_collateral

Moves the account's own USDC onto its debt, one for one, up to the close factor × debt per call. Anyone can call it while the account is liquidatable. No bonus.

## The health rule

A liquidation can't shrink the margin between limit and debt:

```
debt_after + limit_before <= debt_before + limit_after
```

Otherwise it fails with `HealthNotImproved`.

## What stops a liquidation

| Error | Cause |
|---|---|
| `NotLiquidatable` | the debt is not above the liquidation limit |
| `StalePrice` | any position's price is older than its `liq_price_age_secs`, which blocks the whole account |
| `PriceTooUncertain` | an oracle band is wider than `max_conf_bps` |
| `PriceUnclear` | the position is a stock around a split |
| `NotFirstInOrder` | another position comes first, see [The order](#the-order) |
| `HealthNotImproved` | the health rule above |
| `ZeroAmount` | the repayment or seized amount rounds to nothing |
| `MissingAccount`, `AccountMismatch` | the health-check accounts are incomplete or out of order |
| a token program error | the issuer paused the mint or froze the vault |

## After a liquidation

- The account returns to the base rate tier.
- A `Liquidated` event carries `account`, `liquidator`, `mint`, `kind` (1 token, 2 liquidity position, 3 Meteora), `repaid`, `seized` and the remaining `debt`. For Meteora, `seized` is the share in basis points.
- Debt left with no collateral is written off at once. A `BadDebt` event shows what the yield buffer, the reserve, protocol fees and juniors each absorbed.

## Building the transaction

Each instruction takes the health-check accounts as remaining accounts, in slot order:

- **Token:** its asset account; for Token-2022, its mint and vault; its price account unless fixed at $1; for staked SOL, the SOL price account, then the stake pool account if it has one.
- **Orca or Raydium position:** the LP market, the dex position account, the base asset, the base price account.
- **Meteora position:** the LP market, the pair, the position account, the base asset, the base price account. Its bin arrays go first, before all health-check accounts.

`ix.liquidate`, `ix.liquidateLp`, `ix.dlmmLiquidate` and `ix.repayFromCollateral` add these, create your token accounts and request 1.4M compute units. A full 16-position account takes about 550k, or about 1.06M for a Meteora liquidation.

Send it as a v0 transaction through the deployment's lookup table with `buildTransaction`. A legacy transaction can pass the 1232-byte limit.

## Example

Save as `liquidate.ts` in the repository root.

```ts
// takes one liquidation step on every account that is past its liquidation limit
import fs from "node:fs";
import { Connection, Keypair } from "@solana/web3.js";
import { type Deployment, KIND_DLMM, KIND_LP, MAX_U64, buildTransaction, decodeEvents, fetchAllCredits, fetchHealth, fetchPool, getProgram, ix } from "./sdk/index.ts";

const d: Deployment = JSON.parse(fs.readFileSync(`deployments/${process.env.CLUSTER ?? "devnet"}.json`, "utf8"));
const me = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.KEYPAIR!, "utf8"))));
const connection = new Connection(process.env.RPC_URL ?? d.rpcUrl, "confirmed");
const program = getProgram(connection);
const pool = await fetchPool(program);

for (const { account: credit } of await fetchAllCredits(program)) {
  const owner = credit.owner;
  // one stale price fails the whole health check, and that account is skipped
  const health = await fetchHealth(program, d, owner).catch(() => null);
  if (!health || !health.debt.gt(health.liquidationLimit)) continue;

  // slots with kind 0 are empty, and a position with an unclear price cannot be taken yet
  const slot = credit.positions.findIndex((p, i) => p.kind !== 0 && !health.positionUnclear[i]);
  if (slot < 0) continue;
  const { kind, mint } = credit.positions[slot];
  const maxRepay = health.debt.muln(pool.params.closeFactorBps).divn(10_000);
  const ixs =
    kind === KIND_LP
      ? await ix.liquidateLp(program, d, me.publicKey, owner, mint)
      : kind === KIND_DLMM
        ? await ix.dlmmLiquidate(program, d, me.publicKey, owner, mint, maxRepay)
        : mint.toBase58() === d.usdcMint
            ? await ix.repayFromCollateral(program, d, me.publicKey, owner, MAX_U64)
            : await ix.liquidate(program, d, me.publicKey, owner, mint, maxRepay);

  const latest = await connection.getLatestBlockhash();
  const tx = await buildTransaction(connection, d, me.publicKey, ixs, latest.blockhash);
  tx.sign([me]);
  const signature = await connection.sendTransaction(tx);
  await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  const sent = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
  const events = decodeEvents(sent?.meta?.logMessages ?? []).map((e) => e.name);
  console.log(`${owner.toBase58()} ${signature} ${events.join(", ")}`);
}
```

```sh
CLUSTER=localnet KEYPAIR=~/.config/solana/id.json npx tsx liquidate.ts
```

Two runs on a local chain against a borrower with 50 NVDAx and $5,000 drawn, after the stock fell from $180 to $100:

| | Debt | Liquidation limit | Borrower's NVDAx | Liquidator's USDC | Liquidator's NVDAx |
|---|---|---|---|---|---|
| Before | $5,000.00 | $3,375.00 | 50 | 6,000.00 | 0 |
| After run 1 | $2,500.00 | $1,603.13 | 23.75 | 3,500.00 | 26.25 |
| After run 2 | $1,250.00 | $717.19 | 10.625 | 2,250.00 | 39.375 |

## The reference keeper

`keeper/index.ts` is a working liquidator. Start it with `npm run keeper`.

| Variable | Default | Meaning |
|---|---|---|
| `CLUSTER` | from `RPC_URL`, else `localnet` | which `deployments/<cluster>.json` to load |
| `RPC_URL` | the deployment's `rpcUrl` | RPC endpoint |
| `KEEPER_KEYPAIR` | `~/.config/solana/id.json` | signer, and the wallet whose USDC pays |
| `INTERVAL_MS` | 5000 | time between passes |
| `PREMIUM_INTERVAL_MS` | 600000 | time between refreshes of accounts paying a risk premium |
| `PYTH_INTERVAL_MS` | 30000 | time between Pyth feed posts |
| `PYTH_PUSH` | on, except on `localnet` | `0` stops posting Pyth feeds |
| `DRY_RUN` | unset | `1` logs actions without sending |

For each account past its limit it first nets the account's own USDC against the debt, then tries token positions largest first, then liquidity positions, moving on after `NotFirstInOrder`. It skips a step it can't afford. It also refreshes tiers, samples volatility, pays the senior withdrawal queue, posts Pyth feeds and, on a demo deployment where it holds the admin key, re-sends prices. It doesn't collect LP fees.

## Numbers on devnet

As read on 23 Nov 2026. `doc_and_refs/TUNES.md` lists every setting and wins where it disagrees with this page.

| Setting | Value |
|---|---|
| Liquidation bonus (`liq_bonus_bps`) | SOL 1%, SOL liquidity positions 2%, NVDAx and AAPLx 5%, the rest the pool's 5% |
| Close factor (`close_factor_bps`) | 50% of the debt per transaction |
| Liquidation cost (`liq_cost_bps`) | SOL 5%, staked SOL 6%, stocks 10%, BONK 15%, USDC 0%, liquidity positions 5% |
| Oldest price (`liq_price_age_secs`) | 1 day for JitoSOL and JupSOL; the other prices don't expire |
| Widest oracle band (`max_conf_bps`) | 2% |
| Liquidation shocks | see [users.md](users.md#shocks) |

The demo chain has the same bonuses, costs and band, prices that expire after 1 day (4 days for AAPLx), and no Raydium pool.

| Account | Address |
|---|---|
| Program | `A4UnuBwwBLbvxj3AnUtCDzkj11kp1wdPh8CydUn5quc7` |
| Lookup table | `A9KAGTcNirqiHQePpGe1pgvjdJrKAS62PemxoZeiiENS` |
| USDC (mock) | `75bxZeFLwNKqezhQ2KHhUASsuxVBJN31g9D8EuSuRW5U` |
| NVDAx (mock) | `3mGpn5jTL25imzYaSNwUtthQ7cJgpMsJnXmf1vJf4Gij` |
| AAPLx (mock, Token-2022) | `HDgRzeChz6fKBY1P5Ytdie3JigAteiq2eqphD5xeMEcm` |
| JitoSOL (mock) | `2FpbByvzXNwxQrq5cqDoGLf2bx8nHdMWx3dcugayk4er` |
| JupSOL (mock) | `F1FZjjvG7DRRvF3tnUVp9N8y6a46i7rH2qfYLhnA1dK6` |
| BONK (mock, priced per million) | `CSAKKN1szfgwzr8KohREVtTB7GGdc9NdG4YCMU6KYZPM` |
| Orca SOL/USDC pool | `EHXKciegvkuBAm2P2TUChpkTvRNm4ewwaBa6JmfN8357` |
| Raydium SOL/USDC pool | `5ZnKViaNwjT2iCZsgAchihmUurnaKTau4MWPUj1MQSnP` |
| Meteora SOL/USDC pair | `Em4nQAHyFnCpm4FoofwqUX7KLcFvaZac42HXybVmnNHi` |

The full list, price accounts included, is in `deployments/devnet.json`. Mock USDC on devnet comes only from the team's faucet.

## Test on a local chain

```sh
npm run localnet                                          # keep it running
npm run faucet -- --to <your address> --usdc 6000 --lp 0  # 20 SOL, 50 NVDAx, 6,000 USDC
npm run price -- --asset stock --price 100                # or --asset sol
```

Lower the price until a borrower is past the liquidation limit, then run the example or the keeper with `CLUSTER=localnet`.
