"use client";

import { motion } from "motion/react";
import type { ReactNode } from "react";
import { EASE } from "@/components/motion";
import FadeContent from "@/components/reactbits/FadeContent";
import { ExampleApy, ExampleNote } from "./PoolFacts";

/** One difference: what it is on the left, the figures that show it on the right, a rule above. It resolves out of pixel blocks as it scrolls in */
function Card({ title, body, children }: { title: string; body: string; children: ReactNode }) {
  return (
    <div className="border-t border-line">
      <FadeContent effect="pixel" duration={1.2} threshold={0.3} className="grid gap-10 py-14 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)] lg:gap-20 lg:py-20">
        <div>
          <h3 className="text-[28px] font-semibold leading-[1.1] tracking-[-0.03em]">{title}</h3>
          <p className="mt-4 max-w-[360px] text-[15px] leading-[1.65] text-t2">{body}</p>
        </div>
        <div className="flex flex-col justify-center">{children}</div>
      </FadeContent>
    </div>
  );
}

// what a SOL-USDC position lets you borrow, as a share of its value: priced as it stands, and priced after a drop
const RANGES: [string, number, number][] = [
  ["+/-3% range", 80.8, 67.0],
  ["120 to 180 range", 82.1, 70.8],
  ["Full range", 80.7, 79.4],
];

/** What sets the pool apart, one ruled row each */
export function Features() {
  return (
    <div className="mt-14 border-b border-line">
      <Card
        title="Your customized CLP count as collateral"
        body="A liquidity position loses value when the price leaves its range. We value it at the price after a drop, so your limit holds when the market falls. Narrow ranges lose more, so they count for less."
      >
        <div className="mb-4 flex justify-between text-[12.5px] text-t3">
          <span>Borrowable, SOL-USDC</span>
          <span>
            Today <span className="mx-1.5">→</span> <span className="text-t1">After a drop</span>
          </span>
        </div>
        {RANGES.map(([range, today, crash]) => (
          <div key={range} className="border-t border-line py-5">
            <div className="flex items-baseline justify-between text-[14px]">
              <span className="font-medium">{range}</span>
              <span className="tabular-nums">
                <span className="text-t3">{today.toFixed(1)}%</span>
                <span className="mx-2 text-t3">→</span>
                <span className="text-brand">{crash.toFixed(1)}%</span>
              </span>
            </div>
            {/* the bar starts at today's figure and settles back to the one after a drop */}
            <div className="relative mt-3.5 h-1.5 bg-s3">
              <div className="absolute inset-y-0 left-0 bg-white/[0.14]" style={{ width: `${today}%` }} />
              <motion.div
                className="absolute inset-y-0 left-0 bg-brand"
                initial={{ width: `${today}%` }}
                whileInView={{ width: `${crash}%` }}
                viewport={{ once: true, amount: 1 }}
                transition={{ duration: 1.1, delay: 0.25, ease: EASE }}
              />
            </div>
          </div>
        ))}
      </Card>

      <Card title="Lenders choose their risk" body="Senior lenders are paid first and lose money last. Junior lenders take losses first and earn a higher rate for it.">
        <div className="grid grid-cols-2">
          <div className="pr-6">
            <div className="text-[12.5px] text-t3">Senior · sUSDC</div>
            <ExampleApy tranche="senior" className="mt-2 block text-[44px] font-semibold leading-none tracking-[-0.04em] text-green sm:text-[60px]" />
            <div className="mt-3 text-[13.5px] text-t2">Paid first, loses last</div>
          </div>
          <div className="border-l border-line pl-6">
            <div className="text-[12.5px] text-t3">Junior · jUSDC</div>
            <ExampleApy tranche="junior" className="mt-2 block text-[44px] font-semibold leading-none tracking-[-0.04em] text-orange sm:text-[60px]" />
            <div className="mt-3 text-[13.5px] text-t2">Takes losses first</div>
          </div>
        </div>
        <ExampleNote className="mt-8 border-t border-line pt-4 text-[12px] text-t3" />
      </Card>

    </div>
  );
}
