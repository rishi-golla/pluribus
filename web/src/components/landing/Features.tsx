import type { ReactNode } from "react";
import { FadeUp } from "@/components/motion";
import { AutopayRepaid, ExampleApy, ExampleNote } from "./PoolFacts";

/**
 * One column of the section: no card and no icon, just a number, a rule and the content,
 * split from its neighbours by hairlines like a printed spec sheet
 */
function Column({ index, title, body, delay, children }: { index: number; title: string; body: string; delay: number; children: ReactNode }) {
  return (
    <FadeUp delay={delay} y={20} className="group relative flex flex-col border-t border-line pb-8 pt-7 first:border-t-0 md:border-l md:border-t-0 md:px-7 md:first:border-l-0 md:first:pl-0 md:last:pr-0">
      {/* A rule in the accent that runs across the top of the column on hover */}
      <span className="absolute -top-px left-0 h-[2px] w-0 bg-brand transition-[width] duration-300 ease-out group-hover:w-full" />
      <div className="font-mono text-[12px] text-brand">0{index}</div>
      <h3 className="mt-4 text-[20px] font-semibold leading-[1.2] tracking-[-0.03em]">{title}</h3>
      <p className="mt-3 text-[14px] leading-[1.6] text-t2">{body}</p>
      <div className="mt-auto pt-8">{children}</div>
    </FadeUp>
  );
}

const ltvRows = [
  ["+/-3% range", "80.8%", "67.0%"],
  ["120 to 180 range", "82.1%", "70.8%"],
  ["Full range", "80.7%", "79.4%"],
];

export function Features() {
  return (
    <div className="mt-14 grid border-y border-line md:grid-cols-3">
      <Column
        index={1}
        delay={0}
        title="Liquidity positions count as collateral"
        body="A liquidity position loses value when the price leaves its range. We value it at the price after a drop, so your limit holds when the market falls. Narrow ranges lose more, so they count for less."
      >
        <div className="font-mono text-[12.5px]">
          <div className="grid grid-cols-[1fr_auto_auto] gap-x-6 border-b border-line pb-2 text-t3">
            <span>Borrowable, SOL-USDC</span>
            <span>Today</span>
            <span className="text-brand">After a drop</span>
          </div>
          {ltvRows.map(([range, naive, crash]) => (
            <div key={range} className="grid grid-cols-[1fr_auto_auto] gap-x-6 border-b border-dashed border-line py-2.5 last:border-0">
              <span className="text-t2">{range}</span>
              <span className="text-t3 line-through decoration-t3/60">{naive}</span>
              <span className="text-brand">{crash}</span>
            </div>
          ))}
        </div>
      </Column>

      <Column
        index={2}
        delay={0.08}
        title="Your LP fees pay down the loan"
        body="Liquidity positions earn trading fees. Anyone can collect them for a small share, and the rest repays your debt or goes back into the position if you prefer. Keep the loan in good standing and your interest rate falls over time."
      >
        <AutopayRepaid />
      </Column>

      <Column
        index={3}
        delay={0.16}
        title="Lenders choose their risk"
        body="Senior lenders are paid first and lose money last. Junior lenders take losses first and earn a higher rate for it."
      >
        <div className="grid grid-cols-2 border-t border-line">
          <div className="pr-4 pt-4">
            <div className="font-mono text-[12px] text-t3">Senior · sUSDC</div>
            <ExampleApy tranche="senior" className="mt-1.5 block font-mono text-[30px] leading-none tracking-[-0.04em] text-green" />
          </div>
          <div className="border-l border-line pl-4 pt-4">
            <div className="font-mono text-[12px] text-t3">Junior · jUSDC</div>
            <ExampleApy tranche="junior" className="mt-1.5 block font-mono text-[30px] leading-none tracking-[-0.04em] text-orange" />
          </div>
        </div>
        <ExampleNote className="mt-3 font-mono text-[11.5px] text-t3" />
      </Column>
    </div>
  );
}
