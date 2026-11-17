// One loop that liquidates, refreshes loyalty tiers, collects LP fees and keeps the demo feed fresh
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import anchor from "@coral-xyz/anchor";
import {
  IGNORE_CACHE,
  NO_TOKEN_EXTENSION_CONTEXT,
  WhirlpoolContext,
  buildWhirlpoolClient,
  collectFeesQuote,
} from "@orca-so/whirlpools-sdk";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  type TransactionInstruction,
} from "@solana/web3.js";
import BN from "bn.js";
import {
  type CreditAccount,
  type Deployment,
  type HealthView,
  type Pool,
  KIND_LP,
  KIND_TOKEN,
  MAX_U64,
  buildTransaction,
  decodeError,
  fetchAllCredits,
  fetchCredit,
  fetchHealth,
  fetchPool,
  getProgram,
  ix,
  pda,
} from "../sdk/index.ts";

const env = process.env;
const BPS = new BN(10_000);
// Borrow indexes are scaled by 1e18
const INDEX_ONE = new BN(10).pow(new BN(18));

function millis(name: string, fallback: number): number {
  const n = Number(env[name] ?? fallback);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number of milliseconds, got "${env[name]}"`);
  return n;
}

function readJson(file: string, hint: string) {
  if (!fs.existsSync(file)) throw new Error(`${file} is missing, ${hint}`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${file} is not valid JSON`);
  }
}

const cluster = env.CLUSTER ?? /devnet|testnet|mainnet/.exec(env.RPC_URL ?? "")?.[0] ?? "localnet";
const d: Deployment = readJson(
  path.join(import.meta.dirname, "../deployments", `${cluster}.json`),
  `run setup for ${cluster} or set CLUSTER`,
);
const keypairFile = env.KEEPER_KEYPAIR ?? path.join(os.homedir(), ".config/solana/id.json");
const secret = readJson(keypairFile, "set KEEPER_KEYPAIR to a keypair file");
if (!Array.isArray(secret) || secret.length !== 64) throw new Error(`${keypairFile} is not a Solana keypair file`);
const keeper = Keypair.fromSecretKey(Uint8Array.from(secret));
const me = keeper.publicKey;
const intervalMs = millis("INTERVAL_MS", 5000);
const autopayMs = millis("AUTOPAY_INTERVAL_MS", 600_000);
const dryRun = env.DRY_RUN === "1";

const connection = new Connection(env.RPC_URL ?? d.rpcUrl, "confirmed");
const program = getProgram(connection);
const orca = buildWhirlpoolClient(WhirlpoolContext.from(connection, new anchor.Wallet(keeper)));
const usdcMint = new PublicKey(d.usdcMint);
const keeperUsdc = getAssociatedTokenAddressSync(usdcMint, me);

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const usd = (units: BN) => (Number(units.toString()) / 1e6).toFixed(2);
const symbol = (mint: PublicKey) => d.assets[mint.toBase58()]?.symbol ?? mint.toBase58();
// The program's own message when a transaction failed inside it, else the first line of the error and its cause
const reason = (e: any): string =>
  decodeError(e?.logs ?? [])?.message ?? [e?.message ?? e, e?.cause?.message].filter(Boolean).join(": ").split("\n")[0];
const attempt = (what: string, run: () => Promise<unknown>) => run().catch((e) => log(`${what} failed: ${reason(e)}`));

// Sends one action and logs it, and returns false when nothing was sent
async function send(what: string, ixs: TransactionInstruction[]): Promise<boolean> {
  if (dryRun) {
    log(`Dry run, not sent: ${what}`);
    return false;
  }
  // A v0 transaction through the deployment's lookup table, so liquidating a crowded account still fits in one
  const latest = await connection.getLatestBlockhash();
  const tx = await buildTransaction(connection, d, keeper.publicKey, ixs, latest.blockhash);
  tx.sign([keeper]);
  const signature = await connection.sendTransaction(tx);
  const { value } = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  if (value.err) throw new Error(`Transaction ${signature} failed: ${JSON.stringify(value.err)}`);
  log(`${what}, tx ${signature}`);
  return true;
}

// Takes one liquidation step, cheapest first, and returns whether a transaction went out
async function liquidateStep(pool: Pool, owner: PublicKey, credit: CreditAccount, health: HealthView): Promise<boolean> {
  // A position whose price is unclear around a corporate action can't be seized yet, so the others go first
  const held = credit.positions
    .map((p, slot) => ({ ...p, value: health.positionValue[slot], unclear: health.positionUnclear[slot] }))
    .filter((p) => p.kind !== 0 && !p.unclear);
  const maxRepay = health.debt.mul(new BN(pool.params.closeFactorBps)).div(BPS);

  // The account's own USDC needs no money from the keeper and pays no bonus
  const own = held.find((p) => p.kind === KIND_TOKEN && p.mint.equals(usdcMint));
  if (own) {
    const amount = BN.min(own.amount, maxRepay);
    return send(
      `Liquidation of ${owner}: ${usd(amount)} USDC of its own collateral netted against debt`,
      await ix.repayFromCollateral(program, d, me, owner, MAX_U64),
    );
  }

  const balance = await connection.getTokenAccountBalance(keeperUsdc).then(
    (b) => new BN(b.value.amount),
    () => null,
  );
  // Tokens before LP positions, largest first
  held.sort((a, b) => a.kind - b.kind || b.value.cmp(a.value));
  for (const p of held) {
    const lp = p.kind === KIND_LP;
    // What the whole position sells for at the liquidation discount, rounded up like the program does
    const price = p.value.mul(BPS).div(BPS.addn(pool.params.liqBonusBps)).addn(1);
    // An NFT cannot be split, so an LP position is always paid for in full
    const pay = lp ? price : BN.min(maxRepay, price);
    const name = lp ? `LP position ${p.mint.toBase58()}` : `${symbol(p.mint)} collateral`;
    if (!balance || balance.lt(pay)) {
      const has = balance ? `holds ${usd(balance)} USDC` : `has no USDC account ${keeperUsdc.toBase58()}`;
      log(`Skipped liquidating ${name} of ${owner}: keeper ${has} and needs ${usd(pay)}`);
      continue;
    }
    return send(
      `Liquidation of ${owner}: up to ${usd(pay)} USDC paid for ${name}`,
      lp ? await ix.liquidateLp(program, d, me, owner, p.mint) : await ix.liquidate(program, d, me, owner, p.mint, maxRepay),
    );
  }
  return false;
}

// The tier `refresh_tier` would leave the account in, by the same rules as the program
function expectedTier(pool: Pool, credit: CreditAccount, health: HealthView, now: number): number {
  const p = pool.params;
  let to = credit.tier;
  if (health.debt.isZero()) return to;
  let since = credit.healthySince.toNumber();
  if (health.liquidationLimit.mul(BPS).lt(health.debt.muln(p.warnHealthBps))) {
    to = 0;
    since = now;
  }
  while (to + 1 < p.tierMinHealthySecs.length && now - since >= p.tierMinHealthySecs[to + 1].toNumber()) to++;
  return to;
}

async function watchDebt(pool: Pool, owner: PublicKey, now: number) {
  const read = async () => ({ credit: await fetchCredit(program, owner), health: await fetchHealth(program, d, owner) });
  let { credit, health } = await read();
  while (credit && health?.debt.gt(health.liquidationLimit)) {
    if (!(await liquidateStep(pool, owner, credit, health))) break;
    ({ credit, health } = await read());
  }
  if (!credit || !health) return;
  const to = expectedTier(pool, credit, health, now);
  if (to !== credit.tier) {
    await send(`Tier of ${owner}: refreshed from ${credit.tier} to ${to}`, await ix.refreshTier(program, d, owner));
  }
}

const lastFeeCheck = new Map<string, number>();

async function autopay(pool: Pool, account: CreditAccount, positionMint: PublicKey) {
  const owner = account.owner;
  const id = positionMint.toBase58();
  if (Date.now() - (lastFeeCheck.get(id) ?? 0) < autopayMs) return;
  lastFeeCheck.set(id, Date.now());
  // Only Orca positions in the main whirlpool are harvested, Raydium positions keep their fees until withdrawn
  const position = await orca.getPosition(pda.orcaPosition(positionMint), IGNORE_CACHE).catch(() => null);
  if (!position?.getData().whirlpool.equals(new PublicKey(d.whirlpool))) return;
  // The pool's tokens are classic SPL tokens, which the program requires of every asset, so no transfer fee applies
  const fees = collectFeesQuote({
    whirlpool: position.getWhirlpoolData(),
    position: position.getData(),
    tickLower: position.getLowerTickData(),
    tickUpper: position.getUpperTickData(),
    tokenExtensionCtx: NO_TOKEN_EXTENSION_CONTEXT,
  });
  if (fees.feeOwedA.isZero() && fees.feeOwedB.isZero()) return;
  // The SOL fee, and USDC beyond what is owed, become collateral, which needs a free slot unless the account holds that token
  const holds = (mint: PublicKey) => account.positions.some((p) => p.kind === KIND_TOKEN && p.mint.equals(mint));
  const index = pool.borrowIndex[account.tier];
  const debt = account.debtShares.mul(index).div(INDEX_ONE);
  // USDC stays as collateral when it is more than the debt, or too little to retire a single debt share
  const kept = !fees.feeOwedB.isZero() && (fees.feeOwedB.gt(debt) || fees.feeOwedB.mul(INDEX_ONE).div(index).isZero());
  const slots = Number(!fees.feeOwedA.isZero() && !holds(new PublicKey(d.solMint))) + Number(kept && !holds(usdcMint));
  if (slots > account.positions.filter((p) => p.kind === 0).length) return;
  const owed = `${Number(fees.feeOwedA.toString()) / 1e9} SOL and ${usd(fees.feeOwedB)} USDC`;
  await send(
    `Autopay for ${owner}: ${owed} of fees from LP position ${id}`,
    await ix.autopay(program, d, me, owner, positionMint),
  );
}

// Re-sends each demo price before it is halfway to stale
async function heartbeat(pool: Pool, now: number) {
  if (!pool.demoMode || !pool.admin.equals(me)) return;
  const mints = Object.keys(d.assets).map((m) => new PublicKey(m));
  const [prices, assets] = await Promise.all([
    program.account.demoPrice.fetchMultiple(mints.map(pda.demoPrice)),
    program.account.asset.fetchMultiple(mints.map(pda.asset)),
  ]);
  for (const [i, mint] of mints.entries()) {
    const [price, asset] = [prices[i], assets[i]];
    if (!price || !asset || (now - price.publishTime.toNumber()) * 2 <= asset.params.maxPriceAgeSecs) continue;
    await attempt(`Demo feed heartbeat for ${symbol(mint)}`, async () =>
      send(
        `Demo feed heartbeat: ${symbol(mint)} kept at ${usd(price.price)}`,
        await ix.setDemoPrice(program, me, mint, price.price, price.conf),
      ),
    );
  }
}

// Feeds each asset's latest price into its volatility once it is a sample the program will take
async function volatility(pool: Pool, now: number) {
  const mints = Object.keys(d.assets).filter((m) => d.assets[m].priceAccount);
  const assets = await program.account.asset.fetchMultiple(mints.map((m) => pda.asset(new PublicKey(m))));
  const p = pool.params;
  for (const [i, m] of mints.entries()) {
    const asset = assets[i];
    if (!asset || asset.params.volHorizonSecs === 0) continue;
    const priceAccount = new PublicKey(d.assets[m].priceAccount!);
    const quote = pool.demoMode ? await program.account.demoPrice.fetchNullable(priceAccount) : null;
    // Pyth accounts are read by the program itself, so outside demo mode the keeper just tries
    const published = quote ? quote.publishTime.toNumber() : now;
    if (published < asset.volTime.toNumber() + p.volMinIntervalSecs || now - published > p.volMaxAgeSecs) continue;
    const mint = new PublicKey(m);
    await attempt(`Volatility of ${symbol(mint)}`, async () =>
      send(`Volatility of ${symbol(mint)} sampled`, await ix.updateVol(program, d, mint)),
    );
  }
}

let stopping = false;
let wake = () => {};

async function pass() {
  const [pool, credits, clock] = await Promise.all([
    fetchPool(program),
    fetchAllCredits(program),
    connection.getAccountInfo(SYSVAR_CLOCK_PUBKEY),
  ]);
  if (!clock) throw new Error("The RPC returned no clock sysvar");
  // The chain's own time, which is what the program compares against
  const now = Number(clock.data.readBigInt64LE(32));
  // First, because a stale price blocks every health check below
  await attempt("Demo feed heartbeat", () => heartbeat(pool, now));
  // Right after, while a fresh price is still young enough to count
  await attempt("Volatility", () => volatility(pool, now));
  for (const { account } of credits) {
    if (stopping) return;
    const owner = account.owner;
    // Fees first, since they pay debt down at no cost before a liquidation is considered
    for (const p of account.positions) {
      if (p.kind === KIND_LP) await attempt(`Autopay for ${owner}`, () => autopay(pool, account, p.mint));
    }
    if (!account.debtShares.isZero()) await attempt(`Debt check of ${owner}`, () => watchDebt(pool, owner, now));
  }
}

const stop = () => {
  stopping = true;
  wake();
};
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, stop);
// Windows can't send a child process a signal, so a parent with an IPC channel asks for the same clean stop
process.on("message", (m) => m === "stop" && stop());
process.channel?.unref();

log(`Keeper ${me.toBase58()} on ${connection.rpcEndpoint} (${cluster}), every ${intervalMs} ms${dryRun ? ", dry run" : ""}`);
while (!stopping) {
  await attempt("Pass", pass);
  // A signal that came during the pass found nothing to wake
  if (stopping) break;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, intervalMs);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}
log("Keeper stopped");
