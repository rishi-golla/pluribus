"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { FadeUp } from "@/components/motion";
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

/** The example portfolio as a table: what each holding is worth, how far its price is assumed to fall, and what it lets you borrow */
export function CreditLimit() {
  const facts = usePoolFacts();
  const ex = facts?.example;
  const dash = ex === undefined ? "…" : "—";
  return (
    <section aria-labelledby="credit-limit" className="grid items-start gap-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,640px)]">
      <FadeUp y={20}>
        <div className="text-[12px] uppercase tracking-[0.06em] text-brand">Borrowing limit</div>
        <h2 id="credit-limit" className="mt-4 text-[32px] sm:text-[40px] font-semibold leading-[1.08] tracking-[-0.025em]">
          How much you can borrow
        </h2>
        <p className="mt-5 max-w-[440px] text-[15px] leading-[1.65] text-t2">
          You can borrow what your assets would still be worth after a sharp price drop. Riskier assets count for less.
        </p>
        <Link href="/docs#credit-limit" className="group mt-7 inline-flex items-center gap-1.5 text-[14px] text-t1">
          How the limit is calculated
          <ArrowRight size={15} strokeWidth={1.75} className="transition-transform duration-200 group-hover:translate-x-0.5" />
        </Link>
      </FadeUp>

      <FadeUp y={20} delay={0.06}>
        <table className="w-full text-[12.5px] tabular-nums sm:text-[13.5px]">
          <thead>
            <tr className="border-b border-line-2 text-[11.5px] uppercase tracking-[0.05em] text-t3">
              <th className="pb-3 text-left font-normal">Asset</th>
              <th className="pb-3 text-right font-normal">Value</th>
              <th className="pb-3 text-right font-normal">Price drop</th>
              <th className="pb-3 text-right font-normal">Counted</th>
              <th className="pb-3 text-right font-normal">Borrow</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.key} className="border-b border-line">
                <td className="py-3">
                  {r.name}
                  {r.sub && <span className="ml-2 hidden text-t3 sm:inline">{r.sub}</span>}
                </td>
                <td className="py-3 text-right">{dollars(EXAMPLE_USD[r.key])}</td>
                <td className="py-3 text-right text-t2">{ex ? `−${pct(ex.falls[r.key])}` : dash}</td>
                <td className="py-3 text-right text-t2">{ex ? pct(ex.credit[r.key] / EXAMPLE_USD[r.key]) : dash}</td>
                <td className="py-3 text-right">{ex ? dollars(ex.credit[r.key]) : dash}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-b border-line-2 font-semibold">
              <td className="py-3">Total</td>
              <td className="py-3 text-right">{dollars(TOTAL)}</td>
              <td />
              <td className="py-3 text-right">{ex ? pct(ex.creditLimit / TOTAL) : dash}</td>
              <td className="py-3 text-right text-brand">{ex ? dollars(ex.creditLimit) : dash}</td>
            </tr>
          </tfoot>
        </table>
        <div className="mt-3 text-[11.5px] text-t3">
          {ex === null ? `Couldn't read the ${CLUSTER} pool.` : `An example ${dollars(TOTAL)} portfolio, using the ${CLUSTER} pool's current settings.`}
        </div>
      </FadeUp>
    </section>
  );
}
