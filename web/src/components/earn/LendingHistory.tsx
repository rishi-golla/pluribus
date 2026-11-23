"use client";

import { motion } from "motion/react";
import { ArrowDownLeft, ArrowUpRight, Check, Clock, Repeat, X, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Tag } from "@/components/ui";
import { Segmented } from "@/components/Segmented";
import type { Live } from "@/components/app/providers";
import { money, shortKey, usd } from "@/lib/account";
import { explorer, isSignature } from "@/lib/explorer";
import { DEMO_LENDING, fetchLending, type LenderEvent } from "@/lib/lending";

const TRANCHES = {
  senior: { name: "Senior", token: "sUSDC", tone: "green" as const },
  junior: { name: "Junior", token: "jUSDC", tone: "orange" as const },
};

const LENDING_KIND: Record<LenderEvent["kind"], { label: string; icon: LucideIcon; color: string; sign: "+" | "-" | "" }> = {
  deposit: { label: "Deposit", icon: ArrowDownLeft, color: "var(--color-brand)", sign: "+" },
  withdraw: { label: "Withdrawal", icon: ArrowUpRight, color: "var(--color-green)", sign: "-" },
  convert: { label: "Moved to junior", icon: Repeat, color: "var(--color-brand)", sign: "" },
  "exit-requested": { label: "Exit requested", icon: Clock, color: "var(--color-orange)", sign: "" },
  "exit-claimed": { label: "Exit claimed", icon: Check, color: "var(--color-green)", sign: "" },
  "exit-cancelled": { label: "Exit cancelled", icon: X, color: "var(--color-t3)", sign: "" },
  queued: { label: "Withdrawal queued", icon: Clock, color: "var(--color-orange)", sign: "" },
  settled: { label: "Withdrawal paid", icon: Check, color: "var(--color-green)", sign: "-" },
};
const LENDING_FILTERS = ["All", "Deposits", "Withdrawals", "Queue"] as const;
type LendingFilter = (typeof LENDING_FILTERS)[number];
const LENDING_FILTER_KINDS: Record<Exclude<LendingFilter, "All">, LenderEvent["kind"][]> = {
  Deposits: ["deposit", "convert"],
  Withdrawals: ["withdraw", "exit-claimed", "settled"],
  Queue: ["exit-requested", "exit-cancelled", "queued"],
};
const LENDING_SHOWN = 10;
const lendingDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric", timeZone: "UTC" });

/** The wallet's deposits, withdrawals, conversions and exit queue moves, newest first, from the indexer */
export function LendingHistory({ live }: { live: Live | null }) {
  const [filter, setFilter] = useState<LendingFilter>("All");
  const [showAll, setShowAll] = useState(false);
  // Null when no indexer is configured or it did not answer, kept with its wallet so another wallet never shows it
  const [fetched, setFetched] = useState<{ owner: string; rows: LenderEvent[] | null }>();
  const owner = live?.owner;
  useEffect(() => {
    if (!owner) return;
    let on = true;
    // Every transaction of the wallet gives a fresh `live`, so the list is read again after each one
    fetchLending(owner)
      .catch(() => null)
      .then((rows) => on && setFetched({ owner, rows }));
    return () => {
      on = false;
    };
  }, [owner, live]);

  // Undefined while loading
  const loaded = live ? (fetched && fetched.owner === owner ? fetched.rows : undefined) : DEMO_LENDING;
  const listed = loaded ? [...loaded].reverse() : [];
  const matching = filter === "All" ? listed : listed.filter((r) => LENDING_FILTER_KINDS[filter].includes(r.kind));
  const rows = showAll ? matching : matching.slice(0, LENDING_SHOWN);
  return (
    <div className="panel">
      <div className="flex flex-wrap items-center justify-between gap-3 px-[22px] pt-[18px]">
        <h3 className="flex items-center gap-2 text-[15px] font-medium tracking-[-0.01em]">
          Lending activity {loaded && <span className="font-normal text-t3">{listed.length} events</span>}
        </h3>
        <Segmented small label="Filter lending activity" items={LENDING_FILTERS} value={filter} onChange={setFilter} />
      </div>
      <div className="overflow-x-auto">
      <table className="mt-3.5 w-full min-w-[680px] border-collapse md:min-w-0">
        <thead>
          <tr className="text-[12.5px] text-t3 [&_th]:whitespace-nowrap [&_th]:px-4 [&_th]:pb-3 [&_th]:font-normal">
            <th className="pl-[22px] text-left">Activity</th>
            <th className="text-left">Date</th>
            <th className="text-right">Amount</th>
            <th className="text-right">Shares</th>
            <th className="pr-[22px] text-right">Transaction</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const k = LENDING_KIND[r.kind];
            const t = TRANCHES[r.tranche];
            const Icon = k.icon;
            return (
              <motion.tr key={r.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2 }} className="border-t border-line transition-colors hover:bg-white/[0.02] [&_td]:px-4 [&_td]:py-3.5">
                <td className="pl-[22px]">
                  <div className="flex items-center gap-3">
                    <span className="grid size-8 place-items-center rounded-lg border border-line bg-s3" style={{ color: k.color }}>
                      <Icon size={15} strokeWidth={1.75} />
                    </span>
                    <div>
                      <div className="flex items-center gap-2 font-medium">
                        {k.label}
                        <Tag tone={t.tone}>{t.name}</Tag>
                      </div>
                      <div className="mt-0.5 text-[12.5px] text-t3">{r.detail}</div>
                    </div>
                  </div>
                </td>
                <td className="whitespace-nowrap text-t2">{lendingDate(r.date)}</td>
                <td className={`text-right font-medium ${k.sign ? "" : "text-t2"}`}>{r.amount > 0 ? `${k.sign}${usd(r.amount)}` : "-"}</td>
                <td className="whitespace-nowrap text-right text-t2">
                  {money(r.shares)} {t.token}
                </td>
                <td className="pr-[22px] text-right">
                  <a
                    href={isSignature(r.tx) ? explorer(r.tx) : "#"}
                    {...(isSignature(r.tx) && { target: "_blank", rel: "noreferrer" })}
                    className="inline-flex items-center justify-end gap-1.5 font-mono text-[12.5px] text-t3 transition-colors hover:text-t1"
                  >
                    {isSignature(r.tx) ? shortKey(r.tx) : r.tx}
                    <ArrowUpRight size={13} strokeWidth={1.75} />
                  </a>
                </td>
              </motion.tr>
            );
          })}
        </tbody>
      </table>
      </div>
      {!rows.length && (
        <div className="px-[22px] py-10 text-center text-t3">
          {loaded === undefined ? "Loading lending activity" : loaded === null ? "Shown once an indexer is connected" : filter === "All" ? "No lending activity yet" : `No ${filter.toLowerCase()} yet`}
        </div>
      )}
      {matching.length > LENDING_SHOWN && (
        <button type="button" onClick={() => setShowAll(!showAll)} className="w-full cursor-pointer border-t border-line py-3 text-[13px] font-medium text-t2 transition-colors hover:text-t1">
          {showAll ? `Show the latest ${LENDING_SHOWN}` : `Show all ${matching.length}`}
        </button>
      )}
    </div>
  );
}
