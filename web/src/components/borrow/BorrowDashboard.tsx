"use client";

import { AnimatePresence, motion } from "motion/react";
import { Activity, ArrowRight, Award, ChevronDown, ChevronRight, Info, Plus, ShieldCheck, TrendingUp, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Chip, KV, Label, StatusDot, Swatch, Tag, Token } from "@/components/ui";
import { EASE, Num } from "@/components/motion";
import { Segmented } from "@/components/Segmented";
import { LineChart } from "@/components/charts/LineChart";
import { useAccount, useToast, type Live } from "@/components/app/providers";
import { displayAmount, healthOf, healthPos, healthTone, money, shortKey, usd } from "@/lib/account";
import { series } from "@/lib/chart";
import { deployment } from "@/lib/cluster";
import { healthAfterDrop, type Collateral } from "@/lib/live";
import { TOKEN_INFO, iconSrc, tokenIcon } from "@/lib/tokens";
import { CollateralDialog } from "./CollateralDialog";
import { PortfolioChart, RANGES, SERIES, type Range, type SeriesKey } from "./PortfolioChart";

const ic = { size: 16, strokeWidth: 1.75 };
const QUICK = [
  { label: "25%", pct: 0.25 },
  { label: "30%", pct: 0.3 },
  { label: "50%", pct: 0.5 },
  { label: "Max", pct: 1 },
] as const;
type Mode = "Draw" | "Repay";
type Status = "idle" | "signing" | "confirming";

type Projection = { mode: Mode; amount: number; valid: boolean; newDebt: number };
const pct = (v: number) => `${(v * 100).toFixed(2)}%`;

function CreditHero({ p }: { p: Projection }) {
  const { debt, creditLimit, liquidationLimit, borrowApr, tier, live } = useAccount();
  const health = healthOf(debt, liquidationLimit);
  const nextHealth = healthOf(p.newDebt, liquidationLimit);
  const showDelta = p.valid && p.amount > 0;
  const available = Math.max(0, creditLimit - debt);
  const share = (v: number) => (creditLimit > 0 ? Math.min(100, (v / creditLimit) * 100) : 0);
  const base = share(p.mode === "Draw" ? debt : p.newDebt);
  const delta = showDelta ? share(Math.abs(p.newDebt - debt)) : 0;
  const status = health < 1 ? "Liquidatable" : health >= 1.5 ? "Healthy" : health >= 1.2 ? "Caution" : "At risk";
  const bar = { duration: 0.6, ease: EASE };
  const rateParts = live
    ? [
        ["Base rate", pct(live.rate.base)],
        [`Utilization, ${(live.pool.utilization * 100).toFixed(1)}%`, `+${pct(live.rate.utilization)}`],
        [`Loyalty, ${live.healthyDays} healthy days`, `${live.rate.discount ? "-" : ""}${pct(live.rate.discount)}`],
        // Risky collateral pays juniors for taking the first loss, less as the account earns loyalty tiers
        ...(live.rate.premium > 0 ? [["Risk premium, collateral mix", `+${pct(live.rate.premium)}`]] : []),
      ]
    : [
        ["Base rate", "7.80%"],
        ["Risk premium", "+2.90%"],
        ["Loyalty, 142 healthy days", "-1.10%"],
      ];

  return (
    <section className="panel grid grid-cols-[1.5fr_1px_1fr_1px_1fr]">
      <div className="px-[26px] py-6">
        <Label>
          Available to borrow <Info />
        </Label>
        <div className="mt-2.5 flex items-baseline gap-2.5">
          <Num value={available} decimals={2} prefix="$" countUp className="text-[40px] font-medium leading-[1.05] tracking-[-0.04em] tabular-nums" />
          {!live && (
            <Tag tone="green" className="ml-1.5">
              <TrendingUp />
              +$412.80 today
            </Tag>
          )}
          {live && health < 1 && (
            <Tag tone="red" className="ml-1.5">
              <TriangleAlert />
              Over liquidation limit by {usd(debt - liquidationLimit)}
            </Tag>
          )}
          {live?.viewError && health >= 1 && (
            <Tag tone="orange" className="ml-1.5">
              <TriangleAlert />
              {live.viewError}
            </Tag>
          )}
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
              <Num value={available} decimals={2} prefix="$" />
            </b>
          </span>
          <span className="ml-auto inline-flex items-center">
            Credit limit<b>${money(creditLimit)}</b>
          </span>
        </div>
      </div>
      <div className="self-stretch bg-line" />
      <div className="px-[26px] py-6">
        <div className="flex items-center justify-between">
          <Label>
            Health factor <Info />
          </Label>
          <Tag tone={status === "Healthy" ? "green" : status === "Caution" ? "orange" : "red"}>
            <StatusDot />
            {status}
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
                className="absolute -top-[5px] h-4 w-1 rounded-[2px] border border-white/80"
                initial={{ opacity: 0, left: `${healthPos(health)}%` }}
                animate={{ opacity: 1, left: `${healthPos(nextHealth)}%` }}
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
            {tier}
          </Tag>
        </div>
        <div className="mt-2.5 text-[40px] font-medium leading-[1.05] tracking-[-0.04em] tabular-nums">
          <Num value={borrowApr * 100} decimals={2} suffix="%" countUp />
          <span className="ml-1.5 text-lg font-normal tracking-[-0.01em] text-t3">APR</span>
        </div>
        <div className="mt-3">
          {rateParts.map(([k, v], i) => (
            <KV key={k} k={k} dense>
              {i === 2 ? <span className="text-green">{v}</span> : v}
            </KV>
          ))}
        </div>
      </div>
    </section>
  );
}

function PortfolioPanel() {
  const { debt, creditLimit, collateralValue, live } = useAccount();
  const [range, setRange] = useState<Range>("90D");
  const [focus, setFocusState] = useState<SeriesKey>("Value");
  const [touched, setTouched] = useState(false);
  const setFocus = (k: SeriesKey) => {
    setFocusState(k);
    setTouched(true);
  };
  const stats = [
    { key: "Value", label: "Collateral value", color: "var(--color-brand)", value: collateralValue },
    { key: "Credit", label: "Credit limit", color: "#ededef", value: creditLimit },
    { key: "Debt", label: "Debt", color: "var(--color-orange)", value: debt },
  ] as const;
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
              onClick={() => setFocus(s.key)}
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
        <PortfolioChart range={range} focus={touched ? focus : null} samples={live?.samples} />
      </div>
    </div>
  );
}

function Spinner() {
  return <span className="inline-block size-4 animate-spin rounded-full border-2 border-[#09090b]/25 border-t-[#09090b]" aria-hidden />;
}

/** All Draw/Repay form state plus the projected outcome, shared by the hero and the panel. */
function useDrawForm() {
  const { mode: source, debt, creditLimit, liquidationLimit, poolCash, walletUsdc, transact } = useAccount();
  const [mode, setMode] = useState<Mode>("Draw");
  const [raw, setRaw] = useState(source === "live" ? "" : "5000.00");
  const [chip, setChip] = useState<string | null>(source === "live" ? null : "30%");
  const [status, setStatus] = useState<Status>("idle");

  const amount = Number(raw) || 0;
  const max = mode === "Draw" ? Math.max(0, creditLimit - debt) : debt;
  const newDebt = mode === "Draw" ? debt + amount : Math.max(0, debt - amount);
  const nextHealth = healthOf(newDebt, liquidationLimit);
  const error =
    amount <= 0
      ? "Enter an amount"
      : // Debt is shown rounded to the cent, and typing that figure back in has to work
        amount > (mode === "Draw" ? max : Math.round(max * 100) / 100) + 1e-9
        ? mode === "Draw"
          ? "Exceeds available credit"
          : "Exceeds your debt"
        : amount > (mode === "Draw" ? poolCash : walletUsdc)
          ? mode === "Draw"
            ? "Exceeds pool liquidity"
            : "Exceeds wallet balance"
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
      const ok = await transact(mode === "Draw" ? "draw" : "repay", amount, setStatus);
      setStatus("idle");
      if (!ok) return;
      apply(mode, amount);
      clear();
    },
  };
}

type DrawForm = ReturnType<typeof useDrawForm>;

function DrawPanel({ form, onApply }: { form: DrawForm; onApply: (mode: Mode, amount: number) => void }) {
  const { debt, creditLimit, liquidationLimit, borrowApr, autopayPerMonth } = useAccount();
  const { mode, raw, chip, status, amount, max, newDebt, nextHealth, error } = form;
  const health = healthOf(debt, liquidationLimit);
  const used = (v: number) => (creditLimit > 0 ? (v / creditLimit) * 100 : 0);
  const interest = (newDebt * borrowApr) / 12;
  const coverage = interest > 0 ? Math.min(100, (autopayPerMonth / interest) * 100) : 100;
  const arrow = <ArrowRight size={13} strokeWidth={1.75} className="text-t3" />;
  const label =
    status === "signing" ? "Confirm in wallet..." : status === "confirming" ? "Confirming on Solana..." : (error ?? `${mode} ${money(amount).replace(/\.00$/, "")} USDC`);

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
            {used(debt).toFixed(1)}%{arrow}
            <Num value={used(newDebt)} decimals={1} suffix="%" />
          </KV>
          <KV k="Borrow APR">{pct(borrowApr)}</KV>
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
          {mode === "Draw" ? "No maturity, no fees" : "No repay fees"}
        </div>
      </div>
    </div>
  );
}

/* ---------- Collateral ---------- */

type Kind = "SOL" | "LSTs" | "LP positions" | "Tokenized stocks" | "Memes";
const FILTERS: { label: "All" | Kind; icons: string[] }[] = [
  { label: "All", icons: [] },
  { label: "SOL", icons: ["sol.webp"] },
  { label: "LSTs", icons: ["jitosol.webp", "jupsol.webp", "msol.png"] },
  { label: "LP positions", icons: ["orca.png", "ray.webp", "met.webp"] },
  { label: "Tokenized stocks", icons: ["nvdax.webp", tokenIcon("AAPLx")] },
  { label: "Memes", icons: ["bonk.webp"] },
];

function Meter({ n, label }: { n: number; label: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex h-3.5 items-end gap-[3px]">
        {[6, 8, 10, 12, 14].map((h, i) => (
          <i key={h} className={`block w-1 rounded-[1px] ${i < n ? "bg-t2" : "bg-s3"}`} style={{ height: h }} />
        ))}
      </span>
      {label}
    </div>
  );
}

function RangeBar({ from, to, at }: { from: number; to: number; at: number }) {
  return (
    <span className="relative inline-block h-1.5 w-[92px] rounded-full bg-s3">
      <span className="absolute inset-y-0 rounded-full bg-green/45" style={{ left: `${from}%`, right: `${100 - to}%` }} />
      <span className="absolute -top-[3px] h-3 w-0.5 rounded-[1px] bg-white" style={{ left: `${at}%` }} />
    </span>
  );
}

function TokenIcon({ src, badge }: { src: string; badge?: string }) {
  return (
    <span className="relative inline-block size-8 shrink-0">
      <Token src={iconSrc(src)} size={32} />
      {badge && <Token src={iconSrc(badge)} size={15} className="absolute -bottom-[3px] -right-[3px] shadow-[0_0_0_2px_var(--color-s1)]" />}
    </span>
  );
}

const Pair = ({ badge }: { badge: string }) => (
  <span className="flex">
    <span className="rounded-full shadow-[0_0_0_2px_var(--color-s1)]">
      <TokenIcon src="sol.webp" />
    </span>
    <span className="-ml-2.5">
      <TokenIcon src="usdc.webp" badge={badge} />
    </span>
  </span>
);

type Position = { kind: Kind | null; icon: ReactNode; name: string; sub: string; bal: string; val: string; vsub: string; ltv: number; naive?: string; power: string; liq: ReactNode; mint?: string; dlmm?: { empty: boolean } };
const KINDS: Record<string, Kind | null> = { SOL: "SOL", JitoSOL: "LSTs", JupSOL: "LSTs", NVDAx: "Tokenized stocks", AAPLx: "Tokenized stocks", USDC: null };
const TOKENS: Record<string, { kind: Kind | null; icon: string; sub: string }> = Object.fromEntries(
  Object.entries(TOKEN_INFO).map(([symbol, info]) => [symbol, { ...info, kind: KINDS[symbol] ?? null }]),
);
const rangePrice = (v: number) => money(v, v >= 100 ? 0 : 2);

/** A table row for an on-chain position, in the same shape as the demo rows */
function toRow(c: Collateral): Position {
  const base = { mint: c.mint, val: usd(c.value), ltv: c.value > 0 ? (c.power / c.value) * 100 : 0, power: usd(c.power) };
  if (c.dlmm) {
    const { lower, upper, sol, usdc, naive, empty } = c.dlmm;
    const inside = c.price >= lower && c.price <= upper;
    const spot = upper > lower ? Math.min(100, Math.max(0, 25 + ((c.price - lower) / (upper - lower)) * 50)) : 50;
    return {
      ...base,
      kind: "LP positions",
      icon: <Pair badge="met.webp" />,
      name: c.symbol,
      sub: `Meteora DLMM, ${rangePrice(lower)} to ${rangePrice(upper)}`,
      bal: `Position ${shortKey(c.mint)}`,
      vsub: empty ? "No liquidity" : `${money(sol)} ${c.symbol.split("-")[0]} + ${money(usdc)} USDC`,
      naive: c.value > 0 ? `${((naive / c.value) * 100).toFixed(1)}%` : undefined,
      dlmm: { empty },
      liq: (
        <div className="flex items-center gap-2.5">
          <RangeBar from={25} to={75} at={spot} />
          {empty ? <Tag>Empty</Tag> : <Tag tone={inside ? "green" : "orange"}>{inside ? "In range" : "Out of range"}</Tag>}
        </div>
      ),
    };
  }
  if (c.lp) {
    const { lower, upper, sol, usdc, naive } = c.lp;
    const inside = c.price >= lower && c.price <= upper;
    return {
      ...base,
      kind: "LP positions",
      icon: <Pair badge="orca.png" />,
      name: "SOL-USDC",
      sub: `Orca Whirlpool, ${rangePrice(lower)} to ${rangePrice(upper)}`,
      bal: `Position ${shortKey(c.mint)}`,
      vsub: `${money(sol)} SOL + ${money(usdc)} USDC`,
      naive: `${((naive / c.value) * 100).toFixed(1)}%`,
      liq: (
        <div className="flex items-center gap-2.5">
          <RangeBar from={25} to={75} at={Math.min(100, Math.max(0, 25 + ((c.price - lower) / (upper - lower)) * 50))} />
          <Tag tone={inside ? "green" : "orange"}>{inside ? "In range" : "Out of range"}</Tag>
        </div>
      ),
    };
  }
  const token = TOKENS[c.symbol] ?? TOKENS.USDC;
  // The on-chain liquidation cost is the protocol's own measure of how deep an asset's market is
  const depth = c.risk.liqCostBps <= 500 ? 5 : c.risk.liqCostBps <= 1000 ? 3 : 2;
  return {
    ...base,
    kind: token.kind,
    icon: <TokenIcon src={token.icon} />,
    name: c.symbol,
    sub: token.sub,
    bal: `${money(c.amount)} ${c.symbol}`,
    vsub: usd(c.price),
    liq: <Meter n={depth} label={depth === 2 ? <Tag tone="orange">Risky</Tag> : <span className="text-[12.5px] text-t2">{depth === 5 ? "Deep" : "Moderate"}</span>} />,
  };
}

const POSITIONS: Position[] = [
  { kind: "SOL", icon: <TokenIcon src="sol.webp" />, name: "SOL", sub: "Solana", bal: "120.50 SOL", val: "$18,075.00", vsub: "$150.00", ltv: 66.5, power: "$12,020.00", liq: <Meter n={5} label={<span className="text-[12.5px] text-t2">Deep</span>} /> },
  { kind: "LSTs", icon: <TokenIcon src="jitosol.webp" />, name: "JitoSOL", sub: "Liquid staking", bal: "41.44 JitoSOL", val: "$6,950.00", vsub: "1 JitoSOL = 1.118 SOL", ltv: 65, power: "$4,518.00", liq: <Meter n={5} label={<span className="text-[12.5px] text-t2">Deep</span>} /> },
  { kind: "LP positions", icon: <Pair badge="orca.png" />, name: "SOL-USDC", sub: "Orca Whirlpool, 120 to 180", bal: "Position #8812", val: "$10,000.00", vsub: "$38.20 fees unclaimed", ltv: 70.8, naive: "82.1%", power: "$7,080.00", liq: <div className="flex items-center gap-2.5"><RangeBar from={25} to={75} at={50} /><Tag tone="green">In range</Tag></div> },
  { kind: "LP positions", icon: <Pair badge="ray.webp" />, name: "SOL-USDC", sub: "Raydium CLMM, full range", bal: "Position #2207", val: "$5,200.00", vsub: "$11.70 fees unclaimed", ltv: 79.4, naive: "80.7%", power: "$4,129.00", liq: <div className="flex items-center gap-2.5"><RangeBar from={0} to={100} at={50} /><Tag tone="green">In range</Tag></div> },
  { kind: "LP positions", icon: <Pair badge="met.webp" />, name: "SOL-USDC", sub: "Meteora DLMM, 130 to 170", bal: "Position 9Wq4...hT2e", val: "$8,400.00", vsub: "28.00 SOL + 4,200.00 USDC", ltv: 68.9, naive: "79.6%", power: "$5,788.00", liq: <div className="flex items-center gap-2.5"><RangeBar from={25} to={75} at={50} /><Tag tone="green">In range</Tag></div> },
  { kind: "Tokenized stocks", icon: <TokenIcon src="nvdax.webp" />, name: "NVDAx", sub: "NVIDIA xStock", bal: "18.00 NVDAx", val: "$3,240.00", vsub: "Market closed", ltv: 58, power: "$1,879.00", liq: <Meter n={3} label={<span className="text-[12.5px] text-t2">Moderate</span>} /> },
  { kind: "Memes", icon: <TokenIcon src="bonk.webp" />, name: "BONK", sub: "Bonk", bal: "212.4M BONK", val: "$4,765.00", vsub: "$0.00002243", ltv: 35, power: "$1,668.00", liq: <Meter n={2} label={<Tag tone="orange">Risky</Tag>} /> },
];

function CollateralPanel({ onStressTest }: { onStressTest: () => void }) {
  const [filter, setFilter] = useState<"All" | Kind>("All");
  const [dialog, setDialog] = useState<{ withdraw?: string; add?: string } | null>(null);
  const toast = useToast();
  const { live } = useAccount();
  const all = live ? live.collateral.map(toRow) : POSITIONS;
  const rows = all.filter((p) => filter === "All" || p.kind === filter);
  return (
    <section className="panel mt-4">
      {live && <CollateralDialog live={live} open={dialog} onClose={() => setDialog(null)} />}
      <div className="flex items-center justify-between px-[22px] pt-[18px]">
        <h3 className="flex items-center gap-2 text-[15px] font-medium tracking-[-0.01em]">
          Collateral <span className="font-normal text-t3">{all.length === 1 ? "1 position" : `${all.length} positions`}</span>
        </h3>
        <div className="flex items-center gap-2.5">
          <button type="button" onClick={onStressTest} className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-[10px] border border-line-2 bg-s2 px-3.5 text-[13.5px] font-medium transition-colors hover:bg-s3">
            <Activity {...ic} />
            Run stress test
          </button>
          <button
            type="button"
            onClick={() => (live ? setDialog({}) : toast({ title: "Connect a wallet to deposit", detail: "SOL, LSTs, LP positions, xStocks", tone: "info" }))}
            className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-[10px] bg-[#f4f4f5] px-3.5 text-[13.5px] font-medium text-[#09090b] transition-colors hover:bg-white"
          >
            <Plus {...ic} />
            Deposit
          </button>
        </div>
      </div>
      <div className="flex gap-2 border-b border-line px-[22px] pb-3.5 pt-4">
        {FILTERS.map((f) => (
          <button
            key={f.label}
            type="button"
            onClick={() => setFilter(f.label)}
            className={`inline-flex h-[34px] cursor-pointer items-center gap-2 whitespace-nowrap rounded-full border border-line-2 px-3.5 text-[13px] transition-colors ${
              filter === f.label ? "bg-s3 text-t1" : "bg-white/[0.015] text-t2 hover:text-t1"
            }`}
          >
            {!!f.icons.length && (
              <span className="flex">
                {f.icons.map((i, k) => (
                  <Token key={i} src={iconSrc(i)} size={16} className={`shadow-[0_0_0_2px_var(--color-s1)] ${k ? "-ml-1.5" : ""}`} />
                ))}
              </span>
            )}
            {f.label}
          </button>
        ))}
      </div>
      <table className="mt-2 w-full border-collapse">
        <thead>
          <tr className="text-[12.5px] text-t3 [&_th]:whitespace-nowrap [&_th]:px-4 [&_th]:pb-3 [&_th]:font-normal">
            <th className="pl-[22px] text-left">Asset</th>
            <th className="text-right">Balance</th>
            <th className="text-right">Value</th>
            <th className="text-right">
              <span className="inline-flex items-center gap-1">
                Crash-test LTV <Info size={12} strokeWidth={1.75} />
              </span>
            </th>
            <th className="text-right">Borrowing power</th>
            <th className="text-left">Liquidity / range</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
              <motion.tr
                key={r.mint ?? r.name + r.sub}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.25 }}
                onClick={() => r.mint && setDialog({ withdraw: r.mint })}
                className="group cursor-pointer border-t border-line transition-colors hover:bg-white/[0.02] [&_td]:px-4 [&_td]:py-3.5"
              >
                <td className="pl-[22px]">
                  <div className="flex items-center gap-3">
                    {r.icon}
                    <div>
                      <div className="font-medium">{r.name}</div>
                      <div className="mt-0.5 text-[12.5px] text-t3">{r.sub}</div>
                    </div>
                  </div>
                </td>
                <td className="text-right font-medium">{r.bal}</td>
                <td className="text-right">
                  <div className="font-medium">{r.val}</div>
                  <div className="mt-0.5 text-[12.5px] text-t3">{r.vsub}</div>
                </td>
                <td className="text-right">
                  <div className="inline-flex items-center gap-2.5">
                    <span className="flex h-1 w-14 overflow-hidden rounded-full bg-s3">
                      <i className="block h-full bg-t2" style={{ width: `${r.ltv}%` }} />
                    </span>
                    <span className="font-medium">{r.ltv.toFixed(1)}%</span>
                  </div>
                  {r.naive && <div className="mt-0.5 text-[12.5px] text-t3">Naive {r.naive}</div>}
                </td>
                <td className="text-right font-medium">{r.power}</td>
                <td>{r.liq}</td>
                <td className="pr-[22px] text-right">
                  <div className="flex items-center justify-end gap-2">
                    {/* A Meteora position is topped up, trimmed or closed in place, the same dialog the row opens */}
                    {r.dlmm && r.mint && (
                      <>
                        {[
                          ...(r.dlmm.empty ? [] : [{ label: "Add", open: { add: r.mint } }]),
                          { label: r.dlmm.empty ? "Close" : "Withdraw", open: { withdraw: r.mint } },
                        ].map((a) => (
                          <button
                            key={a.label}
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setDialog(a.open);
                            }}
                            className="h-7 cursor-pointer rounded-lg border border-line-2 bg-s2 px-2.5 text-[12.5px] font-medium transition-colors hover:bg-s3"
                          >
                            {a.label}
                          </button>
                        ))}
                      </>
                    )}
                    <ChevronRight {...ic} className="inline text-t3 transition-transform group-hover:translate-x-0.5 group-hover:text-t1" />
                  </div>
                </td>
              </motion.tr>
            ))}
        </tbody>
      </table>
      {!rows.length && (
        <div className="px-[22px] py-10 text-center text-t3">
          {all.length ? `No ${filter} deposited` : "No collateral yet"}
          {!all.length && live?.canFund && (
            <button type="button" onClick={() => live.fund()} className="ml-2 cursor-pointer text-brand hover:underline">
              Get test tokens
            </button>
          )}
          {/* An account with nothing in it and nothing owed can be closed for its rent, and opened again on the next deposit */}
          {!all.length && live?.hasAccount && live.debt === 0 && (
            <button
              type="button"
              onClick={async () => (await live.closeAccount(() => {})) && toast({ title: "Credit account closed", detail: "Its rent went back to your wallet", tone: "info" })}
              className="ml-3 cursor-pointer text-t2 hover:text-t1 hover:underline"
            >
              Close account
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/* ---------- Stress test + autopay ---------- */

const SHOCKS = Array.from({ length: 36 }, (_, i) => i * 2);
const healthAtShock = (s: number, debt: number, limit: number) => Math.max(0.55, (limit / debt) * (1 - (s / 53.7) * (1 - debt / limit) * 1.0) - Math.pow(s / 70, 3) * 0.12);
const CRASHES = [10, 30, 50];
// Shown before a wallet connects, with the same figures scripts/setup.ts gives the pool
const PREVIEW_SCENARIOS = [
  { name: "Crypto crash", sol: 0.3, stock: 0.15 },
  { name: "Equity crash", sol: 0.15, stock: 0.35 },
  { name: "Broad selloff", sol: 0.25, stock: 0.25 },
];

/** Moves the demo price feed, so a crash can be shown on stage */
function PriceControl({ live }: { live: Live }) {
  const toast = useToast();
  const [asset, setAsset] = useState<"SOL" | "NVDAx">("SOL");
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const mint = asset === "SOL" ? deployment!.solMint : deployment!.stockMint;
  const price = live.prices[mint];
  const target = Number(raw) || 0;
  const set = async (next: number) => {
    setBusy(true);
    const ok = await live.setPrice(mint, next);
    setBusy(false);
    if (!ok) return;
    setRaw("");
    toast({ title: `${asset} price set to ${usd(next)}`, detail: `Was ${usd(price)}`, tone: "info" });
  };
  const chip = "cursor-pointer rounded-lg border border-line px-2.5 py-1.5 text-xs font-medium text-t2 transition-colors hover:border-line-2 hover:text-t1 disabled:cursor-not-allowed disabled:opacity-50";
  return (
    <div className="mb-4 flex items-center gap-1.5">
      <Label className="mr-1.5">Demo price</Label>
      <Segmented small label="Demo price asset" items={["SOL", "NVDAx"] as const} value={asset} onChange={setAsset} />
      {CRASHES.map((c) => (
        <button key={c} type="button" disabled={busy} onClick={() => set(Math.round(price * (100 - c)) / 100)} className={chip}>
          -{c}%
        </button>
      ))}
      <label className="ml-auto flex h-[30px] w-[104px] items-center gap-1 rounded-lg border border-line bg-bg px-2.5 text-xs font-medium transition-colors focus-within:border-line-2">
        <span className="text-t3">$</span>
        <input
          inputMode="decimal"
          aria-label={`New ${asset} price`}
          placeholder={price.toFixed(2)}
          value={raw}
          onChange={(e) => /^\d*\.?\d{0,2}$/.test(e.target.value) && setRaw(e.target.value)}
          className="w-full min-w-0 bg-transparent text-t1 outline-none placeholder:text-t3"
        />
      </label>
      <button type="button" disabled={busy || target <= 0} onClick={() => set(target)} className={chip}>
        Set price
      </button>
    </div>
  );
}

function StressPanel({ highlight }: { highlight: boolean }) {
  const { debt, creditLimit, live } = useAccount();
  const mints = { sol: deployment?.solMint ?? "", stock: deployment?.stockMint ?? "" };
  const solPrice = live ? live.prices[mints.sol] : 150.12;
  const scenarios = live?.scenarios ?? PREVIEW_SCENARIOS;
  const [picked, setPicked] = useState<number | null>(null);
  const sel = Math.min(picked ?? live?.binding ?? 0, scenarios.length - 1);
  const sc = scenarios[sel];
  // The x axis is the fall of the asset the scenario hits hardest, and the other asset falls in the scenario's proportion
  const lead = Math.max(sc.sol, sc.stock);
  const follower = Math.round((Math.min(sc.sol, sc.stock) / (lead || 1)) * 100);
  const xTitle =
    sc.sol === sc.stock
      ? "SOL, LP and stock drop"
      : sc.sol > sc.stock
        ? `SOL and LP drop, stocks ${follower}% as much`
        : `Stock drop, SOL and LP ${follower}% as much`;
  const dropAt = (s: number) => ({ sol: lead ? Math.min(0.99, (s / 100) * (sc.sol / lead)) : 0, stock: lead ? Math.min(0.99, (s / 100) * (sc.stock / lead)) : 0 });
  const pct = (v: number) => `-${Math.round(v * 100)}%`;
  const describe = (s: number) => {
    const d = dropAt(s);
    return `SOL ${pct(d.sol)} ($${(solPrice * (1 - d.sol)).toFixed(2)}), stocks ${pct(d.stock)}`;
  };
  // Health above the top of the chart is drawn at the top
  const hf = live
    ? SHOCKS.map((s) => (debt > 0 ? Math.min(2.5, Math.max(0.5, healthAfterDrop(live, mints, dropAt(s)))) : 2.5))
    : SHOCKS.map((s) => healthAtShock(s, debt, creditLimit));
  const crossing = hf.findIndex((h) => h <= 1);
  const liqIdx = Math.max(0, crossing);
  const crashIdx = Math.min(SHOCKS.length - 1, Math.round(lead * 50));
  return (
    <motion.div className="panel" animate={{ boxShadow: highlight ? "0 0 0 1px rgba(158,140,255,0.5), 0 0 40px -8px rgba(158,140,255,0.45)" : "inset 0 1px 0 rgba(255,255,255,0.03)" }} transition={{ duration: 0.6 }}>
      <div className="flex items-center justify-between gap-4 px-[22px] pt-[18px]">
        <h3 className="text-[15px] font-medium tracking-[-0.01em]">Stress test</h3>
        
      </div>
      <div className="px-[22px] pb-[22px] pt-[18px]">
        {live?.canSetPrice && <PriceControl live={live} />}
        <div role="group" aria-label="Crash scenario" className="grid gap-px overflow-hidden rounded-xl border border-line bg-line" style={{ gridTemplateColumns: `repeat(${scenarios.length}, minmax(0, 1fr))` }}>
          {scenarios.map((s, i) => (
            <button
              key={s.name}
              type="button"
              aria-pressed={i === sel}
              onClick={() => setPicked(i)}
              className={`cursor-pointer px-3.5 py-3 text-left transition-colors ${i === sel ? "bg-s3" : "bg-s1 hover:bg-s2"}`}
            >
              <Label className={i === sel ? "text-t1" : undefined}>
                {s.name}
                {live && i === live.binding && <Tag tone="brand">Sets your limit</Tag>}
              </Label>
              <div className="mt-1.5 flex flex-wrap gap-x-3 text-[13.5px] font-medium tabular-nums text-red">
                <span>SOL {pct(s.sol)}</span>
                <span>Stocks {pct(s.stock)}</span>
              </div>
            </button>
          ))}
        </div>
        
        <div className="mt-4">
          <LineChart
            width={634}
            height={254}
            pad={{ top: 10, right: 40, bottom: 44, left: 8 }}
            xTitle={xTitle}
            lines={[{ key: "hf", label: "Health factor", color: "#3ddc97", data: hf, fill: 0.14 }]}
            yMin={0.5}
            yMax={2.5}
            yTicks={[1, 1.5, 2, 2.5]}
            fmtY={(v) => v.toFixed(1)}
            xLabels={["0%", "-10%", "-20%", "-30%", "-40%", "-50%", "-60%", "-70%"]}
            titleAt={(i) => (SHOCKS[i] ? describe(SHOCKS[i]) : `Today, SOL $${solPrice.toFixed(2)}`)}
            fmtValue={(v) => (live && v >= 2.5 ? (debt > 0 ? "2.50+" : "No debt") : v.toFixed(2))}
            restIndex={crashIdx}
            ariaLabel="Health factor by crash size"
            overlay={({ x, y, innerWidth, pad }) => (
              <g>
                <rect x={pad.left} y={y(1)} width={innerWidth} height={y(0.5) - y(1)} fill="rgba(255,97,102,0.07)" />
                <line x1={pad.left} x2={pad.left + innerWidth} y1={y(1)} y2={y(1)} stroke="#ff6166" strokeDasharray="4 4" strokeWidth={1.2} />
                {(!live || crossing >= 0) && (
                  <>
                    <circle cx={x(liqIdx)} cy={y(1)} r={4} fill="#ff6166" stroke="#0d0f12" strokeWidth={2} />
                    <text x={x(liqIdx) + (live && liqIdx < 12 ? 10 : -10)} y={y(1) + 18} textAnchor={live && liqIdx < 12 ? "start" : "end"} style={{ fill: "#ff6166", fontSize: 11.5 }}>
                      Liquidation at {sc.sol === sc.stock ? `${pct(dropAt(SHOCKS[liqIdx]).sol)} on both` : `SOL ${pct(dropAt(SHOCKS[liqIdx]).sol)}, stocks ${pct(dropAt(SHOCKS[liqIdx]).stock)}`}
                    </text>
                  </>
                )}
              </g>
            )}
          />
        </div>
      </div>
    </motion.div>
  );
}

const FEES = series(30, 6, 8, 5, 3).map((v) => Math.max(2.2, v));
const DAY_MS = 86_400_000;

/** Test control: trades the pool and harvests once a second instead of waiting hours for real fees and the keeper */
function useFastHarvest(live: Live | null) {
  const [running, setRunning] = useState(false);
  const [total, setTotal] = useState({ usd: 0, runs: 0 });
  const harvest = useRef(live?.harvest);
  useEffect(() => {
    harvest.current = live?.harvest;
  });
  useEffect(() => {
    if (!running) return;
    let stop = false;
    (async () => {
      while (!stop) {
        const started = Date.now();
        const got = await harvest.current?.();
        if (!got) break;
        if (!stop) setTotal((t) => ({ usd: t.usd + got.repaid + got.keptUsdc + got.sol * got.solPrice, runs: t.runs + 1 }));
        await new Promise((r) => setTimeout(r, Math.max(0, 1000 - (Date.now() - started))));
      }
      if (!stop) setRunning(false);
    })();
    return () => {
      stop = true;
    };
  }, [running]);
  return { running, total, toggle: () => setRunning((r) => !r) };
}

function AutopayPanel() {
  const { live, months, today, autopayPerMonth } = useAccount();
  const fast = useFastHarvest(live);
  const [enabled, setOn] = useState(true);
  // On-chain anyone may harvest a deposited LP position, so a borrower cannot switch autopay off
  const on = live ? live.collateral.some((c) => c.lp || c.dlmm) : enabled;
  const toast = useToast();
  const AW = 458;
  const bw = (AW - 29 * 4) / 30;
  const toggle = () => {
    setOn(!on);
    toast(on ? { title: "Autopay paused", detail: "LP fees stay in positions", tone: "info" } : { title: "Autopay resumed", detail: "Next harvest in 7m" });
  };
  const paid = months.flatMap((m) => m.events).filter((e) => e.kind === "autopay");
  const dayOf = (iso: string) => Math.round(Date.parse(iso) / DAY_MS);
  const fees = live ? FEES.map((_, i) => paid.filter((e) => dayOf(e.date) === dayOf(today) - 29 + i).reduce((s, e) => s + e.amount, 0)) : FEES;
  const top = Math.max(14, ...fees);
  return (
    <div className="panel">
      <div className="flex items-center justify-between px-[22px] pt-[18px]">
        <h3 className="flex items-center gap-2 text-[15px] font-medium tracking-[-0.01em]">
          Autopay
          <Tag tone={on ? "green" : "neutral"}>
            <StatusDot />
            {on ? "Active" : live ? "No LP position" : "Paused"}
          </Tag>
        </h3>
        {live?.canHarvest && on && (
          <button
            type="button"
            onClick={fast.toggle}
            aria-pressed={fast.running}
            title="Test only, harvests every second"
            className={`ml-auto mr-3 cursor-pointer rounded-md border px-2 py-0.5 text-[11.5px] font-medium transition-colors ${fast.running ? "border-green/50 text-green" : "border-line text-t3 hover:border-line-2 hover:text-t1"}`}
          >
            {fast.running ? "Stop 1s harvest" : "Test: harvest every 1s"}
          </button>
        )}
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="Autopay"
          disabled={!!live}
          onClick={toggle}
          className={`relative h-5 w-[34px] rounded-full transition-colors duration-300 ${live ? "cursor-not-allowed" : "cursor-pointer"} ${on ? "bg-green" : "bg-s3"}`}
        >
          <motion.span className="absolute top-0.5 size-4 rounded-full bg-white" initial={false} animate={{ left: on ? 16 : 2 }} transition={{ type: "spring", stiffness: 600, damping: 35 }} />
        </button>
      </div>
      <div className="px-[22px] pb-[22px] pt-[18px]">
        <div className="text-[13px] text-t2">
          {fast.running || fast.total.runs > 0
            ? `Test harvest: ${fast.total.runs} runs, ${usd(fast.total.usd)} collected`
            : "The keeper harvests LP fees and repays debt every 10 minutes by default"}
        </div>
        <div className="mt-[18px] flex items-center justify-between">
          <Label>Daily fees repaid, 30D</Label>
          <span className="text-[12.5px] text-t2">
            Avg <b className="font-medium text-t1">{live ? usd(fees.reduce((s, v) => s + v, 0) / 30) : "$7.08"}</b> / day
          </span>
        </div>
        <motion.svg
          viewBox={`0 0 ${AW} 150`}
          width="100%"
          height={150}
          className="mt-2.5 [&_text]:fill-t3"
          initial="hidden"
          whileInView="shown"
          viewport={{ once: true, amount: 0.5 }}
          aria-label="Fees repaid per day, 30D"
        >
          {[0, 1, 2].map((j) => (
            <line key={j} x1={0} x2={AW} y1={10 + j * 40} y2={10 + j * 40} stroke="rgba(255,255,255,0.05)" />
          ))}
          {fees.map((v, i) => {
            const h = (v / top) * 120;
            return (
              <motion.rect
                key={i}
                x={i * (bw + 4)}
                y={130 - h}
                width={bw}
                height={h}
                rx={2}
                fill={on ? "#3ddc97" : "#62666e"}
                fillOpacity={i === 29 ? 1 : 0.55}
                style={{ transformBox: "fill-box", transformOrigin: "bottom" }}
                variants={{ hidden: { scaleY: 0 }, shown: { scaleY: 1 } }}
                transition={{ duration: 0.6, delay: i * 0.02, ease: EASE }}
              />
            );
          })}
          <text x={0} y={146} fontSize={11}>
            {live ? new Date(Date.parse(today) - 29 * DAY_MS).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "Oct 16"}
          </text>
          <text x={AW} y={146} fontSize={11} textAnchor="end">
            Today
          </text>
        </motion.svg>
        <div className="mt-3.5 grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-line bg-line">
          {[
            ["This month", <Num key="m" value={autopayPerMonth} decimals={2} prefix="$" countUp className="text-green" />],
            ["Lifetime", <Num key="l" value={live ? paid.reduce((s, e) => s + e.amount, 0) : 1847.2} decimals={2} prefix="$" countUp />],
            ["Next harvest", fast.running ? "Every 1s" : live ? (on ? "By keeper" : "-") : on ? "7m" : "Paused"],
          ].map(([k, v]) => (
            <div key={k as string} className="bg-s1 px-3.5 py-3">
              <Label>{k}</Label>
              <div className="mt-1 text-[17px] font-medium tracking-[-0.02em]">{v}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The Borrow page. `full={false}` renders just the top half for the landing page preview. */
export function BorrowDashboard({ full = true }: { full?: boolean }) {
  const { debt, liquidationLimit, poolCash, live } = useAccount();
  const toast = useToast();
  const form = useDrawForm();
  const stressRef = useRef<HTMLDivElement>(null);
  const [highlightStress, setHighlightStress] = useState(false);

  const onApply = (mode: Mode, amount: number) => {
    const next = mode === "Draw" ? debt + amount : Math.max(0, debt - amount);
    const fmt = (h: number) => (Number.isFinite(h) ? h.toFixed(2) : "max");
    toast({ title: `${mode === "Draw" ? "Drew" : "Repaid"} ${money(amount)} USDC`, detail: `Health factor ${fmt(healthOf(debt, liquidationLimit))} to ${fmt(healthOf(next, liquidationLimit))}` });
  };

  const runStressTest = () => {
    stressRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightStress(true);
    setTimeout(() => setHighlightStress(false), 1800);
  };

  return (
    <main className="mx-auto max-w-[1280px] px-10 pb-16 pt-9">
      <div className="mb-7 flex items-end justify-between">
        <div>
          <h1 className="text-[32px] font-medium leading-[1.1] tracking-[-0.035em]">Credit Line</h1>
          <p className="mt-2 text-[14.5px] text-t2">Borrow USDC against your Solana portfolio</p>
        </div>
        <div className="flex gap-2">
          <Chip>
            Pool liquidity <b>{usd(poolCash, 0)}</b>
          </Chip>
          <Chip>
            Borrow APR from <b>{live ? pct(live.pool.baseApr - Math.max(...live.tiers.map((t) => t.discount))) : "7.80%"}</b>
          </Chip>
        </div>
      </div>
      <section className="grid grid-cols-[minmax(0,1fr)_384px] gap-4">
        <PortfolioPanel />
        <DrawPanel form={form} onApply={onApply} />
      </section>
      <div className="mt-4">
        <CreditHero p={form.projection} />
      </div>
      {full && (
        <>
          <CollateralPanel onStressTest={runStressTest} />
          <section className="mt-4 grid grid-cols-[1.35fr_1fr] gap-4">
            <div ref={stressRef}>
              <StressPanel highlight={highlightStress} />
            </div>
            <AutopayPanel />
          </section>
        </>
      )}
    </main>
  );
}
