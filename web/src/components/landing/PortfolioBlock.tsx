"use client";

import { motion } from "motion/react";
import { useState } from "react";
import { EASE, Num } from "@/components/motion";
import { CLUSTER } from "@/lib/cluster";
import { CLASS_COLORS } from "@/lib/markets";
import { EXAMPLE_USD, usePoolFacts, type ExampleKey } from "./PoolFacts";

// the example portfolio, each part colored like its asset class in the app; USDC has no class there
const PARTS: { key: ExampleKey; name: string; sub: string; color: string }[] = [
  { key: "sol", name: "SOL", sub: "Solana", color: CLASS_COLORS.SOL },
  { key: "lp", name: "SOL-USDC", sub: "Orca position", color: CLASS_COLORS["LP positions"] },
  { key: "stock", name: "NVDAx", sub: "NVIDIA xStock", color: CLASS_COLORS.Stocks },
  { key: "usdc", name: "USDC", sub: "Cash", color: "#7c8494" },
];

const TOTAL = Object.values(EXAMPLE_USD).reduce((a, b) => a + b, 0);

// A treemap: SOL down the left, the LP across the top right, NVDAx and USDC under it, each area to scale
const RECTS: Record<ExampleKey, { x: number; y: number; w: number; h: number }> = (() => {
  const { sol, lp, stock, usdc } = EXAMPLE_USD;
  const left = sol / TOTAL;
  const top = lp / (lp + stock + usdc);
  const split = stock / (stock + usdc);
  return {
    sol: { x: 0, y: 0, w: left, h: 1 },
    lp: { x: left, y: 0, w: 1 - left, h: top },
    stock: { x: left, y: top, w: (1 - left) * split, h: 1 - top },
    usdc: { x: left + (1 - left) * split, y: top, w: (1 - left) * (1 - split), h: 1 - top },
  };
})();

const dollars = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const at = (v: number) => `${v * 100}%`;

/** The hero's picture: an example portfolio as one block, with the share a crash would take hatched out of each part */
export function PortfolioBlock() {
  const facts = usePoolFacts();
  const ex = facts?.example;
  const [active, setActive] = useState<ExampleKey | null>(null);
  const part = PARTS.find((p) => p.key === active);
  // share of each part the worst crash takes, 0 until the pool has been read
  const cut = (k: ExampleKey) => (ex ? Math.min(1, Math.max(0, 1 - ex.survived[k] / EXAMPLE_USD[k])) : 0);

  const readout = part
    ? {
        label: `${part.name} backs`,
        value: ex?.survived[part.key],
        note: ex ? `${dollars(EXAMPLE_USD[part.key])} held, ${pct(cut(part.key))} lost in a ${ex.scenario.toLowerCase()}` : `${dollars(EXAMPLE_USD[part.key])} held`,
      }
    : {
        label: "Borrow up to",
        value: ex?.creditLimit,
        note:
          ex === null
            ? `Couldn't read the ${CLUSTER} pool.`
            : ex
              ? `Hatched: lost in the worst of ${ex.scenarios} crashes, a ${ex.scenario.toLowerCase()} with SOL down ${pct(ex.falls.sol)}`
              : "Crash-testing with the pool's settings",
      };

  return (
    <div>
      <div className="mb-4 flex items-center justify-between text-[12.5px] text-t3">
        <span>Example {dollars(TOTAL)} portfolio</span>
        <span className="flex items-center gap-2">
          <span className="size-2.5 rounded-[2px] border border-white/25 [background:repeating-linear-gradient(135deg,rgb(255_255_255/0.5)_0_1px,transparent_1px_3px)]" />
          Lost in a crash
        </span>
      </div>

      <div className="-m-[3px]">
        <div className="relative aspect-[5/4]" role="img" aria-label={`${readout.label}: ${readout.value === undefined ? "not read yet" : dollars(readout.value)}. ${readout.note}`}>
          {PARTS.map((p, i) => {
            const r = RECTS[p.key];
            const share = cut(p.key);
            return (
              <button
                key={p.key}
                type="button"
                aria-label={`${p.name}, ${dollars(EXAMPLE_USD[p.key])}${ex ? `, backs ${dollars(ex.survived[p.key])}` : ""}`}
                onMouseEnter={() => setActive(p.key)}
                onMouseLeave={() => setActive(null)}
                onFocus={() => setActive(p.key)}
                onBlur={() => setActive(null)}
                className="absolute cursor-default p-[3px] text-left"
                style={{ left: at(r.x), top: at(r.y), width: at(r.w), height: at(r.h) }}
              >
                <motion.div
                  className="size-full"
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ delay: 0.25 + i * 0.07, duration: 0.6, ease: EASE }}
                >
                  <div
                    className={`relative size-full overflow-hidden rounded-[8px] transition-opacity duration-200 ${active && active !== p.key ? "opacity-30" : ""}`}
                    style={{ backgroundColor: p.color, boxShadow: `inset 0 0 0 1px ${p.color}` }}
                  >
                    {/* the share the crash takes, cleared from the top so what is left reads as what the part backs */}
                    <motion.div
                      className="absolute inset-x-0 top-0"
                      style={{ background: `repeating-linear-gradient(135deg, ${p.color}66 0 1.5px, transparent 1.5px 7px), var(--color-s1)` }}
                      initial={{ height: "0%" }}
                      animate={{ height: at(share) }}
                      transition={{ delay: 0.9 + i * 0.08, duration: 0.9, ease: EASE }}
                    />
                    {share >= 0.12 && (
                      <motion.span
                        className="absolute right-3 top-2.5 font-mono text-[11px]"
                        style={{ color: p.color }}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={{ delay: 1.6 + i * 0.08, duration: 0.4 }}
                      >
                        −{pct(share)}
                      </motion.span>
                    )}
                    <div className="absolute bottom-3 left-3.5 right-3 text-[#07080a]">
                      <div className="text-[13px] font-medium leading-tight">{p.name}</div>
                      <div className="text-[11.5px] leading-tight opacity-75">{p.sub}</div>
                      <div className="mt-1.5 text-[20px] font-medium leading-none tracking-[-0.03em]">{dollars(EXAMPLE_USD[p.key])}</div>
                    </div>
                  </div>
                </motion.div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-5 flex items-end justify-between gap-6 border-t border-line pt-5">
        <div>
          <div className="text-[12.5px] text-t3">{readout.label}</div>
          <div className="mt-1.5 text-[40px] font-medium leading-none tracking-[-0.045em]">
            {readout.value === undefined ? "—" : <Num value={readout.value} prefix="$" countUp />}
          </div>
        </div>
        <p className="max-w-[270px] text-right text-[12.5px] leading-[1.5] text-t3">{readout.note}</p>
      </div>
    </div>
  );
}
