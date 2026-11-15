"use client";

import { motion, useInView } from "motion/react";
import { useRef, useState, type PointerEvent } from "react";
import { series, smoothPath, type Point } from "@/lib/chart";
import { Swatch } from "@/components/ui";
import { EASE } from "@/components/motion";

export const RANGES = ["7D", "30D", "90D", "1Y"] as const;
export type Range = (typeof RANGES)[number];
export const SERIES = ["Value", "Credit", "Debt"] as const;
export type SeriesKey = (typeof SERIES)[number];

const W = 754;
const H = 372;
const PAD = { top: 10, right: 52, bottom: 26, left: 8 };
const Y_MAX = 60000;
const Y_TICKS = [0, 15000, 30000, 45000, 60000];
const END = Date.UTC(2026, 10, 14);
const DAY = 86_400_000;

/* 365 days of history; the last 90 are the exact series from the approved mockup. */
const coll90 = series(90, 39800, 48230, 900, 7);
const collYear = [...series(276, 30200, coll90[0], 1100, 13).slice(0, -1), ...coll90];
const debtAt = (daysAgo: number) =>
  (daysAgo > 71 ? (daysAgo > 200 ? 6200 : 9800) : daysAgo > 48 ? 11300 : daysAgo > 26 ? 12800 : daysAgo > 9 ? 13200 : 14500) - ((((89 - daysAgo) % 7) + 7) % 7) * 18;
const YEAR = collYear.map((c, i) => {
  const daysAgo = collYear.length - 1 - i;
  const ratio = daysAgo < 90 ? 0.62 + 0.029 * ((89 - daysAgo) / 89) : 0.6 + 0.02 * (i / 275);
  return { t: END - daysAgo * DAY, collateral: c, limit: c * ratio, debt: debtAt(daysAgo) };
});

const LINES = [
  { key: "Value", label: "Collateral", field: "collateral", color: "#9e8cff", fill: 0.28, width: 2 },
  { key: "Credit", label: "Credit limit", field: "limit", color: "#ededef", fill: 0, width: 1.5, dash: "4 4" },
  { key: "Debt", label: "Debt", field: "debt", color: "#ffa24c", fill: 0.1, width: 1.75 },
] as const;

const DAYS: Record<Range, number> = { "7D": 7, "30D": 30, "90D": 90, "1Y": 365 };
const MOCK_90D_LABELS = ["Aug 16", "Sep 1", "Sep 15", "Oct 1", "Oct 15", "Nov 1", "Nov 14"];
const fmtDate = (t: number, year = false) =>
  new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(year && { year: "numeric" }), timeZone: "UTC" });
const usd = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;

const iw = W - PAD.left - PAD.right;
const ih = H - PAD.top - PAD.bottom;
const y = (v: number) => PAD.top + ih - (v / Y_MAX) * ih;

/** `focus` dims the other series; null shows all three at full strength. */
export function PortfolioChart({ range, focus }: { range: Range; focus: SeriesKey | null }) {
  const data = YEAR.slice(-DAYS[range]);
  const n = data.length;
  const x = (i: number) => PAD.left + (i / (n - 1)) * iw;
  const restIndex = Math.round((n - 1) * (71 / 89));
  const [hover, setHover] = useState<number | null>(null);
  const idx = Math.min(hover ?? restIndex, n - 1);
  const cx = x(idx);

  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.4 });

  const labels =
    range === "90D" ? MOCK_90D_LABELS : Array.from({ length: 7 }, (_, k) => fmtDate(data[Math.round((k / 6) * (n - 1))].t));

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const vx = ((e.clientX - r.left) / r.width) * W;
    setHover(Math.max(0, Math.min(n - 1, Math.round(((vx - PAD.left) / iw) * (n - 1)))));
  };

  const spring = { type: "spring", stiffness: 520, damping: 42 } as const;

  return (
    <div ref={ref} className="relative mt-2 h-[372px]">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        className="cursor-crosshair touch-none text-[11px] [&_text]:fill-t3"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label={`Collateral, credit limit and debt over the last ${range}`}
      >
        <defs>
          {LINES.map((l) => (
            <linearGradient key={l.key} id={`pf-${l.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={l.color} stopOpacity={l.fill} />
              <stop offset="1" stopColor={l.color} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        {Y_TICKS.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={PAD.left + iw} y1={y(v)} y2={y(v)} stroke="rgba(255,255,255,0.05)" />
            <text x={W - 4} y={y(v) + 4} textAnchor="end">
              {v === 0 ? "$0" : `$${v / 1000}K`}
            </text>
          </g>
        ))}
        {labels.map((lab, i) => (
          <text key={`${lab}-${i}`} x={PAD.left + (i / (labels.length - 1)) * iw} y={H - 6} textAnchor={i === 0 ? "start" : i === labels.length - 1 ? "end" : "middle"}>
            {lab}
          </text>
        ))}
        {LINES.map((l, k) => {
          const pts: Point[] = data.map((p, i) => [x(i), y(p[l.field])]);
          const d = smoothPath(pts);
          const dim = focus !== null && focus !== l.key;
          return (
            <motion.g key={`${l.key}-${range}`} animate={{ opacity: dim ? 0.35 : 1 }} transition={{ duration: 0.3 }}>
              {l.fill > 0 && (
                <motion.path
                  d={`${d} L${pts[n - 1][0]},${PAD.top + ih} L${pts[0][0]},${PAD.top + ih} Z`}
                  fill={`url(#pf-${l.key})`}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: inView ? 1 : 0 }}
                  transition={{ duration: 0.9, delay: 0.5 + k * 0.1, ease: EASE }}
                />
              )}
              {"dash" in l ? (
                <motion.path
                  d={d}
                  fill="none"
                  stroke={l.color}
                  strokeWidth={l.width}
                  strokeDasharray={l.dash}
                  strokeLinecap="round"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: inView ? 1 : 0 }}
                  transition={{ duration: 0.9, delay: 0.6, ease: EASE }}
                />
              ) : (
                <motion.path
                  d={d}
                  fill="none"
                  stroke={l.color}
                  strokeWidth={l.width}
                  strokeLinecap="round"
                  initial={{ pathLength: 0 }}
                  animate={{ pathLength: inView ? 1 : 0 }}
                  transition={{ duration: 1.4, delay: k * 0.12, ease: EASE }}
                />
              )}
            </motion.g>
          );
        })}
        <motion.g initial={{ opacity: 0 }} animate={{ opacity: inView ? 1 : 0 }} transition={{ duration: 0.4, delay: 1.2 }}>
          <motion.line y1={PAD.top} y2={PAD.top + ih} stroke="rgba(255,255,255,0.18)" strokeDasharray="3 3" initial={false} animate={{ x1: cx, x2: cx }} transition={spring} />
          {LINES.map((l) => {
            const cy = y(data[idx][l.field]);
            return (
              <g key={l.key}>
                <motion.circle r={7} fill={l.color} fillOpacity={0.18} initial={false} animate={{ cx, cy }} transition={spring} />
                <motion.circle r={3.5} fill={l.color} stroke="#0d0f12" strokeWidth={1.5} initial={false} animate={{ cx, cy }} transition={spring} />
              </g>
            );
          })}
        </motion.g>
      </svg>
      <motion.div
        className="glass-tip pointer-events-none absolute top-[18px] min-w-[170px] rounded-[10px] border border-line-2 px-3 py-2.5 text-xs"
        initial={{ opacity: 0, left: cx - 196 }}
        animate={{ opacity: inView ? 1 : 0, left: cx > 230 ? cx - 196 : cx + 16 }}
        transition={{ left: spring, opacity: { duration: 0.4, delay: 1.2 } }}
      >
        <div className="mb-1.5 text-t3">{fmtDate(data[idx].t, true)}</div>
        {LINES.map((l) => (
          <div key={l.key} className="flex justify-between gap-4 py-0.5">
            <span className="flex items-center gap-1.5 text-t2">
              <Swatch color={l.color} />
              {l.label}
            </span>
            <b className="font-medium">{usd(data[idx][l.field])}</b>
          </div>
        ))}
      </motion.div>
    </div>
  );
}
