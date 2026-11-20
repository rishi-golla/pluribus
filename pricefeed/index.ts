// Mirrors real mainnet prices into a local chain's demo price accounts, so a localnet values collateral at market prices
// A local validator has no Pyth receiver, so the program reads each asset's demo price there; this keeps those at mainnet's
// Every source is on-chain, read from Solana mainnet over plain RPC, with no API key:
//   - Pyth's push-feed accounts, for the feeds Pyth keeps posting there: SOL and the liquid staking tokens
//   - Orca Whirlpool pools, for assets Pyth leaves stale on-chain: NVDAx and AAPLx from their USDC pools, and BONK from
//     the SOL/BONK pool times Pyth's SOL price. A pool's price is its last trade, so its fee is taken as the band around it
// A Pyth quote older than the asset's limit is not used, and the asset keeps its last price, which the keeper keeps fresh
//
//   npm run pricefeed                        the deployment for CLUSTER, localnet by default
//   PRICEFEED_SYMBOLS=SOL,BONK npm run pricefeed   only these assets, so the others can be set by hand with npm run price
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Connection, Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import Decimal from "decimal.js";
import { type Deployment, buildTransaction, decodePriceUpdate, getProgram, ix, pda } from "../sdk/index.ts";

const env = process.env;
const positive = (name: string, fallback: number) => {
  const n = Number(env[name] ?? fallback);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got "${env[name]}"`);
  return n;
};
const intervalMs = positive("PRICEFEED_INTERVAL_MS", 10_000);
// A move smaller than this is not worth a transaction, unless the demo price is getting old
const minMoveBps = positive("PRICEFEED_MIN_MOVE_BPS", 1);
// A Pyth push feed this much older than now counts as stale
const maxPythAge = positive("PRICEFEED_MAX_AGE_SECS", 600);

// Mainnet Orca Whirlpools by asset symbol, with the side the asset sits on and what it is quoted in
// The deepest pool for each when this was written: NVDAx/USDC about $233k, AAPLx/USDC $20k, SOL/BONK $224k
const WHIRLPOOL_PROGRAM = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
const POOLS: Record<string, { pool: PublicKey; side: "A" | "B"; quote: "USDC" | "SOL" }> = {
  NVDAx: { pool: new PublicKey("6R4r93V5fcMzc13CL2enEepDSYcr4Qx3ptZBDwudTXCo"), side: "A", quote: "USDC" },
  AAPLx: { pool: new PublicKey("9JsDnmZonykBmrybuYaZUYxr4DCbZZQTdYQzdFXtDr5F"), side: "A", quote: "USDC" },
  BONK: { pool: new PublicKey("5zpyutJu9ee6jFymDGoK7F6S5Kczqtc9FomP3ueKuyA9"), side: "B", quote: "SOL" },
};

const cluster = env.CLUSTER ?? "localnet";
const file = path.join(import.meta.dirname, "../deployments", `${cluster}.json`);
if (!fs.existsSync(file)) throw new Error(`${file} is missing, run setup for ${cluster} or set CLUSTER`);
const d: Deployment = JSON.parse(fs.readFileSync(file, "utf8"));
// The pool admin signs set_demo_price, the same key setup used
const keyFile = env.ADMIN_KEYPAIR ?? path.join(os.homedir(), ".config/solana/id.json");
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(env.DEMO_ADMIN_SECRET?.trim() || fs.readFileSync(keyFile, "utf8"))));
const connection = new Connection(env.RPC_URL ?? d.rpcUrl, "confirmed");
const program = getProgram(connection);
const mainnet = new Connection(env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");

const only = env.PRICEFEED_SYMBOLS?.split(",").map((s) => s.trim().toUpperCase());
// Every asset with a demo price account and a source; USDC is fixed at $1 and has neither
const assets = Object.entries(d.assets).flatMap(([mint, a]) =>
  a.priceAccount && (POOLS[a.symbol] || a.feedId) && (!only || only.includes(a.symbol.toUpperCase()))
    ? [{ mint: new PublicKey(mint), symbol: a.symbol, feedId: a.feedId?.replace(/^0x/, ""), pool: POOLS[a.symbol], exponent: a.priceExponent ?? 0 }]
    : [],
);
if (!assets.length) throw new Error("No asset has both a demo price account and a source");
// SOL's Pyth feed prices the pools quoted in SOL, whether or not SOL itself is being fed
const solFeed = d.assets[d.solMint]?.feedId?.replace(/^0x/, "");

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const dollars = (micro: BN) => (Number(micro.toString()) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 8 });
type Quote = { price: BN; conf: BN; publishTime: number; source: string };
// Micro-dollars per 10^exponent whole tokens, the unit set_demo_price takes
const micro = (usd: Decimal, exponent: number) => new BN(usd.mul(1e6).mul(Decimal.pow(10, exponent)).floor().toFixed(0));

// Whirlpool layout: fee rate u16 at 45 in millionths, sqrt price u128 Q64.64 at 65, token mint A at 101 and B at 181
const decimals = new Map<string, number>();
async function poolPrice(data: Buffer): Promise<{ aInB: Decimal; fee: Decimal }> {
  const [mintA, mintB] = [new PublicKey(data.subarray(101, 133)), new PublicKey(data.subarray(181, 213))];
  const missing = [mintA, mintB].filter((m) => !decimals.has(m.toBase58()));
  if (missing.length) {
    // A mint keeps its decimals at byte 44, under either token program
    const infos = await mainnet.getMultipleAccountsInfo(missing);
    missing.forEach((m, i) => decimals.set(m.toBase58(), infos[i]!.data[44]));
  }
  const sqrt = new Decimal(new BN(data.subarray(65, 81), "le").toString()).div(Decimal.pow(2, 64));
  const shift = decimals.get(mintA.toBase58())! - decimals.get(mintB.toBase58())!;
  return { aInB: sqrt.pow(2).mul(Decimal.pow(10, shift)), fee: new Decimal(data.readUInt16LE(45)).div(1e6) };
}

async function fromMainnet(): Promise<Map<string, Quote>> {
  const feeds = [...new Set([solFeed, ...assets.map((a) => a.feedId)].filter((f): f is string => !!f))];
  const pools = assets.filter((a) => a.pool);
  const infos = await mainnet.getMultipleAccountsInfo([...feeds.map((f) => pda.pythFeed(f)), ...pools.map((a) => a.pool!.pool)]);
  const out = new Map<string, Quote>();
  const now = Math.floor(Date.now() / 1000);
  // Pyth first, since the pools quoted in SOL need SOL's price
  const pyth = new Map(feeds.map((f, i) => [f, infos[i] && decodePriceUpdate(infos[i]!.data)]));
  const sol = solFeed ? pyth.get(solFeed) : null;
  for (const a of assets) {
    if (a.pool || !a.feedId) continue;
    const q = infos[feeds.indexOf(a.feedId)] && decodePriceUpdate(infos[feeds.indexOf(a.feedId)]!.data, a.exponent);
    if (q && now - q.publishTime <= maxPythAge) out.set(a.symbol, { ...q, source: "pyth" });
  }
  for (const [j, a] of pools.entries()) {
    const info = infos[feeds.length + j];
    if (!info?.owner.equals(WHIRLPOOL_PROGRAM)) {
      log(`${a.symbol}: ${a.pool!.pool.toBase58()} is not an Orca Whirlpool on mainnet`);
      continue;
    }
    const { aInB, fee } = await poolPrice(info.data);
    let usd = a.pool!.side === "A" ? aInB : new Decimal(1).div(aInB);
    if (a.pool!.quote === "SOL") {
      if (!sol || now - sol.publishTime > maxPythAge) continue;
      usd = usd.mul(new Decimal(sol.price.toString()).div(1e6));
    }
    const price = micro(usd, a.exponent);
    out.set(a.symbol, { price, conf: new BN(new Decimal(price.toString()).mul(fee).ceil().toFixed(0)), publishTime: now, source: "orca" });
  }
  return out;
}

const warned = new Set<string>();
async function tick() {
  const now = Math.floor(Date.now() / 1000);
  const [quotes, demo, assetAccounts] = await Promise.all([
    fromMainnet(),
    program.account.demoPrice.fetchMultiple(assets.map((a) => pda.demoPrice(a.mint))),
    program.account.asset.fetchMultiple(assets.map((a) => pda.asset(a.mint))),
  ]);
  const ixs: TransactionInstruction[] = [];
  const moved: string[] = [];
  for (const [i, a] of assets.entries()) {
    // An asset switched to its live feed reads Pyth itself, and its demo account no longer counts
    if (assetAccounts[i]?.livePrice) continue;
    const fresh = quotes.get(a.symbol);
    if (!fresh) {
      if (!warned.has(a.symbol)) log(`${a.symbol}: no fresh on-chain price; keeping its current price`);
      warned.add(a.symbol);
      continue;
    }
    warned.delete(a.symbol);
    const current = demo[i];
    const maxAge = assetAccounts[i]?.params.maxPriceAgeSecs ?? 60;
    const moveBps = current && !current.price.isZero() ? fresh.price.sub(current.price).abs().muln(10_000).div(current.price).toNumber() : Infinity;
    const aging = !current || (now - current.publishTime.toNumber()) * 2 > maxAge;
    if (moveBps < minMoveBps && !aging) continue;
    ixs.push(...(await ix.setDemoPrice(program, admin.publicKey, a.mint, fresh.price, fresh.conf)));
    moved.push(`${a.symbol} $${dollars(fresh.price)} (${fresh.source}${fresh.source === "pyth" ? `, ${now - fresh.publishTime}s old` : ""})`);
  }
  if (!ixs.length) return;
  const latest = await connection.getLatestBlockhash();
  const tx = await buildTransaction(connection, d, admin.publicKey, ixs, latest.blockhash);
  tx.sign([admin]);
  const signature = await connection.sendTransaction(tx);
  const { value } = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  if (value.err) throw new Error(`set_demo_price failed: ${JSON.stringify(value.err)}`);
  log(`Set ${moved.join(", ")}`);
}

log(`Price feed for ${cluster} at ${env.RPC_URL ?? d.rpcUrl}: ${assets.map((a) => `${a.symbol} (${a.pool ? "orca" : "pyth"})`).join(", ")}, every ${intervalMs} ms from mainnet`);
for (;;) {
  await tick().catch((e) => log(`Tick failed: ${e?.message ?? e}`));
  await new Promise((r) => setTimeout(r, intervalMs));
}
