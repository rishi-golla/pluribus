import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, type Connection } from "@solana/web3.js";
import {
  type Deployment,
  type OrcaPosition,
  fetchCredit,
  fetchHealth,
  fetchJuniorExit,
  fetchLpMarket,
  fetchPool,
  fetchPositions,
  fetchPrices,
  fetchSeniorExits,
  getProgram,
  listOrcaPositions,
  math,
  pda,
} from "./pluribus/sdk";
import type { AccountEvent, Month } from "./account";

export type Risk = math.RiskPosition;
// Columns per scenario in the on-chain shock tables
const GROUPS = math.MAX_GROUPS;
const DAY = 86_400;
// The pool stores scenarios by number only, so these follow the order scripts/setup.ts creates them in
const SCENARIO_NAMES = ["Crypto crash", "Equity crash", "Broad selloff"];

const num = (x: { toString(): string }, decimals = 6) => Number(x.toString()) / 10 ** decimals;
// The full tables valued in one scenario only, since a dynamic shock is scaled against every scenario of its group
const scenario = (p: math.ShockParams, s: number): math.ShockParams => ({ ...p, only: s });

export type Collateral = {
  /** Token mint, or the position NFT mint for an LP */
  mint: string;
  symbol: string;
  amount: number;
  /** The same amount in base units */
  raw: string;
  price: number;
  value: number;
  /** This position's part of the credit limit */
  power: number;
  risk: Risk;
  /** Price range, payout at the current price, and the limit a flat per-token discount would give */
  lp?: { lower: number; upper: number; sol: number; usdc: number; naive: number };
};

export type LiveMarket = { collateral: number; crashLtv: number | null; liqCostBps: number };
/** One lending tranche, whose APY is unknown while it holds nothing */
export type TrancheStats = { assets: number; apy: number | null; sharePrice: number };

export async function loadLive(connection: Connection, d: Deployment, owner: PublicKey) {
  const program = getProgram(connection);
  const whirlpool = new PublicKey(d.whirlpool);
  const listed = Object.keys(d.assets);
  const [pool, credit, viewed, prices, assetAccounts, lpMarket, lamports, tokens, tokens2022, supply, juniorSupply, walletLps, poolLps, queuedExit, seniorExits] = await Promise.all([
    fetchPool(program),
    fetchCredit(program, owner),
    // A stale price fails the view, and the page still has to load so the price can be set again
    fetchHealth(program, d, owner).catch((e: Error) => e),
    fetchPrices(program, d),
    program.account.asset.fetchMultiple(listed.map((m) => pda.asset(new PublicKey(m)))),
    fetchLpMarket(program, whirlpool),
    connection.getBalance(owner),
    connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
    // Token-2022 mints like the xStock keep their balances under the other token program
    connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }),
    connection.getTokenSupply(pda.shareMint()),
    // The junior mint only exists once the admin has opened that tranche
    connection.getTokenSupply(pda.juniorMint()).catch(() => null),
    listOrcaPositions(connection, d, owner),
    listOrcaPositions(connection, d, pda.pool()),
    fetchJuniorExit(program, owner),
    // A program from before the senior queue has no such accounts, and the page still loads
    fetchSeniorExits(program, owner).catch(() => []),
  ]);
  // Every token the deployment lists that the program has whitelisted, by mint
  const assets = new Map(assetAccounts.flatMap((a, i) => (a ? [[listed[i], a] as const] : [])));
  const [solAsset, stockAsset] = [assets.get(d.solMint), assets.get(d.stockMint)];
  if (!solAsset || !stockAsset) throw new Error(`SOL or ${d.assets[d.stockMint]?.symbol ?? "the stock"} is not listed on ${d.cluster}`);
  const positions = credit ? await fetchPositions(program, d, credit) : [];
  const now = Date.now() / 1000;

  const shock: math.ShockParams = {
    numScenarios: pool.params.numScenarios,
    initShockBps: pool.params.initShockBps,
    maintShockBps: pool.params.maintShockBps,
    maxShockBps: pool.params.maxShockBps,
  };
  const risks = positions.map((p) => p.risk);
  const sums = Array.from({ length: shock.numScenarios }, (_, s) => math.limits(risks, scenario(shock, s), prices).creditLimit);
  // The scenario that sets the credit limit, since each position's share of the limit is its value there
  const binding = Math.max(0, sums.indexOf(Math.min(...sums)));
  const worst = scenario(shock, binding);
  const shockOf = (group: number) => (shock.initShockBps[binding * GROUPS + group] ?? 0) / 1e4;

  const stats = math.poolStats(pool, { senior: supply.value.amount, junior: juniorSupply?.value.amount });
  const params = pool.params;
  const tier = credit?.tier ?? 0;
  const health = viewed instanceof Error ? null : viewed;
  const estimate = math.limits(risks, shock, prices);
  // The program's own figures whenever its view runs, and the float estimate when there is no account or the view fails
  const account = health
    ? { debt: num(health.debt), creditLimit: num(health.creditLimit), liquidationLimit: num(health.liquidationLimit), collateralValue: num(health.collateralValue), rateBps: health.borrowRateBps }
    : {
        debt: credit ? (Number(credit.debtShares.toString()) * Number(pool.borrowIndex[tier].toString())) / 1e24 : 0,
        creditLimit: estimate.creditLimit,
        liquidationLimit: estimate.liquidationLimit,
        collateralValue: estimate.collateralValue,
        rateBps: stats.borrowRateBps - params.tierDiscountBps[tier],
      };
  const scale = sums[binding] > 0 ? account.creditLimit / sums[binding] : 0;

  const collateral: Collateral[] = positions.map((p, i) => {
    const price = health ? num(health.positionPrice[p.slot]) : prices[p.risk.mint];
    const value = health ? num(health.positionValue[p.slot]) : estimate.values[i];
    const base = {
      mint: p.mint.toBase58(),
      amount: "amount" in p.risk ? p.risk.amount : 1,
      raw: p.amount.toString(),
      price,
      value,
      power: math.limits([p.risk], worst, prices).creditLimit * scale,
      risk: p.risk,
    };
    if ("amount" in p.risk) return { ...base, symbol: d.assets[base.mint]?.symbol ?? "Token" };
    const { liquidity, tickLower, tickUpper, group, usdcGroup, liqCostBps } = p.risk;
    const held = math.lpAmounts(liquidity, tickLower, tickUpper, price);
    // The same shocks as the crash test, applied to what the position holds now instead of what it would hold after the crash
    const naive = (held.sol * price * (1 - shockOf(group)) + held.usdc * (1 - shockOf(usdcGroup))) * (1 - liqCostBps / 1e4);
    return { ...base, symbol: "SOL-USDC", lp: { lower: math.tickToPrice(tickLower), upper: math.tickToPrice(tickUpper), ...held, naive } };
  });

  const tierDebt = pool.debtShares.map((s, t) => (Number(s.toString()) * Number(pool.borrowIndex[t].toString())) / 1e24);
  const avgRateBps = stats.debt > 0 ? tierDebt.reduce((sum, debt, t) => sum + debt * (stats.borrowRateBps - params.tierDiscountBps[t]), 0) / stats.debt : stats.borrowRateBps;
  const lenderShare = 1 - (params.reserveFactorBps + params.protocolFeeBps) / 1e4;
  // The lenders' part splits senior : junior as S : J + premium x S, the premium scaled below the target share
  const seniorCut = lenderShare * stats.seniorShare;
  const senior: TrancheStats = { assets: stats.seniorAssets, apy: stats.seniorApyBps / 1e4, sharePrice: stats.seniorShareValue ?? 1 };
  const junior: TrancheStats | null = juniorSupply && { assets: stats.juniorAssets, apy: stats.juniorApyBps / 1e4, sharePrice: stats.juniorShareValue ?? 1 };

  const borrowRateBps = account.rateBps;
  const accounts = [...tokens.value, ...tokens2022.value];
  // Base units over decimals rather than uiAmount, which a scaled Token-2022 mint multiplies, since deposits count base units
  const balance = (mint: string) =>
    accounts
      .filter((t) => t.account.data.parsed.info.mint === mint)
      .reduce((sum, t) => sum + Number(t.account.data.parsed.info.tokenAmount.amount) / 10 ** t.account.data.parsed.info.tokenAmount.decimals, 0);
  /** Shares of one tranche in the wallet, whole and in base units */
  const shares = (mint: PublicKey) => {
    const raw: string = accounts.find((t) => t.account.data.parsed.info.mint === mint.toBase58())?.account.data.parsed.info.tokenAmount.amount ?? "0";
    return { amount: num(raw), raw };
  };

  // A listing still in its activation delay backs no new debt, the same as a paused one
  const waiting = (activeAt: { toString(): string }) => now < math.effectiveAt(pool, activeAt);
  const juniorWallet = shares(pda.juniorMint());
  const juniorPrice = junior?.sharePrice ?? 1;
  const deadline = queuedExit ? math.juniorExitDeadline(pool, queuedExit) : 0;
  const exit = queuedExit && {
    shares: num(queuedExit.shares),
    // A queued exit can lose value while it waits but never gains any
    value: Math.min(num(queuedExit.value), num(queuedExit.shares) * juniorPrice),
    unlockAt: queuedExit.unlockAt.toNumber(),
    deadline,
    feeBps: Math.min(queuedExit.feeBps, params.juniorExitFeeBps),
    /** As of this reading, which the app takes every few seconds */
    state: (now < queuedExit.unlockAt.toNumber() ? "waiting" : now < deadline ? "ready" : "lapsed") as "waiting" | "ready" | "lapsed",
  };

  const tokenMarket = (mint: string, asset: typeof solAsset): LiveMarket => ({
    collateral: num(asset.totalDeposited, asset.decimals) * prices[mint],
    crashLtv:
      math.limits([{ mint, group: asset.params.group, liqCostBps: asset.params.liqCostBps, amount: 1, shockBps: math.dynamicShocks(asset, params) }], shock, prices)
        .creditLimit / prices[mint],
    liqCostBps: asset.params.liqCostBps,
  });
  /** What the SDK's limits helper needs to value an Orca position in the whitelisted pool */
  const lpRisk = (lp: Pick<OrcaPosition, "liquidity" | "tickLower" | "tickUpper">): Risk => ({
    mint: d.solMint,
    group: solAsset.params.group,
    liqCostBps: lpMarket.liqCostBps,
    paused: lpMarket.paused || solAsset.params.paused || waiting(lpMarket.activeAt) || waiting(solAsset.activeAt),
    shockBps: math.dynamicShocks(solAsset, params),
    liquidity: lp.liquidity,
    tickLower: lp.tickLower,
    tickUpper: lp.tickUpper,
    usdcGroup: pool.usdcGroup,
  });
  const lpTotals = math.limits(poolLps.map(lpRisk), shock, prices);

  return {
    today: new Date().toISOString().slice(0, 10),
    owner: owner.toBase58(),
    credit: pda.credit(owner).toBase58(),
    hasAccount: !!credit,
    /** Why the program's health view failed, in which case the account figures are estimates */
    viewError: viewed instanceof Error ? viewed.message.replace(/^Health view failed: /, "") : null,
    debt: account.debt,
    creditLimit: account.creditLimit,
    liquidationLimit: account.liquidationLimit,
    collateralValue: account.collateralValue,
    borrowApr: borrowRateBps / 1e4,
    tier,
    healthyDays: credit ? Math.floor((now - credit.healthySince.toNumber()) / DAY) : 0,
    /** Parts of the borrow rate, which add up to `borrowApr` */
    rate: { base: params.baseRateBps / 1e4, utilization: (borrowRateBps + params.tierDiscountBps[tier] - params.baseRateBps) / 1e4, discount: params.tierDiscountBps[tier] / 1e4 },
    tiers: params.tierDiscountBps.map((bps, t) => ({ discount: bps / 1e4, minDays: params.tierMinHealthySecs[t].toNumber() / DAY })),
    collateral,
    prices,
    shock,
    /** Every crash scenario in the pool, as the fall it applies to SOL and to stocks when setting the credit limit */
    scenarios: Array.from({ length: shock.numScenarios }, (_, s) => {
      const fall = (group: number) => (shock.initShockBps[s * GROUPS + group] ?? 0) / 1e4;
      return { name: SCENARIO_NAMES[s] ?? `Scenario ${s + 1}`, sol: fall(solAsset.params.group), stock: fall(stockAsset.params.group) };
    }),
    /** Index of the scenario that sets the credit limit */
    binding,
    lpRisk,
    /** Mints of every whitelisted token other than SOL, which is deposited from the wallet's native balance */
    tokenMints: [...assets.keys()].filter((m) => m !== d.solMint),
    /** The same for `amount` whole tokens of any whitelisted mint */
    tokenRisk: (mint: string, amount: number): Risk => {
      const asset = assets.get(mint);
      if (!asset) throw new Error(`${d.assets[mint]?.symbol ?? mint} is not listed on ${d.cluster}`);
      const { group, liqCostBps, paused } = asset.params;
      return { mint, group, liqCostBps, paused: paused || waiting(asset.activeAt), amount, shockBps: math.dynamicShocks(asset, params) };
    },
    pool: {
      supplied: stats.cash + stats.debt,
      cash: stats.cash,
      /** Idle USDC not held back for queued senior exits: what draws and instant withdrawals can use */
      available: Math.max(0, stats.cash - num(pool.seniorReserved ?? 0)),
      /** The senior withdrawal queue: USDC held back for it, the ticket it pays next and the one a new exit gets */
      seniorQueue: { reserved: num(pool.seniorReserved ?? 0), head: Number(pool.seniorHead ?? 0), next: Number(pool.seniorNextTicket ?? 0) },
      debt: stats.debt,
      reserves: stats.reserves,
      protocolFees: stats.protocolFees,
      lenderAssets: stats.lenderAssets,
      utilization: stats.utilization,
      baseApr: stats.borrowRateBps / 1e4,
      avgApr: avgRateBps / 1e4,
      senior,
      /** Missing until the admin opens the junior tranche */
      junior,
      /** Where each dollar of borrower interest goes, which adds up to 1 */
      split: { senior: seniorCut, junior: lenderShare - seniorCut, protocol: params.protocolFeeBps / 1e4, insurance: params.reserveFactorBps / 1e4 },
      /** The premium juniors earn on senior yield right now, for taking losses first */
      juniorPremium: stats.juniorPremium,
      /** The most the premium can be, and the junior share of the pool at which it is paid in full */
      juniorPremiumMax: params.juniorPremiumBps / 1e4,
      juniorTarget: params.juniorTargetBps / 1e4,
      /** This week's payout: a budget fixed when the epoch opened on Friday, paid out evenly until `end` (unix seconds) */
      epoch: params.epochSecs > 0 ? { end: pool.epochEnd.toNumber(), budget: num(pool.epochBudget), buffer: stats.yieldBuffer } : null,
      kink: params.kinkBps / 1e4,
      badDebt: num(pool.badDebt),
      // Borrower interest to date, implied by the insurance reserve's fixed cut of it
      interest: params.reserveFactorBps ? (stats.reserves * 1e4) / params.reserveFactorBps : 0,
    },
    markets: {
      sol: tokenMarket(d.solMint, solAsset),
      nvdax: tokenMarket(d.stockMint, stockAsset),
      "orca-lp": { collateral: lpTotals.collateralValue, crashLtv: lpTotals.collateralValue > 0 ? lpTotals.creditLimit / lpTotals.collateralValue : null, liqCostBps: lpMarket.liqCostBps },
    } as Record<string, LiveMarket>,
    wallet: {
      sol: lamports / 1e9,
      stock: balance(d.stockMint),
      usdc: balance(d.usdcMint),
      /** Whole tokens held of each listed mint */
      tokens: Object.fromEntries(listed.map((m) => [m, balance(m)])) as Record<string, number>,
      shares: { senior: shares(pda.shareMint()), junior: juniorWallet },
      lps: walletLps,
    },
      /** The wallet's queued junior exit, with its value at today's junior share price */
    juniorExit: exit,
    /** The wallet's queued senior exits, oldest first, with how many tickets wait ahead of each */
    seniorExits: seniorExits
      .filter((e) => !e.cancelled)
      .map((e) => {
        const ticket = Number(e.ticket);
        return { ticket, shares: num(e.shares), value: num(e.value), ahead: Math.max(0, ticket - Number(pool.seniorHead ?? 0)) };
      }),
    /** How junior money leaves: the wait a new exit of the wallet's shares would get, the claim window and the fee */
    juniorRules: {
      waitSecs: math.juniorExitDelay(params, pool.juniorQueued, juniorWallet.raw, juniorSupply?.value.amount ?? 0),
      /** The wait for an exit of `shares` whole junior shares */
      waitFor: (shares: number) => math.juniorExitDelay(params, pool.juniorQueued, Math.round(shares * 1e6), juniorSupply?.value.amount ?? 0),
      windowSecs: params.juniorExitWindowSecs,
      feeBps: params.juniorExitFeeBps,
      /** Unix seconds until which governance has frozen junior exits, or null */
      pausedUntil: now < pool.juniorPauseEnd.toNumber() ? pool.juniorPauseEnd.toNumber() : null,
    },
  };
}

export type LiveData = Awaited<ReturnType<typeof loadLive>>;

/** Health once SOL and stocks have fallen by `drop` (0 to 1 each), with USDC unchanged */
export const healthAfterDrop = (live: LiveData, mints: { sol: string; stock: string }, drop: { sol: number; stock: number }) =>
  math.limits(
    live.collateral.map((c) => c.risk),
    live.shock,
    { ...live.prices, [mints.sol]: live.prices[mints.sol] * (1 - drop.sol), [mints.stock]: live.prices[mints.stock] * (1 - drop.stock) },
  ).liquidationLimit / live.debt;

export type DayStats = { date: string; draws: number; repays: number; autopay: number };

// A local validator forgets transactions within minutes, so history comes from the indexer and never from the RPC
async function indexed<T>(path: string): Promise<T[]> {
  const url = process.env.NEXT_PUBLIC_INDEXER_URL;
  if (!url) return [];
  const res = await fetch(url + path);
  return res.ok ? res.json() : [];
}

export const fetchEvents = (owner: string) => indexed<AccountEvent>(`/accounts/${owner}/events`);
/** Protocol volume per day for the 90 days ending today, oldest first */
export const fetchStats = () => indexed<DayStats>("/stats");

/** Groups indexed events into statement months, always ending with the current month */
export function monthsOf(events: AccountEvent[], today: string, avgApr: number, tier: string): Month[] {
  const keys = [...new Set([...events.map((e) => e.date.slice(0, 7)), today.slice(0, 7)])].sort();
  return keys.map((key) => {
    const name = (month: "long" | "short") => new Date(`${key}-01T00:00:00Z`).toLocaleDateString("en-US", { month, timeZone: "UTC" });
    return {
      key,
      label: `${name("long")} ${key.slice(0, 4)}`,
      short: name("short"),
      avgApr,
      tier,
      inProgress: key === today.slice(0, 7),
      events: events.filter((e) => e.date.startsWith(key)),
    };
  });
}
