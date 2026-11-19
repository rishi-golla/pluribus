// Float versions of the program's valuation rules, for previews only
// The on-chain `health` view stays the source of truth

export type Numeric = number | bigint | string | { toString(): string };

export type RiskPosition = {
  // The mint whose price applies: the token itself, or the base token of an LP position
  mint: string;
  group: number;
  liqCostBps: number;
  paused?: boolean;
  // The asset's dynamic shock in bps for the draw and liquidation tables, laid over the table like the program does
  shockBps?: { init: number; maint: number };
} & (
  | { amount: number }
  // `usdcGroup` is the pool's `usdcGroup`: the USDC side of an LP position takes that group's shock
  | { liquidity: Numeric; tickLower: number; tickUpper: number; usdcGroup: number }
  // A Meteora position: each bin's price in USDC per whole base token and its liquidity in USDC at that price
  | { bins: DlmmBin[]; usdcGroup: number }
);

export type DlmmBin = { price: number; usdc: number };

// Mirrors `dlmm::Curve`: each bin counts as whichever of its two tokens is worth less at `price`,
// all USDC once the price is above the bin and all base token below it, the USDC marked down to `usdcKept`
export function dlmmValue(bins: DlmmBin[], price: number, usdcKept = 1) {
  return bins.reduce((sum, b) => sum + Math.min(b.usdc * usdcKept, (b.usdc * price) / b.price), 0);
}

// Whole base tokens and USDC the position holds once the pair trades at `price`, fees left out
export function dlmmAmounts(bins: DlmmBin[], price: number) {
  return bins.reduce((t, b) => (b.price <= price ? { ...t, usdc: t.usdc + b.usdc } : { ...t, base: t.base + b.usdc / b.price }), { base: 0, usdc: 0 });
}

// `only` values a single scenario of the full tables
export type ShockParams = { numScenarios: number; initShockBps: number[]; maintShockBps: number[]; maxShockBps?: number; only?: number };

const BPS = 10_000;
export const MAX_GROUPS = 6;

// Mirrors `PoolParams::shocks_for`: the scenario where the group falls hardest takes all of the dynamic shock `d`,
// the others the same fraction of it as in the table, never below the table and never above the cap
export function shockFor(params: ShockParams, init: boolean, scenario: number, group: number, d = 0) {
  const table = init ? params.initShockBps : params.maintShockBps;
  const at = (s: number) => (group < MAX_GROUPS ? (table[s * MAX_GROUPS + group] ?? 0) : 0);
  const worst = Math.max(0, ...Array.from({ length: params.numScenarios }, (_, s) => at(s)));
  const t = at(scenario);
  const scaled = worst > 0 ? (d * t) / worst : 0;
  return Math.min(Math.max(t, scaled), params.maxShockBps ?? BPS - 1);
}

// Mirrors `Asset::dynamic_shocks`: z x sigma x sqrt(T) in bps, draws from the higher of the two variance averages,
// the liquidation line from the slow one alone and never above the draw shock
export function dynamicShocks(
  asset: { varFast: Numeric; varSlow: Numeric; params: { volHorizonSecs: number } },
  p: { zInitX100: number; zMaintX100: number },
) {
  const shock = (v: number, z: number) => (z * Math.sqrt(v * asset.params.volHorizonSecs)) / 1e7;
  const [fast, slow] = [Number(asset.varFast.toString()), Number(asset.varSlow.toString())];
  const init = shock(Math.max(fast, slow), p.zInitX100);
  return { init, maint: Math.min(shock(slow, p.zMaintX100), init) };
}
// The pool quotes micro-USDC per lamport, so a dollar price per SOL is the raw price times 10^(9 - 6)
const RAW = 1000;

const num = (x: Numeric) => Number(x.toString());

export const tickToPrice = (tick: number) => 1.0001 ** tick * RAW;

export const priceToTick = (price: number) => Math.round(Math.log(price / RAW) / Math.log(1.0001));

// Whole SOL and USDC the position would pay out with SOL at `price`, fees left out
export function lpAmounts(liquidity: Numeric, tickLower: number, tickUpper: number, price: number) {
  const [lower, upper] = [1.0001 ** (tickLower / 2), 1.0001 ** (tickUpper / 2)];
  const s = Math.min(Math.max(Math.sqrt(price / RAW), lower), upper);
  const l = num(liquidity);
  return { sol: (l * (1 / s - 1 / upper)) / 1e9, usdc: (l * (s - lower)) / 1e6 };
}

export function lpValue(liquidity: Numeric, tickLower: number, tickUpper: number, price: number) {
  const { sol, usdc } = lpAmounts(liquidity, tickLower, tickUpper, price);
  return sol * price + usdc;
}

// Dollar values: every position is shocked together per scenario, summed, and the worst scenario wins
export function limits(positions: RiskPosition[], params: ShockParams, prices: Record<string, number>) {
  const price = (p: RiskPosition) => {
    const v = prices[p.mint];
    if (v === undefined) throw new Error(`No price for ${p.mint}`);
    return v;
  };
  const value = (p: RiskPosition, at: number, usdcKept = 1) => {
    if ("amount" in p) return p.amount * at;
    if ("bins" in p) return dlmmValue(p.bins, at, usdcKept);
    const { sol, usdc } = lpAmounts(p.liquidity, p.tickLower, p.tickUpper, at);
    return sol * at + usdc * usdcKept;
  };
  const worst = (init: boolean) => {
    // A position's shock: the table's, with its dynamic shock laid over it, and a liquidation shock never above the draw shock
    const shock = (s: number, p: RiskPosition) => {
      const draw = shockFor(params, true, s, p.group, p.shockBps?.init ?? 0);
      return init ? draw : Math.min(shockFor(params, false, s, p.group, p.shockBps?.maint ?? 0), draw);
    };
    // Groups past the table are never shocked
    const usdcShock = (s: number, group: number) => shockFor(params, init, s, group);
    const scenarios = params.only === undefined ? Array.from({ length: params.numScenarios }, (_, s) => s) : [params.only];
    const sums = scenarios.map((s) =>
      positions.reduce((sum, p) => {
        // Paused collateral stops backing new debt but still counts against liquidation
        if (init && p.paused) return sum;
        const usdcKept = "amount" in p ? 1 : 1 - usdcShock(s, p.usdcGroup) / BPS;
        return sum + value(p, price(p) * (1 - shock(s, p) / BPS), usdcKept) * (1 - p.liqCostBps / BPS);
      }, 0),
    );
    return sums.length ? Math.min(...sums) : 0;
  };
  const values = positions.map((p) => value(p, price(p)));
  return {
    values,
    collateralValue: values.reduce((a, b) => a + b, 0),
    creditLimit: worst(true),
    liquidationLimit: worst(false),
  };
}

type PoolLike = {
  cash: Numeric;
  reserves: Numeric;
  protocolFees: Numeric;
  juniorAssets: Numeric;
  borrowIndex: Numeric[];
  debtShares: Numeric[];
  yieldBuffer: Numeric;
  epochStart: Numeric;
  epochEnd: Numeric;
  epochBudget: Numeric;
  epochPaid: Numeric;
  lastAccrual: Numeric;
  params: {
    baseRateBps: number;
    slope1Bps: number;
    slope2Bps: number;
    kinkBps: number;
    reserveFactorBps: number;
    protocolFeeBps: number;
    juniorTargetBps: number;
    juniorPremiumBps: number;
    yieldMarginBps: number;
    epochSecs: number;
  };
};

const SECONDS_PER_YEAR = 31_536_000;

// Pool totals in USDC as of the last accrual, with rates in bps a year
// Give each share mint's supply in base units to get what one share of that tranche is worth

export function poolStats(pool: PoolLike, supply: { senior?: Numeric; junior?: Numeric } = {}) {
  const debt = pool.debtShares.reduce((sum: number, s, t) => sum + (num(s) * num(pool.borrowIndex[t])) / 1e18, 0) / 1e6;
  const [cash, reserves, protocolFees] = [pool.cash, pool.reserves, pool.protocolFees].map((x) => num(x) / 1e6);
  const utilization = cash + debt > 0 ? debt / (cash + debt) : 0;
  const p = pool.params;
  const kink = p.kinkBps / BPS;
  const borrowRateBps =
    utilization <= kink
      ? p.baseRateBps + (p.slope1Bps * utilization) / kink
      : p.baseRateBps + p.slope1Bps + (p.slope2Bps * (utilization - kink)) / (1 - kink);
  const yieldBuffer = num(pool.yieldBuffer) / 1e6;
  // Interest still waiting in the yield buffer belongs to no lender yet
  const lenderAssets = Math.max(cash + debt - reserves - protocolFees - yieldBuffer, 0);
  const juniorAssets = Math.min(num(pool.juniorAssets) / 1e6, lenderAssets);
  const seniorAssets = lenderAssets - juniorAssets;
  // Mirrors `Pool::split_weights`: payouts split senior : junior as S : J + premium x filled x S,
  // the premium in full once junior lenders hold the target share of the pool
  const target = p.juniorTargetBps / BPS;
  const premiumRate = p.juniorPremiumBps / BPS;
  const filled = lenderAssets > 0 ? Math.min(juniorAssets / lenderAssets / target, 1) : 0;
  const juniorWeight = juniorAssets + premiumRate * filled * seniorAssets;
  const weights = seniorAssets + juniorWeight;
  const interest = (borrowRateBps / BPS) * debt;
  const toLenders = interest * (1 - (p.reserveFactorBps + p.protocolFeeBps) / BPS);
  // Lenders get the rest of the open epoch's budget over the time it has left, never more than the buffer holds,
  // plus, with epochs off, today's interest as it accrues
  // With epochs on and the epoch over, the next one opens with the buffer less the margin
  const now = Date.now() / 1000;
  const [epochStart, epochEnd] = [num(pool.epochStart), num(pool.epochEnd)];
  const weekly = p.epochSecs > 0;
  // The epoch's even pace, or slower when the buffer cannot cover the rest of it, as of the last accrual
  const left = Math.max(Math.min(num(pool.epochBudget) - num(pool.epochPaid), num(pool.yieldBuffer)), 0) / 1e6;
  const pace = num(pool.epochBudget) / 1e6 / Math.max(epochEnd - epochStart, 1);
  const leftPace = left / Math.max(epochEnd - Math.max(num(pool.lastAccrual), epochStart), 1);
  const streaming = now < epochEnd ? Math.min(pace, leftPace) * SECONDS_PER_YEAR : 0;
  const next = (yieldBuffer * (1 - p.yieldMarginBps / BPS) * SECONDS_PER_YEAR) / Math.max(p.epochSecs, 1);
  // After whole epochs with no transaction the program pays the stale part at once, so today's interest is the better guess
  const stale = now >= epochEnd + p.epochSecs;
  const lenderYear = weekly ? (now < epochEnd ? streaming : stale ? toLenders * (1 - p.yieldMarginBps / BPS) : next) : toLenders + streaming;
  const seniorYear = weights > 0 ? (lenderYear * seniorAssets) / weights : lenderYear;
  const juniorYear = weights > 0 ? (lenderYear * juniorWeight) / weights : 0;
  // An empty tranche shows what its first dollar would earn: the senior rate, and for juniors the premium per unit of target on top
  const seniorRate = seniorAssets > 0 ? seniorYear / seniorAssets : lenderAssets > 0 ? lenderYear / lenderAssets : 0;
  const seniorApyBps = seniorRate * BPS;
  const juniorApyBps = (juniorAssets > 0 ? juniorYear / juniorAssets : seniorRate * (1 + (premiumRate * seniorAssets) / Math.max(lenderAssets * target, 1e-9))) * BPS;
  // The program counts one virtual share and one virtual dollar in each tranche, and never pays above the plain price
  const perShare = (assets: number, units?: Numeric) => {
    const shares = units === undefined ? 0 : num(units) / 1e6;
    return shares > 0 ? Math.min((assets + 1) / (shares + 1), assets / shares) : null;
  };
  return {
    cash,
    debt,
    reserves,
    protocolFees,
    lenderAssets,
    seniorAssets,
    juniorAssets,
    utilization,
    borrowRateBps,
    seniorShareValue: perShare(seniorAssets, supply.senior),
    juniorShareValue: perShare(juniorAssets, supply.junior),
    yieldBuffer,
    // The premium juniors earn on senior yield right now, after scaling below the target share
    juniorPremium: premiumRate * filled,
    // Shares of the lenders' interest each tranche gets
    seniorShare: weights > 0 ? seniorAssets / weights : 1,
    juniorShare: weights > 0 ? juniorWeight / weights : 0,
    seniorApyBps,
    juniorApyBps,
  };
}

type JuniorExitParams = {
  juniorMinDelaySecs: number;
  juniorMaxDelaySecs: number;
  juniorDelayThresholdBps: number;
  juniorExitWindowSecs: number;
};

// Seconds a junior exit queued now would wait, with `queued` junior shares already in the queue
export function juniorExitDelay(params: JuniorExitParams, queued: Numeric, shares: Numeric, supply: Numeric) {
  const { juniorMinDelaySecs: min, juniorMaxDelaySecs: max, juniorDelayThresholdBps: threshold } = params;
  const total = num(supply);
  // Rounded up like the program, so even the smallest exit moves the wait
  const share = total > 0 ? Math.min(Math.ceil(((num(queued) + num(shares)) * BPS) / total), threshold) : threshold;
  return min + Math.ceil(((max - min) * share) / threshold);
}

// When something set to take effect at `at` really does, mirroring `Pool::effective_at`:
// a pause of junior exits that began by then moves it to a full activation delay after the pause ends
export function effectiveAt(
  pool: { params: { activationDelaySecs: number }; juniorPauseStart: Numeric; juniorPauseEnd: Numeric },
  at: Numeric,
) {
  const [start, end, when] = [num(pool.juniorPauseStart), num(pool.juniorPauseEnd), num(at)];
  return end > start && start <= when ? Math.max(when, end + pool.params.activationDelaySecs) : when;
}

// Unix seconds by which a queued exit must be claimed, mirroring `Pool::junior_exit_deadline`
export function juniorExitDeadline(
  pool: { params: JuniorExitParams; juniorPauseStart: Numeric; juniorPauseEnd: Numeric },
  exit: { unlockAt: Numeric; windowSecs: number },
) {
  const unlock = num(exit.unlockAt);
  const window = Math.max(exit.windowSecs, pool.params.juniorExitWindowSecs);
  const [start, end] = [num(pool.juniorPauseStart), num(pool.juniorPauseEnd)];
  return end > unlock && start < unlock + window ? end + window : unlock + window;
}
