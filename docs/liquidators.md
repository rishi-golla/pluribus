# Liquidating on Pluribus

Anyone can liquidate. No registration or allow-list exists. The only deployment is on Solana devnet, with mock tokens and prices written by the admin key.

Every figure below is a setting. The values in force are in [Numbers on devnet](#numbers-on-devnet).

## When an account can be liquidated

An account can be liquidated when its debt is above its liquidation limit. The limit is the account's value in its worst crash scenario, after each asset's liquidation shock and liquidation cost.

The program's `health` view returns both numbers. The SDK simulates it, so nothing is sent or signed:

```ts
const health = await fetchHealth(program, d, owner);
const liquidatable = health.debt.gt(health.liquidationLimit);
```

| Field | Meaning |
|---|---|
| `debt` | what the account owes, with interest to now |
| `liquidationLimit` | debt above this can be liquidated |
| `creditLimit` | the most the owner may draw to |
| `collateralValue` | sum of the positions at the oracle price, no shock |
| `positionValue[5]`, `positionPrice[5]` | per slot, in the order of `credit.positions` |
| `positionUnclear[5]` | true while that position cannot be taken |

Amounts are USDC with 6 decimals. `fetchAllCredits(program)` lists every credit account.

## The three instructions

| Collateral | Instruction | You pay | You receive |
|---|---|---|---|
| A token other than USDC | `liquidate(repay_amount)` | USDC, up to the close factor × debt | tokens worth your payment × (1 + bonus) |
| A liquidity position | `liquidate_lp()` | its value ÷ (1 + bonus), in one payment | the position NFT |
| USDC in the account | `repay_from_collateral(amount)` | nothing | nothing |

### liquidate

- `repay_amount` is in USDC base units. Anything above the close factor × debt is cut down to it, so `u64::MAX` is valid.
- You receive `repay × (1 + bonus) ÷ price` tokens, rounded down. The price is the one the health check used: the low end of the oracle's band.
- When the position holds fewer tokens than that, you receive all of it and pay its value ÷ (1 + bonus), rounded up.
- A position priced at 0 is handed over whole for no payment. This happens when a Token-2022 issuer has emptied the vault.
- When a Token-2022 vault holds fewer tokens than the program's books, you receive your share: `seized × vault ÷ booked`. The price already reflects that.
- SOL arrives as wSOL.
- The USDC mint is refused with `InvalidParams`. Use `repay_from_collateral`.

### liquidate_lp

- It takes no amount. A position NFT cannot be split.
- The payment is the position's value at the oracle price ÷ (1 + bonus), rounded up.
- Up to the close factor × debt of it repays debt. The rest is deposited into the borrower's account as USDC collateral. You pay both parts.
- You receive the NFT. Closing the position on Orca or Raydium is up to you.
- The rent of the NFT's vault account goes to the borrower.
- Raydium's admin can turn off `decrease_liquidity` for a pool, which would leave you holding an NFT you cannot redeem.

### repay_from_collateral

- It moves the account's own USDC collateral onto its debt, one for one.
- Anyone can call it while the account is liquidatable, up to the close factor × debt per call.
- It pays no bonus and costs only the transaction fee.

## The health rule

Every liquidation must leave the margin between limit and debt no smaller:

```
debt_after + limit_before <= debt_before + limit_after
```

A liquidation that breaks it fails with `HealthNotImproved`.

## What stops a liquidation

| Error | Cause |
|---|---|
| `NotLiquidatable` | the debt is not above the liquidation limit |
| `StalePrice` | a price on any position of the account is older than that asset's `liq_price_age_secs`. One stale price blocks the whole account |
| `PriceTooUncertain` | an oracle band is wider than the asset's `max_conf_bps` |
| `PriceUnclear` | the position is a tokenized stock around a split. The account's other positions can still be taken |
| `HealthNotImproved` | the health rule above |
| `ZeroAmount` | the repayment or the seized amount rounds to nothing |
| `MissingAccount`, `AccountMismatch` | the health-check accounts are incomplete or out of order |
| a token program error | the collateral mint is paused or its vault frozen by the issuer |

## After a liquidation

- The account returns to the base rate tier.
- A `Liquidated` event carries `account`, `liquidator`, `mint`, `kind` (1 token, 2 liquidity position), `repaid`, `seized` and the remaining `debt`.
- When no collateral is left and debt remains, the debt is written off at once. A `BadDebt` event shows how much the yield buffer, the reserve, the protocol fees and the junior tranche each absorbed.
- An account whose debt is above the value of its collateral stays liquidatable after every step, until the collateral is gone.

## Building the transaction

Each instruction takes the health-check accounts as remaining accounts, in the order of the account's position slots:

- **Token:** its asset account. For a Token-2022 token, its mint and vault next. Then its price account, unless the asset is fixed at $1. For staked SOL, the SOL price account, and for a stake-pool backing the stake pool account.
- **Liquidity position:** the LP market, the position account on Orca or Raydium, the base asset, the base price account.

The SDK builders `ix.liquidate`, `ix.liquidateLp` and `ix.repayFromCollateral` add them, set a compute budget and create your token account.

Send a v0 transaction through the deployment's lookup table with `buildTransaction`. A legacy transaction for an account with several Token-2022, staking or liquidity positions passes the 1232-byte limit.

## Example

Save as `liquidate.ts` in the repository root.

```ts
// takes one liquidation step on every account that is past its liquidation limit
import fs from "node:fs";
import { Connection, Keypair } from "@solana/web3.js";
import { type Deployment, KIND_LP, MAX_U64, buildTransaction, decodeEvents, fetchAllCredits, fetchHealth, fetchPool, getProgram, ix } from "./sdk/index.ts";

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

Run twice on a local chain on 18 Nov 2026, against a borrower holding 50 NVDAx with $5,000 drawn, after the stock price was set from $180 to $100:

| | Debt | Liquidation limit | Borrower's NVDAx | Liquidator's USDC | Liquidator's NVDAx |
|---|---|---|---|---|---|
| Before | $5,000.00 | $3,375.00 | 50 | 6,000.00 | 0 |
| After run 1 | $2,500.00 | $1,603.13 | 23.75 | 3,500.00 | 26.25 |
| After run 2 | $1,250.00 | $717.19 | 10.625 | 2,250.00 | 39.375 |

## The reference keeper

`keeper/index.ts` is a working liquidator. Start it with `npm run keeper`.

| Variable | Default | Meaning |
|---|---|---|
| `CLUSTER` | read from `RPC_URL`, else `localnet` | which `deployments/<cluster>.json` to load |
| `RPC_URL` | the deployment's `rpcUrl` | RPC endpoint |
| `KEEPER_KEYPAIR` | `~/.config/solana/id.json` | signer, and the wallet whose USDC pays |
| `INTERVAL_MS` | 5000 | time between passes |
| `AUTOPAY_INTERVAL_MS` | 600000 | time between fee harvests per position |
| `DRY_RUN` | unset | `1` logs each action and sends nothing |

On each pass, for every account past its limit, it takes one step at a time:

1. It nets the account's own USDC against the debt.
2. It liquidates token positions, largest first.
3. It buys liquidity positions.

It skips a step when its USDC balance is short of the payment, and logs that. It also refreshes rate tiers, harvests Orca fees and records volatility samples. On a demo deployment it re-sends prices when it holds the admin key.

## Numbers on devnet

As deployed on 18 Nov 2026. `doc_and_refs/TUNES.md` lists every setting with its allowed range. If this page and that file disagree, the file is right.

| Setting | Value |
|---|---|
| Liquidation bonus (`liq_bonus_bps`) | 5%, the same for every asset and liquidity position |
| Close factor (`close_factor_bps`) | 50% of the debt per transaction |
| Liquidation cost (`liq_cost_bps`) | SOL 5%, staked SOL 6%, stocks 10%, USDC 0%, liquidity positions 5% |
| Oldest price for a liquidation (`liq_price_age_secs`) | 1 day, 4 days for AAPLx |
| Widest oracle band (`max_conf_bps`) | 2% |
| Liquidation shocks | see the shock table in [users.md](users.md#shocks) |

The liquidation cost is the haircut the program takes for the cost of selling an asset. For stocks it is twice the bonus.

Mock USDC on devnet comes only from the team's faucet wallet.

| Account | Address |
|---|---|
| Program | `A4UnuBwwBLbvxj3AnUtCDzkj11kp1wdPh8CydUn5quc7` |
| Lookup table | `A9KAGTcNirqiHQePpGe1pgvjdJrKAS62PemxoZeiiENS` |
| USDC (mock) | `75bxZeFLwNKqezhQ2KHhUASsuxVBJN31g9D8EuSuRW5U` |
| NVDAx (mock) | `3mGpn5jTL25imzYaSNwUtthQ7cJgpMsJnXmf1vJf4Gij` |
| AAPLx (mock, Token-2022) | `HDgRzeChz6fKBY1P5Ytdie3JigAteiq2eqphD5xeMEcm` |
| JitoSOL (mock) | `2FpbByvzXNwxQrq5cqDoGLf2bx8nHdMWx3dcugayk4er` |
| JupSOL (mock) | `F1FZjjvG7DRRvF3tnUVp9N8y6a46i7rH2qfYLhnA1dK6` |
| Orca SOL/USDC pool | `EHXKciegvkuBAm2P2TUChpkTvRNm4ewwaBa6JmfN8357` |

`deployments/devnet.json` holds the full list, including each price account.

## Test on a local chain

```sh
npm run localnet                                          # keep it running
npm run faucet -- --to <your address> --usdc 6000 --lp 0  # sends 20 SOL, 50 NVDAx and 6,000 mock USDC
npm run price -- --asset stock --price 100                # or --asset sol
```

`npm run price` moves the demo price of SOL or NVDAx. Lower it until a borrower's debt is above the liquidation limit, then run the example or the keeper with `CLUSTER=localnet`.
