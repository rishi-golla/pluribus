// Idempotent bootstrap of the protocol on top of what orca:fixture created
import fs from "node:fs";
import path from "node:path";
import { NATIVE_MINT, createMint, getMint } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { type AssetParams, type Deployment, type PoolParams, PROGRAM_ID, WHIRLPOOL_PROGRAM_ID, ix, pda } from "../sdk/index.ts";
import { deploymentFile, exists, faucet, program, send } from "./lib.ts";
import { cluster, connection, key, me, root, url, wallet } from "./orca-common.ts";

const DAY = 86_400;
const SOL_FEED = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const SEED_USDC = { senior: 1_000_000, junior: 100_000 };

const fixtureFile = path.join(root, "scripts/out", `${cluster}.json`);
if (!fs.existsSync(fixtureFile)) throw new Error(`${fixtureFile} is missing, run orca:fixture first`);
const fixture = JSON.parse(fs.readFileSync(fixtureFile, "utf8"));
const [usdc, whirlpool] = [new PublicKey(fixture.tokenB.mint), new PublicKey(fixture.whirlpool)];
const solPrice = Math.round(Number(fixture.price) * 100) / 100;
if (!(solPrice > 0)) throw new Error(`Bad pool price "${fixture.price}" in ${fixtureFile}`);
if (fixture.tokenA.mint !== NATIVE_MINT.toBase58() || !(await exists(whirlpool))) {
  throw new Error(`${fixtureFile} does not match the chain at ${url}, run orca:fixture again`);
}

const stockKey = key("stock-mint");
const stock = stockKey.publicKey;
if (!(await exists(stock))) await createMint(connection, wallet, me, null, 6, stockKey);

// Scenarios are crypto crash, equity crash and broad selloff, with columns for the SOL, stock and USDC groups
// The small USDC shock keeps a gap between the draw limit and the liquidation line for USDC collateral
const shocks = (rows: number[][], usdc: number) =>
  rows.flatMap(([sol, equity]) => [sol, equity, usdc, 0]).concat([0, 0, 0, 0]);
const params: PoolParams = {
  numScenarios: 3,
  initShockBps: shocks([[3000, 1500], [1500, 3500], [2500, 2500]], 300),
  maintShockBps: shocks([[2000, 1000], [1000, 2500], [1700, 1700]], 100),
  liqBonusBps: 500,
  closeFactorBps: 5000,
  warnHealthBps: 11_000,
  baseRateBps: 200,
  slope1Bps: 800,
  slope2Bps: 6000,
  kinkBps: 9000,
  reserveFactorBps: 1000,
  protocolFeeBps: 1000,
  protectionFeeBps: 2000,
  tierDiscountBps: [0, 40, 80],
  tierMinHealthySecs: [0, 7 * DAY, 30 * DAY].map((s) => new BN(s)),
};
if (!(await exists(pda.pool()))) await send(await ix.initialize(program, me, usdc, params, true));
if (!(await exists(pda.juniorMint()))) await send(await ix.initJunior(program, me));

const asset = (group: number, oracle: number, feed: string, liqCostBps: number): AssetParams => ({
  group,
  oracle,
  pythFeedId: [...Buffer.from(feed.padEnd(64, "0"), "hex")],
  liqCostBps,
  maxPriceAgeSecs: DAY,
  maxConfBps: 200,
  depositCap: new BN(0),
  paused: false,
});
// The stock feed id is a placeholder, since demo mode never reads it
for (const [mint, assetParams] of [
  [usdc, asset(2, 0, "", 0)],
  [NATIVE_MINT, asset(0, 1, SOL_FEED, 500)],
  [stock, asset(1, 1, "", 1000)],
] as const) {
  if (!(await exists(pda.asset(mint)))) await send(await ix.initAsset(program, me, mint, assetParams));
}
if (!(await exists(pda.lpMarket(whirlpool)))) await send(await ix.initLpMarket(program, me, whirlpool, NATIVE_MINT, 500));

// Existing prices are left alone so a rerun does not undo a crash, use the price script to move them
for (const [mint, price] of [
  [NATIVE_MINT, solPrice],
  [stock, 180],
] as const) {
  if (!(await exists(pda.demoPrice(mint)))) await send(await ix.setDemoPrice(program, me, mint, Math.round(price * 1e6)));
}

const d: Deployment = {
  cluster,
  rpcUrl: url,
  programId: PROGRAM_ID.toBase58(),
  whirlpoolProgramId: WHIRLPOOL_PROGRAM_ID.toBase58(),
  admin: me.toBase58(),
  usdcMint: usdc.toBase58(),
  solMint: NATIVE_MINT.toBase58(),
  stockMint: stock.toBase58(),
  shareMint: pda.shareMint().toBase58(),
  juniorMint: pda.juniorMint().toBase58(),
  whirlpool: whirlpool.toBase58(),
  whirlpoolVaultA: fixture.tokenA.vault,
  whirlpoolVaultB: fixture.tokenB.vault,
  tickSpacing: fixture.tickSpacing,
  demoMode: (await program.account.pool.fetch(pda.pool())).demoMode,
  assets: {
    [usdc.toBase58()]: { symbol: "USDC", name: "USD Coin (mock)", decimals: 6, priceAccount: null },
    [NATIVE_MINT.toBase58()]: {
      symbol: "SOL",
      name: "Solana",
      decimals: 9,
      priceAccount: pda.demoPrice(NATIVE_MINT).toBase58(),
    },
    [stock.toBase58()]: {
      symbol: "NVDAx",
      name: "NVIDIA tokenized stock (mock)",
      decimals: 6,
      priceAccount: pda.demoPrice(stock).toBase58(),
    },
  },
};

for (const junior of [false, true]) {
  const dollars = junior ? SEED_USDC.junior : SEED_USDC.senior;
  if ((await getMint(connection, junior ? pda.juniorMint() : pda.shareMint())).supply > 0n) continue;
  await faucet(d, me, { usdc: dollars });
  await send(await ix.lendDeposit(program, d, me, dollars * 1e6, { junior }));
}

fs.mkdirSync(path.dirname(deploymentFile), { recursive: true });
fs.writeFileSync(deploymentFile, JSON.stringify(d, null, 2) + "\n");
console.log(`Wrote ${deploymentFile}`);
