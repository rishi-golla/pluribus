"use client";

import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { Num } from "@/components/motion";
import { FeeBars } from "./FeeBars";
import { CLUSTER, deployment, getConnection } from "@/lib/cluster";
import { SCENARIO_NAMES, fetchStats } from "@/lib/live";
import { type Asset, type Pool, type PluribusProgram, fetchAsset, fetchLpMarket, fetchPool, fetchPrices, getProgram, math } from "@/lib/pluribus/sdk";

/** The example portfolio the hero draws and the product tour borrows against, in dollars */
export const EXAMPLE_USD = { sol: 3_000, lst: 2_000, lp: 3_000, stock: 1_800, meme: 1_000, usdc: 1_200 } as const;
export type ExampleKey = keyof typeof EXAMPLE_USD;

/** The SOL-USDC ranges the landing compares, each a share either side of today's SOL price, or null for the full range */
export const LP_RANGES = [
  { label: "+/-3% range", width: 0.03 },
  { label: "+/-20% range", width: 0.2 },
  { label: "Full range", width: null },
] as const;
// The widest range an Orca position can have
const MAX_TICK = 443_636;

/** The example portfolio valued with the pool's own crash tables, liquidation costs and prices */
export type Example = {
  /** What each holding still backs for a draw, in the scenario that sets the credit limit */
  credit: Record<ExampleKey, number>;
  creditLimit: number;
  liquidationLimit: number;
  /** How many crash scenarios the pool runs, the one that sets the credit limit, and how far it drops each holding's price for a draw, 0 to 1 */
  scenarios: number;
  scenario: string;
  falls: Record<ExampleKey, number>;
  /** Each tier above the base one: its rate discount, 0 to 1, and the healthy days it takes */
  tiers: { discount: number; days: number }[];
  /** What a dollar of SOL-USDC position backs for a draw in each of `LP_RANGES`, 0 to 1: valued as it holds today, and after the drop that sets its limit */
  ranges: { today: number; crash: number }[];
};

export type PoolFacts = {
  supplied: number;
  drawn: number;
  badDebt: number;
  /** the share of the pool lent out now, in percent */
  utilization: number;
  /** what each tranche pays now, in percent a year: the same figures the Earn page shows */
  apy: { senior: number; junior: number };
  /** Null when an asset or price it needs could not be read, which leaves the yields and stats above standing */
  example: Example | null;
};

async function valueExample(program: PluribusProgram, pool: Pool): Promise<Example> {
  const d = deployment!;
  const key = (k: string) => new PublicKey(k);
  const mintOf = (symbol: string) => {
    const mint = Object.keys(d.assets).find((m) => d.assets[m].symbol === symbol);
    if (!mint) throw new Error(`${symbol} is not in the ${CLUSTER} deployment`);
    return mint;
  };
  const [lstMint, memeMint] = [mintOf("JitoSOL"), mintOf("BONK")];
  const [prices, sol, lst, stock, meme, usdc, market] = await Promise.all([
    fetchPrices(program, d),
    fetchAsset(program, key(d.solMint)),
    fetchAsset(program, key(lstMint)),
    fetchAsset(program, key(d.stockMint)),
    fetchAsset(program, key(memeMint)),
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
    lst: token(lstMint, lst, EXAMPLE_USD.lst),
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
    meme: token(memeMint, meme, EXAMPLE_USD.meme),
    usdc: token(d.usdcMint, usdc, EXAMPLE_USD.usdc),
  };
  const all = Object.values(parts);
  const sums = Array.from({ length: shock.numScenarios }, (_, s) => math.limits(all, { ...shock, only: s }, prices).creditLimit);
  const binding = Math.max(0, sums.indexOf(Math.min(...sums)));
  const worst = { ...shock, only: binding };
  const total = math.limits(all, shock, prices);
  const fall = (asset: Asset) => math.shockFor(shock, true, binding, asset.params.group, math.dynamicShocks(asset, p).init) / 1e4;
  const each = (f: (k: ExampleKey, r: math.RiskPosition) => number) =>
    Object.fromEntries(Object.entries(parts).map(([k, r]) => [k, f(k as ExampleKey, r)])) as Record<ExampleKey, number>;
  // the LP falls with SOL, its base token
  const assets: Record<ExampleKey, Asset> = { sol, lst, lp: sol, stock, meme, usdc };
  // A dollar of position in each range: as it holds today with the draw shocks on each side, and repriced after the drop
  const full = Math.floor(MAX_TICK / d.tickSpacing) * d.tickSpacing;
  const solShock = math.dynamicShocks(sol, p).init;
  const ranges = LP_RANGES.map(({ width }) => {
    const [tickLower, tickUpper] = width === null ? [-full, full] : [tick(solPrice * (1 - width)), tick(solPrice * (1 + width))];
    const liquidity = 1 / math.lpValue(1, tickLower, tickUpper, solPrice);
    const held = math.lpAmounts(liquidity, tickLower, tickUpper, solPrice);
    const keep = (bps: number) => 1 - bps / 1e4;
    const today = Math.min(
      ...Array.from(
        { length: shock.numScenarios },
        (_, s) =>
          (held.sol * solPrice * keep(math.shockFor(shock, true, s, sol.params.group, solShock)) + held.usdc * keep(math.shockFor(shock, true, s, pool.usdcGroup))) *
          keep(market.liqCostBps),
      ),
    );
    return { today, crash: math.limits([{ ...parts.lp, liquidity, tickLower, tickUpper }], shock, prices).creditLimit };
  });
  return {
    credit: each((_, r) => math.limits([r], worst, prices).creditLimit),
    creditLimit: total.creditLimit,
    liquidationLimit: total.liquidationLimit,
    scenarios: shock.numScenarios,
    scenario: SCENARIO_NAMES[binding] ?? `Scenario ${binding + 1}`,
    falls: each((k) => fall(assets[k])),
    tiers: p.tierDiscountBps.slice(1).map((bps, i) => ({ discount: bps / 1e4, days: Math.round(p.tierMinHealthySecs[i + 1].toNumber() / 86_400) })),
    ranges,
  };
}

async function load(): Promise<PoolFacts> {
  const program = getProgram(getConnection());
  const pool = await fetchPool(program);
  // the rates the pool pays now, worked out the way the Earn page does, so the landing never quotes a figure the app does not show
  const now = math.poolStats(pool);
  return {
    supplied: now.lenderAssets,
    drawn: now.debt,
    badDebt: Number(pool.badDebt.toString()) / 1e6,
    utilization: now.utilization * 100,
    apy: { senior: now.seniorApyBps / 100, junior: now.juniorApyBps / 100 },
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
          <span className="font-mono text-[30px] leading-none tracking-[-0.025em] text-brand">—</span>
        ) : (
          <Num value={total} decimals={2} prefix="$" countUp className="font-mono text-[30px] leading-none tracking-[-0.025em] text-brand" />
        )}
        <span className="font-mono text-[12px] text-t3">repaid on {CLUSTER}, 30D</span>
      </div>
      <div className="mt-4">
        <FeeBars days={days ?? null} />
      </div>
      <div className="mt-3 font-mono text-[11.5px] text-t3">{days === null ? "History unavailable right now" : "\u00a0"}</div>
    </>
  );
}

export function ExampleApy({ tranche, className }: { tranche: "senior" | "junior"; className?: string }) {
  const facts = usePoolFacts();
  if (!facts) return <span className={className}>—</span>;
  return <Num value={facts.apy[tranche]} decimals={2} suffix="%" countUp className={className} />;
}

/** The hero's lending line: what the junior tranche pays now, the same figure the Earn page shows */
export function EarnUpTo({ className }: { className?: string }) {
  const facts = usePoolFacts();
  // no yield is claimed when the pool could not be read, or while it pays next to nothing
  if (facts === null || (facts && facts.apy.junior < 0.05)) return null;
  return (
    <p className={className}>
      {facts ? (
        <>
          Earn up to{" "}
          {/* the figure is the point of the line, so it is the one thing in the hero's text that takes the accent */}
          <span className="mx-0.5 text-[1.9em] leading-none tracking-[-0.03em] text-brand">{facts.apy.junior.toFixed(2)}%</span> APY lending USDC.
        </>
      ) : (
        "\u00a0"
      )}
    </p>
  );
}

/** Says where the yields come from: the pool's rates now, which move with how much of it is lent out */
export function ExampleNote({ className }: { className?: string }) {
  const facts = usePoolFacts();
  if (facts === undefined) return <div className={className}>&nbsp;</div>;
  return <div className={className}>{facts ? `Live rates, with ${facts.utilization.toFixed(1)}% of the pool lent out` : `Could not read the ${CLUSTER} pool`}</div>;
}

const compact = (v: number) =>
  v >= 1e6 ? { value: v / 1e6, decimals: 1, suffix: "M" } : v >= 1e3 ? { value: v / 1e3, decimals: 1, suffix: "K" } : { value: v, decimals: 0, suffix: "" };

/** The stats strip, read from the pool this build points at */
export function PoolStats() {
  const facts = usePoolFacts();
  // every token the deployment lists, its Orca pool and each other LP market, such as the Raydium and Meteora pairs
  const collateralTypes = deployment ? Object.keys(deployment.assets).length + 1 + (deployment.lpMarkets?.length ?? 0) : undefined;
  const cells: { label: string; usd?: number; count?: number }[] = [
    { label: "Supplied by lenders", usd: facts?.supplied },
    { label: "Currently borrowed", usd: facts?.drawn },
    { label: "Assets accepted", count: collateralTypes },
    { label: "Unpaid losses", usd: facts?.badDebt },
  ];
  return cells.map((c, i) => (
    <div key={c.label} className={i === 0 ? "py-7" : "border-l border-line py-7 pl-7"}>
      <div className="text-[11.5px] uppercase tracking-[0.04em] text-t3">{c.label}</div>
      <div className="mt-2 text-[38px] font-medium tracking-[-0.025em]">
        {c.count !== undefined ? <Num value={c.count} countUp /> : c.usd === undefined ? "—" : <Num {...compact(c.usd)} prefix="$" countUp />}
      </div>
    </div>
  ));
}
