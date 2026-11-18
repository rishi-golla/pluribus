import type { ReactNode } from "react";
import { FadeUp, Num } from "@/components/motion";
import { FeeBars } from "./FeeBars";

/**
 * One column of the section: no card and no icon, just a number, a rule and the content,
 * split from its neighbours by hairlines like a printed spec sheet
 */
function Column({ index, title, body, delay, children }: { index: number; title: string; body: string; delay: number; children: ReactNode }) {
  return (
    <FadeUp delay={delay} y={20} className="group relative flex flex-col border-l border-line px-7 pb-8 pt-7 first:border-l-0 first:pl-0 last:pr-0">
      {/* A purple rule that runs across the top of the column on hover */}
      <span className="absolute -top-px left-0 h-[2px] w-0 bg-brand transition-[width] duration-300 ease-out group-hover:w-full" />
      <div className="font-mono text-[12px] text-brand">0{index}</div>
      <h3 className="mt-4 text-[22px] font-medium leading-[1.15] tracking-[-0.03em]">{title}</h3>
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
    <div className="mt-14 grid grid-cols-3 border-y border-line">
      <Column
        index={1}
        delay={0}
        title="Crash-tested, not snapshot"
        body="LP positions are valued at the crash price using only ticks, liquidity and oracle prices, so manipulating a pool can't raise your limit."
      >
        <div className="font-mono text-[12.5px]">
          <div className="grid grid-cols-[1fr_auto_auto] gap-x-6 border-b border-line pb-2 text-t3">
            <span>SOL-USDC</span>
            <span>Naive</span>
            <span className="text-brand">Crash</span>
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
        title="Autopay from LP fees"
        body="Keepers harvest your concentrated-liquidity fees on a schedule and repay debt with the USDC part. Stay healthy and your rate keeps dropping."
      >
        <div className="flex items-baseline justify-between">
          <Num value={212.4} decimals={2} prefix="$" countUp className="font-mono text-[30px] leading-none tracking-[-0.04em] text-brand" />
          <span className="font-mono text-[12px] text-t3">repaid, 30D</span>
        </div>
        <div className="mt-4">
          <FeeBars />
        </div>
      </Column>

      <Column
        index={3}
        delay={0.16}
        title="Pick your risk as a lender"
        body="Seniors are protected by the insurance fund and the junior tranche. Juniors take first loss and earn every risk premium."
      >
        <div className="grid grid-cols-2 border-t border-line">
          <div className="pr-4 pt-4">
            <div className="font-mono text-[12px] text-t3">Senior · sUSDC</div>
            <Num value={6.9} decimals={2} suffix="%" countUp className="mt-1.5 block font-mono text-[30px] leading-none tracking-[-0.04em] text-green" />
          </div>
          <div className="border-l border-line pl-4 pt-4">
            <div className="font-mono text-[12px] text-t3">Junior · jUSDC</div>
            <Num value={24.2} decimals={2} suffix="%" countUp className="mt-1.5 block font-mono text-[30px] leading-none tracking-[-0.04em] text-orange" />
          </div>
        </div>
      </Column>
    </div>
  );
}
