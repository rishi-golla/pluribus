"use client";

import { motion } from "motion/react";
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Chip, Label, Swatch, Token } from "@/components/ui";
import { EASE, Num } from "@/components/motion";
import { Segmented } from "@/components/Segmented";
import { LineChart, axisDates, dateLabel } from "@/components/charts/LineChart";
import { CLASS_COLORS, FEES, MARKETS, POOL, TOTALS, VOLUME, compactUsd, fees30d, powerUsed, type AssetClass, type Market } from "@/lib/markets";

const RANGES = ["7D", "30D", "90D"] as const;
type Range = (typeof RANGES)[number];
const DAYS: Record<Range, number> = { "7D": 7, "30D": 30, "90D": 90 };
const CLASSES: AssetClass[] = ["SOL", "LSTs", "LP positions", "Stocks", "Memes"];
const pct = (v: number, d = 1) => `${(v * 100).toFixed(d)}%`;

function KpiStrip() {
  const kpis = [
    { label: "Total supplied", value: POOL.supplied, sub: "$9.0M senior, $1.0M junior" },
    { label: "Total borrowed", value: TOTALS.borrowed, sub: `${pct(TOTALS.borrowed / POOL.supplied)} utilization` },
    { label: "Collateral locked", value: TOTALS.collateral, sub: `${MARKETS.length} markets, 5 asset classes` },
    { label: "Fees, 30D", value: TOTALS.fees, sub: `${pct(TOTALS.avgApr)} average borrow APR` },
    { label: "Volume, 24H", value: TOTALS.volume, sub: "Draws, repays and autopay" },
    { label: "Bad debt", value: 0, sub: `${compactUsd(POOL.insurance)} insurance fund` },
  ];
  return (
    <section className="panel grid grid-cols-6">
      {kpis.map((k, i) => (
        <div key={k.label} className={`px-[22px] py-5 ${i ? "border-l border-line" : ""}`}>
          <Label>{k.label}</Label>
          <div className="mt-2 text-[26px] font-medium leading-none tracking-[-0.035em]">
            <Num value={k.value >= 1e6 ? k.value / 1e6 : k.value / 1e3} decimals={k.value === 0 ? 0 : k.value >= 1e6 ? 2 : 1} prefix="$" suffix={k.value === 0 ? "" : k.value >= 1e6 ? "M" : "K"} countUp />
          </div>
          <div className="mt-2 text-[12.5px] text-t3">{k.sub}</div>
        </div>
      ))}
    </section>
  );
}

const VOL_W = 546;
const VOL_H = 240;
const VOL_KEYS = [
  { key: "draws", label: "Draws", color: "#9e8cff" },
  { key: "repays", label: "Repayments", color: "#3ddc97" },
  { key: "autopay", label: "Autopay", color: "#6aa8ff" },
] as const;

function VolumePanel() {
  const [range, setRange] = useState<Range>("30D");
  const [hover, setHover] = useState<number | null>(null);
  const data = VOLUME.slice(-DAYS[range]);
  const n = data.length;
  const total = (d: (typeof data)[number]) => d.draws + d.repays + d.autopay;
  const yMax = Math.ceil(Math.max(...VOLUME.map(total)) / 250_000) * 250_000;
  const pad = { top: 10, right: 48, bottom: 26, left: 4 };
  const iw = VOL_W - pad.left - pad.right;
  const ih = VOL_H - pad.top - pad.bottom;
  const gap = n > 60 ? 1 : n > 20 ? 3 : 8;
  const bw = (iw - gap * (n - 1)) / n;
  const y = (v: number) => (v / yMax) * ih;
  const idx = hover ?? n - 1;
  const sum = data.reduce((s, d) => s + total(d), 0);
  const labels = axisDates(n);

  return (
    <div className="panel">
      <div className="flex items-center justify-between px-[22px] pt-[18px]">
        <h3 className="text-[15px] font-medium tracking-[-0.01em]">Lending volume</h3>
        <Segmented small label="Volume range" items={RANGES} value={range} onChange={setRange} />
      </div>
      <div className="px-[22px] pb-[22px] pt-3.5">
        <div className="flex items-end justify-between">
          <div>
            <Label>Total, {range}</Label>
            <div className="mt-1 text-2xl font-medium tracking-[-0.03em]">{compactUsd(sum)}</div>
          </div>
          <div className="flex gap-4 text-[12.5px] text-t2">
            {VOL_KEYS.map((k) => (
              <span key={k.key} className="flex items-center gap-1.5">
                <Swatch color={k.color} />
                {k.label}
              </span>
            ))}
          </div>
        </div>
        <div className="relative mt-3">
          <svg viewBox={`0 0 ${VOL_W} ${VOL_H}`} width="100%" height={VOL_H} className="text-[11px] [&_text]:fill-t3" onPointerLeave={() => setHover(null)} role="img" aria-label={`Daily lending volume over ${range}`}>
            {[0, 0.5, 1].map((f) => (
              <g key={f}>
                <line x1={pad.left} x2={pad.left + iw} y1={pad.top + ih - f * ih} y2={pad.top + ih - f * ih} stroke="rgba(255,255,255,0.05)" />
                <text x={VOL_W - 2} y={pad.top + ih - f * ih + 4} textAnchor="end">
                  {compactUsd(yMax * f)}
                </text>
              </g>
            ))}
            {labels.map((lab, i) => (
              <text key={`${lab}-${i}`} x={pad.left + (i / 6) * iw} y={VOL_H - 6} textAnchor={i === 0 ? "start" : i === 6 ? "end" : "middle"}>
                {lab}
              </text>
            ))}
            {data.map((d, i) => {
              const x = pad.left + i * (bw + gap);
              let base = pad.top + ih;
              const dim = hover !== null && hover !== i;
              return (
                <g key={`${range}-${i}`} onPointerEnter={() => setHover(i)} className="cursor-crosshair">
                  <rect x={x - gap / 2} y={pad.top} width={bw + gap} height={ih} fill="transparent" />
                  {VOL_KEYS.map((k, kk) => {
                    const h = y(d[k.key]);
                    base -= h;
                    return (
                      <motion.rect
                        key={k.key}
                        x={x}
                        width={bw}
                        rx={Math.min(2, bw / 3)}
                        fill={k.color}
                        initial={{ y: pad.top + ih, height: 0 }}
                        animate={{ y: base, height: Math.max(0, h - 1), opacity: dim ? 0.35 : 0.9 }}
                        transition={{ duration: 0.55, delay: (i / n) * 0.5 + kk * 0.05, ease: EASE, opacity: { duration: 0.15 } }}
                      />
                    );
                  })}
                </g>
              );
            })}
          </svg>
          <div
            className="glass-tip pointer-events-none absolute top-1 min-w-[170px] rounded-[10px] border border-line-2 px-3 py-2.5 text-xs transition-[left] duration-150"
            style={{ left: Math.min(VOL_W - 190, Math.max(0, pad.left + idx * (bw + gap) - 85)) }}
          >
            <div className="mb-1.5 text-t3">{dateLabel(n - 1 - idx, true)}</div>
            {VOL_KEYS.map((k) => (
              <div key={k.key} className="flex justify-between gap-4 py-0.5">
                <span className="flex items-center gap-1.5 text-t2">
                  <Swatch color={k.color} />
                  {k.label}
                </span>
                <b className="font-medium">{compactUsd(data[idx][k.key])}</b>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function FeesPanel() {
  const [range, setRange] = useState<Range>("30D");
  const n = DAYS[range];
  const lenders = FEES.lenders.slice(-n);
  const insurance = FEES.insurance.slice(-n);
  const total = lenders.reduce((s, v) => s + v, 0) + insurance.reduce((s, v) => s + v, 0);
  return (
    <div className="panel">
      <div className="flex items-center justify-between px-[22px] pt-[18px]">
        <h3 className="text-[15px] font-medium tracking-[-0.01em]">Lending fees</h3>
        <Segmented small label="Fees range" items={RANGES} value={range} onChange={setRange} />
      </div>
      <div className="px-[22px] pb-[22px] pt-3.5">
        <div className="flex items-end justify-between">
          <div>
            <Label>Borrower interest, {range}</Label>
            <div className="mt-1 text-2xl font-medium tracking-[-0.03em]">{compactUsd(total)}</div>
          </div>
          <div className="flex gap-4 text-[12.5px] text-t2">
            <span>
              Seniors <b className="font-medium text-t1">{compactUsd(total * 0.59)}</b>
            </span>
            <span>
              Juniors <b className="font-medium text-t1">{compactUsd(total * 0.31)}</b>
            </span>
            <span>
              Insurance <b className="font-medium text-t1">{compactUsd(total * 0.1)}</b>
            </span>
          </div>
        </div>
        <div className="mt-3">
          <LineChart
            width={VOL_W}
            height={VOL_H}
            pad={{ top: 10, right: 48, bottom: 26, left: 4 }}
            lines={[
              { key: "lenders", label: "To lenders", color: "#3ddc97", data: lenders, fill: 0.22 },
              { key: "insurance", label: "Insurance fund", color: "#a0a4ab", data: insurance, fill: 0.08, width: 1.5 },
            ]}
            yMax={3000}
            yTicks={[0, 1500, 3000]}
            fmtY={compactUsd}
            xLabels={axisDates(n)}
            titleAt={(i) => dateLabel(n - 1 - i, true)}
            fmtValue={(v) => `$${Math.round(v).toLocaleString("en-US")}`}
            animKey={range}
            ariaLabel={`Daily lending fees over ${range}`}
          />
        </div>
      </div>
    </div>
  );
}

function MixBar({ title, value, field }: { title: string; value: number; field: "collateral" | "borrowed" }) {
  const byClass = CLASSES.map((c) => ({ c, v: MARKETS.filter((m) => m.cls === c).reduce((s, m) => s + m[field], 0) }));
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <Label>{title}</Label>
        <span className="font-medium">{compactUsd(value)}</span>
      </div>
      <div className="mt-2.5 flex h-3 gap-[3px] overflow-hidden rounded-full">
        {byClass.map(({ c, v }, i) => (
          <motion.i
            key={c}
            className="block h-full rounded-[3px]"
            style={{ background: CLASS_COLORS[c] }}
            initial={{ width: 0 }}
            whileInView={{ width: `${(v / value) * 100}%` }}
            viewport={{ once: true }}
            transition={{ duration: 0.8, delay: 0.1 + i * 0.08, ease: EASE }}
            title={`${c}: ${compactUsd(v)}`}
          />
        ))}
      </div>
    </div>
  );
}

function MixPanel() {
  return (
    <section className="panel mt-4 grid grid-cols-[1fr_1fr_1.1fr] items-center gap-10 px-[22px] py-5">
      <MixBar title="Collateral by asset class" value={TOTALS.collateral} field="collateral" />
      <MixBar title="Borrowed against each class" value={TOTALS.borrowed} field="borrowed" />
      <div className="grid grid-cols-5 gap-3">
        {CLASSES.map((c) => {
          const share = MARKETS.filter((m) => m.cls === c).reduce((s, m) => s + m.collateral, 0) / TOTALS.collateral;
          return (
            <div key={c}>
              <div className="flex items-center gap-1.5 whitespace-nowrap text-[12px] text-t2">
                <Swatch color={CLASS_COLORS[c]} />
                {c === "LP positions" ? "LPs" : c}
              </div>
              <div className="mt-1 font-medium">{pct(share)}</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

type SortKey = "collateral" | "borrowed" | "power" | "apr" | "fees" | "volume";
const SORTERS: Record<SortKey, (m: Market) => number> = {
  collateral: (m) => m.collateral,
  borrowed: (m) => m.borrowed,
  power: powerUsed,
  apr: (m) => m.borrowApr,
  fees: fees30d,
  volume: (m) => m.volume24h,
};
const COLUMNS: { key: SortKey; label: string }[] = [
  { key: "collateral", label: "Collateral" },
  { key: "borrowed", label: "Borrowed" },
  { key: "power", label: "Credit used" },
  { key: "apr", label: "Borrow APR" },
  { key: "fees", label: "Fees, 30D" },
  { key: "volume", label: "Volume, 24H" },
];
const FILTER_ICONS: Record<"All" | AssetClass, string[]> = {
  All: [],
  SOL: ["sol.webp"],
  LSTs: ["jitosol.webp", "jupsol.webp", "msol.png"],
  "LP positions": ["orca.png", "ray.webp"],
  Stocks: ["nvdax.webp"],
  Memes: ["bonk.webp"],
};

function MarketIcon({ m }: { m: Market }) {
  if (!m.lpBadge) return <Token src={`/tokens/${m.icon}`} size={32} />;
  return (
    <span className="flex">
      <span className="rounded-full shadow-[0_0_0_2px_var(--color-s1)]">
        <Token src="/tokens/sol.webp" size={32} />
      </span>
      <span className="relative -ml-2.5 inline-block size-8">
        <Token src="/tokens/usdc.webp" size={32} />
        <Token src={`/tokens/${m.lpBadge}`} size={15} className="absolute -bottom-[3px] -right-[3px] shadow-[0_0_0_2px_var(--color-s1)]" />
      </span>
    </span>
  );
}

function LiquidityMeter({ n }: { n: number }) {
  return (
    <span className="flex h-3.5 items-end gap-[3px]" aria-label={`Liquidity score ${n} of 5`}>
      {[6, 8, 10, 12, 14].map((h, i) => (
        <i key={h} className={`block w-1 rounded-[1px] ${i < n ? "bg-t2" : "bg-s3"}`} style={{ height: h }} />
      ))}
    </span>
  );
}

function MarketsTable() {
  const [filter, setFilter] = useState<"All" | AssetClass>("All");
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "collateral", dir: -1 });
  const rows = useMemo(
    () => MARKETS.filter((m) => filter === "All" || m.cls === filter).sort((a, b) => (SORTERS[sort.key](a) - SORTERS[sort.key](b)) * sort.dir),
    [filter, sort],
  );
  const toggleSort = (key: SortKey) => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: -1 }));

  return (
    <section className="panel mt-4">
      <div className="flex items-center justify-between px-[22px] pt-[18px]">
        <h3 className="flex items-center gap-2 text-[15px] font-medium tracking-[-0.01em]">
          Collateral markets <span className="font-normal text-t3">{rows.length} of {MARKETS.length}</span>
        </h3>
        <span className="text-[12.5px] text-t3">All markets borrow from one USDC pool, priced by Pyth</span>
      </div>
      <div className="flex gap-2 border-b border-line px-[22px] pb-3.5 pt-4">
        {(["All", ...CLASSES] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`inline-flex h-[34px] cursor-pointer items-center gap-2 whitespace-nowrap rounded-full border border-line-2 px-3.5 text-[13px] transition-colors ${
              filter === f ? "bg-s3 text-t1" : "bg-white/[0.015] text-t2 hover:text-t1"
            }`}
          >
            {!!FILTER_ICONS[f].length && (
              <span className="flex">
                {FILTER_ICONS[f].map((i, k) => (
                  <Token key={i} src={`/tokens/${i}`} size={16} className={`shadow-[0_0_0_2px_var(--color-s1)] ${k ? "-ml-1.5" : ""}`} />
                ))}
              </span>
            )}
            {f}
          </button>
        ))}
      </div>
      <table className="mt-2 w-full border-collapse">
        <thead>
          <tr className="text-[12.5px] text-t3 [&_th]:whitespace-nowrap [&_th]:px-4 [&_th]:pb-3 [&_th]:font-normal">
            <th className="pl-[22px] text-left">Market</th>
            {COLUMNS.map((c) => {
              const on = sort.key === c.key;
              const Icon = on ? (sort.dir === -1 ? ArrowDown : ArrowUp) : ArrowUpDown;
              return (
                <th key={c.key} className="text-right" aria-sort={on ? (sort.dir === -1 ? "descending" : "ascending") : "none"}>
                  <button type="button" onClick={() => toggleSort(c.key)} className={`inline-flex cursor-pointer items-center gap-1 transition-colors hover:text-t1 ${on ? "text-t1" : ""}`}>
                    {c.label}
                    <Icon size={12} strokeWidth={1.75} className={on ? "" : "opacity-50"} />
                  </button>
                </th>
              );
            })}
            <th className="text-left">Liquidity</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => {
            const used = powerUsed(m);
            return (
              <motion.tr
                key={m.id}
                layout="position"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.25 }}
                className="group border-t border-line transition-colors hover:bg-white/[0.02] [&_td]:px-4 [&_td]:py-3.5"
              >
                <td className="pl-[22px]">
                  <div className="flex items-center gap-3">
                    <MarketIcon m={m} />
                    <div>
                      <div className="font-medium">{m.name}</div>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-t3">
                        <Swatch color={CLASS_COLORS[m.cls]} />
                        {m.sub}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="text-right">
                  <div className="font-medium">{compactUsd(m.collateral)}</div>
                  <div className={`mt-0.5 text-[12.5px] ${m.change24h >= 0 ? "text-green" : "text-red"}`}>
                    {m.change24h >= 0 ? "+" : ""}
                    {pct(m.change24h)}
                  </div>
                </td>
                <td className="text-right font-medium">{compactUsd(m.borrowed)}</td>
                <td className="text-right">
                  <div className="inline-flex items-center gap-2.5">
                    <span className="flex h-1 w-14 overflow-hidden rounded-full bg-s3">
                      <i className={`block h-full ${used > 0.85 ? "bg-orange" : "bg-t2"}`} style={{ width: `${Math.min(100, used * 100)}%` }} />
                    </span>
                    <span className="font-medium">{pct(used, 0)}</span>
                  </div>
                  <div className="mt-0.5 text-[12.5px] text-t3">Crash LTV {pct(m.crashLtv)}</div>
                </td>
                <td className="text-right font-medium">{pct(m.borrowApr, 2)}</td>
                <td className="text-right font-medium text-green">{compactUsd(fees30d(m))}</td>
                <td className="text-right font-medium">{compactUsd(m.volume24h)}</td>
                <td>
                  <LiquidityMeter n={m.liquidity} />
                </td>
                <td className="pr-[22px] text-right">
                  <Link href="/borrow" aria-label={`Borrow against ${m.name}`} className="inline-flex text-t3 transition-colors group-hover:text-t1">
                    <ChevronRight size={16} strokeWidth={1.75} className="transition-transform group-hover:translate-x-0.5" />
                  </Link>
                </td>
              </motion.tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

export function OverviewDashboard() {
  return (
    <main className="mx-auto max-w-[1280px] px-10 pb-16 pt-9">
      <div className="mb-7 flex items-end justify-between">
        <div>
          <h1 className="text-[32px] font-medium leading-[1.1] tracking-[-0.035em]">Overview</h1>
          <p className="mt-2 text-[14.5px] text-t2">How the Pluribus credit markets look right now, by asset, fees and volume.</p>
        </div>
        <div className="flex gap-2">
          <Chip>
            <span className="size-1.5 rounded-full bg-green shadow-[0_0_8px_var(--color-green)]" />
            Pyth prices live
          </Chip>
          <Chip>
            Utilization <b>{pct(TOTALS.borrowed / POOL.supplied)}</b>
          </Chip>
        </div>
      </div>
      <KpiStrip />
      <section className="mt-4 grid grid-cols-2 gap-4">
        <VolumePanel />
        <FeesPanel />
      </section>
      <MixPanel />
      <MarketsTable />
    </main>
  );
}
