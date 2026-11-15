import { Activity, Layers, Repeat, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { series } from "@/lib/chart";
import { KV, Token } from "@/components/ui";

function FeatureCard({ icon: Icon, title, body, children }: { icon: LucideIcon; title: string; body: string; children: ReactNode }) {
  return (
    <div className="panel p-[26px]">
      <div className="grid size-10 place-items-center rounded-xl border border-line-2 bg-s3 text-t1">
        <Icon size={16} strokeWidth={1.75} />
      </div>
      <h3 className="mt-5 text-[19px] font-medium tracking-[-0.025em]">{title}</h3>
      <p className="mt-2 text-sm leading-[1.55] text-t2">{body}</p>
      <div className="mt-[22px] border-t border-line pt-4">{children}</div>
    </div>
  );
}

const ltvRows = [
  ["+/-3% range", "80.8%", "67.0%"],
  ["120 to 180 range", "82.1%", "70.8%"],
  ["Full range", "80.7%", "79.4%"],
];

const FEE_W = 335;
const fees = series(30, 6, 8, 5, 3).map((v) => Math.max(2.2, v));
const feeBarW = (FEE_W - 29 * 3) / 30;

export function Features() {
  return (
    <div className="mt-14 grid grid-cols-3 gap-4">
      <FeatureCard
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
        icon={Repeat}
        title="Autopay from LP fees"
        body="Keepers harvest your concentrated-liquidity fees on a schedule and repay debt with the USDC part. Stay healthy and your rate keeps dropping."
      >
        <svg viewBox={`0 0 ${FEE_W} 96`} width="100%" height="96" className="inline align-baseline" aria-label="Fees repaid per day over the last 30 days">
          {fees.map((v, i) => {
            const h = (v / 14) * 90;
            return <rect key={i} x={i * (feeBarW + 3)} y={96 - h} width={feeBarW} height={h} rx={2} fill="#3ddc97" fillOpacity={0.25 + (i / 29) * 0.6} />;
          })}
        </svg>
        <div className="mt-1.5 flex items-center justify-between text-xs text-t3">
          <span>Fees repaid, 30D</span>
          <span className="font-medium text-green">$212.40</span>
        </div>
      </FeatureCard>

      <FeatureCard
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
          <span className="text-[17px] font-medium text-green">6.90%</span>
        </div>
        <div className="mt-2 flex items-center justify-between border-t border-line pb-1 pt-2.5">
          <span className="flex items-center gap-2.5">
            <Token src="/tokens/usdc.webp" size={20} />
            <span>
              Junior <span className="text-t3">jUSDC</span>
            </span>
          </span>
          <span className="text-[17px] font-medium text-orange">24.20%</span>
        </div>
      </FeatureCard>
    </div>
  );
}
