// Shared by setup, faucet, price and e2e
import fs from "node:fs";
import path from "node:path";
import { IGNORE_CACHE, PDAUtil, PoolUtil, PriceMath, WhirlpoolIx, toTx } from "@orca-so/whirlpools-sdk";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  createSyncNativeInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync, NATIVE_MINT, createMint } from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
  sendAndConfirmTransaction, AddressLookupTableProgram } from "@solana/web3.js";
import BN from "bn.js";
import { type AssetParams, type Deployment, type PoolParams, getProgram, ix, math, pda, Asset, PythQuote, decodePriceUpdate, lookupAddresses } from "../sdk/index.ts";
import {
  DEC_A,
  DEC_B,
  PROGRAM,
  TICK_SPACING,
  ataA,
  ataB,
  client,
  cluster,
  connection,
  ctx,
  me,
  root,
  tickArray,
  wallet,
  whirlpool, key } from "./orca-common.ts";

export const program = getProgram(connection);
export const deploymentFile = path.join(root, "deployments", `${cluster}.json`);

export function loadDeployment(): Deployment {
  if (!fs.existsSync(deploymentFile)) throw new Error(`${deploymentFile} is missing, run setup first`);
  return JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
}

export const exists = async (address: PublicKey) => (await connection.getAccountInfo(address)) !== null;

// The first signer pays, and the admin wallet signs alone by default
export const send = (ixs: TransactionInstruction[], signers: Keypair[] = [wallet]) =>
  sendAndConfirmTransaction(connection, new Transaction().add(...ixs), signers, { commitment: "confirmed" });

// Anything but a pure tightening waits out the activation delay, so these wait and apply it when that is short
// A local validator runs on a clock of seconds, a live cluster on days, which is too long to wait for here
async function applyWhenDue(pendingAt: () => Promise<number>, apply: () => Promise<TransactionInstruction[]>) {
  const at = await pendingAt();
  if (!at) return;
  if (at * 1000 - Date.now() > 120_000) throw new Error(`The change waits until ${new Date(at * 1000).toISOString()}, apply it then`);
  // The chain clock can trail the wall clock, so the wait is measured on the chain
  // The due time is read again before each try, since a pause of junior exits can push it back meanwhile
  for (let tries = 0, due = at; ; tries++) {
    while (((await connection.getBlockTime(await connection.getSlot("confirmed"))) ?? 0) < due) await new Promise((r) => setTimeout(r, 1000));
    try {
      await send(await apply());
      return;
    } catch (e) {
      due = await pendingAt();
      if (tries > 10 || due * 1000 - Date.now() > 120_000) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// When a waiting change can apply: its own time, or later if a pause of junior exits pushed it back
async function dueAt(pendingAt: { toString(): string }) {
  return Number(pendingAt.toString()) && math.effectiveAt(await program.account.pool.fetch(pda.pool()), pendingAt);
}

export async function setParamsNow(params: PoolParams) {
  await send(await ix.setParams(program, me, params));
  await applyWhenDue(async () => dueAt((await program.account.pool.fetch(pda.pool())).pendingAt), () => ix.applyParams(program));
}

export async function setAssetNow(mint: PublicKey, params: AssetParams) {
  await send(await ix.setAsset(program, me, mint, params));
  await applyWhenDue(async () => dueAt((await program.account.asset.fetch(pda.asset(mint))).pendingAt), () => ix.applyAsset(program, mint));
}

const DAY = 86_400;

// Pyth feed ids in hex, from https://hermes.pyth.network/v2/price_feeds?query=SOL/USD and so on
export const FEEDS = {
  SOL: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  JITOSOL: "67be9f519b95cf24338801051f9a808eff0a578ccb388db73b7f6fe1de019ffb",
  BONK: "72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419",
  AAPL: "49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
  NVDA: "b1073854ed24cbc755dc527418f52b7d271f6cc967bbf8d8129112b18860a593",
};
// Each listed token's own feed, by symbol
// Pyth has no JUPSOL/USD feed, so JupSOL reads JITOSOL/USD, which its fixed SOL backing caps at 1.22 x SOL
export const FEED_OF: Record<string, string> = {
  SOL: FEEDS.SOL,
  NVDAx: FEEDS.NVDA,
  AAPLx: FEEDS.AAPL,
  JitoSOL: FEEDS.JITOSOL,
  JupSOL: FEEDS.JITOSOL,
  BONK: FEEDS.BONK,
};
export const feedParam = (hex: string) => [...Buffer.from(hex, "hex")];
const hexOf = (id: number[]) => Buffer.from(id).toString("hex");
// SOL and NVDAx stay on admin-written prices, so the crash demo can still move them
export const LIVE_SYMBOLS = ["JitoSOL", "JupSOL", "AAPLx", "BONK"];
// Yearly rate in bps charged on debt each asset backs, and the share of it each loyalty tier pays
export const PREMIUM_BPS: Record<string, number> = { BONK: 1500, NVDAx: 300, AAPLx: 300 };
export const PREMIUM_TIERS = [10_000, 6_000, 3_000];
// The liquidator's bonus in bps on a token and on liquidity positions in it; an asset not named here pays the pool's
export const LIQ_BONUS_BPS: Record<string, [number, number]> = { SOL: [100, 200] };

// A mock memecoin in a shock column of its own: scenarios are crypto crash, equity crash and broad selloff
export const MEME = {
  keyName: "bonk-mint",
  symbol: "BONK",
  name: "Bonk (mock)",
  decimals: 5,
  group: 4,
  liqCostBps: 1500,
  maxConfBps: 200,
  volHorizonSecs: 2 * DAY,
  sigmaSeedBps: 15_000,
  initShocks: [6000, 3000, 5000],
  maintShocks: [4500, 2000, 3800],
  // Priced per million tokens, since six decimals per token would round BONK's price to a few units
  priceExponent: 6,
  // Dollars per million tokens with 6 decimals, about what Pyth quotes, written to the demo account until the feed is used
  demoPrice: 2_400_000,
};

export async function chainNow() {
  return (await connection.getBlockTime(await connection.getSlot("confirmed"))) ?? Math.floor(Date.now() / 1000);
}

// Adds each listed asset's Pyth feed id and push account, and the push account of SOL behind a staking token
export function addFeeds(d: Deployment): Deployment {
  for (const a of Object.values(d.assets)) {
    const feed = FEED_OF[a.symbol];
    if (!feed) continue;
    a.feedId = feed;
    a.pythAccount = pda.pythFeed(feed).toBase58();
    if (a.backing) a.backing.solPythAccount = pda.pythFeed(FEEDS.SOL).toBase58();
  }
  return d;
}

const mintOf = (d: Deployment, symbol: string) => {
  const found = Object.entries(d.assets).find(([, a]) => a.symbol === symbol);
  return found ? new PublicKey(found[0]) : null;
};

// Demo mode only: puts every waiting change of the pool, the assets and the LP markets into effect now, and ends the
// activation delay of new listings, which is 8 days on devnet
export async function demoActivateNow(d: Deployment): Promise<boolean> {
  const [pool, now] = await Promise.all([program.account.pool.fetch(pda.pool()), chainNow()]);
  if (!pool.demoMode) return false;
  const mints = Object.keys(d.assets).map((m) => new PublicKey(m));
  const markets = [d.whirlpool, ...(d.lpMarkets ?? []).map((m) => m.pool)].map((p) => pda.lpMarket(new PublicKey(p)));
  const [assets, lps] = await Promise.all([
    program.account.asset.fetchMultiple(mints.map((m) => pda.asset(m))),
    program.account.lpMarket.fetchMultiple(markets),
  ]);
  const waiting = [
    ...assets.flatMap((a, i) => (a && (!a.pendingAt.isZero() || !a.premiumPendingAt.isZero() || a.activeAt.gtn(now)) ? [pda.asset(mints[i])] : [])),
    ...lps.flatMap((m, i) => (m && (!m.pendingAt.isZero() || m.activeAt.gtn(now)) ? [markets[i]] : [])),
  ];
  if (!waiting.length && pool.pendingAt.isZero() && pool.premiumTierPendingAt.isZero()) return false;
  await send(await ix.demoActivate(program, me, waiting));
  console.log(`Activated the waiting changes of the pool and ${waiting.length} assets and markets`);
  return true;
}

// Fills one shock column of the pool, one value per scenario, leaving every other parameter as it is on chain
// Filling an empty column is a tightening that applies at once, and a demo pool applies any other change at once as well
export async function ensureShockColumn(d: Deployment, group: number, init: number[], maint: number[]) {
  const at = (s: number) => s * math.MAX_GROUPS + group;
  const done = (p: PoolParams) => init.every((v, s) => p.initShockBps[at(s)] === v) && maint.every((v, s) => p.maintShockBps[at(s)] === v);
  const params = (await program.account.pool.fetch(pda.pool())).params;
  if (done(params)) return;
  if (init.length !== params.numScenarios || maint.length !== params.numScenarios) {
    throw new Error(`The pool has ${params.numScenarios} scenarios, not ${init.length}`);
  }
  const next: PoolParams = { ...params, initShockBps: [...params.initShockBps], maintShockBps: [...params.maintShockBps] };
  init.forEach((v, s) => (next.initShockBps[at(s)] = v));
  maint.forEach((v, s) => (next.maintShockBps[at(s)] = v));
  await send(await ix.setParams(program, me, next));
  await demoActivateNow(d);
  if (!done((await program.account.pool.fetch(pda.pool())).params)) throw new Error(`Shock column ${group} did not apply, it waits out the activation delay`);
  console.log(`Shock column ${group} set to ${init.join("/")} for draws and ${maint.join("/")} for liquidations`);
}

// Points each listed asset's on-chain feed id at its real Pyth feed, which the placeholders from before live prices are not
export async function ensureFeedIds(d: Deployment) {
  for (const [mint, a] of Object.entries(d.assets)) {
    const feed = FEED_OF[a.symbol];
    if (!feed) continue;
    const asset = await program.account.asset.fetch(pda.asset(new PublicKey(mint)));
    // A change that already waits carries the parameters to build on
    const params = asset.pendingAt.isZero() ? asset.params : asset.pending;
    if (hexOf(params.pythFeedId) === feed) continue;
    await send(await ix.setAsset(program, me, new PublicKey(mint), { ...params, pythFeedId: feedParam(feed) }));
    console.log(`${a.symbol} feed id set to ${feed}`);
  }
}

// Sets each asset's risk premium and the share of it each loyalty tier pays
export async function ensurePremiums(d: Deployment) {
  for (const [mint, a] of Object.entries(d.assets)) {
    const asset = await program.account.asset.fetch(pda.asset(new PublicKey(mint)));
    const want = PREMIUM_BPS[a.symbol] ?? 0;
    if ((asset.premiumPendingAt.isZero() ? asset.premiumBps : asset.pendingPremiumBps) === want) continue;
    await send(await ix.setAssetPremium(program, me, new PublicKey(mint), want));
    console.log(`${a.symbol} premium set to ${want} bps`);
  }
  const pool = await program.account.pool.fetch(pda.pool());
  const tiers = pool.premiumTierPendingAt.isZero() ? pool.premiumTierBps : pool.pendingPremiumTierBps;
  if (!PREMIUM_TIERS.every((v, i) => tiers[i] === v)) {
    await send(await ix.setPremiumTiers(program, me, PREMIUM_TIERS));
    console.log(`Premium tiers set to ${PREMIUM_TIERS.join("/")} bps`);
  }
}

// Sets each asset's own liquidation bonus
export async function ensureLiqBonuses(d: Deployment) {
  for (const [mint, a] of Object.entries(d.assets)) {
    const asset = await program.account.asset.fetch(pda.asset(new PublicKey(mint)));
    const [token, lp] = LIQ_BONUS_BPS[a.symbol] ?? [0, 0];
    if (asset.liqBonusBps === token && asset.lpLiqBonusBps === lp) continue;
    // a program from before the upgrade has no such instruction, and the rest of setup must still run against it
    const sent = await send(await ix.setAssetLiqBonus(program, me, new PublicKey(mint), token, lp)).then(
      () => true,
      () => false,
    );
    console.log(sent ? `${a.symbol} liquidation bonus set to ${token} bps, ${lp} bps on its positions` : `${a.symbol} liquidation bonus not set: the program refused it`);
  }
}

// Creates the mock memecoin mint, lists it with a demo price and records it in `d`, and is safe to run again
// Its shock column has to be filled before this, since the listing's volatility horizon needs a column that shocks something
export async function listMeme(d: Deployment): Promise<PublicKey> {
  const mintKey = key(MEME.keyName);
  const mint = mintKey.publicKey;
  if (!(await exists(mint))) {
    await createMint(connection, wallet, me, null, MEME.decimals, mintKey);
    console.log(`Created mock ${MEME.symbol} mint ${mint.toBase58()}`);
  }
  if (!(await exists(pda.asset(mint)))) {
    // The same price age limits as SOL, which devnet listed with the longest
    const sol = (await program.account.asset.fetch(pda.asset(NATIVE_MINT))).params;
    const params: AssetParams = {
      group: MEME.group,
      oracle: 1,
      pythFeedId: feedParam(FEEDS.BONK),
      liqCostBps: MEME.liqCostBps,
      maxPriceAgeSecs: sol.maxPriceAgeSecs,
      maxConfBps: MEME.maxConfBps,
      depositCap: new BN(0),
      paused: false,
      volHorizonSecs: MEME.volHorizonSecs,
      rateSource: 0,
      rateAccount: PublicKey.default,
      fixedRate: new BN(0),
      rateBaseMint: PublicKey.default,
      rateFeedId: Array(32).fill(0),
      liqPriceAgeSecs: Math.max(sol.liqPriceAgeSecs, sol.maxPriceAgeSecs),
      uiMultiplier: false,
      jumpHoldSecs: 0,
    };
    await send(await ix.initAsset(program, me, mint, params, MEME.sigmaSeedBps));
    console.log(`Listed ${MEME.symbol} in shock group ${MEME.group}`);
  }
  const listed = await program.account.asset.fetch(pda.asset(mint));
  // The unit can only change while nothing is deposited, and a demo price written for the old unit is written again
  const rescaled = listed.priceExponent !== MEME.priceExponent && listed.totalDeposited.isZero();
  if (rescaled) {
    await send(await ix.setPriceExponent(program, me, mint, MEME.priceExponent));
    console.log(`${MEME.symbol} is now priced per ${10 ** MEME.priceExponent} tokens`);
  }
  if (rescaled || !(await exists(pda.demoPrice(mint)))) await send(await ix.setDemoPrice(program, me, mint, MEME.demoPrice));
  d.assets[mint.toBase58()] = {
    symbol: MEME.symbol,
    name: MEME.name,
    decimals: MEME.decimals,
    priceAccount: pda.demoPrice(mint).toBase58(),
    priceExponent: rescaled ? MEME.priceExponent : listed.priceExponent,
  };
  return mint;
}

// The lookup table of the addresses every transaction reuses, made if it is missing and extended with whatever is new
export async function ensureLookupTable(d: Deployment): Promise<PublicKey> {
  const previous = fs.existsSync(deploymentFile) ? (JSON.parse(fs.readFileSync(deploymentFile, "utf8")) as Deployment).lookupTable : undefined;
  const old = previous ? (await connection.getAddressLookupTable(new PublicKey(previous))).value : null;
  let table = old?.isActive() && old.state.authority?.equals(me) ? old.key : null;
  if (!table) {
    // The slot must already be in the slot hashes of the bank that runs the transaction, so a finalized one, and a
    // load-balanced RPC can still run it on a node that disagrees, so a few tries with a fresh slot
    for (let attempt = 1; !table; attempt++) {
      // Some way back from the confirmed tip, further on each try, so it is an ancestor of whichever node runs it
      const recentSlot = (await connection.getSlot("confirmed")) - [2, 10, 40, 100, 200][attempt - 1];
      const [create, address] = AddressLookupTableProgram.createLookupTable({ authority: me, payer: me, recentSlot });
      try {
        await send([create]);
        table = address;
      } catch (e) {
        if (attempt >= 5) throw e;
        await new Promise((r) => setTimeout(r, 3_000));
      }
    }
  }
  const listed = new Set(((await connection.getAddressLookupTable(table)).value?.state.addresses ?? []).map((k) => k.toBase58()));
  const missing = lookupAddresses(d).filter((k) => !listed.has(k.toBase58()));
  for (let i = 0; i < missing.length; i += 20) {
    await send([AddressLookupTableProgram.extendLookupTable({ lookupTable: table, authority: me, payer: me, addresses: missing.slice(i, i + 20) })]);
  }
  d.lookupTable = table.toBase58();
  return table;
}

// The newest a feed may be for an asset to go live: the keeper posts again within half a minute once it runs
// Why the program could not use the feeds of `asset` right now, or null when it can
// It rescales a Pyth price to 6 decimals before it checks the confidence band, so a price of a few millionths of a dollar
// can fail a band that is a tiny share of it
function unreadable(asset: Asset, feeds: Map<string, Uint8Array | null>, now: number): string | null {
  const p = asset.params;
  const own = hexOf(p.pythFeedId);
  for (const id of [own, p.rateSource !== 0 ? hexOf(p.rateFeedId) : null]) {
    if (!id) continue;
    // The asset's own feed is scaled to its priced unit, a staking token's SOL leg never is
    const data = feeds.get(id);
    const q = data ? decodePriceUpdate(data, id === own ? asset.priceExponent : 0) : null;
    if (!q) return `feed ${id.slice(0, 8)} has no fully verified update on chain`;
    // Draws need a price within the asset's own limit, which is the least a live asset has to meet
    if (now - q.publishTime > p.maxPriceAgeSecs) return `feed ${id.slice(0, 8)} was last posted ${now - q.publishTime} s ago, over its ${p.maxPriceAgeSecs} s limit`;
    if (q.price.lte(q.conf) || (!process.env.LIVE_ANYWAY && q.conf.muln(10_000).gt(q.price.muln(p.maxConfBps)))) {
      return `at 6 decimals feed ${id.slice(0, 8)} is ${q.price.toString()} with a band of ${q.conf.toString()}, wider than ${p.maxConfBps} bps of the price (LIVE_ANYWAY=1 skips this check)`;
    }
  }
  return null;
}

// Switches assets from their demo price to their Pyth feed, once the feed is fresh and readable by the program
// An asset whose feed is not stays on its demo price, since every health check of an account holding it would fail
export async function goLive(d: Deployment, symbols: string[]) {
  const mints = symbols.flatMap((s) => mintOf(d, s) ?? []);
  const fetched = await program.account.asset.fetchMultiple(mints.map((m) => pda.asset(m)));
  const todo = mints.flatMap((mint, i) => (fetched[i] && !fetched[i].livePrice ? [{ mint, asset: fetched[i] }] : []));
  if (!todo.length) return;
  const ids = (a: Asset) => [hexOf(a.params.pythFeedId), a.params.rateSource !== 0 ? hexOf(a.params.rateFeedId) : null];
  const feeds = [...new Set(todo.flatMap(({ asset }) => ids(asset)).filter((f): f is string => !!f))];
  try {
    // Loaded here so scripts that never go live do not load Pyth's receiver
    const { pushFeeds } = await import("../keeper/pyth.ts");
    const posted = await pushFeeds(connection, wallet, feeds, 60, await chainNow());
    if (posted.length) console.log(`Posted ${posted.length} Pyth feeds to the push oracle`);
  } catch (e) {
    console.warn(`Could not post Pyth updates: ${(e as Error).message}`);
  }
  const infos = await connection.getMultipleAccountsInfo(feeds.map((f) => pda.pythFeed(f)));
  const quotes = new Map(feeds.map((f, i) => [f, infos[i]?.data ?? null]));
  const now = await chainNow();
  for (const { mint, asset } of todo) {
    const name = d.assets[mint.toBase58()].symbol;
    const why = unreadable(asset, quotes, now);
    if (why) {
      console.warn(`${name} stays on its demo price: ${why}`);
      continue;
    }
    await send(await ix.demoSetLivePrice(program, me, mint, true));
    console.log(`${name} now reads its Pyth feed`);
  }
}


// A CLI flag that must be a number of zero or more
export function amount(name: string, value: string): number {
  const n = Number(value);
  if (value.trim() === "" || !Number.isFinite(n) || n < 0) {
    throw new Error(`--${name} must be a number of zero or more, got "${value}"`);
  }
  return n;
}

const units = (whole: number, decimals: number) => BigInt(Math.round(whole * 10 ** decimals));

export type FaucetOptions = {
  sol?: number;
  stock?: number;
  usdc?: number;
  // Whole tokens of any other mock mint the admin can mint, by mint address
  tokens?: Record<string, number>;
  // Dollar value of the Orca position to open, over `range` in dollars per SOL
  lp?: number;
  range?: [number, number];
  nftProgram?: PublicKey;
};

// Makes a wallet demo-ready and returns the mint of the Orca position it was given, if any
export async function faucet(d: Deployment, to: PublicKey, o: FaucetOptions): Promise<PublicKey | null> {
  if (o.sol && cluster === "localnet") {
    const signature = await connection.requestAirdrop(to, Number(units(o.sol, 9)));
    await connection.confirmTransaction({ signature, ...(await connection.getLatestBlockhash()) }, "confirmed");
  }

  const mints: TransactionInstruction[] = [];
  for (const [mint, whole] of [
    [d.stockMint, o.stock],
    [d.usdcMint, o.usdc],
    ...Object.entries(o.tokens ?? {}),
  ] as const) {
    if (!whole) continue;
    const key = new PublicKey(mint);
    // Token-2022 mocks, like the xStock, mint through their own program
    const program = new PublicKey(d.assets[mint].tokenProgram ?? TOKEN_PROGRAM_ID.toBase58());
    const account = getAssociatedTokenAddressSync(key, to, true, program);
    mints.push(
      createAssociatedTokenAccountIdempotentInstruction(me, account, to, key, program),
      createMintToInstruction(key, account, me, units(whole, d.assets[mint].decimals), [], program),
    );
  }
  if (mints.length) await send(mints);

  return o.lp ? openPosition(to, o.lp, o.range ?? [120, 180], o.nftProgram ?? TOKEN_2022_PROGRAM_ID) : null;
}

// Opens a position as the admin, who holds the mock USDC mint authority, then hands the NFT over
async function openPosition(to: PublicKey, usd: number, range: [number, number], nftProgram: PublicKey) {
  const pool = await client.getPool(whirlpool, IGNORE_CACHE);
  const { sqrtPrice, tokenVaultA, tokenVaultB } = pool.getData();
  const price = PriceMath.sqrtPriceX64ToPrice(sqrtPrice, DEC_A, DEC_B).toNumber();
  const [lower, upper] = range.map((p) => Math.round(math.priceToTick(p) / TICK_SPACING) * TICK_SPACING);
  if (!(lower < upper)) throw new Error(`Range ${range.join("-")} is empty at tick spacing ${TICK_SPACING}`);
  // Value is linear in liquidity
  const liquidity = new BN(Math.floor(usd / math.lpValue(1, lower, upper, price)).toFixed(0));
  const max = PoolUtil.getTokenAmountsFromLiquidity(
    liquidity,
    sqrtPrice,
    PriceMath.tickIndexToSqrtPriceX64(lower),
    PriceMath.tickIndexToSqrtPriceX64(upper),
    true,
  );

  await (await pool.initTickArrayForTicks([lower, upper], me, IGNORE_CACHE, "fixed"))?.buildAndExecute();
  const funding: TransactionInstruction[] = [];
  if (!max.tokenA.isZero()) {
    const lamports = BigInt(max.tokenA.toString());
    const have = await connection.getBalance(me);
    if (BigInt(have) < lamports + BigInt(LAMPORTS_PER_SOL)) {
      throw new Error(`Admin has ${have / LAMPORTS_PER_SOL} SOL, too little to fund a $${usd} position`);
    }
    funding.push(SystemProgram.transfer({ fromPubkey: me, toPubkey: ataA, lamports }), createSyncNativeInstruction(ataA));
  }
  if (!max.tokenB.isZero()) {
    funding.push(createMintToInstruction(pool.getData().tokenMintB, ataB, me, BigInt(max.tokenB.toString())));
  }
  await send(funding);

  const mint = Keypair.generate();
  const position = PDAUtil.getPosition(PROGRAM, mint.publicKey);
  const held = getAssociatedTokenAddressSync(mint.publicKey, me, false, nftProgram);
  const open = {
    whirlpool,
    owner: me,
    funder: me,
    positionPda: position,
    positionTokenAccount: held,
    tickLowerIndex: lower,
    tickUpperIndex: upper,
  };
  await toTx(
    ctx,
    nftProgram.equals(TOKEN_2022_PROGRAM_ID)
      ? WhirlpoolIx.openPositionWithTokenExtensionsIx(ctx.program, {
          ...open,
          positionMint: mint.publicKey,
          withTokenMetadataExtension: true,
        })
      : WhirlpoolIx.openPositionIx(ctx.program, { ...open, positionMintAddress: mint.publicKey }),
  )
    .addSigner(mint)
    .addInstruction(
      WhirlpoolIx.increaseLiquidityIx(ctx.program, {
        liquidityAmount: liquidity,
        tokenMaxA: max.tokenA,
        tokenMaxB: max.tokenB,
        whirlpool,
        position: position.publicKey,
        positionTokenAccount: held,
        positionAuthority: me,
        tokenOwnerAccountA: ataA,
        tokenOwnerAccountB: ataB,
        tokenVaultA,
        tokenVaultB,
        tickArrayLower: tickArray(lower),
        tickArrayUpper: tickArray(upper),
      }),
    )
    .buildAndExecute();

  const account = getAssociatedTokenAddressSync(mint.publicKey, to, true, nftProgram);
  await send([
    createAssociatedTokenAccountIdempotentInstruction(me, account, to, mint.publicKey, nftProgram),
    createTransferCheckedInstruction(held, mint.publicKey, account, me, 1, 0, [], nftProgram),
  ]);
  return mint.publicKey;
}
