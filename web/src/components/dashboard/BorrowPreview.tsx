"use client";

import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Award, Bell, Check, ChevronDown, Info, Search, ShieldCheck, TrendingUp } from "lucide-react";
import { useRef, useState } from "react";
import { Brandmark, Chip, KV, Label, StatusDot, Swatch, Tag, Token } from "@/components/ui";
import { EASE, Num } from "@/components/motion";
import { PortfolioChart, RANGES, SERIES, type Range, type SeriesKey } from "./PortfolioChart";
import { Segmented } from "./Segmented";

const ic = { size: 16, strokeWidth: 1.75 };

const LIMIT = 31294;
const INITIAL_DEBT = 14500;
const APR = 0.096;
const AUTOPAY_PER_MONTH = 212.4;
const QUICK = [
  { label: "25%", pct: 0.25 },
  { label: "30%", pct: 0.3 },
  { label: "50%", pct: 0.5 },
  { label: "Max", pct: 1 },
] as const;
type Mode = "Draw" | "Repay";
type Status = "idle" | "signing" | "confirming";

const money = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const healthOf = (debt: number) => (debt > 0 ? LIMIT / debt : Infinity);
const healthTone = (h: number) => (h >= 1.5 ? "text-green" : h >= 1.2 ? "text-orange" : "text-red");
/** Position on the 1.00 / 1.50 / 2.00 / 3.00+ scale, which is piecewise linear. */
const healthPos = (h: number) => {
  if (h <= 1) return 0;
  if (h <= 2) return ((h - 1) / 0.5) * 33.333;
  return Math.min(100, 66.667 + (h - 2) * 33.333);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Keeps the raw value numeric while showing thousands separators as the user types. */
const displayAmount = (raw: string) => {
  const [int, dec] = raw.split(".");
  const grouped = (int || "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return dec !== undefined ? `${grouped}.${dec}` : grouped;
};

function AppNav() {
  const links = ["Borrow", "Earn", "Statements", "Docs"];
  return (
    <header className="flex h-16 items-center gap-10 border-b border-line bg-[rgb(7_8_10/0.7)] px-7 backdrop-blur-md">
      <Brandmark />
      <nav className="flex gap-0.5">
        {links.map((l) => (
          <a key={l} href="#" className={`rounded-[9px] px-3.5 py-2 text-sm font-medium transition-colors ${l === "Borrow" ? "bg-s3 text-t1" : "text-t2 hover:text-t1"}`}>
            {l}
          </a>
        ))}
      </nav>
      <div className="ml-auto flex items-center gap-2">
        <div className="flex items-center gap-1.5 px-2 text-[13px] text-t2">
          <Token src="/tokens/sol.webp" size={16} />
          $150.12 <span className="text-green">+2.41%</span>
        </div>
        <div className="flex h-9 w-[220px] items-center gap-2 rounded-[10px] border border-line bg-s1 pl-3 pr-2.5 text-[13px] text-t3">
          <Search {...ic} />
          Search markets
          <kbd className="ml-auto rounded-[5px] border border-line-2 px-1.5 py-px font-mono text-[11px] text-t3">/</kbd>
        </div>
        <div className="grid size-9 place-items-center rounded-[10px] border border-line bg-s1 text-t2">
          <Bell {...ic} />
        </div>
        <div className="flex h-9 items-center gap-2 rounded-[10px] border border-line bg-s1 pl-1.5 pr-2.5 text-[13px] font-medium">
          <span className="wallet-avatar size-6 rounded-[7px]" />
          7xKX...q9Fh
          <ChevronDown {...ic} className="text-t3" />
        </div>
      </div>
    </header>
  );
}

type Projection = { mode: Mode; amount: number; valid: boolean; newDebt: number };

function CreditHero({ debt, p }: { debt: number; p: Projection }) {
  const health = healthOf(debt);
  const nextHealth = healthOf(p.newDebt);
  const showDelta = p.valid && p.amount > 0;
  const base = ((p.mode === "Draw" ? debt : p.newDebt) / LIMIT) * 100;
  const delta = showDelta ? (Math.abs(p.newDebt - debt) / LIMIT) * 100 : 0;
  const status = health >= 1.5 ? { tone: "green" as const, text: "Healthy" } : { tone: "neutral" as const, text: health >= 1.2 ? "Caution" : "At risk" };
  const bar = { duration: 0.6, ease: EASE };

  return (
    <section className="panel grid grid-cols-[1.5fr_1px_1fr_1px_1fr]">
      <div className="px-[26px] py-6">
        <Label>
          Available to borrow <Info />
        </Label>
        <div className="mt-2.5 flex items-baseline gap-2.5">
          <Num value={LIMIT - debt} decimals={2} prefix="$" countUp className="text-[40px] font-medium leading-[1.05] tracking-[-0.04em] tabular-nums" />
          <Tag tone="green" className="ml-1.5">
            <TrendingUp />
            +$412.80 today
          </Tag>
        </div>
        <div className="mt-[22px] flex h-2.5 gap-[3px] overflow-hidden rounded-full">
          <motion.i className="block h-full rounded-[3px] bg-brand" initial={{ width: 0 }} animate={{ width: `${base}%` }} transition={{ ...bar, delay: 0.2 }} />
          <motion.i
            className={`block h-full rounded-[3px] ${p.mode === "Draw" ? "bg-brand/40" : "bg-green/50"}`}
            initial={false}
            animate={{ width: `${delta}%`, opacity: delta > 0 ? 1 : 0 }}
            transition={bar}
          />
          <i className="stripes block h-full flex-1 rounded-[3px]" />
        </div>
        <div className="mt-3.5 flex gap-5 whitespace-nowrap text-[13px] text-t2 [&_b]:ml-1 [&_b]:font-medium [&_b]:text-t1">
          <span className="inline-flex items-center">
            <Swatch color="var(--color-brand)" className="mr-[7px]" />
            Borrowed
            <b>
              <Num value={debt} decimals={2} prefix="$" />
            </b>
          </span>
          <span className="inline-flex items-center">
            <Swatch color="rgba(255,255,255,0.2)" className="mr-[7px]" />
            Available
            <b>
              <Num value={LIMIT - debt} decimals={2} prefix="$" />
            </b>
          </span>
          <span className="ml-auto inline-flex items-center">
            Credit limit<b>$31,294.00</b>
          </span>
        </div>
      </div>
      <div className="self-stretch bg-line" />
      <div className="px-[26px] py-6">
        <div className="flex items-center justify-between">
          <Label>
            Health factor <Info />
          </Label>
          <Tag tone={status.tone} className={status.tone === "neutral" ? "bg-orange-dim text-orange" : undefined}>
            <StatusDot />
            {status.text}
          </Tag>
        </div>
        <div className={`mt-2.5 text-[40px] font-medium leading-[1.05] tracking-[-0.04em] tabular-nums transition-colors ${healthTone(health)}`}>
          {Number.isFinite(health) ? <Num value={health} decimals={2} countUp /> : "No debt"}
        </div>
        <div className="health-scale relative mt-[22px] h-1.5 rounded-full">
          <AnimatePresence>
            {showDelta && (
              <motion.span
                key="ghost"
                className="absolute -top-[5px] h-4 w-1 rounded-[2px] border border-white/80 bg-transparent"
                initial={{ opacity: 0, left: `${healthPos(health)}%` }}
                animate={{ opacity: 1, left: `${healthPos(nextHealth)}%` }}
                exit={{ opacity: 0 }}
                transition={{ type: "spring", stiffness: 260, damping: 30 }}
              />
            )}
          </AnimatePresence>
          <motion.span
            className="absolute -top-[5px] h-4 w-1 rounded-[2px] bg-white shadow-[0_0_0_3px_var(--color-s1)]"
            initial={{ left: "0%" }}
            animate={{ left: `${healthPos(health)}%` }}
            transition={{ type: "spring", stiffness: 120, damping: 20, delay: 0.3 }}
          />
        </div>
        <div className="mt-2 flex justify-between text-[11.5px] text-t3">
          <span>1.00 Liquidation</span>
          <span>1.50</span>
          <span>2.00</span>
          <span>3.00+</span>
        </div>
      </div>
      <div className="self-stretch bg-line" />
      <div className="px-[26px] py-6">
        <div className="flex items-center justify-between">
          <Label>
            Your borrow rate <Info />
          </Label>
          <Tag tone="brand">
            <Award />
            Tier 3
          </Tag>
        </div>
        <div className="mt-2.5 text-[40px] font-medium leading-[1.05] tracking-[-0.04em] tabular-nums">
          <Num value={9.6} decimals={2} suffix="%" countUp />
          <span className="ml-1.5 text-lg font-normal tracking-[-0.01em] text-t3">APR</span>
        </div>
        <div className="mt-3">
          <KV k="Base rate" dense>7.80%</KV>
          <KV k="Risk premium" dense>+2.90%</KV>
          <KV k="Loyalty, 142 healthy days" dense>
            <span className="text-green">-1.10%</span>
          </KV>
        </div>
      </div>
    </section>
  );
}

function PortfolioPanel({ debt }: { debt: number }) {
  const [range, setRange] = useState<Range>("90D");
  const [focus, setFocusState] = useState<SeriesKey>("Value");
  const [touched, setTouched] = useState(false);
  const setFocus = (k: SeriesKey) => {
    setFocusState(k);
    setTouched(true);
  };
  const stats = [
    { key: "Value", label: "Collateral value", color: "var(--color-brand)", value: 48230 },
    { key: "Credit", label: "Credit limit", color: "#ededef", value: LIMIT },
    { key: "Debt", label: "Debt", color: "var(--color-orange)", value: debt },
  ];
  return (
    <div className="panel">
      <div className="flex items-center justify-between px-[22px] pt-[18px]">
        <h3 className="text-[15px] font-medium tracking-[-0.01em]">Portfolio</h3>
        <div className="flex items-center gap-2.5">
          <Segmented small label="Highlight series" items={SERIES} value={focus} onChange={setFocus} />
          <Segmented small label="Time range" items={RANGES} value={range} onChange={setRange} />
        </div>
      </div>
      <div className="px-[22px] pb-[22px] pt-3.5">
        <div className="flex items-center gap-7">
          {stats.map((s) => (
            <button
              key={s.label}
              type="button"
              onClick={() => setFocus(s.key as SeriesKey)}
              className={`cursor-pointer text-left transition-opacity duration-300 ${!touched || focus === s.key ? "opacity-100" : "opacity-60 hover:opacity-90"}`}
            >
              <Label>
                <Swatch color={s.color} />
                {s.label}
              </Label>
              <Num value={s.value} decimals={2} prefix="$" className="mt-1 block text-2xl font-medium tracking-[-0.03em]" />
            </button>
          ))}
        </div>
        <PortfolioChart range={range} focus={touched ? focus : null} />
      </div>
    </div>
  );
}

function Spinner() {
  return <span className="inline-block size-4 animate-spin rounded-full border-2 border-[#09090b]/25 border-t-[#09090b]" aria-hidden />;
}

/** All Draw/Repay form state plus the projected outcome, shared by the hero and the panel. */
function useDrawForm(debt: number) {
  const [mode, setMode] = useState<Mode>("Draw");
  const [raw, setRaw] = useState("5000.00");
  const [chip, setChip] = useState<string | null>("30%");
  const [status, setStatus] = useState<Status>("idle");

  const amount = Number(raw) || 0;
  const max = mode === "Draw" ? LIMIT - debt : debt;
  const newDebt = mode === "Draw" ? debt + amount : Math.max(0, debt - amount);
  const nextHealth = healthOf(newDebt);
  const error =
    amount <= 0
      ? "Enter an amount"
      : amount > max + 1e-9
        ? mode === "Draw"
          ? "Exceeds available credit"
          : "Exceeds your debt"
        : mode === "Draw" && nextHealth < 1.1
          ? "Health factor too low"
          : null;

  const clear = () => {
    setRaw("");
    setChip(null);
  };

  return {
    mode,
    raw,
    chip,
    status,
    amount,
    max,
    newDebt,
    nextHealth,
    error,
    projection: { mode, amount, newDebt, valid: !error } satisfies Projection,
    switchMode: (m: Mode) => {
      setMode(m);
      clear();
    },
    pick: (label: string, pct: number) => {
      setChip(label);
      setRaw((Math.floor(max * pct * 100) / 100).toFixed(2));
    },
    type: (v: string) => {
      setRaw(v);
      setChip(null);
    },
    normalize: () => raw && setRaw((Number(raw) || 0).toFixed(2)),
    run: async (apply: (mode: Mode, amount: number) => void) => {
      if (error || status !== "idle") return;
      setStatus("signing");
      await sleep(1100);
      setStatus("confirming");
      await sleep(900);
      apply(mode, amount);
      setStatus("idle");
      clear();
    },
  };
}

type DrawForm = ReturnType<typeof useDrawForm>;

function DrawPanel({ debt, form, onApply }: { debt: number; form: DrawForm; onApply: (mode: Mode, amount: number) => void }) {
  const { mode, raw, chip, status, amount, max, newDebt, nextHealth, error } = form;
  const health = healthOf(debt);
  const interest = (newDebt * APR) / 12;
  const coverage = interest > 0 ? Math.min(100, (AUTOPAY_PER_MONTH / interest) * 100) : 100;
  const arrow = <ArrowRight size={13} strokeWidth={1.75} className="text-t3" />;

  const label = status === "signing" ? "Confirm in wallet..." : status === "confirming" ? "Confirming on Solana..." : (error ?? `${mode} ${money(amount).replace(/\.00$/, "")} USDC`);

  return (
    <div className="panel">
      <div className="px-[22px] pb-[22px] pt-[18px]">
        <Segmented label="Action" items={["Draw", "Repay"] as const} value={mode} onChange={form.switchMode} />
        <label className="mt-4 block rounded-[14px] border border-line bg-bg px-4 py-3.5 transition-colors focus-within:border-line-2">
          <div className="flex items-center justify-between">
            <Label>Amount</Label>
            <Label>
              {mode === "Draw" ? "Available" : "Debt"} {money(max)}
            </Label>
          </div>
          <div className="mt-2.5 flex items-center justify-between gap-3">
            <input
              inputMode="decimal"
              aria-label={`${mode} amount in USDC`}
              placeholder="0.00"
              value={displayAmount(raw)}
              onChange={(e) => {
                const v = e.target.value.replace(/,/g, "");
                if (/^\d*\.?\d{0,2}$/.test(v)) form.type(v);
              }}
              onBlur={form.normalize}
              className="w-full min-w-0 bg-transparent text-[32px] font-medium tracking-[-0.035em] text-t1 outline-none placeholder:text-t3"
            />
            <span className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-line-2 bg-s3 pl-1.5 pr-2.5 font-medium">
              <Token src="/tokens/usdc.webp" size={20} />
              USDC
              <ChevronDown {...ic} className="text-t3" />
            </span>
          </div>
          <div className="mt-1 text-[12.5px] text-t3">${money(amount)}</div>
        </label>
        <div className="mt-2.5 flex gap-1.5">
          {QUICK.map((q) => (
            <button
              key={q.label}
              type="button"
              onClick={() => form.pick(q.label, q.pct)}
              className={`flex-1 cursor-pointer rounded-lg border py-1.5 text-center text-xs font-medium transition-colors ${
                chip === q.label ? "border-line-2 bg-s3 text-t1" : "border-line text-t2 hover:border-line-2 hover:text-t1"
              }`}
            >
              {q.label}
            </button>
          ))}
        </div>
        <div className="mt-[18px]">
          <KV k="Health factor">
            <span className={healthTone(health)}>{Number.isFinite(health) ? health.toFixed(2) : "No debt"}</span>
            {arrow}
            <span className={`transition-colors ${healthTone(nextHealth)}`}>{Number.isFinite(nextHealth) ? <Num value={nextHealth} decimals={2} /> : "No debt"}</span>
          </KV>
          <KV k="Credit used">
            {((debt / LIMIT) * 100).toFixed(1)}%{arrow}
            <Num value={(newDebt / LIMIT) * 100} decimals={1} suffix="%" />
          </KV>
          <KV k="Borrow APR">9.60%</KV>
          <KV k="Est. monthly interest">
            <Num value={interest} decimals={2} prefix="$" />
          </KV>
          <KV k="Covered by autopay">
            <span className={coverage >= 100 ? "text-green" : "text-orange"}>
              ~<Num value={coverage} suffix="%" />
            </span>
          </KV>
        </div>
        <motion.button
          type="button"
          onClick={() => form.run(onApply)}
          disabled={!!error || status !== "idle"}
          whileTap={!error && status === "idle" ? { scale: 0.98 } : undefined}
          className={`mt-[18px] flex h-12 w-full items-center justify-center gap-2.5 rounded-xl text-[15px] font-medium transition-colors ${
            error ? "cursor-not-allowed bg-s3 text-t3" : "cursor-pointer bg-[#f4f4f5] text-[#09090b] hover:bg-white"
          }`}
        >
          {status !== "idle" && <Spinner />}
          {label}
        </motion.button>
        <div className="mt-3 flex items-center justify-center gap-1.5 text-xs text-t3">
          <ShieldCheck size={13} strokeWidth={1.75} />
          {mode === "Draw" ? "No maturity. Repay any time, no fees." : "Repay any time, no fees. Autopay keeps running."}
        </div>
      </div>
    </div>
  );
}

type Toast = { id: number; title: string; detail: string };

/** The Borrow dashboard at its native 1440px width. Fully interactive; scaled down inside the landing page frame. */
export function BorrowPreview() {
  const [debt, setDebt] = useState(INITIAL_DEBT);
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const form = useDrawForm(debt);

  const onApply = (mode: Mode, amount: number) => {
    const next = mode === "Draw" ? debt + amount : Math.max(0, debt - amount);
    const before = healthOf(debt);
    const after = healthOf(next);
    setDebt(next);
    clearTimeout(timer.current);
    setToast({
      id: Date.now(),
      title: `${mode === "Draw" ? "Drew" : "Repaid"} ${money(amount)} USDC`,
      detail: `Health factor ${Number.isFinite(before) ? before.toFixed(2) : "max"} to ${Number.isFinite(after) ? after.toFixed(2) : "max"}`,
    });
    timer.current = setTimeout(() => setToast(null), 4200);
  };

  return (
    <div className="relative bg-bg">
      <div className="app-ambient pointer-events-none absolute inset-x-0 top-0 h-[520px]" />
      <AnimatePresence>
        {toast && (
          <motion.div
            key={toast.id}
            role="status"
            className="glass-tip absolute right-7 top-[80px] z-10 flex items-center gap-3 rounded-2xl border border-line-2 py-3 pl-3 pr-5"
            initial={{ opacity: 0, y: -12, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 380, damping: 30 }}
          >
            <span className="grid size-9 place-items-center rounded-xl bg-green-dim text-green">
              <Check size={18} strokeWidth={2.25} />
            </span>
            <div>
              <div className="text-[13.5px] font-medium">{toast.title}</div>
              <div className="text-[12.5px] text-t2">{toast.detail}</div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="relative">
        <AppNav />
        <main className="mx-auto max-w-[1280px] px-10 pb-16 pt-9">
          <div className="mb-7 flex items-end justify-between">
            <div>
              <h1 className="text-[32px] font-medium leading-[1.1] tracking-[-0.035em]">Credit Line</h1>
              <p className="mt-2 text-[14.5px] text-t2">Borrow USDC against your whole Solana portfolio. No maturity, repaid by your LP fees.</p>
            </div>
            <div className="flex gap-2">
              <Chip>
                Pool liquidity <b>$2,004,118</b>
              </Chip>
              <Chip>
                Borrow APR from <b>7.80%</b>
              </Chip>
            </div>
          </div>
          <CreditHero debt={debt} p={form.projection} />
          <section className="mt-4 grid grid-cols-[minmax(0,1fr)_384px] gap-4">
            <PortfolioPanel debt={debt} />
            <DrawPanel debt={debt} form={form} onApply={onApply} />
          </section>
        </main>
      </div>
    </div>
  );
}
