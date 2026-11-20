"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { FadeUp } from "@/components/motion";
import WakeSlider from "@/components/reactbits/WakeSlider";
import { CLUSTER } from "@/lib/cluster";
import { EXAMPLE_USD, usePoolFacts, type ExampleKey } from "./PoolFacts";

const ROWS: { key: ExampleKey; name: string; sub?: string }[] = [
  { key: "sol", name: "SOL" },
  { key: "lst", name: "JitoSOL", sub: "staked SOL" },
  { key: "lp", name: "SOL-USDC LP", sub: "Orca" },
  { key: "stock", name: "NVDAx", sub: "xStock" },
  { key: "meme", name: "BONK", sub: "memecoin" },
  { key: "usdc", name: "USDC" },
];
const TOTAL = Object.values(EXAMPLE_USD).reduce((a, b) => a + b, 0);
const dollars = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
const pct = (v: number) => `${Math.round(v * 100)}%`;

/**
 * A calculator over the example portfolio: drag how much you hold and see what it lets you borrow.
 * The mix of holdings stays the example's, and a limit is linear in the size of each holding, so every figure scales with the slider.
 */
export function BorrowLimit() {
  const facts = usePoolFacts();
  const ex = facts?.example;
  const [held, setHeld] = useState(TOTAL);
  const scale = held / TOTAL;
  const dash = ex === undefined ? "…" : "—";

  return (
    <section aria-labelledby="credit-limit" className="mt-24 grid items-start gap-14 sm:mt-[144px] lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)] lg:gap-20">
      <FadeUp y={20}>
        <h2 id="credit-limit" className="text-[32px] font-semibold leading-[1.08] tracking-[-0.025em] sm:text-[40px]">
          How much you can borrow
        </h2>
        <p className="mt-5 max-w-[360px] text-[15px] leading-[1.65] text-t2">
          You can borrow what your assets would still be worth after a sharp price drop. Riskier assets count for less.
        </p>
        <Link href="/docs#credit-limit" className="group mt-7 inline-flex items-center gap-1.5 text-[14px] text-t1">
          How the limit is calculated
          <ArrowRight size={15} strokeWidth={1.75} className="transition-transform duration-200 group-hover:translate-x-0.5" />
        </Link>
      </FadeUp>

      <FadeUp y={20} delay={0.06}>
        <div className="flex items-end justify-between gap-6">
          <div>
            <div className="text-[13px] text-t2">You hold</div>
            <div className="mt-1 text-[40px] font-semibold leading-none tracking-[-0.035em] tabular-nums sm:text-[56px]">{dollars(held)}</div>
          </div>
          <div className="text-right">
            <div className="text-[13px] text-t2">You can borrow</div>
            <div className="mt-1 text-[40px] font-semibold leading-none tracking-[-0.035em] tabular-nums text-brand sm:text-[56px]">{ex ? dollars(ex.creditLimit * scale) : dash}</div>
          </div>
        </div>

        <WakeSlider
          className="mt-8 w-full"
          ariaLabel="How much you hold, in dollars"
          value={held}
          onChange={setHeld}
          min={1_000}
          max={100_000}
          step={1_000}
          bars={56}
          height={64}
          restHeight={14}
          gap={3}
          fillColor="var(--color-brand)"
          trackColor="var(--color-s3)"
        />
        <div className="mt-2 flex justify-between text-[12px] tabular-nums text-t3">
          <span>$1,000</span>
          <span>Drag to change</span>
          <span>$100,000</span>
        </div>

        <table className="mt-10 w-full text-[12.5px] tabular-nums sm:text-[13.5px]">
          <thead>
            <tr className="border-b border-line-2 text-[12px] text-t3">
              <th className="pb-3 text-left font-normal">Asset</th>
              <th className="pb-3 text-right font-normal">Value</th>
              <th className="hidden pb-3 text-right font-normal sm:table-cell">Price drop</th>
              <th className="pb-3 text-right font-normal">Counted</th>
              <th className="pb-3 text-right font-normal">Borrow</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.key} className="border-b border-line">
                <td className="py-3 font-medium">
                  {r.name}
                  {r.sub && <span className="ml-2 hidden font-normal text-t3 sm:inline">{r.sub}</span>}
                </td>
                <td className="py-3 text-right text-t2">{dollars(EXAMPLE_USD[r.key] * scale)}</td>
                <td className="hidden py-3 text-right text-t2 sm:table-cell">{ex ? `−${pct(ex.falls[r.key])}` : dash}</td>
                <td className="py-3 text-right text-t2">{ex ? pct(ex.credit[r.key] / EXAMPLE_USD[r.key]) : dash}</td>
                <td className="py-3 text-right">{ex ? dollars(ex.credit[r.key] * scale) : dash}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-3 text-[12px] text-t3">
          {ex === null ? `Couldn't read the ${CLUSTER} pool.` : `An example mix of holdings, using the ${CLUSTER} pool's current settings.`}
        </div>
      </FadeUp>
    </section>
  );
}
