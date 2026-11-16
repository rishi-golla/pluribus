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
  params: {
    baseRateBps: number;
    slope1Bps: number;
    slope2Bps: number;
    kinkBps: number;
    reserveFactorBps: number;
    protocolFeeBps: number;
    protectionFeeBps: number;
  };
};

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
  const lenderAssets = Math.max(cash + debt - reserves - protocolFees, 0);
  const juniorAssets = Math.min(num(pool.juniorAssets) / 1e6, lenderAssets);
  const seniorAssets = lenderAssets - juniorAssets;
  // What borrowers pay, spread over everything lent, after the reserve and protocol cuts
  const lenderYield = borrowRateBps * utilization * (1 - (p.reserveFactorBps + p.protocolFeeBps) / BPS);
  // Senior lenders pay the protection fee only while there are junior lenders to pay it to
  const fee = juniorAssets > 0 ? p.protectionFeeBps / BPS : 0;
  const perShare = (assets: number, units?: Numeric) =>
    units !== undefined && num(units) > 0 ? assets / (num(units) / 1e6) : null;
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
    seniorApyBps: lenderYield * (1 - fee),
    // Not defined for an empty tranche, where the first dollar would collect the whole fee
    juniorApyBps: juniorAssets > 0 ? lenderYield * (1 + (fee * seniorAssets) / juniorAssets) : null,
  };
}
