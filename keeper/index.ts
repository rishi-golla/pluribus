// One loop that liquidates, refreshes loyalty tiers and risk premiums, pays the senior withdrawal queue and keeps the demo feed fresh
// LP fees are not its job: anyone collects them for the bounty, through the SDK or the app
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  KIND_DLMM,
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
  type Asset,
} from "../sdk/index.ts";
import { feedTimes, pushFeeds } from "./pyth.ts";

const env = process.env;
const BPS = new BN(10_000);

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
// How often an account paying a risk premium is refreshed, which books the premium and resets it to the collateral held
const premiumMs = millis("PREMIUM_INTERVAL_MS", 600_000);
// How often the push feeds of live assets are posted again; PYTH_PUSH=0 leaves them to someone else
const pythMs = millis("PYTH_INTERVAL_MS", 30_000);
const pythPush = env.PYTH_PUSH !== "0" && cluster !== "localnet";
const dryRun = env.DRY_RUN === "1";

const connection = new Connection(env.RPC_URL ?? d.rpcUrl, "confirmed");
const program = getProgram(connection);
const usdcMint = new PublicKey(d.usdcMint);
const keeperUsdc = getAssociatedTokenAddressSync(usdcMint, me);

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const usd = (units: BN) => (Number(units.toString()) / 1e6).toFixed(2);
const symbol = (mint: PublicKey) => d.assets[mint.toBase58()]?.symbol ?? mint.toBase58();
// Names for the feeds in the log, the first asset on a shared feed winning
const symbols = new Map<string, string>();
for (const a of Object.values(d.assets)) if (a.feedId && !symbols.has(a.feedId)) symbols.set(a.feedId, a.symbol);
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
    const dlmm = p.kind === KIND_DLMM;
    // The most the whole position can cost: its bonus is its asset's own, so the discount is not known here
    const price = p.value;
    // An NFT cannot be split, so an LP position is always paid for in full; a Meteora position is sold in part like a token
    const pay = lp ? price : BN.min(maxRepay, price);
    const name = lp ? `LP position ${p.mint.toBase58()}` : dlmm ? `Meteora position ${p.mint.toBase58()}` : `${symbol(p.mint)} collateral`;
    if (!balance || balance.lt(pay)) {
      const has = balance ? `holds ${usd(balance)} USDC` : `has no USDC account ${keeperUsdc.toBase58()}`;
      log(`Skipped liquidating ${name} of ${owner}: keeper ${has} and needs ${usd(pay)}`);
      continue;
    }
    const ixs = lp
      ? await ix.liquidateLp(program, d, me, owner, p.mint)
      : dlmm
        ? await ix.dlmmLiquidate(program, d, me, owner, p.mint, maxRepay)
        : await ix.liquidate(program, d, me, owner, p.mint, maxRepay);
    try {
      return await send(`Liquidation of ${owner}: up to ${usd(pay)} USDC paid for ${name}`, ixs);
    } catch (e: any) {
      // the program takes positions in its own order, so one that is not first yet waits for the ones ahead of it
      if (decodeError(e?.logs ?? [])?.name !== "NotFirstInOrder") throw e;
    }
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
  const id = owner.toBase58();
  if (to !== credit.tier) {
    await send(`Tier of ${owner}: refreshed from ${credit.tier} to ${to}`, await ix.refreshTier(program, d, owner));
    lastPremiumRefresh.set(id, Date.now());
    return;
  }
  // The premium is booked whenever the account is touched, so a quiet account is refreshed on a schedule:
  // that keeps junior payouts smooth and moves a changed collateral mix or asset premium into effect
  const charged = credit.premiumBps !== 0 || health.premiumRateBps !== 0;
  if (charged && Date.now() - (lastPremiumRefresh.get(id) ?? 0) >= premiumMs) {
    lastPremiumRefresh.set(id, Date.now());
    await send(`Premium of ${owner}: booked at ${health.premiumRateBps / 100}% a year`, await ix.refreshTier(program, d, owner));
  }
}

const lastPremiumRefresh = new Map<string, number>();

// Re-sends each demo price before it is halfway to stale
// An asset switched to its live feed reads Pyth instead, so its demo account is left alone
async function heartbeat(pool: Pool, assets: (Asset | null)[], now: number) {
  if (!pool.demoMode || !pool.admin.equals(me)) return;
  const mints = Object.keys(d.assets).map((m) => new PublicKey(m));
  const prices = await program.account.demoPrice.fetchMultiple(mints.map(pda.demoPrice));
  for (const [i, mint] of mints.entries()) {
    const [price, asset] = [prices[i], assets[i]];
    if (!price || !asset || asset.livePrice || (now - price.publishTime.toNumber()) * 2 <= asset.params.maxPriceAgeSecs) continue;
    await attempt(`Demo feed heartbeat for ${symbol(mint)}`, async () =>
      send(
        `Demo feed heartbeat: ${symbol(mint)} kept at ${usd(price.price)}`,
        await ix.setDemoPrice(program, me, mint, price.price, price.conf),
      ),
    );
  }
}

// Pyth feed ids in hex, without the placeholder an asset carries while it has no feed
const feedHex = (id: number[]) => (id.some((b) => b !== 0) ? Buffer.from(id).toString("hex") : null);

// The feeds the program reads for one asset: its own, and the SOL feed behind a staking token's backing
function feedsOf(asset: Asset): string[] {
  const p = asset.params;
  return [feedHex(p.pythFeedId), p.rateSource !== 0 ? feedHex(p.rateFeedId) : null].filter((f): f is string => !!f);
}

// An asset is priced from Pyth once the pool has left demo mode, or while the admin has switched it to its live feed
const isLive = (pool: Pool, asset: Asset) => !pool.demoMode || asset.livePrice;

// Posts fresh Hermes updates to the push accounts of `feeds` that are more than `maxAgeSecs` old, and logs what moved
async function postFeeds(what: string, feeds: Iterable<string>, maxAgeSecs: number, now: number) {
  const ids = [...new Set(feeds)];
  if (!pythPush || !ids.length) return;
  if (dryRun) return log(`Dry run, not posted: ${what}`);
  const posted = await pushFeeds(connection, keeper, ids, maxAgeSecs, now);
  if (posted.length) log(`${what}: ${posted.map((p) => `${symbols.get(p.feedId) ?? p.feedId.slice(0, 8)} at ${p.publishTime}`).join(", ")}`);
}

// Keeps the push feed of every asset the program prices from Pyth fresh, so its health checks never meet a stale price
async function pythFeeds(pool: Pool, assets: (Asset | null)[], now: number) {
  const live = assets.filter((a): a is Asset => !!a && isLive(pool, a));
  await postFeeds("Pyth feeds posted", live.flatMap(feedsOf), pythMs / 1000, now);
}

// Feeds each asset's latest price into its volatility once it is a sample the program will take
async function volatility(pool: Pool, assets: (Asset | null)[], now: number) {
  const p = pool.params;
  // `assets` runs in the deployment's order, and USDC has no price account
  const rows = Object.keys(d.assets).flatMap((m, i) => (d.assets[m].priceAccount && assets[i] ? [{ m, asset: assets[i] }] : []));
  // A sample needs a price at most `volMaxAgeSecs` old, which a feed posted every half minute or so would often miss,
  // so the feeds of assets that are due a sample are refreshed first
  const due = rows.filter(({ asset }) => asset.params.volHorizonSecs !== 0 && isLive(pool, asset) && now >= asset.volTime.toNumber() + p.volMinIntervalSecs);
  await attempt("Pyth feeds before volatility", () =>
    postFeeds("Pyth feeds posted for volatility", due.flatMap(({ asset }) => feedsOf(asset)), p.volMaxAgeSecs / 3, now),
  );
  for (const { m, asset } of rows) {
    if (asset.params.volHorizonSecs === 0) continue;
    // The demo account's publish time, or for a live asset the oldest of its feeds, since the program takes the older price
    let published = now;
    if (isLive(pool, asset)) {
      published = Math.min(now, ...(await feedTimes(connection, feedsOf(asset))).values());
    } else {
      const quote = await program.account.demoPrice.fetchNullable(new PublicKey(d.assets[m].priceAccount!));
      if (quote) published = quote.publishTime.toNumber();
    }
    if (published < asset.volTime.toNumber() + p.volMinIntervalSecs || now - published > p.volMaxAgeSecs) continue;
    const mint = new PublicKey(m);
    await attempt(`Volatility of ${symbol(mint)}`, async () =>
      send(`Volatility of ${symbol(mint)} sampled`, await ix.updateVol(program, d, mint)),
    );
  }
}

// Pays the senior withdrawal queue from the head while the pool's cash covers it, and skips cancelled tickets
// A few per pass, so a long queue never holds up liquidations
async function seniorQueue(start: Pool) {
  let pool = start;
  for (let i = 0; i < 10 && pool.seniorHead.lt(pool.seniorNextTicket); i++) {
    const exit = await program.account.seniorExit.fetchNullable(pda.seniorExit(pool.seniorHead));
    if (!exit) return;
    // The program pays at most the queued value, and less after a loss, so the queued value is enough cash to try
    if (!exit.cancelled && pool.cash.lt(exit.value)) return;
    const what = exit.cancelled
      ? `Senior queue: skipped cancelled ticket ${exit.ticket}`
      : `Senior queue: paid ticket ${exit.ticket} of ${exit.owner}, up to ${usd(exit.value)} USDC`;
    if (!(await send(what, await ix.settleSeniorExit(program, d, me)))) return;
    pool = await fetchPool(program);
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
  const assets = await program.account.asset.fetchMultiple(Object.keys(d.assets).map((m) => pda.asset(new PublicKey(m))));
  // First, because a stale price blocks every health check below
  await attempt("Pyth feeds", () => pythFeeds(pool, assets, now));
  await attempt("Demo feed heartbeat", () => heartbeat(pool, assets, now));
  // Right after, while a fresh price is still young enough to count
  await attempt("Volatility", () => volatility(pool, assets, now));
  for (const { account } of credits) {
    if (stopping) return;
    if (!account.debtShares.isZero()) await attempt(`Debt check of ${account.owner}`, () => watchDebt(pool, account.owner, now));
  }
  // Last, after repayments and liquidations this pass have brought cash back
  if (!stopping) await attempt("Senior queue", async () => seniorQueue(await fetchPool(program)));
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
