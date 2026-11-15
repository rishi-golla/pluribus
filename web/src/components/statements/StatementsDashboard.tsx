"use client";

import { AnimatePresence, motion } from "motion/react";
import { ArrowDownLeft, ArrowUpRight, Award, Calendar, Check, ChevronDown, Download, FileSpreadsheet, Percent, Repeat, TrendingDown, TrendingUp, type LucideIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { KV, Label, Swatch, Tag, Token } from "@/components/ui";
import { EASE, Num } from "@/components/motion";
import { Segmented } from "@/components/Segmented";
import { useAccount, useToast } from "@/components/app/providers";
import { summarize, usd, type EventKind, type MonthSummary } from "@/lib/account";

const KIND: Record<EventKind, { label: string; icon: LucideIcon; color: string }> = {
  draw: { label: "Draw", icon: ArrowDownLeft, color: "var(--color-brand)" },
  repay: { label: "Repayment", icon: ArrowUpRight, color: "var(--color-green)" },
  autopay: { label: "Autopay", icon: Repeat, color: "var(--color-green)" },
  interest: { label: "Interest accrued", icon: Percent, color: "var(--color-orange)" },
  tier: { label: "Tier upgrade", icon: Award, color: "var(--color-brand)" },
};
const FILTERS = ["All", "Draws", "Repayments", "Autopay", "Interest"] as const;
type Filter = (typeof FILTERS)[number];
const FILTER_KIND: Record<Exclude<Filter, "All">, EventKind> = { Draws: "draw", Repayments: "repay", Autopay: "autopay", Interest: "interest" };
const SOURCE_ICON = { orca: "orca.png", raydium: "ray.webp" } as const;

const shortDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "2-digit", timeZone: "UTC" });
const signed = (kind: EventKind, amount: number) => (kind === "tier" ? "-" : `${kind === "draw" || kind === "interest" ? "+" : "-"}${usd(amount)}`);

function Waterfall({ s }: { s: MonthSummary }) {
  const W = 805;
  const H = 270;
  const steps: [string, number, "total" | "up" | "down", string][] = [
    ["Opening", s.opening, "total", "#2a2e35"],
    ["Draws", s.draws, "up", "#9e8cff"],
    ["Interest", s.interest, "up", "#ffa24c"],
    ["Repayments", -s.repayments, "down", "#3ddc97"],
    ["Autopay", -s.autopay, "down", "#3ddc97"],
    ["Closing", s.closing, "total", "#ededef"],
  ];
  const yMax = Math.ceil(Math.max(s.opening, s.closing, s.opening + s.draws + s.interest) / 6000) * 6000;
  const pt = 26;
  const ih = H - pt - 40;
  const Y = (v: number) => pt + ih - (v / yMax) * ih;
  const gap = 28;
  const bw = (W - 52 - gap * 5) / 6;
  const ticks = Array.from({ length: yMax / 6000 + 1 }, (_, i) => i * 6000);
  let run = 0;
  const bars = steps.map(([label, v, kind, color]) => {
    let top: number;
    let bot: number;
    if (kind === "total") {
      top = v;
      bot = 0;
      run = v;
    } else {
      const next = run + v;
      top = Math.max(run, next);
      bot = Math.min(run, next);
      run = next;
    }
    return { label, v, kind, color, top, bot, after: run };
  });

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} className="text-[11px] [&_text]:fill-t3" role="img" aria-label="Balance movement for the month">
      {ticks.map((v) => (
        <g key={v}>
          <line x1={0} x2={W - 52} y1={Y(v)} y2={Y(v)} stroke="rgba(255,255,255,0.05)" />
          <text x={W} y={Y(v) + 4} textAnchor="end">
            ${v / 1000}K
          </text>
        </g>
      ))}
      {bars.map((b, i) => {
        const x = i * (bw + gap);
        const h = Math.max(3, Y(b.bot) - Y(b.top));
        const txt = b.kind === "total" ? usd(b.v) : `${b.v >= 0 ? "+" : "-"}${usd(Math.abs(b.v))}`;
        return (
          <g key={b.label}>
            <motion.rect
              x={x}
              width={bw}
              rx={6}
              fill={b.color}
              initial={{ y: Y(b.bot), height: 0 }}
              animate={{ y: Y(b.top), height: h }}
              transition={{ duration: 0.7, delay: 0.1 + i * 0.12, ease: EASE }}
            />
            {i < bars.length - 1 && (
              <motion.line
                x1={x + bw}
                x2={x + bw + gap}
                y1={Y(b.after)}
                y2={Y(b.after)}
                stroke="rgba(255,255,255,0.25)"
                strokeDasharray="3 3"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.5 + i * 0.12 }}
              />
            )}
            <motion.text
              x={x + bw / 2}
              y={Y(b.top) - 9}
              textAnchor="middle"
              style={{ fill: "#ededef", fontSize: 12.5, fontWeight: 500 }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.45 + i * 0.12 }}
            >
              {txt}
            </motion.text>
            <text x={x + bw / 2} y={H - 14} textAnchor="middle" fontSize={12}>
              {b.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function MonthPicker({ months, value, onChange }: { months: { key: string; label: string; inProgress?: boolean }[]; value: string; onChange: (k: string) => void }) {
  const [open, setOpen] = useState(false);
  const current = months.find((m) => m.key === value)!;
  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-[10px] border border-line-2 bg-s2 px-3.5 text-[13.5px] font-medium transition-colors hover:bg-s3"
      >
        <Calendar size={16} strokeWidth={1.75} />
        {current.label}
        <ChevronDown size={16} strokeWidth={1.75} className={`text-t3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      <AnimatePresence>
        {open && (
          <>
            <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
            <motion.ul
              role="listbox"
              className="glass-tip absolute right-0 z-30 mt-2 w-56 rounded-xl border border-line-2 p-1.5"
              initial={{ opacity: 0, y: -6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.98 }}
              transition={{ duration: 0.18 }}
            >
              {[...months].reverse().map((m) => (
                <li key={m.key}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={m.key === value}
                    onClick={() => {
                      onChange(m.key);
                      setOpen(false);
                    }}
                    className="flex w-full cursor-pointer items-center justify-between rounded-lg px-3 py-2 text-left text-[13.5px] transition-colors hover:bg-white/[0.05]"
                  >
                    <span>
                      {m.label}
                      {m.inProgress && <span className="ml-2 text-xs text-t3">In progress</span>}
                    </span>
                    {m.key === value && <Check size={15} strokeWidth={2} className="text-brand" />}
                  </button>
                </li>
              ))}
            </motion.ul>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

export function StatementsDashboard() {
  const { months, debt } = useAccount();
  const toast = useToast();
  const summaries = useMemo(() => summarize(months, debt), [months, debt]);
  const [monthKey, setMonthKey] = useState("2026-10");
  const [filter, setFilter] = useState<Filter>("All");
  const month = months.find((m) => m.key === monthKey)!;
  const s = summaries[monthKey];
  const idx = months.findIndex((m) => m.key === monthKey);
  const prev = idx > 0 ? summaries[months[idx - 1].key] : null;
  const change = prev ? s.closing - prev.closing : 0;
  const rows = filter === "All" ? s.rows : s.rows.filter((r) => r.kind === FILTER_KIND[filter]);
  const [y, mo] = monthKey.split("-").map(Number);
  const lastDay = month.inProgress ? 14 : new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const short = month.short;
  const covered = s.interest > 0 ? s.autopay / s.interest : 0;

  const exportCsv = () => {
    const header = "date,type,detail,amount_usdc,balance_usdc,transaction";
    const lines = [...s.rows].reverse().map((r) => [r.date, KIND[r.kind].label, `"${r.detail}"`, r.kind === "tier" ? 0 : r.amount, r.balance.toFixed(2), r.tx].join(","));
    const url = URL.createObjectURL(new Blob([[header, ...lines].join("\n")], { type: "text/csv" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: `pluribus-statement-${monthKey}.csv` });
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: "Statement exported", detail: `${s.rows.length} events from ${month.label}` });
  };

  return (
    <main className="mx-auto max-w-[1280px] px-10 pb-16 pt-9">
      <div className="mb-7 flex items-end justify-between">
        <div>
          <h1 className="text-[32px] font-medium leading-[1.1] tracking-[-0.035em]">Statements</h1>
          <p className="mt-2 text-[14.5px] text-t2">Monthly account statements, built from indexed on-chain events.</p>
        </div>
        <div className="flex gap-2">
          <MonthPicker months={months} value={monthKey} onChange={setMonthKey} />
          <button type="button" onClick={exportCsv} className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-[10px] border border-line-2 bg-s2 px-3.5 text-[13.5px] font-medium transition-colors hover:bg-s3">
            <FileSpreadsheet size={16} strokeWidth={1.75} />
            Export CSV
          </button>
          <button type="button" onClick={() => window.print()} className="inline-flex h-9 cursor-pointer items-center gap-2 rounded-[10px] bg-[#f4f4f5] px-3.5 text-[13.5px] font-medium text-[#09090b] transition-colors hover:bg-white">
            <Download size={16} strokeWidth={1.75} />
            Download PDF
          </button>
        </div>
      </div>

      <section className="panel grid grid-cols-[340px_1px_minmax(0,1fr)]">
        <div className="p-[26px]">
          <Label>{month.inProgress ? `Balance so far, ${short} 14` : `Closing balance, ${short} ${lastDay}`}</Label>
          <Num value={s.closing} decimals={2} prefix="$" className="mt-2.5 block text-[40px] font-medium leading-[1.05] tracking-[-0.04em] tabular-nums" />
          {prev && (
            <div className="mt-2.5 flex">
              <Tag tone={change >= 0 ? "orange" : "green"}>
                {change >= 0 ? <TrendingUp /> : <TrendingDown />}
                {change >= 0 ? "+" : "-"}
                {usd(Math.abs(change))} vs {months[idx - 1].short}
              </Tag>
            </div>
          )}
          <div className="mb-3.5 mt-[22px] h-px bg-line" />
          <KV k="Account">
            <span className="font-mono text-[12.5px]">4fQm...Z2tk</span>
          </KV>
          <KV k="Period">
            {short} 1 to {short} {lastDay}, {y}
          </KV>
          <KV k="Average APR">{(month.avgApr * 100).toFixed(2)}%</KV>
          <KV k="Rate tier">
            <Tag tone="brand">{month.tier}</Tag>
          </KV>
        </div>
        <div className="self-stretch bg-line" />
        <div className="p-[26px]">
          <div className="flex items-center justify-between">
            <h3 className="text-[15px] font-medium">Balance movement</h3>
            <div className="flex gap-4 text-[12.5px] text-t3">
              <span className="flex items-center gap-1.5">
                <Swatch color="var(--color-brand)" />
                Increases debt
              </span>
              <span className="flex items-center gap-1.5">
                <Swatch color="var(--color-green)" />
                Reduces debt
              </span>
            </div>
          </div>
          <div className="mt-2.5">
            <Waterfall key={monthKey} s={s} />
          </div>
        </div>
      </section>

      <section className="mt-4 grid grid-cols-[minmax(0,1fr)_372px] gap-4">
        <div className="panel">
          <div className="flex items-center justify-between px-[22px] pt-[18px]">
            <h3 className="flex items-center gap-2 text-[15px] font-medium tracking-[-0.01em]">
              Activity <span className="font-normal text-t3">{s.rows.length} events</span>
            </h3>
            <Segmented small label="Filter activity" items={FILTERS} value={filter} onChange={setFilter} />
          </div>
          <table className="mt-3.5 w-full border-collapse">
            <thead>
              <tr className="text-[12.5px] text-t3 [&_th]:px-4 [&_th]:pb-3 [&_th]:font-normal">
                <th className="pl-[22px] text-left">Activity</th>
                <th className="text-left">Date</th>
                <th className="text-right">Amount</th>
                <th className="text-right">Balance</th>
                <th className="pr-[22px] text-right">Transaction</th>
              </tr>
            </thead>
            <tbody>
              
                {rows.map((r) => {
                  const k = KIND[r.kind];
                  const Icon = k.icon;
                  return (
                    <motion.tr
                      key={r.id}
                            initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                            transition={{ duration: 0.2 }}
                      className="border-t border-line transition-colors hover:bg-white/[0.02] [&_td]:px-4 [&_td]:py-3.5"
                    >
                      <td className="pl-[22px]">
                        <div className="flex items-center gap-3">
                          <span className="grid size-8 place-items-center rounded-[10px] border border-line bg-s3" style={{ color: k.color }}>
                            <Icon size={15} strokeWidth={1.75} />
                          </span>
                          <div>
                            <div className="font-medium">{k.label}</div>
                            <div className="mt-0.5 flex items-center gap-1.5 text-[12.5px] text-t3">
                              {r.source && <Token src={`/tokens/${SOURCE_ICON[r.source]}`} size={16} />}
                              {r.detail}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="text-t2">{shortDate(r.date)}</td>
                      <td className={`text-right font-medium ${r.kind === "repay" || r.kind === "autopay" ? "text-green" : r.kind === "tier" ? "text-t3" : ""}`}>{signed(r.kind, r.amount)}</td>
                      <td className="text-right text-t2">{usd(r.balance)}</td>
                      <td className="pr-[22px] text-right">
                        <a href="#" className="inline-flex items-center justify-end gap-1.5 font-mono text-[12.5px] text-t3 transition-colors hover:text-t1">
                          {r.tx}
                          <ArrowUpRight size={13} strokeWidth={1.75} />
                        </a>
                      </td>
                    </motion.tr>
                  );
                })}
            </tbody>
          </table>
          {!rows.length && <div className="px-[22px] py-10 text-center text-t3">No {filter.toLowerCase()} this month.</div>}
        </div>

        <div className="grid content-start gap-4">
          <div className="panel">
            <div className="flex items-center justify-between px-[22px] pt-[18px]">
              <h3 className="text-[15px] font-medium tracking-[-0.01em]">Rate tier</h3>
              <span className="text-[12.5px] text-t3">142 healthy days</span>
            </div>
            <div className="px-[22px] pb-[22px] pt-[18px]">
              <div className="flex items-baseline gap-2.5">
                <span className="text-[30px] font-medium tracking-[-0.03em]">Tier 3</span>
                <span className="font-medium text-green">-1.10% APR</span>
              </div>
              <div className="mt-[18px] grid grid-cols-4 gap-1.5">
                {[100, 100, 100, 37].map((w, i) => (
                  <div key={i} className="h-1.5 overflow-hidden rounded-full bg-s3">
                    <motion.i
                      className="block h-full bg-brand"
                      initial={{ width: 0 }}
                      whileInView={{ width: `${w}%` }}
                      viewport={{ once: true }}
                      transition={{ duration: 0.5, delay: 0.15 + i * 0.18, ease: EASE }}
                    />
                  </div>
                ))}
              </div>
              <div className="mt-2 grid grid-cols-4 gap-1.5 text-xs text-t3">
                {[
                  ["Tier 1", "0%"],
                  ["Tier 2", "-0.70%"],
                  ["Tier 3", "-1.10%"],
                  ["Tier 4", "-1.50%"],
                ].map(([t, r]) => (
                  <div key={t} className={t === "Tier 3" ? "text-t1" : ""}>
                    {t}
                    <b className={`mt-0.5 block text-[13px] font-medium ${t === "Tier 3" ? "text-t1" : "text-t2"}`}>{r}</b>
                  </div>
                ))}
              </div>
              <div className="mt-4 text-[13px] text-t2">38 more healthy days to Tier 4. Your risk premium resets if the account is liquidated.</div>
            </div>
          </div>
          <div className="panel">
            <div className="px-[22px] pt-[18px]">
              <h3 className="text-[15px] font-medium tracking-[-0.01em]">Autopay vs interest</h3>
            </div>
            <div className="px-[22px] pb-[22px] pt-[18px]">
              <Label className="mb-1.5">LP fees applied to debt</Label>
              <motion.div
                key={`a-${monthKey}`}
                className="flex h-7 items-center rounded-lg bg-green-dim px-2.5 text-[12.5px] font-medium text-green"
                initial={{ width: "20%" }}
                animate={{ width: `${Math.max(20, Math.min(100, (s.autopay / Math.max(s.autopay, s.interest)) * 100))}%` }}
                transition={{ duration: 0.7, ease: EASE }}
              >
                {usd(s.autopay)}
              </motion.div>
              <Label className="mb-1.5 mt-3">Interest accrued</Label>
              <motion.div
                key={`i-${monthKey}`}
                className="flex h-7 items-center whitespace-nowrap rounded-lg bg-orange-dim px-2.5 text-[12.5px] font-medium text-orange"
                initial={{ width: "20%" }}
                animate={{ width: `${Math.max(20, Math.min(100, (s.interest / Math.max(s.autopay, s.interest)) * 100))}%` }}
                transition={{ duration: 0.7, ease: EASE, delay: 0.1 }}
              >
                {usd(s.interest)}
              </motion.div>
              <div className="mb-3 mt-[18px] h-px bg-line" />
              <div className="flex items-center justify-between">
                <span className="text-t2">Autopay covered your interest</span>
                <span className="text-xl font-medium tracking-[-0.03em] text-green">{covered.toFixed(1)}x</span>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
