"use client";

import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Check, Download, Loader2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { FadeUp, Num } from "@/components/motion";
import { Tag, Token } from "@/components/ui";
import { ExampleNote, usePoolFacts } from "./PoolFacts";

const SNAP = { type: "spring", stiffness: 560, damping: 44, mass: 0.7 } as const;
const QUICK = { duration: 0.16 } as const;
const money = (v: number, d = 2) => v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const signed = (v: number) => `${v < 0 ? "−" : "+"}$${money(Math.abs(v))}`;

/* ---------- The example account, shared by every tab ---------- */

type Kind = "draw" | "repay" | "autopay" | "interest";
type Row = { id: string; date: string; kind: Kind; amount: number };
const LABEL: Record<Kind, string> = { draw: "Draw", repay: "Repayment", autopay: "Autopay from LP fees", interest: "Interest" };

// Three months of the How it works example, ending with the debt the Borrow tab starts from
const MONTHS: { key: string; name: string; rows: Row[] }[] = [
  {
    key: "sep",
    name: "September 2026",
    rows: [
      { id: "s1", date: "Sep 4", kind: "draw", amount: 2_000 },
      { id: "s2", date: "Sep 12", kind: "autopay", amount: -31.2 },
      { id: "s3", date: "Sep 20", kind: "interest", amount: 14.6 },
      { id: "s4", date: "Sep 27", kind: "autopay", amount: -29.8 },
    ],
  },
  {
    key: "oct",
    name: "October 2026",
    rows: [
      { id: "o1", date: "Oct 6", kind: "interest", amount: 15.1 },
      { id: "o2", date: "Oct 11", kind: "autopay", amount: -36 },
      { id: "o3", date: "Oct 15", kind: "draw", amount: 500 },
      { id: "o4", date: "Oct 19", kind: "autopay", amount: -33.4 },
      { id: "o5", date: "Oct 30", kind: "repay", amount: -400 },
    ],
  },
  {
    key: "nov",
    name: "November 2026",
    rows: [
      { id: "n1", date: "Nov 3", kind: "draw", amount: 1_500 },
      { id: "n2", date: "Nov 9", kind: "autopay", amount: -38.4 },
      { id: "n3", date: "Nov 13", kind: "interest", amount: 21.75 },
    ],
  },
];
const total = (rows: Row[]) => rows.reduce((s, r) => s + r.amount, 0);
const OPENINGS = MONTHS.map((_, i) => total(MONTHS.slice(0, i).flatMap((m) => m.rows)));
const START_DEBT = total(MONTHS.flatMap((m) => m.rows));

const LIMIT = 9_250;
const LIQUIDATION = 10_400;
const health = (debt: number) => (debt > 0 ? LIQUIDATION / debt : Infinity);
// 1 at the left edge of the bar, 3 or more at the right
const barPos = (h: number) => (Number.isFinite(h) ? Math.min(1, Math.max(0, (h - 1) / 2)) : 1);
const healthColor = (h: number) => (h < 1.3 ? "var(--color-red)" : h < 1.8 ? "var(--color-orange)" : "var(--color-green)");

/* ---------- Small shared controls ---------- */

function Pills<T extends string>({ id, items, value, onChange, small }: { id: string; items: readonly { key: T; label: ReactNode }[]; value: T; onChange: (v: T) => void; small?: boolean }) {
  return (
    <div className={`inline-flex rounded-full border border-line bg-bg p-1 ${small ? "text-[12px]" : "text-[13.5px]"}`}>
      {items.map((it) => (
        <button
          key={it.key}
          type="button"
          onClick={() => onChange(it.key)}
          className={`relative cursor-pointer rounded-full font-medium transition-colors ${small ? "px-2.5 py-1" : "px-4 py-1.5"} ${value === it.key ? "text-t1" : "text-t3 hover:text-t2"}`}
        >
          {value === it.key && <motion.span layoutId={`pill-${id}`} transition={SNAP} className="absolute inset-0 rounded-full bg-s3" />}
          <span className="relative">{it.label}</span>
        </button>
      ))}
    </div>
  );
}

function Slider({ value, max, step, onChange, label }: { value: number; max: number; step: number; onChange: (v: number) => void; label: string }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <input
      type="range"
      aria-label={label}
      min={0}
      max={max}
      step={step}
      value={value}
      disabled={max <= 0}
      onChange={(e) => onChange(Number(e.target.value))}
      className="tour-range w-full"
      style={{ background: `linear-gradient(90deg, var(--color-brand) ${pct}%, rgb(255 255 255 / 0.08) ${pct}%)` }}
    />
  );
}

type Stage = "idle" | "busy" | "done";
/** Pretends to sign and confirm, so a click feels like the real app without touching a chain */
function useFakeTx() {
  const [stage, setStage] = useState<Stage>("idle");
  const run = (commit: () => void) => {
    if (stage !== "idle") return;
    setStage("busy");
    setTimeout(() => {
      commit();
      setStage("done");
      setTimeout(() => setStage("idle"), 1100);
    }, 650);
  };
  return { stage, run };
}

function ActionButton({ stage, disabled, onClick, children, done }: { stage: Stage; disabled?: boolean; onClick: () => void; children: ReactNode; done: ReactNode }) {
  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.98 }}
      disabled={disabled || stage !== "idle"}
      onClick={onClick}
      className="mt-6 grid h-11 w-full cursor-pointer place-items-center rounded-xl bg-[#f4f4f5] text-[14px] font-medium text-[#09090b] transition-opacity disabled:cursor-default disabled:opacity-60 [&:disabled[data-stage]]:opacity-100"
      data-stage={stage === "idle" ? undefined : stage}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span key={stage} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={QUICK} className="flex items-center gap-2">
          {stage === "busy" ? (
            <>
              <Loader2 size={15} className="animate-spin" />
              Confirming
            </>
          ) : stage === "done" ? (
            <>
              <Check size={15} strokeWidth={2.25} />
              {done}
            </>
          ) : (
            children
          )}
        </motion.span>
      </AnimatePresence>
    </motion.button>
  );
}

/* ---------- Borrow ---------- */

function BorrowCard({ debt, onCommit }: { debt: number; onCommit: (kind: "draw" | "repay", amount: number) => void }) {
  const [mode, setMode] = useState<"draw" | "repay">("draw");
  const max = Math.floor(mode === "draw" ? Math.max(0, LIMIT - debt) : debt);
  const [raw, setRaw] = useState(2_500);
  const amount = Math.min(raw, max);
  const after = mode === "draw" ? debt + amount : debt - amount;
  const [now, next] = [health(debt), health(after)];
  const tx = useFakeTx();
  const fmtH = (h: number) => (Number.isFinite(h) ? h.toFixed(2) : "No debt");

  return (
    <>
      <div className="flex items-center justify-between">
        <Pills
          id="borrow-mode"
          small
          items={[
            { key: "draw", label: "Draw" },
            { key: "repay", label: "Repay" },
          ]}
          value={mode}
          onChange={setMode}
        />
        <span className="text-[12.5px] text-t3">
          Debt <span className="font-medium text-t1">${money(debt)}</span>
        </span>
      </div>

      <div className="mt-6 flex items-end justify-between">
        <div className="text-[34px] font-medium leading-none tracking-[-0.04em] tabular-nums">
          <Num value={amount} prefix="$" />
        </div>
        <span className="flex items-center gap-2 rounded-full border border-line-2 bg-s2 py-1 pl-1 pr-3 text-[13px] font-medium">
          <Token src="/tokens/usdc.webp" size={20} />
          USDC
        </span>
      </div>
      <div className="mt-5">
        <Slider label={`Amount to ${mode}`} value={amount} max={max} step={25} onChange={setRaw} />
        <div className="mt-2 flex justify-between text-[12px] text-t3">
          <span>$0</span>
          <button type="button" onClick={() => setRaw(max)} className="cursor-pointer transition-colors hover:text-t1">
            Max ${money(max, 0)}
          </button>
        </div>
      </div>

      <div className="mt-6 space-y-3 rounded-xl border border-line bg-bg p-4 text-[13px]">
        <div className="flex items-center justify-between">
          <span className="text-t2">Credit used</span>
          <span className="font-medium tabular-nums">
            {Math.round((debt / LIMIT) * 100)}% <span className="text-t3">→</span> {Math.round((after / LIMIT) * 100)}%
          </span>
        </div>
        <div className="relative h-1.5 overflow-hidden rounded-full bg-white/[0.07]">
          <motion.div className="absolute inset-y-0 left-0 rounded-full bg-brand/40" animate={{ width: `${(Math.max(debt, after) / LIMIT) * 100}%` }} transition={SNAP} />
          <motion.div className="absolute inset-y-0 left-0 rounded-full bg-brand" animate={{ width: `${(Math.min(debt, after) / LIMIT) * 100}%` }} transition={SNAP} />
        </div>
        <div className="flex items-center justify-between pt-1">
          <span className="text-t2">Health factor</span>
          <span className="font-medium tabular-nums">
            <span style={{ color: healthColor(now) }}>{fmtH(now)}</span> <span className="text-t3">→</span>{" "}
            <motion.span animate={{ color: healthColor(next) }} transition={QUICK}>
              {fmtH(next)}
            </motion.span>
          </span>
        </div>
        <div className="relative h-1.5 rounded-full bg-[linear-gradient(90deg,var(--color-red),var(--color-orange)_35%,var(--color-green)_70%)] opacity-80">
          <motion.span
            className="absolute top-1/2 h-3.5 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow-[0_0_0_3px_var(--color-bg)]"
            animate={{ left: `${barPos(next) * 100}%` }}
            transition={SNAP}
          />
        </div>
      </div>

      <ActionButton stage={tx.stage} disabled={amount <= 0} onClick={() => tx.run(() => onCommit(mode, amount))} done={`${mode === "draw" ? "Drawn" : "Repaid"}, added to your statement`}>
        {mode === "draw" ? "Draw" : "Repay"} ${money(amount, 0)}
      </ActionButton>
    </>
  );
}

/* ---------- Earn ---------- */

const TRANCHES = {
  senior: { name: "Senior", token: "sUSDC", color: "var(--color-green)", tone: "green" as const },
  junior: { name: "Junior", token: "jUSDC", color: "var(--color-orange)", tone: "orange" as const },
};
type Tranche = keyof typeof TRANCHES;
const HORIZONS = [
  { key: "1m", label: "1M", days: 30 },
  { key: "6m", label: "6M", days: 182 },
  { key: "1y", label: "1Y", days: 365 },
] as const;
const grown = (amount: number, apy: number, days: number) => amount * (1 + apy / 100 / 365) ** days;
const SECONDS_PER_YEAR = 31_536_000;

function EarnCard() {
  const [pick, setPick] = useState<Tranche>("senior");
  const [amount, setAmount] = useState(10_000);
  const [horizon, setHorizon] = useState<(typeof HORIZONS)[number]["key"]>("1y");
  const [position, setPosition] = useState<{ tranche: Tranche; amount: number; at: number } | null>(null);
  const [now, setNow] = useState(0);
  const tx = useFakeTx();

  // The live counter of a deposit, ticking at the tranche's real per-second rate
  useEffect(() => {
    if (!position) return;
    const id = setInterval(() => setNow(Date.now()), 60);
    return () => clearInterval(id);
  }, [position]);

  const t = TRANCHES[pick];
  // the example yields come from the pool's own rate curve, and nothing is drawn until it has been read
  const facts = usePoolFacts();
  const apy = { senior: facts?.apy.senior ?? 0, junior: facts?.apy.junior ?? 0 };
  const days = HORIZONS.find((h) => h.key === horizon)!.days;
  const earned = grown(amount, apy[pick], days) - amount;
  // Both tranches on one scale, so the gap between them shows
  const top = grown(Math.max(amount, 1), apy.junior, days) - amount;
  const line = (rate: number) =>
    Array.from({ length: 25 }, (_, i) => `${i ? "L" : "M"}${(i / 24) * 400},${108 - ((grown(amount, rate, (i / 24) * days) - amount) / (top || 1)) * 96}`).join(" ");
  const path = line(apy[pick]);
  const other = line(apy[pick === "senior" ? "junior" : "senior"]);
  const live = position ? (position.amount * (apy[position.tranche] / 100) * Math.max(0, now - position.at)) / 1000 / SECONDS_PER_YEAR : 0;

  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        {(Object.keys(TRANCHES) as Tranche[]).map((k) => (
          <motion.button
            key={k}
            type="button"
            whileTap={{ scale: 0.97 }}
            onClick={() => setPick(k)}
            className={`relative cursor-pointer rounded-xl border px-4 py-3 text-left transition-colors ${k === pick ? "border-line-2" : "border-line hover:border-line-2"}`}
          >
            {k === pick && <motion.span layoutId="earn-pick" transition={SNAP} className="absolute inset-0 rounded-xl bg-s3" />}
            <span className="relative flex items-center gap-2 text-[13px] text-t2">
              <Token src="/tokens/usdc.webp" size={18} />
              {TRANCHES[k].name}
            </span>
            <span className="relative mt-1.5 block text-[22px] font-medium tracking-[-0.03em]" style={{ color: TRANCHES[k].color }}>
              {facts ? `${apy[k].toFixed(1)}%` : "—"} <span className="text-[12px] font-normal text-t3">APY</span>
            </span>
          </motion.button>
        ))}
      </div>
      <ExampleNote className="mt-2 text-[11.5px] text-t3" />

      <div className="mt-4 flex items-center justify-between text-[13px]">
        <span className="text-t2">Deposit</span>
        <span className="font-medium tabular-nums">${money(amount, 0)}</span>
      </div>
      <div className="mt-2.5">
        <Slider label="Deposit amount" value={amount} max={50_000} step={500} onChange={(v) => setAmount(Math.max(500, v))} />
      </div>

      <div className="mt-5 flex items-end justify-between">
        <div>
          <div className="text-[12.5px] text-t3">Interest earned</div>
          <div className="mt-1 text-[28px] font-medium leading-none tracking-[-0.04em]" style={{ color: t.color }}>
            <Num value={earned} decimals={2} prefix="+$" />
          </div>
        </div>
        <Pills id="earn-horizon" small items={HORIZONS} value={horizon} onChange={setHorizon} />
      </div>
      <svg viewBox="0 0 400 112" preserveAspectRatio="none" className="mt-3 h-[96px] w-full overflow-visible" aria-hidden>
        <defs>
          <linearGradient id="earn-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={t.color} stopOpacity={0.2} />
            <stop offset="1" stopColor={t.color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <motion.path d={`${path} L400,108 L0,108 Z`} fill="url(#earn-fill)" animate={{ d: `${path} L400,108 L0,108 Z` }} transition={SNAP} />
        <motion.path d={other} fill="none" stroke="var(--color-t3)" strokeWidth={1.25} strokeDasharray="3 4" vectorEffect="non-scaling-stroke" animate={{ d: other }} transition={SNAP} />
        <motion.path d={path} fill="none" stroke={t.color} strokeWidth={2} strokeLinecap="round" vectorEffect="non-scaling-stroke" animate={{ d: path, stroke: t.color }} transition={SNAP} />
      </svg>

      <AnimatePresence mode="popLayout" initial={false}>
        {position ? (
          <motion.div key="pos" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={QUICK} className="mt-5 flex items-center justify-between rounded-xl border border-line bg-bg px-4 py-3">
            <div>
              <div className="flex items-center gap-1.5 text-[12px] text-t3">
                <span className="relative flex size-1.5">
                  <span className="absolute inline-flex size-full animate-ping rounded-full bg-green opacity-60" />
                  <span className="relative inline-flex size-1.5 rounded-full bg-green" />
                </span>
                Earning live in {TRANCHES[position.tranche].token}
              </div>
              <div className="mt-1 font-mono text-[15px] tabular-nums text-t1">+${live.toFixed(6)}</div>
            </div>
            <button type="button" onClick={() => setPosition(null)} className="cursor-pointer rounded-lg border border-line-2 px-3 py-1.5 text-[12.5px] font-medium text-t2 transition-colors hover:text-t1">
              Withdraw
            </button>
          </motion.div>
        ) : (
          <motion.div key="cta" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={QUICK}>
            <ActionButton stage={tx.stage} onClick={() => tx.run(() => (setNow(Date.now()), setPosition({ tranche: pick, amount, at: Date.now() })))} done="Deposited">
              Deposit ${money(amount, 0)} into {t.token}
            </ActionButton>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

/* ---------- Statements ---------- */

const FILTERS = [
  { key: "all", label: "All" },
  { key: "autopay", label: "Autopay" },
  { key: "moves", label: "Draws & repays" },
  { key: "interest", label: "Interest" },
] as const;
type Filter = (typeof FILTERS)[number]["key"];
const matches = (f: Filter, k: Kind) => f === "all" || (f === "moves" ? k === "draw" || k === "repay" : f === k);
const rowColor = (k: Kind) => (k === "autopay" ? "text-green" : k === "interest" ? "text-t2" : "text-t1");

function StatementCard({ today }: { today: Row[] }) {
  const [month, setMonth] = useState(MONTHS.length - 1);
  const [filter, setFilter] = useState<Filter>("all");
  const m = MONTHS[month];
  const rows = month === MONTHS.length - 1 ? [...m.rows, ...today] : m.rows;
  const shown = rows.filter((r) => matches(filter, r.kind));
  const opening = OPENINGS[month];
  const closing = opening + total(rows);
  const interest = total(rows.filter((r) => r.kind === "interest"));
  const autopay = -total(rows.filter((r) => r.kind === "autopay"));
  const covered = interest > 0 ? Math.min(1, autopay / interest) : 1;

  const exportCsv = () => {
    const lines = ["date,type,amount", ...rows.map((r) => `${r.date},${LABEL[r.kind]},${r.amount.toFixed(2)}`)];
    const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
    Object.assign(document.createElement("a"), { href: url, download: `pluribus-example-${m.key}.csv` }).click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="flex items-center justify-between">
        <Pills id="statement-month" small items={MONTHS.map((x, i) => ({ key: String(i), label: x.name.slice(0, 3) }))} value={String(month)} onChange={(v) => setMonth(Number(v))} />
        <button type="button" onClick={exportCsv} className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-line-2 px-2.5 py-1.5 text-[12px] font-medium text-t2 transition-colors hover:text-t1">
          <Download size={13} strokeWidth={1.75} />
          CSV
        </button>
      </div>

      <div className="mt-5 flex items-baseline justify-between">
        <div className="text-[20px] font-medium tracking-[-0.03em]">{m.name}</div>
        <div className="text-[12.5px] text-t3">Opening ${money(opening)}</div>
      </div>
      <div className="mt-3 flex gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            onClick={() => setFilter(f.key)}
            className={`cursor-pointer rounded-md px-2 py-1 text-[11.5px] font-medium transition-colors ${filter === f.key ? "bg-brand-dim text-brand" : "text-t3 hover:text-t2"}`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <ul className="mt-3 h-[208px] overflow-hidden">
        <AnimatePresence initial={false} mode="popLayout">
          {shown.map((r) => (
            <motion.li
              key={r.id}
              layout
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 8 }}
              transition={{ layout: SNAP, opacity: QUICK, x: SNAP }}
              className="-mx-2 flex items-center justify-between rounded-lg border-b border-line px-2 py-2.5 text-[13.5px] transition-colors hover:bg-white/[0.03]"
            >
              <span className="flex items-center gap-3">
                <span className="w-12 text-[12px] text-t3">{r.date}</span>
                <span className="text-t2">{LABEL[r.kind]}</span>
              </span>
              <span className={`font-medium tabular-nums ${rowColor(r.kind)}`}>{signed(r.amount)}</span>
            </motion.li>
          ))}
          {shown.length === 0 && (
            <motion.li key="none" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="py-6 text-center text-[13px] text-t3">
              Nothing of this kind this month
            </motion.li>
          )}
        </AnimatePresence>
      </ul>

      <div className="mt-4 flex items-center justify-between border-t border-line pt-4">
        <span className="text-[13px] text-t2">Closing balance</span>
        <span className="text-[20px] font-medium tracking-[-0.03em] tabular-nums">
          <Num value={closing} decimals={2} prefix="$" />
        </span>
      </div>
      <div className="mt-3 flex items-center gap-3 text-[12.5px]">
        <span className="whitespace-nowrap text-t3">Interest covered by LP fees</span>
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/[0.07]">
          <motion.div className="h-full rounded-full bg-green" animate={{ width: `${covered * 100}%` }} transition={SNAP} />
        </div>
        <span className="w-9 text-right font-medium tabular-nums text-green">{Math.round(covered * 100)}%</span>
      </div>
    </>
  );
}

/* ---------- The showcase ---------- */

const TABS = [
  {
    key: "borrow",
    label: "Borrow",
    title: "Draw USDC in one step.",
    body: "Slide to an amount and watch your health factor before you sign. Try a draw, then open Statements to see it booked.",
    points: ["No maturity date", "Repay any time, from your wallet or your collateral", "LP fees pay the debt down on their own"],
    href: "/borrow",
    cta: "Open a credit line",
  },
  {
    key: "earn",
    label: "Earn",
    title: "Lend at the risk you choose.",
    body: "Seniors are paid first and protected by two layers of cover. Juniors take first loss for a much higher yield.",
    points: ["Interest accrues every second", "Seniors are covered by the insurance fund and juniors", "Juniors earn every risk premium"],
    href: "/earn",
    cta: "Start earning",
  },
  {
    key: "statements",
    label: "Statements",
    title: "Every dollar, accounted for.",
    body: "A monthly statement of each draw, repayment and autopay, and how much of your interest your LP fees covered.",
    points: ["Filter by kind of activity", "Track autopay against interest", "Export any month as CSV"],
    href: "/statements",
    cta: "See statements",
  },
] as const;
type Tab = (typeof TABS)[number]["key"];

/** Borrow, Earn and Statements as tabs over one example account, so a draw on one tab shows up on another */
export function ProductTour() {
  const [tab, setTab] = useState<Tab>("borrow");
  const [today, setToday] = useState<Row[]>([]);
  const debt = START_DEBT + total(today);
  const index = TABS.findIndex((t) => t.key === tab);
  const [dir, setDir] = useState(1);
  const go = (next: Tab) => {
    setDir(TABS.findIndex((t) => t.key === next) >= index ? 1 : -1);
    setTab(next);
  };
  const t = TABS[index];

  const commit = (kind: "draw" | "repay", amount: number) =>
    setToday((rows) => [...rows, { id: `t${rows.length}`, date: "Today", kind, amount: kind === "draw" ? amount : -amount }]);

  return (
    <section aria-labelledby="product-tour">
      <FadeUp className="text-center" y={20}>
        <h2 id="product-tour" className="text-[44px] font-medium leading-[1.05] tracking-[-0.045em]">
          How it works
        </h2>
        <div className="mt-7 flex justify-center">
          <Pills id="tour-tab" items={TABS} value={tab} onChange={go} />
        </div>
      </FadeUp>

      <FadeUp y={28} delay={0.06} className="mt-12 grid grid-cols-[minmax(0,1fr)_540px] items-center gap-20">
        <div className="relative min-h-[300px]">
          <AnimatePresence mode="popLayout" initial={false} custom={dir}>
            <motion.div
              key={tab}
              custom={dir}
              variants={{ enter: (d: number) => ({ opacity: 0, x: d * -24 }), center: { opacity: 1, x: 0 }, exit: (d: number) => ({ opacity: 0, x: d * 24 }) }}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ x: SNAP, opacity: QUICK }}
            >
              <h3 className="text-[34px] font-medium leading-[1.08] tracking-[-0.04em]">{t.title}</h3>
              <p className="mt-4 max-w-[440px] text-[15.5px] leading-[1.6] text-t2">{t.body}</p>
              <ul className="mt-6 space-y-2.5">
                {t.points.map((p) => (
                  <li key={p} className="flex items-center gap-2.5 text-[14px] text-t2">
                    <Check size={14} strokeWidth={2.25} className="text-brand" />
                    {p}
                  </li>
                ))}
              </ul>
              <Link href={t.href} className="group mt-7 inline-flex items-center gap-1.5 text-[14px] font-medium text-t1">
                {t.cta}
                <ArrowRight size={15} strokeWidth={1.75} className="transition-transform duration-200 group-hover:translate-x-0.5" />
              </Link>
              {tab === "statements" && today.length > 0 && <div className="mt-5"><Tag tone="brand">{today.length === 1 ? "Your draw or repayment from Borrow is" : `Your ${today.length} moves from Borrow are`} in November</Tag></div>}
            </motion.div>
          </AnimatePresence>
        </div>

        <div className="panel relative h-[500px] overflow-hidden rounded-2xl shadow-[0_24px_60px_-24px_rgb(0_0_0/0.7)]">
          <AnimatePresence mode="popLayout" initial={false} custom={dir}>
            <motion.div
              key={tab}
              custom={dir}
              variants={{ enter: (d: number) => ({ opacity: 0, x: d * 40 }), center: { opacity: 1, x: 0 }, exit: (d: number) => ({ opacity: 0, x: d * -40 }) }}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ x: SNAP, opacity: QUICK }}
              className="absolute inset-0 p-7"
            >
              {tab === "borrow" && <BorrowCard debt={debt} onCommit={commit} />}
              {tab === "earn" && <EarnCard />}
              {tab === "statements" && <StatementCard today={today} />}
            </motion.div>
          </AnimatePresence>
        </div>
      </FadeUp>
    </section>
  );
}
