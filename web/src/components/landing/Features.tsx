import { Activity, Layers, Repeat, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { KV, Token } from "@/components/ui";
import { FadeUp, Num } from "@/components/motion";
import { FeeBars } from "./FeeBars";

function FeatureCard({ icon: Icon, title, body, delay, children }: { icon: LucideIcon; title: string; body: string; delay: number; children: ReactNode }) {
  return (
    <FadeUp delay={delay} y={24}>
      <div className="panel group h-full p-[26px] transition-[border-color,translate] duration-300 hover:-translate-y-1 hover:border-line-2">
        <div className="grid size-10 place-items-center rounded-xl border border-line-2 bg-s3 text-t1 transition-colors duration-300 group-hover:text-brand">
          <Icon size={16} strokeWidth={1.75} />
        </div>
        <h3 className="mt-5 text-[19px] font-medium tracking-[-0.025em]">{title}</h3>
        <p className="mt-2 text-sm leading-[1.55] text-t2">{body}</p>
        <div className="mt-[22px] border-t border-line pt-4">{children}</div>
      </div>
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
    <div className="mt-14 grid grid-cols-3 gap-4">
      <FeatureCard
        delay={0}
        icon={Activity}
        title="Crash-tested, not snapshot"
        body="LP positions are valued at the crash price using only ticks, liquidity and oracle prices, so manipulating a pool can't raise your limit."
      >
        <div className="mb-1.5 flex items-center justify-between text-xs text-t3">
          <span>SOL-USDC position</span>
          <span className="flex gap-7">
            <span>Naive</span>
            <span>Crash-test</span>
          </span>
        </div>
        {ltvRows.map(([range, naive, crash]) => (
          <KV key={range} k={range}>
            <span className="flex gap-[34px]">
              <span className="text-t3">{naive}</span>
              <span>{crash}</span>
            </span>
          </KV>
        ))}
      </FeatureCard>

      <FeatureCard
        delay={0.08}
        icon={Repeat}
        title="Autopay from LP fees"
        body="Keepers harvest your concentrated-liquidity fees on a schedule and repay debt with the USDC part. Stay healthy and your rate keeps dropping."
      >
        <FeeBars />
        <div className="mt-1.5 flex items-center justify-between text-xs text-t3">
          <span>Fees repaid, 30D</span>
          <Num value={212.4} decimals={2} prefix="$" countUp className="font-medium text-green" />
        </div>
      </FeatureCard>

      <FeatureCard
        delay={0.16}
        icon={Layers}
        title="Pick your risk as a lender"
        body="Seniors are protected by the insurance fund and the junior tranche. Juniors take first loss and earn every risk premium."
      >
        <div className="flex items-center justify-between py-1.5">
          <span className="flex items-center gap-2.5">
            <Token src="/tokens/usdc.webp" size={20} />
            <span>
              Senior <span className="text-t3">sUSDC</span>
            </span>
          </span>
          <Num value={6.9} decimals={2} suffix="%" countUp className="text-[17px] font-medium text-green" />
        </div>
        <div className="mt-2 flex items-center justify-between border-t border-line pb-1 pt-2.5">
          <span className="flex items-center gap-2.5">
            <Token src="/tokens/usdc.webp" size={20} />
            <span>
              Junior <span className="text-t3">jUSDC</span>
            </span>
          </span>
          <Num value={24.2} decimals={2} suffix="%" countUp className="text-[17px] font-medium text-orange" />
        </div>
      </FeatureCard>
    </div>
  );
}
