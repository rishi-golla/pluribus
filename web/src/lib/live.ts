import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, type Connection } from "@solana/web3.js";
import BN from "bn.js";
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
  pda, DLMM_PROGRAM_ID, KIND_DLMM, binPrice, decodeDlmmPair, decodeDlmmPosition } from "./pluribus/sdk";
import type { AccountEvent, Month } from "./account";
import { INDEXER_URL } from "./cluster";

export type Risk = math.RiskPosition;
// Columns per scenario in the on-chain shock tables
const GROUPS = math.MAX_GROUPS;
const DAY = 86_400;
// The pool stores scenarios by number only, so these follow the order scripts/setup.ts creates them in
export const SCENARIO_NAMES = ["Crypto crash", "Equity crash", "Broad selloff"];

const num = (x: { toString(): string }, decimals = 6) => Number(x.toString()) / 10 ** decimals;
// The full tables valued in one scenario only, since a dynamic shock is scaled against every scenario of its group
const scenario = (p: math.ShockParams, s: number): math.ShockParams => ({ ...p, only: s });

export type Collateral = {
  /** Token mint, the position NFT mint for an LP, or the position account for a Meteora position */
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
  /**
   * An LP or Meteora position: how far the pool's price may sit from the oracle's, in bps, for anyone to compound its fees back
   * into it, or 0 when its fees repay debt through autopay. Always 0 for a token
   */
  compoundBps: number;
  /** Price range, payout at the current price, and the limit a flat per-token discount would give */
  lp?: { lower: number; upper: number; sol: number; usdc: number; naive: number };
  /** The same for a Meteora position, whose `mint` is the position account the pool owns, with its pair, bin range and whether it holds no liquidity */
  dlmm?: { pair: string; lowerBin: number; upperBin: number; lower: number; upper: number; sol: number; usdc: number; naive: number; empty: boolean };
};

/** A listed Meteora pair: where a new position goes and why it might take no new liquidity */
export type DlmmMarket = {
  pair: string;
  baseMint: string;
  /** The base token's symbol */
  symbol: string;
  /** Whether the base token is the pair's token X, which fixes the bin price direction and the order of the two amounts */
  baseIsX: boolean;
  baseDecimals: number;
  activeId: number;
  binStep: number;
  /** USDC per whole base token at the pair's active bin */
  price: number;
  /** USDC per whole base token at a bin */
  binPrice: (binId: number) => number;
  /** Why no new position or liquidity is accepted right now, or null */
  closed: string | null;
  /** What the SDK's limits helper needs to value bins in this pair */
  risk: (bins: math.DlmmBin[]) => Risk;
};

export type LiveMarket = { collateral: number; crashLtv: number | null; liqCostBps: number };
/** One lending tranche, whose APY is unknown while it holds nothing */
export type TrancheStats = { assets: number; apy: number | null; sharePrice: number };

export async function loadLive(connection: Connection, d: Deployment, owner: PublicKey) {
  const program = getProgram(connection);
  const whirlpool = new PublicKey(d.whirlpool);
  const listed = Object.keys(d.assets);
  const [pool, credit, viewed, prices, assetAccounts, lpMarket, lamports, tokens, tokens2022, supply, juniorSupply, walletLps, poolLps, queuedExit, seniorExits, dlmmListed] = await Promise.all([
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
    // A deployment with no Meteora pair listed has nothing to read here
    loadDlmmListings(connection, program, d),
  ]);
  // Every Meteora position deposited by anyone, which the pool owns while it backs a credit line, valued like one account's
  const poolDlmm = dlmmListed.length ? await loadPoolDlmm(connection, program, d) : [];
  // Every token the deployment lists that the program has whitelisted, by mint
  const assets = new Map(assetAccounts.flatMap((a, i) => (a ? [[listed[i], a] as const] : [])));
  const [solAsset, stockAsset] = [assets.get(d.solMint), assets.get(d.stockMint)];
  if (!solAsset || !stockAsset) throw new Error(`SOL or ${d.assets[d.stockMint]?.symbol ?? "the stock"} is not listed on ${d.cluster}`);
  const dlmmHeld = credit?.positions.filter((p) => p.kind === KIND_DLMM) ?? [];
  const [positions, dlmmAccounts] = await Promise.all([
    credit ? fetchPositions(program, d, credit) : [],
    // The position accounts, for their bin range, which a position with no liquidity otherwise does not show
    dlmmHeld.length ? connection.getMultipleAccountsInfo(dlmmHeld.map((p) => p.mint)) : [],
  ]);
  const now = Date.now() / 1000;
  // A listing still in its activation delay backs no new debt, the same as a paused one
  const waiting = (activeAt: { toString(): string }) => now < math.effectiveAt(pool, activeAt);
  const dlmmPositions = new Map(
    dlmmHeld.flatMap((p, i) => {
      const info = dlmmAccounts[i];
      return info?.owner.equals(DLMM_PROGRAM_ID) ? [[p.mint.toBase58(), decodeDlmmPosition(p.mint, info.data)] as const] : [];
    }),
  );
  const dlmmMarkets: DlmmMarket[] = dlmmListed.flatMap(({ pair, market }) => {
    const baseMint = market.baseMint.toBase58();
    const asset = assets.get(baseMint);
    if (!asset) return [];
    const baseIsX = market.baseFirst;
    const [decimalsX, decimalsY] = baseIsX ? [asset.decimals, 6] : [6, asset.decimals];
    const at = (id: number) => binPrice(id, pair.binStep, decimalsX, decimalsY, baseIsX);
    const closed =
      pair.status !== 0
        ? "Meteora has disabled this pair"
        : market.paused || asset.params.paused
          ? "Market is paused"
          : waiting(market.activeAt) || waiting(asset.activeAt)
            ? "Market is not active yet"
            : null;
    return [
      {
        pair: pair.address.toBase58(),
        baseMint,
        symbol: d.assets[baseMint]?.symbol ?? "SOL",
        baseIsX,
        baseDecimals: asset.decimals,
        activeId: pair.activeId,
        binStep: pair.binStep,
        price: at(pair.activeId),
        binPrice: at,
        closed,
        risk: (bins: math.DlmmBin[]): Risk => ({
          mint: baseMint,
          group: asset.params.group,
          liqCostBps: market.liqCostBps,
          paused: market.paused || asset.params.paused || waiting(market.activeAt) || waiting(asset.activeAt),
          shockBps: math.dynamicShocks(asset, pool.params),
          bins,
          usdcGroup: pool.usdcGroup,
        }),
      },
    ];
  });

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
    ? {
        debt: num(health.debt),
        creditLimit: num(health.creditLimit),
        liquidationLimit: num(health.liquidationLimit),
        collateralValue: num(health.collateralValue),
        rateBps: health.borrowRateBps,
        premiumBps: health.premiumRateBps,
      }
    : {
        debt: credit ? (Number(credit.debtShares.toString()) * Number(pool.borrowIndex[tier].toString())) / 1e24 : 0,
        creditLimit: estimate.creditLimit,
        liquidationLimit: estimate.liquidationLimit,
        collateralValue: estimate.collateralValue,
        // The premium the account was last charged, scaled by its tier's share
        premiumBps: credit ? (credit.premiumBps * pool.premiumTierBps[tier]) / 1e4 : 0,
        rateBps: 0,
      };
  if (!health) account.rateBps = stats.borrowRateBps - params.tierDiscountBps[tier] + account.premiumBps;
  const scale = sums[binding] > 0 ? account.creditLimit / sums[binding] : 0;

  const collateral: Collateral[] = positions.map((p, i) => {
    // The program quotes a token worth a fraction of a cent per 10^priceExponent tokens
    const price = health ? num(health.positionPrice[p.slot]) / 10 ** (d.assets[p.risk.mint]?.priceExponent ?? 0) : prices[p.risk.mint];
    const value = health ? num(health.positionValue[p.slot]) : estimate.values[i];
    const base = {
      mint: p.mint.toBase58(),
      amount: "amount" in p.risk ? p.risk.amount : 1,
      raw: p.amount.toString(),
      price,
      value,
      power: math.limits([p.risk], worst, prices).creditLimit * scale,
      risk: p.risk,
        // Kept per position slot on the account, and only an LP or Meteora position can have one
      compoundBps: p.kind === "token" ? 0 : (credit?.compoundSlippageBps[p.slot] ?? 0),
    };
    if ("amount" in p.risk) return { ...base, symbol: d.assets[base.mint]?.symbol ?? "Token" };
    if ("bins" in p.risk) {
      const { bins, group, usdcGroup, liqCostBps } = p.risk;
      const held = math.dlmmAmounts(bins, price);
      const naive = (held.base * price * (1 - shockOf(group)) + held.usdc * (1 - shockOf(usdcGroup))) * (1 - liqCostBps / 1e4);
      const at = dlmmPositions.get(base.mint);
      const market = dlmmMarkets.find((m) => m.pair === at?.pair.toBase58());
      // The position's own range, so one that holds no liquidity still shows where it sits
      const edges = at && market ? [market.binPrice(at.lower), market.binPrice(at.upper)] : bins.map((b) => b.price);
      const range = edges.length ? { lower: Math.min(...edges), upper: Math.max(...edges) } : { lower: price, upper: price };
      const symbol = `${market?.symbol ?? d.assets[p.risk.mint]?.symbol ?? "SOL"}-USDC`;
      return {
        ...base,
        symbol,
        dlmm: { pair: at?.pair.toBase58() ?? "", lowerBin: at?.lower ?? 0, upperBin: at?.upper ?? 0, ...range, sol: held.base, usdc: held.usdc, naive, empty: !bins.length },
      };
    }
    const { liquidity, tickLower, tickUpper, group, usdcGroup, liqCostBps } = p.risk;
    const held = math.lpAmounts(liquidity, tickLower, tickUpper, price);
    // The same shocks as the crash test, applied to what the position holds now instead of what it would hold after the crash
    const naive = (held.sol * price * (1 - shockOf(group)) + held.usdc * (1 - shockOf(usdcGroup))) * (1 - liqCostBps / 1e4);
    return { ...base, symbol: "SOL-USDC", lp: { lower: math.tickToPrice(tickLower), upper: math.tickToPrice(tickUpper), ...held, naive } };
  });

  const tierDebt = pool.debtShares.map((s, t) => (Number(s.toString()) * Number(pool.borrowIndex[t].toString())) / 1e24);
  const avgRateBps = stats.debt > 0 ? tierDebt.reduce((sum, debt, t) => sum + debt * (stats.borrowRateBps - params.tierDiscountBps[t]), 0) / stats.debt : stats.borrowRateBps;
  const lenderShare = 1 - (params.reserveFactorBps + params.protocolFeeBps) / 1e4;
  // The lenders' part splits senior : junior as S : J + premium x the senior dollars juniors cover, see `poolStats`
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
    rate: {
      base: params.baseRateBps / 1e4,
      utilization: (borrowRateBps - account.premiumBps + params.tierDiscountBps[tier] - params.baseRateBps) / 1e4,
      discount: params.tierDiscountBps[tier] / 1e4,
      /** The collateral's risk premium after the tier's share, paid to junior lenders */
      premium: account.premiumBps / 1e4,
    },
    /** Share of each asset's risk premium charged in each loyalty tier */
    premiumTiers: pool.premiumTierBps.map((bps) => bps / 1e4),
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
    /** Every Meteora pair listed on-chain, for opening positions */
    dlmm: dlmmMarkets,
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
      /** Junior rate over senior rate right now, for taking losses first */
      juniorMultiple: stats.juniorMultiple,
      /** The most the multiple can be while juniors are thin, and what it is at the target share of the pool */
      juniorMultipleMax: stats.juniorMultipleMax,
      juniorMultipleAtTarget: stats.juniorMultipleAtTarget,
      juniorTarget: params.juniorTargetBps / 1e4,
      /** This week's payout: a budget fixed when the epoch opened on Friday, paid out evenly until `end` (unix seconds) */
      epoch: params.epochSecs > 0 ? { end: pool.epochEnd.toNumber(), budget: num(pool.epochBudget), buffer: stats.yieldBuffer } : null,
      kink: params.kinkBps / 1e4,
      /** The share of a compounded position's fees paid to whoever compounds it, in bps */
      compoundBountyBps: pool.compoundBountyBps,
      badDebt: num(pool.badDebt),
      // Borrower interest to date, implied by the insurance reserve's fixed cut of it
      interest: params.reserveFactorBps ? (stats.reserves * 1e4) / params.reserveFactorBps : 0,
    },
    markets: {
      // Each whitelisted token, under the overview's market id, which is its symbol in lower case
      ...Object.fromEntries([...assets].filter(([mint]) => mint !== d.usdcMint).map(([mint, asset]) => [d.assets[mint].symbol.toLowerCase(), tokenMarket(mint, asset)])),
      "orca-lp": lpTotalsMarket(lpTotals, lpMarket.liqCostBps),
      ...(dlmmListed.length ? { "met-lp": lpTotalsMarket(math.limits(poolDlmm, shock, prices), dlmmListed[0].market.liqCostBps) } : {}),
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
  if (!INDEXER_URL) return [];
  // A local indexer that is not running is the same as none
  const res = await fetch(INDEXER_URL + path).catch(() => null);
  return res?.ok ? res.json() : [];
}

export const fetchEvents = (owner: string) => indexed<AccountEvent>(`/accounts/${owner}/events`);
/** Protocol volume per day for the 90 days ending today, oldest first */
/** A pool's LP collateral as an overview market: its value now, and the share of it a crash test leaves as credit */
const lpTotalsMarket = (t: { collateralValue: number; creditLimit: number }, liqCostBps: number): LiveMarket => ({
  collateral: t.collateralValue,
  crashLtv: t.collateralValue > 0 ? t.creditLimit / t.collateralValue : null,
  liqCostBps,
});

// PositionV2 keeps its owner at byte 40, so the pool's own positions are found without reading anyone's credit account
async function loadPoolDlmm(connection: Connection, program: ReturnType<typeof getProgram>, d: Deployment): Promise<Risk[]> {
  const held = await connection.getProgramAccounts(DLMM_PROGRAM_ID, { dataSlice: { offset: 0, length: 0 }, filters: [{ memcmp: { offset: 40, bytes: pda.pool().toBase58() } }] });
  if (!held.length) return [];
  // The positions as one account's slots, so they are priced exactly as a borrower's own Meteora position is
  const slots = held.map(({ pubkey }) => ({ kind: KIND_DLMM, mint: pubkey, amount: new BN(1), bump: 0 }));
  const all = await fetchPositions(program, d, { positions: slots } as unknown as Parameters<typeof fetchPositions>[2]);
  return all.map((p) => p.risk);
}

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

/** Each Meteora pair the deployment lists that is also listed on-chain, with the program's market for it */
async function loadDlmmListings(connection: Connection, program: ReturnType<typeof getProgram>, d: Deployment) {
  const listed = (d.lpMarkets ?? []).filter((m) => m.dexProgram === DLMM_PROGRAM_ID.toBase58());
  if (!listed.length) return [];
  const [pairs, markets] = await Promise.all([
    connection.getMultipleAccountsInfo(listed.map((m) => new PublicKey(m.pool))),
    program.account.lpMarket.fetchMultiple(listed.map((m) => pda.lpMarket(new PublicKey(m.pool)))),
  ]);
  return listed.flatMap((m, i) => {
    const [info, market] = [pairs[i], markets[i]];
    // A pair the deployment names but the admin has not listed, or one that is gone, cannot take a position
    if (!info?.owner.equals(DLMM_PROGRAM_ID) || !market) return [];
    return [{ pair: decodeDlmmPair(new PublicKey(m.pool), info.data), market }];
  });
}
