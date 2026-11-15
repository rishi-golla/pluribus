"use client";

import { motion, useInView } from "motion/react";
import { useId, useRef, useState, type PointerEvent, type ReactNode } from "react";
import { smoothPath, type Point } from "@/lib/chart";
import { Swatch } from "@/components/ui";
import { EASE } from "@/components/motion";

export type ChartLine = { key: string; label: string; color: string; data: number[]; fill?: number; width?: number; dash?: string };
export type Scale = { x: (i: number) => number; y: (v: number) => number; innerWidth: number; innerHeight: number; pad: Pad };
type Pad = { top: number; right: number; bottom: number; left: number };

type Props = {
  width: number;
  height: number;
  pad?: Pad;
  lines: ChartLine[];
  yMin?: number;
  yMax: number;
  yTicks: number[];
  fmtY: (v: number) => string;
  xLabels: string[];
  /** Tooltip heading for a data index. */
  titleAt: (i: number) => string;
  fmtValue: (v: number) => string;
  /** Index shown when the pointer is not over the chart. */
  restIndex?: number;
  /** Dims every series except this one. */
  focus?: string | null;
  /** Changing this redraws the lines from scratch (e.g. on range change). */
  animKey?: string;
  ariaLabel: string;
  overlay?: (s: Scale) => ReactNode;
};

const SPRING = { type: "spring", stiffness: 520, damping: 42 } as const;

export function LineChart({
  width: W,
  height: H,
  pad = { top: 10, right: 52, bottom: 26, left: 8 },
  lines,
  yMin = 0,
  yMax,
  yTicks,
  fmtY,
  xLabels,
  titleAt,
  fmtValue,
  restIndex,
  focus = null,
  animKey = "",
  ariaLabel,
  overlay,
}: Props) {
  const n = lines[0].data.length;
  const iw = W - pad.left - pad.right;
  const ih = H - pad.top - pad.bottom;
  const x = (i: number) => pad.left + (i / (n - 1)) * iw;
  const y = (v: number) => pad.top + ih - ((v - yMin) / (yMax - yMin)) * ih;

  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [hover, setHover] = useState<number | null>(null);
  const idx = Math.min(hover ?? restIndex ?? n - 1, n - 1);
  const cx = x(idx);
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.4 });

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const vx = ((e.clientX - r.left) / r.width) * W;
    setHover(Math.max(0, Math.min(n - 1, Math.round(((vx - pad.left) / iw) * (n - 1)))));
  };

  return (
    <div ref={ref} className="relative" style={{ height: H }}>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        className="cursor-crosshair touch-none text-[11px] [&_text]:fill-t3"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label={ariaLabel}
      >
        <defs>
          {lines.map((l) => (
            <linearGradient key={l.key} id={`lc-${uid}-${l.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={l.color} stopOpacity={l.fill ?? 0} />
              <stop offset="1" stopColor={l.color} stopOpacity={0} />
            </linearGradient>
          ))}
        </defs>
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={pad.left} x2={pad.left + iw} y1={y(v)} y2={y(v)} stroke="rgba(255,255,255,0.05)" />
            <text x={W - 4} y={y(v) + 4} textAnchor="end">
              {fmtY(v)}
            </text>
          </g>
        ))}
        {xLabels.map((lab, i) => (
          <text key={`${lab}-${i}`} x={pad.left + (i / (xLabels.length - 1)) * iw} y={H - 6} textAnchor={i === 0 ? "start" : i === xLabels.length - 1 ? "end" : "middle"}>
            {lab}
          </text>
        ))}
        {overlay?.({ x, y, innerWidth: iw, innerHeight: ih, pad })}
        {lines.map((l, k) => {
          const pts: Point[] = l.data.map((v, i) => [x(i), y(v)]);
          const d = smoothPath(pts);
          const dim = focus !== null && focus !== l.key;
          return (
            <motion.g key={`${l.key}-${animKey}`} animate={{ opacity: dim ? 0.35 : 1 }} transition={{ duration: 0.3 }}>
              {!!l.fill && (
                <motion.path
                  d={`${d} L${pts[n - 1][0]},${pad.top + ih} L${pts[0][0]},${pad.top + ih} Z`}
                  fill={`url(#lc-${uid}-${l.key})`}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: inView ? 1 : 0 }}
                  transition={{ duration: 0.9, delay: 0.5 + k * 0.1, ease: EASE }}
                />
              )}
              {l.dash ? (
                <motion.path
                  d={d}
                  fill="none"
                  stroke={l.color}
                  strokeWidth={l.width ?? 2}
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
                  strokeWidth={l.width ?? 2}
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
          <motion.line y1={pad.top} y2={pad.top + ih} stroke="rgba(255,255,255,0.18)" strokeDasharray="3 3" initial={false} animate={{ x1: cx, x2: cx }} transition={SPRING} />
          {lines.map((l) => {
            const cy = y(l.data[idx]);
            return (
              <g key={l.key}>
                <motion.circle r={7} fill={l.color} fillOpacity={0.18} initial={false} animate={{ cx, cy }} transition={SPRING} />
                <motion.circle r={3.5} fill={l.color} stroke="#0d0f12" strokeWidth={1.5} initial={false} animate={{ cx, cy }} transition={SPRING} />
              </g>
            );
          })}
        </motion.g>
      </svg>
      <motion.div
        className="glass-tip pointer-events-none absolute top-[18px] min-w-[170px] rounded-[10px] border border-line-2 px-3 py-2.5 text-xs"
        initial={{ opacity: 0, left: cx > 230 ? cx - 196 : cx + 16 }}
        animate={{ opacity: inView ? 1 : 0, left: cx > 230 ? cx - 196 : cx + 16 }}
        transition={{ left: SPRING, opacity: { duration: 0.4, delay: 1.2 } }}
      >
        <div className="mb-1.5 text-t3">{titleAt(idx)}</div>
        {lines.map((l) => (
          <div key={l.key} className="flex justify-between gap-4 py-0.5">
            <span className="flex items-center gap-1.5 text-t2">
              <Swatch color={l.color} />
              {l.label}
            </span>
            <b className="font-medium">{fmtValue(l.data[idx])}</b>
          </div>
        ))}
      </motion.div>
    </div>
  );
}

const DAY = 86_400_000;
const END = Date.UTC(2026, 10, 14);
/** UTC formatting so server and client render the same string. */
export const dateLabel = (daysAgo: number, year = false) =>
  new Date(END - daysAgo * DAY).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(year && { year: "numeric" }), timeZone: "UTC" });
export const axisDates = (n: number) => Array.from({ length: 7 }, (_, k) => dateLabel(n - 1 - Math.round((k / 6) * (n - 1))));
