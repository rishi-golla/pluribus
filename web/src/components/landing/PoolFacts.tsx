"use client";

import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { Num } from "@/components/motion";
import { FeeBars } from "./FeeBars";
import { CLUSTER, deployment, getConnection } from "@/lib/cluster";
import { SCENARIO_NAMES, fetchStats } from "@/lib/live";
import { type Asset, type Pool, type PluribusProgram, fetchAsset, fetchLpMarket, fetchPool, fetchPrices, getProgram, math } from "@/lib/pluribus/sdk";

/** The example portfolio How it works draws and the product tour borrows against, in dollars */
export const EXAMPLE_USD = { sol: 3_750, lp: 3_750, stock: 3_000, usdc: 1_500 } as const;
export type ExampleKey = keyof typeof EXAMPLE_USD;

/** The example portfolio valued with the pool's own crash tables, liquidation costs and prices */
export type Example = {
  /** What each part still backs in the scenario that sets the credit limit */
  survived: Record<ExampleKey, number>;
  creditLimit: number;
  liquidationLimit: number;
  /** How many crash scenarios the pool runs, the one that sets the credit limit, and how far it drops SOL and stocks for a draw, 0 to 1 */
  scenarios: number;
  scenario: string;
  falls: { sol: number; stock: number };
  /** Each tier above the base one: its rate discount, 0 to 1, and the healthy days it takes */
  tiers: { discount: number; days: number }[];
};

export type PoolFacts = {
  supplied: number;
  drawn: number;
  badDebt: number;
  /** the utilization the example yields are worked out at, in percent */
  kink: number;
  apy: { senior: number; junior: number };
  /** Null when an asset or price it needs could not be read, which leaves the yields and stats above standing */
  example: Example | null;
};

async function valueExample(program: PluribusProgram, pool: Pool): Promise<Example> {
  const d = deployment!;
  const key = (k: string) => new PublicKey(k);
  const [prices, sol, stock, usdc, market] = await Promise.all([
    fetchPrices(program, d),
    fetchAsset(program, key(d.solMint)),
    fetchAsset(program, key(d.stockMint)),
    fetchAsset(program, key(d.usdcMint)),
    fetchLpMarket(program, key(d.whirlpool)),
  ]);
  const p = pool.params;
  const shock: math.ShockParams = { numScenarios: p.numScenarios, initShockBps: p.initShockBps, maintShockBps: p.maintShockBps, maxShockBps: p.maxShockBps };
  const token = (mint: string, asset: Asset, usd: number): math.RiskPosition => ({
    mint,
    group: asset.params.group,
    liqCostBps: asset.params.liqCostBps,
    shockBps: math.dynamicShocks(asset, p),
    amount: usd / prices[mint],
  });
  // An Orca position 20% either side of today's SOL price, on the pool's tick spacing
  const solPrice = prices[d.solMint];
  const tick = (price: number) => Math.round(math.priceToTick(price) / d.tickSpacing) * d.tickSpacing;
  const [lower, upper] = [tick(solPrice * 0.8), tick(solPrice * 1.2)];
  const parts: Record<ExampleKey, math.RiskPosition> = {
    sol: token(d.solMint, sol, EXAMPLE_USD.sol),
    lp: {
      mint: d.solMint,
      group: sol.params.group,
      liqCostBps: market.liqCostBps,
      shockBps: math.dynamicShocks(sol, p),
      // value is linear in liquidity
      liquidity: EXAMPLE_USD.lp / math.lpValue(1, lower, upper, solPrice),
      tickLower: lower,
      tickUpper: upper,
      usdcGroup: pool.usdcGroup,
    },
    stock: token(d.stockMint, stock, EXAMPLE_USD.stock),
    usdc: token(d.usdcMint, usdc, EXAMPLE_USD.usdc),
  };
  const all = Object.values(parts);
  const sums = Array.from({ length: shock.numScenarios }, (_, s) => math.limits(all, { ...shock, only: s }, prices).creditLimit);
  const binding = Math.max(0, sums.indexOf(Math.min(...sums)));
  const worst = { ...shock, only: binding };
  const total = math.limits(all, shock, prices);
  const fall = (asset: Asset) => math.shockFor(shock, true, binding, asset.params.group, math.dynamicShocks(asset, p).init) / 1e4;
  return {
    survived: Object.fromEntries(Object.entries(parts).map(([k, r]) => [k, math.limits([r], worst, prices).creditLimit])) as Record<ExampleKey, number>,
    creditLimit: total.creditLimit,
    liquidationLimit: total.liquidationLimit,
    scenarios: shock.numScenarios,
    scenario: SCENARIO_NAMES[binding] ?? `Scenario ${binding + 1}`,
    falls: { sol: fall(sol), stock: fall(stock) },
    tiers: p.tierDiscountBps.slice(1).map((bps, i) => ({ discount: bps / 1e4, days: Math.round(p.tierMinHealthySecs[i + 1].toNumber() / 86_400) })),
  };
}

async function load(): Promise<PoolFacts> {
  const program = getProgram(getConnection());
  const pool = await fetchPool(program);
  const now = math.poolStats(pool);
  const p = pool.params;
  const [kink, target] = [p.kinkBps / 1e4, p.juniorTargetBps / 1e4];
  const size = 1e12;
  // the pool's own rate curve and split, at its kink with juniors at their target share:
  // a pool nobody has borrowed from yet pays nothing, which says nothing about the design
  const example = math.poolStats({
    cash: (1 - kink) * size,
    debtShares: [kink * size],
    borrowIndex: [1e18],
    juniorAssets: target * size,
    reserves: 0,
    protocolFees: 0,
    yieldBuffer: 0,
    epochStart: 0,
    epochEnd: 0,
    epochBudget: 0,
    epochPaid: 0,
    lastAccrual: 0,
    // epochs only decide when interest reaches lenders, not how much
    params: { ...p, epochSecs: 0 },
  });
  return {
    supplied: now.lenderAssets,
    drawn: now.debt,
    badDebt: Number(pool.badDebt.toString()) / 1e6,
    kink: kink * 100,
    apy: { senior: example.seniorApyBps / 100, junior: example.juniorApyBps / 100 },
    example: await valueExample(program, pool).catch(() => null),
  };
}

// one read for the whole page
let cached: Promise<PoolFacts> | undefined;

/** Undefined while the pool is being read, null when it could not be: the page then shows a dash, never a made-up figure */
export function usePoolFacts() {
  const [facts, setFacts] = useState<PoolFacts | null | undefined>(deployment ? undefined : null);
  useEffect(() => {
    if (!deployment) return;
    let on = true;
    (cached ??= load()).then(
      (f) => on && setFacts(f),
      () => {
        cached = undefined;
        if (on) setFacts(null);
      },
    );
    return () => {
      on = false;
    };
  }, []);
  return facts;
}

/** USDC repaid by autopay on each of the last 30 days, oldest first, from the indexer */
export type AutopayDays = number[];
let autopayCached: Promise<AutopayDays | null> | undefined;

/** Undefined while loading, null when no indexer is configured or it did not answer */
export function useAutopayDays() {
  const [days, setDays] = useState<AutopayDays | null | undefined>(undefined);
  useEffect(() => {
    let on = true;
    // fetchStats returns nothing at all when NEXT_PUBLIC_INDEXER_URL is unset
    (autopayCached ??= fetchStats().then((s) => (s.length ? s.slice(-30).map((d) => d.autopay) : null), () => null)).then((d) => on && setDays(d));
    return () => {
      on = false;
    };
  }, []);
  return days;
}

/** USDC repaid by autopay across the protocol over the last 30 days, with a bar per day */
export function AutopayRepaid() {
  const days = useAutopayDays();
  const total = days?.reduce((s, v) => s + v, 0);
  return (
    <>
      <div className="flex items-baseline justify-between">
        {total === undefined ? (
          <span className="font-mono text-[30px] leading-none tracking-[-0.04em] text-brand">—</span>
        ) : (
          <Num value={total} decimals={2} prefix="$" countUp className="font-mono text-[30px] leading-none tracking-[-0.04em] text-brand" />
        )}
        <span className="font-mono text-[12px] text-t3">repaid on {CLUSTER}, 30D</span>
      </div>
      <div className="mt-4">
        <FeeBars days={days ?? null} />
      </div>
      <div className="mt-3 font-mono text-[11.5px] text-t3">{days === null ? "Shown once an indexer is connected" : "\u00a0"}</div>
    </>
  );
}

export function ExampleApy({ tranche, className }: { tranche: "senior" | "junior"; className?: string }) {
  const facts = usePoolFacts();
  if (!facts) return <span className={className}>—</span>;
  return <Num value={facts.apy[tranche]} decimals={2} suffix="%" countUp className={className} />;
}

/** Says where the example yields come from, so they are not read as a quote */
export function ExampleNote({ className }: { className?: string }) {
  const facts = usePoolFacts();
  if (facts === undefined) return <div className={className}>&nbsp;</div>;
  return <div className={className}>{facts ? `Example at ${facts.kink}% utilization, from the on-chain rate curve` : `Could not read the ${CLUSTER} pool`}</div>;
}

const compact = (v: number) =>
  v >= 1e6 ? { value: v / 1e6, decimals: 1, suffix: "M" } : v >= 1e3 ? { value: v / 1e3, decimals: 1, suffix: "K" } : { value: v, decimals: 0, suffix: "" };

/** The stats strip, read from the pool this build points at */
export function PoolStats() {
  const facts = usePoolFacts();
  const cells: { label: string; usd?: number; count?: number }[] = [
    { label: `Total supplied on ${CLUSTER}`, usd: facts?.supplied },
    { label: `Credit drawn on ${CLUSTER}`, usd: facts?.drawn },
    { label: "Collateral types", count: 4 },
    { label: `Bad debt on ${CLUSTER}`, usd: facts?.badDebt },
  ];
  return cells.map((c, i) => (
    <div key={c.label} className={i === 0 ? "py-7" : "border-l border-line py-7 pl-7"}>
      <div className="text-[12.5px] text-t3">{c.label}</div>
      <div className="mt-2 text-[40px] font-medium tracking-[-0.045em]">
        {c.count !== undefined ? <Num value={c.count} countUp /> : c.usd === undefined ? "—" : <Num {...compact(c.usd)} prefix="$" countUp />}
      </div>
    </div>
  ));
}
