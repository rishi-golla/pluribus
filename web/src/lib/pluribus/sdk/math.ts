// Float versions of the program's valuation rules, for previews only
// The on-chain `health` view stays the source of truth

export type Numeric = number | bigint | string | { toString(): string };

export type RiskPosition = {
  // The mint whose price applies: the token itself, or the base token of an LP position
  mint: string;
  group: number;
  liqCostBps: number;
  paused?: boolean;
} & (
  | { amount: number }
  // `usdcGroup` is the pool's `usdcGroup`: the USDC side of an LP position takes that group's shock
  | { liquidity: Numeric; tickLower: number; tickUpper: number; usdcGroup: number }
);

export type ShockParams = { numScenarios: number; initShockBps: number[]; maintShockBps: number[] };

const BPS = 10_000;
const MAX_GROUPS = 4;
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
    const { sol, usdc } = lpAmounts(p.liquidity, p.tickLower, p.tickUpper, at);
    return sol * at + usdc * usdcKept;
  };
  const worst = (table: number[], init: boolean) => {
    // Groups past the table are never shocked
    const kept = (s: number, group: number) => 1 - (group < MAX_GROUPS ? table[s * MAX_GROUPS + group] : 0) / BPS;
    const sums = Array.from({ length: params.numScenarios }, (_, s) =>
      positions.reduce((sum, p) => {
        // Paused collateral stops backing new debt but still counts against liquidation
        if (init && p.paused) return sum;
        const usdcKept = "amount" in p ? 1 : kept(s, p.usdcGroup);
        return sum + value(p, price(p) * kept(s, p.group), usdcKept) * (1 - p.liqCostBps / BPS);
      }, 0),
    );
    return sums.length ? Math.min(...sums) : 0;
  };
  const values = positions.map((p) => value(p, price(p)));
  return {
    values,
    collateralValue: values.reduce((a, b) => a + b, 0),
    creditLimit: worst(params.initShockBps, true),
    liquidationLimit: worst(params.maintShockBps, false),
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
  epochSeniorBudget: Numeric;
  epochJuniorBudget: Numeric;
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
  // With weekly epochs the rate is the epoch's fixed budget over the tranche's size now, otherwise today's interest as it accrues
  const weekly = p.epochSecs > 0 && num(pool.epochEnd) > num(pool.epochStart);
  const perYear = SECONDS_PER_YEAR / Math.max(num(pool.epochEnd) - num(pool.epochStart), 1);
  const seniorYear = weekly ? (num(pool.epochSeniorBudget) / 1e6) * perYear : weights > 0 ? (toLenders * seniorAssets) / weights : toLenders;
  const juniorYear = weekly ? (num(pool.epochJuniorBudget) / 1e6) * perYear : weights > 0 ? (toLenders * juniorWeight) / weights : 0;
  // An empty tranche shows what its first dollar would earn: the senior rate, and for juniors the premium per unit of target on top
  const seniorRate = seniorAssets > 0 ? seniorYear / seniorAssets : lenderAssets > 0 ? toLenders / lenderAssets : 0;
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
