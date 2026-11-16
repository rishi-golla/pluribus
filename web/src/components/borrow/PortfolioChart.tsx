"use client";

import { axisTimes, inRange, niceMax, series, timeLabel } from "@/lib/chart";
import { compactUsd } from "@/lib/markets";
import { LineChart, axisDates, dateLabel } from "@/components/charts/LineChart";
import type { Sample } from "@/components/app/providers";

export const RANGES = ["7D", "30D", "90D", "1Y"] as const;
export type Range = (typeof RANGES)[number];
export const SERIES = ["Value", "Credit", "Debt"] as const;
export type SeriesKey = (typeof SERIES)[number];

/* 365 days of history; the last 90 are the exact series from the approved mockup. */
const coll90 = series(90, 39800, 48230, 900, 7);
const collateral = [...series(276, 30200, coll90[0], 1100, 13).slice(0, -1), ...coll90];
const N = collateral.length;
const limit = collateral.map((c, i) => {
  const daysAgo = N - 1 - i;
  return c * (daysAgo < 90 ? 0.62 + 0.029 * ((89 - daysAgo) / 89) : 0.6 + 0.02 * (i / 275));
});
const debt = collateral.map((_, i) => {
  const d = N - 1 - i;
  const step = d > 71 ? (d > 200 ? 6200 : 9800) : d > 48 ? 11300 : d > 26 ? 12800 : d > 9 ? 13200 : 14500;
  return step - ((((89 - d) % 7) + 7) % 7) * 18;
});

const DAYS: Record<Range, number> = { "7D": 7, "30D": 30, "90D": 90, "1Y": 365 };
const MOCK_90D_LABELS = ["Aug 16", "Sep 1", "Sep 15", "Oct 1", "Oct 15", "Nov 1", "Nov 14"];

/** Pass `samples` to chart on-chain readings from this session instead of the demo history */
export function PortfolioChart({ range, focus, samples }: { range: Range; focus: SeriesKey | null; samples?: Sample[] }) {
  const n = DAYS[range];
  const live = samples && inRange(samples, n);
  const data = live
    ? { collateral: live.map((s) => s.collateral), limit: live.map((s) => s.limit), debt: live.map((s) => s.debt) }
    : { collateral: collateral.slice(-n), limit: limit.slice(-n), debt: debt.slice(-n) };
  const yMax = live ? niceMax(Math.max(...data.collateral, ...data.limit, ...data.debt)) : 60000;
  const lines = [
    { key: "Value", label: "Collateral", color: "#9e8cff", data: data.collateral, fill: 0.28, width: 2 },
    { key: "Credit", label: "Credit limit", color: "#ededef", data: data.limit, width: 1.5, dash: "4 4" },
    { key: "Debt", label: "Debt", color: "#ffa24c", data: data.debt, fill: 0.1, width: 1.75 },
  ];
  return (
    <div className="mt-2">
      <LineChart
        width={754}
        height={372}
        lines={lines}
        yMax={yMax}
        yTicks={[0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax)}
        fmtY={live ? compactUsd : (v) => (v === 0 ? "$0" : `$${v / 1000}K`)}
        xLabels={live ? axisTimes(live) : range === "90D" ? MOCK_90D_LABELS : axisDates(n)}
        titleAt={(i) => (live ? timeLabel(live[i].at, true) : dateLabel(n - 1 - i, true))}
        fmtValue={(v) => `$${Math.round(v).toLocaleString("en-US")}`}
        restIndex={live ? live.length - 1 : Math.round((n - 1) * (71 / 89))}
        focus={focus}
        animKey={range}
        straight={!!live}
        ariaLabel={`Collateral, credit limit and debt over the last ${range}`}
      />
    </div>
  );
}
