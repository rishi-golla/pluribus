// Idempotent bootstrap of the protocol on top of what orca:fixture created
import fs from "node:fs";
import path from "node:path";
import {
  ExtensionType,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createInitializeMintInstruction,
  createInitializePausableConfigInstruction,
  createInitializePermanentDelegateInstruction,
  createInitializeScaledUiAmountConfigInstruction,
  createInitializeTransferHookInstruction,
  createMint,
  getMint,
  getMintLen,
} from "@solana/spl-token";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import BN from "bn.js";
import { type AssetParams, type Deployment, type PoolParams, PROGRAM_ID, WHIRLPOOL_PROGRAM_ID, ix, math, pda } from "../sdk/index.ts";
import {
  FEEDS,
  FEED_OF,
  LIVE_SYMBOLS,
  MEME,
  addFeeds,
  demoActivateNow,
  deploymentFile,
  ensureFeedIds,
  ensureLookupTable,
  ensurePremiums,
  ensureShockColumn,
  exists,
  faucet,
  feedParam,
  goLive,
  listMeme,
  program,
  send,
} from "./lib.ts";
import { cluster, connection, key, me, root, url, wallet } from "./orca-common.ts";

const DAY = 86_400;
const SEED_USDC = { senior: 1_000_000, junior: 100_000 };
// A local validator cannot skip days, so localnet runs the same rules on seconds, with the shortest claim window allowed
// The program requires activation >= exit wait + claim window, and a gap >= exit wait + 3 days (the longest window) and >= activation
const WAITS =
  cluster === "localnet"
    ? { exit: 5, window: 60, gap: 3 * DAY + 5, activation: 70 }
    : { exit: 6 * DAY, window: 2 * DAY, gap: 14 * DAY, activation: 8 * DAY };
// Weekly payout epochs from Friday 00:00 UTC; localnet pays interest as it accrues so the e2e run sees it at once
const EPOCH_SECS = cluster === "localnet" ? 0 : 7 * DAY;

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

// Stand-ins for the two biggest single-pool staking tokens, with a fixed SOL backing since devnet has no real pools
const LSTS = [
  { keyName: "jitosol-mint", symbol: "JitoSOL", name: "Jito staked SOL (mock)", rate: 1.31 },
  { keyName: "jupsol-mint", symbol: "JupSOL", name: "Jupiter staked SOL (mock)", rate: 1.22 },
].map((l) => ({ ...l, mint: key(l.keyName).publicKey }));
for (const l of LSTS) {
  if (!(await exists(l.mint))) await createMint(connection, wallet, me, null, 9, key(l.keyName));
}

// A tokenized stock laid out like Backed's xStocks: a Token-2022 mint with the issuer's delegate, pause and
// corporate-action multiplier, and a transfer hook that points nowhere
const xstockKey = key("aaplx-mint");
const xstock = xstockKey.publicKey;
if (!(await exists(xstock))) {
  const extensions = [ExtensionType.PermanentDelegate, ExtensionType.PausableConfig, ExtensionType.ScaledUiAmountConfig, ExtensionType.TransferHook];
  const space = getMintLen(extensions);
  await send(
    [
      SystemProgram.createAccount({
        fromPubkey: me,
        newAccountPubkey: xstock,
        space,
        lamports: await connection.getMinimumBalanceForRentExemption(space),
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializePermanentDelegateInstruction(xstock, me, TOKEN_2022_PROGRAM_ID),
      createInitializePausableConfigInstruction(xstock, me, TOKEN_2022_PROGRAM_ID),
      createInitializeScaledUiAmountConfigInstruction(xstock, me, 1, TOKEN_2022_PROGRAM_ID),
      createInitializeTransferHookInstruction(xstock, me, PublicKey.default, TOKEN_2022_PROGRAM_ID),
      createInitializeMintInstruction(xstock, 8, me, null, TOKEN_2022_PROGRAM_ID),
    ],
    [wallet, xstockKey],
  );
}

// Scenarios are crypto crash, equity crash and broad selloff, with columns for the SOL, stock and USDC groups
// The small USDC shock keeps a gap between the draw limit and the liquidation line for USDC collateral
// Six columns per scenario: SOL, stock, USDC, LST, memecoin and one spare, then a fourth unused scenario
// Staking tokens fall with SOL plus a depeg, `depeg` bps deeper than the SOL column
const shocks = (rows: number[][], usdc: number, depeg: number) =>
  rows.flatMap(([sol, equity, meme]) => [sol, equity, usdc, sol + depeg, meme, 0]).concat(Array(math.MAX_GROUPS).fill(0));
const params: PoolParams = {
  numScenarios: 3,
  initShockBps: shocks([[3000, 1500, MEME.initShocks[0]], [1500, 3500, MEME.initShocks[1]], [2500, 2500, MEME.initShocks[2]]], 300, 500),
  maintShockBps: shocks([[2000, 1000, MEME.maintShocks[0]], [1000, 2500, MEME.maintShocks[1]], [1700, 1700, MEME.maintShocks[2]]], 100, 300),
  liqBonusBps: 500,
  closeFactorBps: 5000,
  warnHealthBps: 11_000,
  baseRateBps: 200,
  slope1Bps: 800,
  slope2Bps: 6000,
  kinkBps: 9000,
  reserveFactorBps: 1000,
  protocolFeeBps: 1000,
  // Each Friday the yield buffer less this margin becomes the week's budget, and the margin carries over
  yieldMarginBps: 1000,
  epochSecs: EPOCH_SECS,
  tierDiscountBps: [0, 40, 80],
  tierMinHealthySecs: [0, 7 * DAY, 30 * DAY].map((s) => new BN(s)),
  // Junior lenders earn the senior rate plus 15% of the senior yield per senior dollar they cover, in full once they hold a tenth of the pool
  juniorTargetBps: 1000,
  juniorPremiumBps: 1500,
  // Exits wait the same whatever the queue, must be claimed within the window, and leave 5 bps with the juniors who stay
  juniorMinDelaySecs: WAITS.exit,
  juniorMaxDelaySecs: WAITS.exit,
  juniorDelayThresholdBps: 10_000,
  juniorExitWindowSecs: WAITS.window,
  juniorExitFeeBps: 5,
  // Governance pauses of at most 90 days, spaced by the gap
  juniorMaxPauseSecs: 90 * DAY,
  juniorPauseGapSecs: WAITS.gap,
  // New collateral and anything that is not a pure tightening wait out the activation delay
  activationDelaySecs: WAITS.activation,
  // Dynamic shocks: d = z x sigma x sqrt(T), with z at about 99.9% for draws and 99% for liquidations
  zInitX100: 300,
  zMaintX100: 233,
  // Volatility rises in over about an hour and fades over about a week
  volTauFastSecs: 3_600,
  volTauSlowSecs: 7 * DAY,
  // A sample needs a price at least a minute newer, under a minute old and within 2%
  volMinIntervalSecs: 60,
  volMaxAgeSecs: 60,
  volConfCapBps: 200,
  // No scenario takes more than 95% off a price
  maxShockBps: 9_500,
};
// The pool opens with no waits so the first listings are live at once, and switches to the real ones after them
const bootstrap: PoolParams = { ...params, juniorMinDelaySecs: 0, juniorMaxDelaySecs: 0, activationDelaySecs: 0 };
if (!(await exists(pda.pool()))) await send(await ix.initialize(program, me, usdc, bootstrap, true));
if (!(await exists(pda.juniorMint()))) await send(await ix.initJunior(program, me));

// `horizon` is the dynamic shock's T: about a day to liquidate crypto, three days for a stock so a weekend fits
const asset = (group: number, oracle: number, feed: string, liqCostBps: number, horizon = 0): AssetParams => ({
  group,
  oracle,
  pythFeedId: [...Buffer.from(feed.padEnd(64, "0"), "hex")],
  liqCostBps,
  maxPriceAgeSecs: DAY,
  maxConfBps: 200,
  depositCap: new BN(0),
  paused: false,
  volHorizonSecs: horizon,
  rateSource: 0,
  rateAccount: PublicKey.default,
  fixedRate: new BN(0),
  rateBaseMint: PublicKey.default,
  rateFeedId: Array(32).fill(0),
  liqPriceAgeSecs: DAY,
  uiMultiplier: false,
  jumpHoldSecs: 0,
});
// A staking token's own price is its Pyth feed or demo account, and its backing is SOL's price at a fixed rate
function staked(rate: number, symbol: string): AssetParams {
  return {
    ...asset(3, 1, FEED_OF[symbol], 600, DAY),
    rateSource: 2,
    rateAccount: PublicKey.default,
    fixedRate: new BN(Math.round(rate * 1e9)),
    rateBaseMint: NATIVE_MINT,
    rateFeedId: feedParam(FEEDS.SOL),
  };
}
// Every feed id is the asset's real Pyth feed, which is only read while the asset is priced from Pyth
// The last column is the annual volatility each dynamic shock starts from: 80% for SOL, 50% for the stock
for (const [mint, assetParams, sigma] of [
  [usdc, asset(2, 0, "", 0), 0],
  [NATIVE_MINT, asset(0, 1, FEED_OF.SOL, 500, DAY), 8_000],
  [stock, asset(1, 1, FEED_OF.NVDAx, 1000, 3 * DAY), 5_000],
  // Staking tokens in the LST group, priced at the lower of their own price and their SOL backing, a point more to sell than SOL
  ...LSTS.map((l) => [l.mint, staked(l.rate, l.symbol), 8_000] as const),
  // The xStock in the stock group: per-share price times the mint's multiplier, and four days of last price for liquidations
  // A price jump has to hold a day before it counts, longer than an issuer could lag the feed on a split
  [xstock, { ...asset(1, 1, FEED_OF.AAPLx, 1000, 3 * DAY), liqPriceAgeSecs: 4 * DAY, uiMultiplier: true, jumpHoldSecs: DAY }, 4_000],
] as const) {
  if (!(await exists(pda.asset(mint)))) {
    const tokenProgram = mint.equals(xstock) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
    await send(await ix.initAsset(program, me, mint, assetParams, sigma, tokenProgram));
  }
}
if (!(await exists(pda.lpMarket(whirlpool)))) await send(await ix.initLpMarket(program, me, whirlpool, NATIVE_MINT, 500));

// With no activation delay in force yet the real parameters apply at once, and from here on loosening waits
const pool = await program.account.pool.fetch(pda.pool());
if (pool.params.activationDelaySecs === 0) await send(await ix.setParams(program, me, params));
// The guardian can only tighten: pause collateral and drop waiting changes
const guardian = key("guardian").publicKey;
if (!pool.guardian.equals(guardian)) await send(await ix.setGuardian(program, me, guardian));

// Existing prices are left alone so a rerun does not undo a crash, use the price script to move them
// A staking token trades a hair under its backing
for (const [mint, price] of [
  [NATIVE_MINT, solPrice],
  [stock, 180],
  [xstock, 230],
  ...LSTS.map((l) => [l.mint, Math.round(solPrice * l.rate * 0.999 * 100) / 100] as const),
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
    [xstock.toBase58()]: {
      symbol: "AAPLx",
      name: "Apple tokenized stock (mock)",
      decimals: 8,
      priceAccount: pda.demoPrice(xstock).toBase58(),
      tokenProgram: TOKEN_2022_PROGRAM_ID.toBase58(),
    },
    ...Object.fromEntries(
      LSTS.map((l) => [
        l.mint.toBase58(),
        {
          symbol: l.symbol,
          name: l.name,
          decimals: 9,
          priceAccount: pda.demoPrice(l.mint).toBase58(),
          backing: { solPriceAccount: pda.demoPrice(NATIVE_MINT).toBase58(), fixedRate: l.rate },
        },
      ]),
    ),
  },
};

// The memecoin has a shock column of its own, which a pool set up before it may not have yet
await ensureShockColumn(d, MEME.group, MEME.initShocks, MEME.maintShocks);
await listMeme(d);
addFeeds(d);
// Feed ids, premiums and new listings wait out the activation delay, which only protects juniors from an admin who sets
// every price anyway, so a demo pool applies them at once
await ensureFeedIds(d);
await ensurePremiums(d);
await demoActivateNow(d);

for (const junior of [false, true]) {
  const dollars = junior ? SEED_USDC.junior : SEED_USDC.senior;
  if ((await getMint(connection, junior ? pda.juniorMint() : pda.shareMint())).supply > 0n) continue;
  await faucet(d, me, { usdc: dollars });
  await send(await ix.lendDeposit(program, d, me, dollars * 1e6, { junior }));
}

// A lookup table of the addresses every transaction reuses, so liquidating an account with many positions fits in one
// A rerun extends the table it made before with whatever is new
await ensureLookupTable(d);

fs.mkdirSync(path.dirname(deploymentFile), { recursive: true });
fs.writeFileSync(deploymentFile, JSON.stringify(d, null, 2) + "\n");
console.log(`Wrote ${deploymentFile}`);

// Off a local chain, which has no Pyth, the assets whose feeds are fresh read them instead of their demo prices
// The rest stay on demo prices, and running setup again, or list:meme, switches them once their feeds are posted
if (d.demoMode && cluster !== "localnet") await goLive(d, LIVE_SYMBOLS);
