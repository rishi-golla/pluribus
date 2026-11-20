import Link from "next/link";
import type { ReactNode } from "react";
import { BorrowLimit } from "@/components/landing/BorrowLimit";
import { Features } from "@/components/landing/Features";
import { MARKS, type MarkName } from "@/components/landing/marks";
import { EarnUpTo, PoolStats } from "@/components/landing/PoolFacts";
import { PortfolioGrid } from "@/components/landing/PortfolioGrid";
import { ProductTour } from "@/components/landing/ProductTour";
import { FadeUp } from "@/components/motion";
import { SiteNav } from "@/components/SiteNav";
import ScrollReveal from "@/components/reactbits/ScrollReveal";
import { Button } from "@/components/ui";
import { CLUSTER } from "@/lib/cluster";

// what devnet takes today, by kind, with the marks of the assets in it; LP venues are named, since the venue is what a holder looks for
const collateral: [MarkName[], string][] = [
  [["sol"], "SOL"],
  [["jitosol", "jupsol"], "Staked SOL"],
  [["orca"], "Orca LPs"],
  [["ray"], "Raydium LPs"],
  [["met"], "Meteora LPs"],
  [["nvdax", "aaplx"], "Tokenized stocks"],
  [["bonk"], "Memecoins"],
];

function Cta({ href, primary, children }: { href: string; primary?: boolean; children: ReactNode }) {
  return (
    <Link
      href={href}
      className={`inline-flex h-12 items-center justify-center whitespace-nowrap rounded-lg border px-6 text-[15px] font-medium transition-colors md:px-4 lg:px-6 ${
        primary ? "border-brand bg-brand text-[#0c0c0c] hover:bg-[#d4ff5e]" : "border-line-2 bg-white/[0.03] text-t1 hover:bg-white/[0.07]"
      }`}
    >
      {children}
    </Link>
  );
}

export default function Home() {
  return (
    <div className="min-h-screen">
      <SiteNav>
        <Button variant="white" href="/overview">
          Launch app
        </Button>
      </SiteNav>
      <div className="mx-auto max-w-[1280px] px-4 sm:px-10">
        {/* from tablet width up the headline, the board and the collateral strip share the first screen, sized in globals.css */}
        <div className="first-screen md:flex md:flex-col">
        <section className="grid gap-14 pt-12 sm:pt-16 md:min-h-0 md:flex-1 md:grid-cols-[minmax(0,1fr)_var(--hero-board)] md:pt-[var(--hero-pad)]">
          <div className="flex flex-col">
            {/* equal space above and below keeps the text centred on the board, whatever sits under it */}
            <div className="hidden flex-1 md:block" />
            <div>
            <FadeUp onMount delay={0.08} y={20}>
              <h1 className="text-[44px] font-semibold leading-[0.98] tracking-[-0.035em] sm:text-[60px] md:text-[length:var(--hero-h1)]">
                Borrow against
                <br />
                everything
                <br />
                you hold.
              </h1>
              <p className="mt-6 max-w-[520px] text-[16px] leading-[1.55] text-t2 sm:text-[18px] md:text-[16px] lg:text-[18px]">
                Basket your SOL, LSTs, LPs, stocks and memecoins into one USDC loan. No maturity, and your LP fees pay it down.
              </p>
            </FadeUp>
            <FadeUp onMount delay={0.18} className="mt-10 flex flex-wrap gap-3 md:mt-[var(--hero-gap)]">
              <Cta href="/borrow" primary>
                Open a credit line
              </Cta>
              <Cta href="/earn">Earn on USDC</Cta>
            </FadeUp>
            </div>
            <div className="relative md:flex-1">
              {/* beside the board this box runs from the buttons down to the strip's rule, and the line sits in its middle */}
              <FadeUp onMount delay={0.32} className="mt-8 md:absolute md:inset-x-0 md:top-0 md:mt-0 md:flex md:h-[calc(100%+var(--strip-gap))] md:items-center">
                <EarnUpTo className="text-[17px] font-bold tracking-[-0.01em] text-t1 md:text-[15px] lg:text-[17px]" />
              </FadeUp>
            </div>
          </div>

          <FadeUp onMount delay={0.12} y={12} className="md:relative md:top-[var(--hero-drop)] md:self-center">
            <PortfolioGrid />
          </FadeUp>
        </section>

        <FadeUp onMount delay={0.34} className="mt-16 border-y border-line py-6 sm:mt-20 md:mb-[var(--hero-end)] md:mt-[var(--strip-gap)] md:shrink-0 md:py-[var(--strip-pad)]">
          <div className="text-[12px] uppercase tracking-[0.06em] text-t3">Collateral on Solana</div>
          {/* one row on desktop and two under it, so the strip's height is known to the first screen's sums */}
          <div className="mt-5 flex flex-wrap items-center gap-x-8 gap-y-4 lg:flex-nowrap lg:justify-between lg:gap-x-4">
            {collateral.map(([marks, name]) => (
              <span key={name} className="flex items-center gap-2.5 whitespace-nowrap text-[14px] font-medium text-t1">
                <span className="flex items-center gap-1.5">
                  {marks.map((mark) => (
                    <svg key={mark} viewBox="0 0 100 100" className="size-[22px] shrink-0" aria-hidden>
                      <path fill="currentColor" fillRule="evenodd" d={MARKS[mark]} />
                    </svg>
                  ))}
                </span>
                {name}
              </span>
            ))}
          </div>
        </FadeUp>
        </div>

        <main className="pb-32">
          <ScrollReveal
            containerClassName="mt-24 max-w-[1040px] sm:mt-[144px] !mb-0"
            textClassName="!text-[30px] !leading-[1.18] tracking-[-0.03em] sm:!text-[52px]"
            baseOpacity={0.12}
            blurStrength={6}
            wordAnimationEnd="center center"
          >
            Pluribus values everything you hold together, as it would stand after a sharp price drop, and lends you USDC against what is left.
          </ScrollReveal>

          <BorrowLimit />

          <div className="mt-24 sm:mt-[144px]">
            <ProductTour />
          </div>

          <FadeUp className="mt-24 sm:mt-[144px]" y={20}>
            <div className="text-[12px] uppercase tracking-[0.06em] text-brand">How it works</div>
            <h2 className="mt-4 text-[32px] font-semibold leading-[1.08] tracking-[-0.025em] sm:text-[40px]">
              What Pluribus does differently
            </h2>
          </FadeUp>
          <Features />

          <FadeUp className="mt-20 sm:mt-[96px]">
            <div className="mb-5 text-[12px] uppercase tracking-[0.06em] text-brand">On {CLUSTER} now</div>
            <div className="grid grid-cols-2 border-y border-line md:grid-cols-4 [&>*:nth-child(3)]:border-l-0 [&>*:nth-child(3)]:pl-0 md:[&>*:nth-child(3)]:border-l md:[&>*:nth-child(3)]:pl-7">
              <PoolStats />
            </div>
          </FadeUp>
        </main>
      </div>
    </div>
  );
}
