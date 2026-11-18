"use client";

import { useEffect, useState } from "react";
import { Num } from "@/components/motion";
import { CLUSTER, deployment, getConnection } from "@/lib/cluster";
import { fetchPool, getProgram, math } from "@/lib/pluribus/sdk";

export type PoolFacts = {
  supplied: number;
  drawn: number;
  badDebt: number;
  /** the utilization the example yields are worked out at, in percent */
  kink: number;
  apy: { senior: number; junior: number };
};

async function load(): Promise<PoolFacts> {
  const pool = await fetchPool(getProgram(getConnection()));
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
