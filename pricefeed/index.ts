// Mirrors real Pyth prices into a local chain's demo price accounts, so a localnet values collateral at market prices
// A local validator has no Pyth receiver, so the program reads each asset's demo price there; this keeps those at Pyth's
//
// Sources, per feed, best first:
//   1. Pyth Hermes, when HERMES_ACCESS_TOKEN is set: every feed the key's plan covers, which may not be all of them
//   2. Pyth's push-feed accounts on mainnet, read over plain RPC with no token: only feeds Pyth keeps posting there,
//      which today are SOL and the liquid staking tokens
// A source older than the asset's limit is not used, and the asset keeps its last price, which the keeper keeps fresh
//
//   npm run pricefeed                        the deployment for CLUSTER, localnet by default
//   PRICEFEED_SYMBOLS=SOL,BONK npm run pricefeed   only these assets, so the others can be set by hand with npm run price
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HermesClient } from "@pythnetwork/hermes-client";
import { Connection, Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
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
// Crypto trades all the time, so an old quote is a broken feed; stocks stop for nights, weekends and holidays
const cryptoMaxAge = positive("PRICEFEED_CRYPTO_MAX_AGE_SECS", 600);
const stockMaxAge = positive("PRICEFEED_STOCK_MAX_AGE_SECS", 4 * 86_400);

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
const token = env.HERMES_ACCESS_TOKEN || undefined;
const hermes = token ? new HermesClient(env.HERMES_URL ?? "https://hermes.pyth.network", { accessToken: token }) : null;

const only = env.PRICEFEED_SYMBOLS?.split(",").map((s) => s.trim().toUpperCase());
// Every asset with a demo price account and a Pyth feed; USDC is fixed at $1 and has neither
const assets = Object.entries(d.assets).flatMap(([mint, a]) =>
  a.priceAccount && a.feedId && (!only || only.includes(a.symbol.toUpperCase()))
    ? [{ mint: new PublicKey(mint), symbol: a.symbol, feedId: a.feedId.replace(/^0x/, ""), exponent: a.priceExponent ?? 0,
         // xStocks are Token-2022, and the stock mint is the mock stock
         maxAge: a.tokenProgram || mint === d.stockMint ? stockMaxAge : cryptoMaxAge }]
    : [],
);
if (!assets.length) throw new Error("No asset has both a demo price account and a Pyth feed");

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const dollars = (micro: BN) => (Number(micro.toString()) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 8 });
type Quote = { price: BN; conf: BN; publishTime: number; source: string };

// Hermes quotes in units of 10^expo; the program wants micro-dollars per 10^exponent whole tokens, as decodePriceUpdate does
const E6 = new BN(1_000_000);
function scale(value: string, expo: number, exponent: number): BN {
  const n = new BN(value).mul(E6).mul(new BN(10).pow(new BN(exponent)));
  return expo < 0 ? n.div(new BN(10).pow(new BN(-expo))) : n.mul(new BN(10).pow(new BN(expo)));
}

// A key only covers the feeds its plan is entitled to, and one feed outside the plan fails a whole request,
// so each feed is asked for on its own and a refused one is left alone for an hour before it is tried again
const refusedUntil = new Map<string, number>();
const REFUSED_RETRY_MS = 3_600_000;
async function fromHermes(): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  if (!hermes) return out;
  const ids = [...new Set(assets.map((a) => a.feedId))].filter((id) => (refusedUntil.get(id) ?? 0) <= Date.now());
  await Promise.all(
    ids.map(async (id) => {
      const res = await hermes.getLatestPriceUpdates([id], { parsed: true }).catch((e) => {
        const names = assets.filter((a) => a.feedId === id).map((a) => a.symbol).join("/");
        if (/status: 40[13]/.test(String(e?.message))) {
          if (!refusedUntil.has(id)) log(`Hermes refused ${names}: the key's plan does not cover this feed, trying again hourly`);
          refusedUntil.set(id, Date.now() + REFUSED_RETRY_MS);
        } else log(`Hermes failed for ${names}: ${e?.message ?? e}`);
        return null;
      });
      for (const p of res?.parsed ?? []) {
        refusedUntil.delete(id);
        for (const a of assets.filter((x) => x.feedId === p.id.replace(/^0x/, ""))) {
          out.set(a.symbol, { price: scale(p.price.price, p.price.expo, a.exponent), conf: scale(p.price.conf, p.price.expo, a.exponent), publishTime: p.price.publish_time, source: "hermes" });
        }
      }
    }),
  );
  return out;
}

async function fromMainnet(): Promise<Map<string, Quote>> {
  const infos = await mainnet.getMultipleAccountsInfo(assets.map((a) => pda.pythFeed(a.feedId)));
  const out = new Map<string, Quote>();
  assets.forEach((a, i) => {
    const q = infos[i] && decodePriceUpdate(infos[i]!.data, a.exponent);
    if (q) out.set(a.symbol, { ...q, source: "mainnet" });
  });
  return out;
}

const warned = new Set<string>();
async function tick() {
  const now = Math.floor(Date.now() / 1000);
  const [hermesQuotes, mainnetQuotes, demo, assetAccounts] = await Promise.all([
    fromHermes().catch((e) => (log(`Hermes failed: ${e?.message ?? e}`), new Map<string, Quote>())),
    fromMainnet().catch((e) => (log(`Mainnet feeds failed: ${e?.message ?? e}`), new Map<string, Quote>())),
    program.account.demoPrice.fetchMultiple(assets.map((a) => pda.demoPrice(a.mint))),
    program.account.asset.fetchMultiple(assets.map((a) => pda.asset(a.mint))),
  ]);
  const ixs: TransactionInstruction[] = [];
  const moved: string[] = [];
  for (const [i, a] of assets.entries()) {
    // An asset switched to its live feed reads Pyth itself, and its demo account no longer counts
    if (assetAccounts[i]?.livePrice) continue;
    const fresh = [hermesQuotes.get(a.symbol), mainnetQuotes.get(a.symbol)].find((q) => q && now - q.publishTime <= a.maxAge);
    if (!fresh) {
      if (!warned.has(a.symbol)) log(`${a.symbol}: no Pyth price newer than ${a.maxAge}s${hermes ? "" : ", set HERMES_ACCESS_TOKEN for every feed"}; keeping its current price`);
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
    moved.push(`${a.symbol} $${dollars(fresh.price)} (${fresh.source}, ${now - fresh.publishTime}s old)`);
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

log(`Price feed for ${cluster} at ${env.RPC_URL ?? d.rpcUrl}: ${assets.map((a) => a.symbol).join(", ")}, every ${intervalMs} ms, from ${hermes ? "Hermes, then " : ""}mainnet push feeds`);
for (;;) {
  await tick().catch((e) => log(`Tick failed: ${e?.message ?? e}`));
  await new Promise((r) => setTimeout(r, intervalMs));
}
