"use client";

import { motion } from "motion/react";
import { ChevronDown, Flame, Shield, ShieldCheck, Zap, type LucideIcon } from "lucide-react";
import { useState } from "react";
import { Chip, KV, Label, StatusDot, Swatch, Tag, Token } from "@/components/ui";
import { EASE, Num } from "@/components/motion";
import { Segmented } from "@/components/Segmented";
import { LineChart, axisDates, dateLabel, type ChartLine } from "@/components/charts/LineChart";
import { useAccount, useToast, type Live, type Sample } from "@/components/app/providers";
import { displayAmount, money, usd } from "@/lib/account";
import { axisTimes, inRange, niceMax, series, smoothPath, timeLabel, type Point } from "@/lib/chart";
import { compactUsd } from "@/lib/markets";

type Tranche = "senior" | "junior";
const TRANCHES = {
  senior: {
    name: "Senior",
    token: "sUSDC",
    apy: 0.069,
    color: "#3ddc97",
    tone: "green" as const,
    badge: Shield,
    tag: { icon: ShieldCheck, text: "Protected" },
    blurb: "Base yield minus a 20% protection fee. Losses reach seniors only after the insurance fund and the entire junior tranche.",
    deposits: "$9.00M",
    exit: "Instant",
    lossOrder: "3rd",
    option: "Protected, instant exit",
  },
  junior: {
    name: "Junior",
    token: "jUSDC",
    apy: 0.242,
    color: "#ffa24c",
    tone: "orange" as const,
    badge: Zap,
    tag: { icon: Flame, text: "First loss" },
    blurb: "Base yield, the senior protection fee and every risk premium. Absorbs bad debt right after the insurance fund.",
    deposits: "$1.00M",
    exit: "7-14 days",
    lossOrder: "2nd",
    option: "First loss, 7 to 14 day cooldown",
  },
};

/* 365 days; the last 90 match the approved mockup. */
const extend = (last90: number[], start: number, vol: number, seed: number) => [...series(276, start, last90[0], vol, seed).slice(0, -1), ...last90];
const SENIOR_APY = extend(series(90, 6.3, 6.9, 0.22, 11), 5.4, 0.25, 21);
const JUNIOR_APY = extend(series(90, 20.4, 24.2, 1.3, 5), 16.8, 1.4, 22);
const UTIL = extend(series(90, 71, 80, 2.2, 9), 58, 2.4, 23);
const SENIOR_DEP = extend(series(90, 7.6, 9.0, 0.12, 31), 4.2, 0.15, 24);
const JUNIOR_DEP = extend(series(90, 0.82, 1.0, 0.03, 32), 0.4, 0.03, 25);

const METRICS = ["APY", "Utilization", "Deposits"] as const;
type Metric = (typeof METRICS)[number];
const EARN_RANGES = ["30D", "90D", "1Y"] as const;
type EarnRange = (typeof EARN_RANGES)[number];
const DAYS: Record<EarnRange, number> = { "30D": 30, "90D": 90, "1Y": 365 };
const MOCK_90D_LABELS = ["Aug 16", "Sep 1", "Sep 15", "Oct 1", "Oct 15", "Nov 1", "Nov 14"];
const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
const whole = (v: number) => Math.round(v * 100);

function Sparkline({ data, color }: { data: number[]; color: string }) {
  const w = 200;
  const h = 56;
  const mn = Math.min(...data);
  const mx = Math.max(...data);
  // A flat series sits on the middle line
  const pts: Point[] = data.map((v, i) => [(i / (data.length - 1)) * (w - 6) + 3, mx > mn ? h - 6 - ((v - mn) / (mx - mn)) * (h - 12) : h / 2]);
  const d = smoothPath(pts);
  const id = `spark-${color.slice(1)}`;
  const end = pts[pts.length - 1];
  return (
    <svg width={w} height={h} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity={0.25} />
          <stop offset="1" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <motion.path d={`${d} L${w - 3},${h} L3,${h} Z`} fill={`url(#${id})`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 1, delay: 0.6 }} />
      <motion.path d={d} fill="none" stroke={color} strokeWidth={1.75} initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ duration: 1.4, ease: EASE }} />
      <motion.circle cx={end[0]} cy={end[1]} r={3} fill={color} initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ delay: 1.3, type: "spring", stiffness: 400, damping: 18 }} />
    </svg>
  );
}

function TrancheCard({ id, selected, onSelect }: { id: Tranche; selected: boolean; onSelect: () => void }) {
  const { live } = useAccount();
  const t = TRANCHES[id];
  const Badge: LucideIcon = t.badge;
  const TagIcon = t.tag.icon;
  const pool = live?.pool;
  const stat = pool?.[id];
  // A deployment whose admin has not opened the junior tranche yet
  const soon = !!pool && !stat;
  const apy = pool ? (stat?.apy ?? null) : t.apy;
  const apyHistory = live ? inRange(live.samples, 90).map((s) => s.apy[id]) : (id === "senior" ? SENIOR_APY : JUNIOR_APY).slice(-90);
  const fee = pool ? whole(pool.protectionFee) : 0;
  const blurb = !stat
    ? t.blurb
    : id === "junior"
      ? `Lender yield plus a protection fee of up to ${fee}% of senior interest, paid in full once junior lenders hold a tenth of the pool. Takes losses before senior lenders, after the insurance reserve and the protocol's uncollected fees.`
      : pool?.junior
        ? `Lender yield minus a protection fee of up to ${fee}%, which scales with how much junior money stands in front. Takes losses only after the insurance reserve, the protocol's uncollected fees and every junior lender.`
        : "Lender yield from borrower interest. Takes losses only after the insurance reserve and the protocol's uncollected fees.";
  const stats = soon
    ? ["-", "-", "-", "-"]
    : stat
      ? [compactUsd(stat.assets), stat.sharePrice.toFixed(4), "Instant", id === "senior" && pool?.junior ? "3rd" : "2nd"]
      : [t.deposits, id === "senior" ? "1.0412" : "1.1876", t.exit, t.lossOrder];
  return (
    <motion.button
      type="button"
      onClick={onSelect}
      disabled={soon}
      aria-pressed={selected}
      whileHover={soon ? undefined : { y: -2 }}
      className={`panel relative overflow-hidden px-[26px] pt-6 text-left transition-[border-color,box-shadow] duration-300 ${soon ? "cursor-not-allowed" : "cursor-pointer"} ${
        selected ? "border-brand/35 shadow-[inset_0_0_0_1px_rgba(158,140,255,0.12),0_0_0_4px_rgba(158,140,255,0.05)]" : soon ? "" : "hover:border-line-2"
      }`}
    >
      <div className="pointer-events-none absolute -right-20 -top-[120px] h-[300px] w-[360px] rounded-full opacity-[0.22] blur-[60px]" style={{ background: t.color }} />
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="relative grid size-10 place-items-center rounded-xl border border-line-2 bg-s2">
            <Token src="/tokens/usdc.webp" size={24} />
            <span className="absolute -bottom-[5px] -right-[5px] grid size-[18px] place-items-center rounded-md shadow-[0_0_0_2px_var(--color-s1)]" style={{ background: t.color }}>
              <Badge size={11} strokeWidth={2.5} className="text-[#09090b]" />
            </span>
          </div>
          <div>
            <div className="text-[17px] font-medium tracking-[-0.02em]">{t.name}</div>
            <div className="text-[13px] text-t3">{t.token}</div>
          </div>
        </div>
        {soon ? (
          <Tag>Coming soon</Tag>
        ) : (
          <Tag tone={t.tone}>
            <TagIcon />
            {t.tag.text}
          </Tag>
        )}
      </div>
      <div className="mt-[26px] flex items-end justify-between">
        <div>
          <Label>Net APY</Label>
          <div className="mt-2 text-[56px] font-medium leading-none tracking-[-0.045em]" style={{ color: apy === null ? "var(--color-t3)" : t.color }}>
            {apy === null ? "-" : <Num value={apy * 100} decimals={2} suffix="%" countUp />}
            <span className="ml-2 text-base font-normal tracking-normal text-t3">APY</span>
          </div>
        </div>
        {apy !== null && <Sparkline data={apyHistory} color={t.color} />}
      </div>
      <div className="mt-3 text-[13.5px] text-t2">{blurb}</div>
      <div className="-mx-[26px] mt-[22px] grid grid-cols-4 border-t border-line pb-5">
        {["Deposits", "Share price", "Withdrawals", "Loss order"].map((k, i) => (
          <div key={k} className={`px-[26px] pt-3.5 ${i ? "border-l border-line" : ""}`}>
            <Label>{k}</Label>
            <div className="mt-1 text-[15px] font-medium">{stats[i]}</div>
          </div>
        ))}
      </div>
    </motion.button>
  );
}

type History = Record<Metric, { lines: ChartLine[]; yMax: number; yTicks: number[]; fmtY: (v: number) => string; fmtValue: (v: number) => string; stats: { label: string; color?: string; value: string }[] }>;

/** The same three charts drawn from on-chain readings taken this session, with the junior series once that tranche is open */
function liveHistory(live: Live, samples: Sample[], range: EarnRange): History {
  const { senior, junior, avgApr, utilization, kink } = live.pool;
  const axis = (yMax: number) => ({ yMax, yTicks: [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax) });
  const percent = (digits: number) => ({ fmtY: (v: number) => `${+v.toFixed(2)}%`, fmtValue: (v: number) => `${v.toFixed(digits)}%` });
  const line = (id: Tranche, data: number[], fill: number): ChartLine => ({ key: id, label: TRANCHES[id].name, color: TRANCHES[id].color, data, fill });
  const of = (pick: (s: Sample) => Record<Tranche, number>, scale: number) => ({ senior: samples.map((s) => pick(s).senior * scale), junior: samples.map((s) => pick(s).junior * scale) });
  const [apy, deposits] = [of((s) => s.apy, 100), of((s) => s.supplied, 1)];
  const used = samples.map((s) => s.utilization * 100);
  const last = samples.length - 1;
  const change = deposits.senior[last] + deposits.junior[last] - deposits.senior[0] - deposits.junior[0];
  return {
    APY: {
      lines: [...(junior ? [line("junior", apy.junior, 0.2)] : []), line("senior", apy.senior, 0.12)],
      ...axis(niceMax(Math.max(...apy.senior, ...apy.junior))),
      ...percent(2),
      stats: [
        { label: `Senior APY, ${range} avg`, color: "var(--color-green)", value: `${avg(apy.senior).toFixed(2)}%` },
        ...(junior ? [{ label: `Junior APY, ${range} avg`, color: "var(--color-orange)", value: `${avg(apy.junior).toFixed(2)}%` }] : []),
        { label: "Borrower APR", value: `${(avgApr * 100).toFixed(2)}%` },
      ],
    },
    Utilization: {
      lines: [{ key: "util", label: "Utilization", color: "#9e8cff", data: used, fill: 0.24 }],
      ...axis(100),
      ...percent(1),
      stats: [
        { label: "Utilization now", color: "var(--color-brand)", value: `${(utilization * 100).toFixed(1)}%` },
        { label: `${range} average`, value: `${avg(used).toFixed(1)}%` },
        { label: "Rate kink", value: `${(kink * 100).toFixed(1)}%` },
      ],
    },
    Deposits: {
      lines: [line("senior", deposits.senior, 0.16), ...(junior ? [line("junior", deposits.junior, 0.2)] : [])],
      ...axis(niceMax(Math.max(...deposits.senior, ...deposits.junior))),
      fmtY: compactUsd,
      fmtValue: compactUsd,
      stats: [
        { label: "Senior deposits", color: "var(--color-green)", value: compactUsd(senior.assets) },
        ...(junior ? [{ label: "Junior deposits", color: "var(--color-orange)", value: compactUsd(junior.assets) }] : []),
        { label: `${range} change`, value: `${change < 0 ? "-" : "+"}${compactUsd(Math.abs(change))}` },
      ],
    },
  };
}

function YieldHistory() {
  const { live } = useAccount();
  const [metric, setMetric] = useState<Metric>("APY");
  const [range, setRange] = useState<EarnRange>("90D");
  const n = DAYS[range];
  const s = (a: number[]) => a.slice(-n);
  const samples = live && inRange(live.samples, n);
  const config = (samples ? liveHistory(live, samples, range) : {
    APY: {
      lines: [
        { key: "jun", label: "Junior", color: "#ffa24c", data: s(JUNIOR_APY), fill: 0.2 },
        { key: "sen", label: "Senior", color: "#3ddc97", data: s(SENIOR_APY), fill: 0.12 },
      ],
      yMax: 32,
      yTicks: [0, 8, 16, 24, 32],
      fmtY: (v: number) => `${v}%`,
      fmtValue: (v: number) => `${v.toFixed(2)}%`,
      stats: [
        { label: `Senior APY, ${range} avg`, color: "var(--color-green)", value: `${avg(s(SENIOR_APY)).toFixed(2)}%` },
        { label: `Junior APY, ${range} avg`, color: "var(--color-orange)", value: `${avg(s(JUNIOR_APY)).toFixed(2)}%` },
        { label: "Borrower APR", value: "12.00%" },
      ],
    },
    Utilization: {
      lines: [{ key: "util", label: "Utilization", color: "#9e8cff", data: s(UTIL), fill: 0.24 }],
      yMax: 100,
      yTicks: [0, 25, 50, 75, 100],
      fmtY: (v: number) => `${v}%`,
      fmtValue: (v: number) => `${v.toFixed(1)}%`,
      stats: [
        { label: "Utilization now", color: "var(--color-brand)", value: "80.0%" },
        { label: `${range} average`, value: `${avg(s(UTIL)).toFixed(1)}%` },
        { label: "Rate kink", value: "90.0%" },
      ],
    },
    Deposits: {
      lines: [
        { key: "sdep", label: "Senior", color: "#3ddc97", data: s(SENIOR_DEP), fill: 0.16 },
        { key: "jdep", label: "Junior", color: "#ffa24c", data: s(JUNIOR_DEP), fill: 0.2 },
      ],
      yMax: 10,
      yTicks: [0, 2.5, 5, 7.5, 10],
      fmtY: (v: number) => `$${v}M`,
      fmtValue: (v: number) => `$${v.toFixed(2)}M`,
      stats: [
        { label: "Senior deposits", color: "var(--color-green)", value: "$9.00M" },
        { label: "Junior deposits", color: "var(--color-orange)", value: "$1.00M" },
        { label: `${range} change`, value: `+$${(SENIOR_DEP.at(-1)! + JUNIOR_DEP.at(-1)! - s(SENIOR_DEP)[0] - s(JUNIOR_DEP)[0]).toFixed(2)}M` },
      ],
    },
  })[metric];

  return (
    <div className="panel">
      <div className="flex items-center justify-between px-[22px] pt-[18px]">
        <h3 className="text-[15px] font-medium tracking-[-0.01em]">Yield history</h3>
        <div className="flex items-center gap-2.5">
          <Segmented small label="Metric" items={METRICS} value={metric} onChange={setMetric} />
          <Segmented small label="Time range" items={EARN_RANGES} value={range} onChange={setRange} />
        </div>
      </div>
      <div className="px-[22px] pb-[22px] pt-3.5">
        <div className="flex items-center gap-7">
          {config.stats.map((st) => (
            <div key={st.label}>
              <Label>
                {"color" in st && st.color && <Swatch color={st.color} />}
                {st.label}
              </Label>
              <div className="mt-1 text-2xl font-medium tracking-[-0.03em]">{st.value}</div>
            </div>
          ))}
        </div>
        <div className="mt-2">
          <LineChart
            width={754}
            height={382}
            lines={config.lines}
            yMax={config.yMax}
            yTicks={config.yTicks}
            fmtY={config.fmtY}
            fmtValue={config.fmtValue}
            xLabels={samples ? axisTimes(samples) : range === "90D" ? MOCK_90D_LABELS : axisDates(n)}
            titleAt={(i) => (samples ? timeLabel(samples[i].at, true) : dateLabel(n - 1 - i, true))}
            restIndex={samples ? samples.length - 1 : Math.round((n - 1) * (58 / 89))}
            animKey={`${metric}-${range}`}
            straight={!!samples}
            ariaLabel={`${metric} over the last ${range}`}
          />
        </div>
      </div>
    </div>
  );
}

function SupplyPanel({ tranche, onTranche }: { tranche: Tranche; onTranche: (t: Tranche) => void }) {
  const { positions, sharePrice, adjustPosition, walletUsdc, poolCash, live } = useAccount();
  const toast = useToast();
  const [mode, setMode] = useState<"Supply" | "Withdraw">("Supply");
  const [raw, setRaw] = useState(live ? "" : "10000.00");
  const [status, setStatus] = useState<"idle" | "signing" | "confirming">("idle");

  const t = TRANCHES[tranche];
  // Unknown for a tranche that is not open or holds nothing yet
  const apyOf = (id: Tranche) => (live ? (live.pool[id]?.apy ?? null) : TRANCHES[id].apy);
  const apy = apyOf(tranche);
  const amount = Number(raw) || 0;
  const max = mode === "Supply" ? walletUsdc : positions[tranche];
  const shares = amount / sharePrice[tranche];
  const error =
    amount <= 0
      ? "Enter an amount"
      : // A position is shown rounded to the cent, and typing that figure back in has to work
        amount > (mode === "Supply" ? max : Math.round(max * 100) / 100) + 1e-9
        ? mode === "Supply"
          ? "Exceeds wallet balance"
          : `Exceeds your ${t.token} position`
        : live && mode === "Withdraw" && amount > poolCash
          ? "Exceeds pool liquidity"
          : null;
  const label = status === "signing" ? "Confirm in wallet..." : status === "confirming" ? "Confirming on Solana..." : (error ?? `${mode} ${money(amount).replace(/\.00$/, "")} USDC`);

  const submit = async () => {
    if (error || status !== "idle") return;
    const ok = await adjustPosition(tranche, mode === "Supply" ? amount : -amount, setStatus);
    setStatus("idle");
    if (!ok) return;
    if (mode === "Supply") {
      toast({ title: `Supplied ${money(amount)} USDC`, detail: `Received ${money(shares)} ${t.token}${apy === null ? "" : ` at ${(apy * 100).toFixed(2)}% APY`}` });
    } else if (tranche === "junior" && !live) {
      toast({ title: `Withdrawal of ${money(amount)} USDC queued`, detail: "Junior exits settle after a 7 to 14 day cooldown", tone: "info" });
    } else {
      toast({ title: `Withdrew ${money(amount)} USDC`, detail: `Burned ${money(shares)} ${t.token}` });
    }
    setRaw("");
  };

  return (
    <div className="panel">
      <div className="px-[22px] pb-[22px] pt-[18px]">
        <Segmented
          label="Action"
          items={["Supply", "Withdraw"] as const}
          value={mode}
          onChange={(m) => {
            setMode(m);
            setRaw("");
          }}
        />
        <div className="mb-2 mt-[18px]">
          <Label>Tranche</Label>
        </div>
        {(["senior", "junior"] as const).map((id) => {
          const o = TRANCHES[id];
          const on = id === tranche;
          const soon = !!live && !live.pool[id];
          const rate = apyOf(id);
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={soon}
              onClick={() => onTranche(id)}
              className={`mt-2 flex w-full items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors first-of-type:mt-0 ${soon ? "cursor-not-allowed" : "cursor-pointer"} ${
                on ? "border-brand/45 bg-brand/5" : soon ? "border-line bg-bg" : "border-line bg-bg hover:border-line-2"
              }`}
            >
              <Token src="/tokens/usdc.webp" size={20} />
              <div>
                <div className="font-medium">{o.name}</div>
                <div className="text-xs text-t3">{live && id === "junior" ? "First loss, instant exit" : o.option}</div>
              </div>
              <span className="ml-auto font-medium" style={{ color: rate === null ? "var(--color-t3)" : o.color }}>
                {soon ? "Soon" : rate === null ? "-" : `${(rate * 100).toFixed(2)}%`}
              </span>
              <span className={`ml-3 size-4 rounded-full transition-[border-width] duration-200 ${on ? "border-[5px] border-brand" : "border-[1.5px] border-line-2"}`} />
            </button>
          );
        })}
        <label className="mt-3.5 block rounded-[14px] border border-line bg-bg px-4 py-3.5 transition-colors focus-within:border-line-2">
          <div className="flex items-center justify-between">
            <Label>Amount</Label>
            <Label>
              {mode === "Supply" ? "Balance" : "Position"} {money(max)}
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
                if (/^\d*\.?\d{0,2}$/.test(v)) setRaw(v);
              }}
              onBlur={() => raw && setRaw((Number(raw) || 0).toFixed(2))}
              className="w-full min-w-0 bg-transparent text-[32px] font-medium tracking-[-0.035em] text-t1 outline-none placeholder:text-t3"
            />
            <span className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-line-2 bg-s3 pl-1.5 pr-2.5 font-medium">
              <Token src="/tokens/usdc.webp" size={20} />
              USDC
              <ChevronDown size={16} strokeWidth={1.75} className="text-t3" />
            </span>
          </div>
        </label>
        <div className="mt-3.5">
          <KV k={mode === "Supply" ? "You receive" : "You burn"}>
            <Num value={shares} decimals={2} /> {t.token}
          </KV>
          <KV k={mode === "Supply" ? "Projected 1Y earnings" : "Remaining position"}>
            {mode === "Supply" ? (
              <span className="text-green">
                +<Num value={amount * (apy ?? 0)} decimals={2} prefix="$" />
              </span>
            ) : (
              <Num value={Math.max(0, positions[tranche] - amount)} decimals={2} prefix="$" />
            )}
          </KV>
          <KV k="Exit">{tranche === "senior" || live ? "Instant, if liquidity allows" : "7 to 14 day cooldown"}</KV>
        </div>
        <motion.button
          type="button"
          onClick={submit}
          disabled={!!error || status !== "idle"}
          whileTap={!error && status === "idle" ? { scale: 0.98 } : undefined}
          className={`mt-4 flex h-12 w-full items-center justify-center gap-2.5 rounded-xl text-[15px] font-medium transition-colors ${
            error ? "cursor-not-allowed bg-s3 text-t3" : "cursor-pointer bg-[#f4f4f5] text-[#09090b] hover:bg-white"
          }`}
        >
          {status !== "idle" && <span className="inline-block size-4 animate-spin rounded-full border-2 border-[#09090b]/25 border-t-[#09090b]" aria-hidden />}
          {label}
        </motion.button>
      </div>
    </div>
  );
}

type Split = { share: number; color: string; label: string };
const SPLIT: Split[] = [
  { share: 0.59, color: "#3ddc97", label: "Senior yield" },
  { share: 0.31, color: "#ffa24c", label: "Junior yield" },
  { share: 0.1, color: "#a0a4ab", label: "Insurance fund" },
];

function Donut({ split, apr }: { split: Split[]; apr: number }) {
  const R = 48;
  const C = 2 * Math.PI * R;
  return (
    <motion.svg width={120} height={120} viewBox="0 0 120 120" initial="hidden" whileInView="shown" viewport={{ once: true, amount: 0.6 }} aria-label="Interest split">
      <circle cx={60} cy={60} r={R} fill="none" stroke="#181b20" strokeWidth={12} />
      {split.map((s, i) => (
        <motion.circle
          key={s.color}
          cx={60}
          cy={60}
          r={R}
          fill="none"
          stroke={s.color}
          strokeWidth={12}
          strokeDashoffset={-split.slice(0, i).reduce((off, x) => off + x.share, 0) * C}
          transform="rotate(-90 60 60)"
          variants={{ hidden: { strokeDasharray: `0 ${C}` }, shown: { strokeDasharray: `${s.share * C - 3} ${C}` } }}
          transition={{ duration: 0.9, delay: 0.15 + i * 0.25, ease: EASE }}
        />
      ))}
      <text x={60} y={56} textAnchor="middle" style={{ fill: "#ededef", font: "500 17px var(--font-geist-sans)" }}>
        {(apr * 100).toFixed(1)}%
      </text>
      <text x={60} y={73} textAnchor="middle" style={{ fill: "#62666e", font: "400 10.5px var(--font-geist-sans)" }}>
        borrow APR
      </text>
    </motion.svg>
  );
}

export function EarnDashboard() {
  const [tranche, setTranche] = useState<Tranche>("senior");
  const { live } = useAccount();
  const pool = live?.pool;
  const layer = (n: number, name: string, color: string, v: number) => {
    const share = pool && pool.supplied > 0 ? (v / pool.supplied) * 100 : 0;
    return { n, name, width: `${share}%`, color, value: compactUsd(v), share: `${share.toFixed(1)}% of pool` };
  };
  const waterfall = pool
    ? [
        layer(1, "Insurance fund", "var(--color-t2)", pool.reserves),
        pool.junior ? layer(2, "Junior tranche", "var(--color-orange)", pool.junior.assets) : { n: 2, name: "Junior tranche", width: "0%", color: "var(--color-s3)", value: "-", share: "Coming soon" },
        layer(3, "Senior lenders", "var(--color-green)", pool.senior.assets),
      ]
    : [
        { n: 1, name: "Insurance fund", width: "1%", color: "var(--color-t2)", value: "$100K", share: "1% of pool" },
        { n: 2, name: "Junior tranche", width: "10%", color: "var(--color-orange)", value: "$1.00M", share: "10% of pool" },
        { n: 3, name: "Senior lenders", width: "90%", color: "var(--color-green)", value: "$9.00M", share: "90% of pool" },
      ];
  const split: Split[] = pool
    ? [
        { share: pool.split.senior, color: "#3ddc97", label: "Senior yield" },
        ...(pool.junior ? [{ share: pool.split.junior, color: "#ffa24c", label: "Junior yield" }] : []),
        { share: pool.split.protocol, color: "#9e8cff", label: "Protocol" },
        { share: pool.split.insurance, color: "#a0a4ab", label: "Insurance fund" },
      ]
    : SPLIT;
  return (
    <main className="mx-auto max-w-[1280px] px-10 pb-16 pt-9">
      <div className="mb-7 flex items-end justify-between">
        <div>
          <h1 className="text-[32px] font-medium leading-[1.1] tracking-[-0.035em]">Earn</h1>
          <p className="mt-2 text-[14.5px] text-t2">Supply USDC to the credit pool. Yield comes only from borrower interest, paid through a rising share price.</p>
        </div>
        <div className="flex gap-2">
          <Chip>
            Total supplied <b>{usd(pool ? pool.supplied : 10_000_000, 0)}</b>
          </Chip>
          <Chip>
            Utilization <b>{`${((pool ? pool.utilization : 0.8) * 100).toFixed(1)}%`}</b>
          </Chip>
          <Chip>
            Bad debt <b>{usd(pool ? pool.badDebt : 0, 0)}</b>
          </Chip>
        </div>
      </div>

      <section className="grid grid-cols-2 gap-4">
        <TrancheCard id="senior" selected={tranche === "senior"} onSelect={() => setTranche("senior")} />
        <TrancheCard id="junior" selected={tranche === "junior"} onSelect={() => setTranche("junior")} />
      </section>

      <section className="mt-4 grid grid-cols-[minmax(0,1fr)_384px] gap-4">
        <YieldHistory />
        <SupplyPanel tranche={tranche} onTranche={setTranche} />
      </section>

      <section className="mt-4 grid grid-cols-[1.15fr_1fr_1fr] gap-4">
        <div className="panel">
          <div className="flex items-center justify-between px-[22px] pt-[18px]">
            <h3 className="text-[15px] font-medium tracking-[-0.01em]">Loss waterfall</h3>
            <span className="text-[12.5px] text-t3">Written down at liquidation</span>
          </div>
          <div className="px-[22px] pb-[22px] pt-2">
            {waterfall.map((w, i) => (
              <div key={w.n} className={`grid grid-cols-[28px_1fr_auto] items-center gap-3.5 py-3 ${i ? "border-t border-line" : ""}`}>
                <span className="grid size-[26px] place-items-center rounded-lg bg-s3 text-xs font-semibold text-t2">{w.n}</span>
                <div>
                  <div className="font-medium">{w.name}</div>
                  <div className="mt-2 flex h-1 overflow-hidden rounded-full bg-s3">
                    <motion.i
                      className="block h-full min-w-1.5 rounded-full"
                      style={{ background: w.color }}
                      initial={{ width: 0 }}
                      whileInView={{ width: w.width }}
                      viewport={{ once: true }}
                      transition={{ duration: 0.9, delay: 0.2 + i * 0.15, ease: EASE }}
                    />
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-medium">{w.value}</div>
                  <div className="mt-0.5 text-[12.5px] text-t3">{w.share}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="panel">
          <div className="flex items-center justify-between px-[22px] pt-[18px]">
            <h3 className="text-[15px] font-medium tracking-[-0.01em]">Coverage gate</h3>
            {live ? (
              <Tag>Coming soon</Tag>
            ) : (
              <Tag tone="green">
                <StatusDot />
                Open
              </Tag>
            )}
          </div>
          <div className="px-[22px] pb-[22px] pt-[18px]">
            <div className="flex items-baseline gap-2">
              {live ? <span className="text-[30px] font-medium tracking-[-0.03em] text-t3">-</span> : <Num value={16.1} decimals={1} suffix="%" countUp className="text-[30px] font-medium tracking-[-0.03em]" />}
              <span className="text-t3">junior / risky debt</span>
            </div>
            <div className="relative mt-[18px] h-2 rounded-full bg-s3">
              <motion.span
                className="absolute inset-y-0 left-0 rounded-full bg-green"
                initial={{ width: 0 }}
                whileInView={{ width: live ? "0%" : "53.7%" }}
                viewport={{ once: true }}
                transition={{ duration: 1, delay: 0.2, ease: EASE }}
              />
              <span className="absolute -top-1.5 left-[33.3%] h-5 w-0.5 rounded-[1px] bg-t1" />
            </div>
            <div className="mt-2 flex justify-between text-[11.5px] text-t3">
              <span>0%</span>
              <span className="ml-[18%]">Min 10%</span>
              <span>30%</span>
            </div>
            <div className="mt-4 text-[13px] text-t2">If juniors leave and coverage drops below the minimum, new draws against memecoins and thin stocks pause automatically.</div>
          </div>
        </div>
        <div className="panel">
          <div className="px-[22px] pt-[18px]">
            <h3 className="text-[15px] font-medium tracking-[-0.01em]">Where interest goes</h3>
          </div>
          <div className="flex items-center gap-5 px-[22px] pb-[22px] pt-[18px]">
            <Donut split={split} apr={pool ? pool.avgApr : 0.12} />
            <div className="flex-1">
              {split.map((s) => (
                <KV key={s.label} k={<span className="flex items-center gap-2"><Swatch color={s.color} />{s.label}</span>}>{whole(s.share)}%</KV>
              ))}
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
