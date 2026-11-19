import Link from "next/link";
import type { ReactNode } from "react";
import { CreditLimit } from "@/components/landing/CreditLimit";
import { Features } from "@/components/landing/Features";
import { MARKS, type MarkName } from "@/components/landing/marks";
import { EarnUpTo, PoolStats } from "@/components/landing/PoolFacts";
import { PortfolioGrid } from "@/components/landing/PortfolioGrid";
import { ProductTour } from "@/components/landing/ProductTour";
import { FadeUp } from "@/components/motion";
import { Brandmark } from "@/components/ui";
import { CLUSTER } from "@/lib/cluster";

const nav = [
  ["Borrow", "/borrow"],
  ["Earn", "/earn"],
  ["Risk", "/docs#credit-limit"],
  ["Docs", "/docs"],
];

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

function Cta({ href, primary, size = "lg", children }: { href: string; primary?: boolean; size?: "md" | "lg"; children: ReactNode }) {
  return (
    <Link
      href={href}
      className={`inline-flex items-center justify-center whitespace-nowrap rounded-lg border font-medium transition-colors ${size === "lg" ? "h-12 px-6 text-[15px]" : "h-10 px-4 text-[14px]"} ${
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
      <div className="mx-auto max-w-[1280px] px-4 sm:px-10">
        <FadeUp onMount y={-8} duration={0.6}>
          <header className="flex h-[72px] items-center gap-10 border-b border-line">
            <Brandmark className="text-[22px]" />
            <nav className="hidden gap-1 md:flex">
              {nav.map(([label, href]) => (
                <Link key={label} href={href} className="px-3 py-2 text-[14px] text-t2 transition-colors hover:text-t1">
                  {label}
                </Link>
              ))}
            </nav>
            <div className="ml-auto flex items-center gap-5">
              <Link href="/docs/liquidators" className="hidden text-[14px] text-t3 transition-colors hover:text-t1 sm:block">
                Liquidators
              </Link>
              <Cta href="/overview" primary size="md">
                Launch app
              </Cta>
            </div>
          </header>
        </FadeUp>

        <section className="grid gap-14 pt-12 sm:pt-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,560px)]">
          <div className="flex flex-col">
            {/* equal space above and below keeps the text centred on the board, whatever sits under it */}
            <div className="hidden flex-1 lg:block" />
            <div>
            <FadeUp onMount delay={0.08} y={20}>
              <h1 className="text-[44px] font-semibold leading-[0.98] tracking-[-0.035em] sm:text-[60px] lg:text-[80px]">
                Borrow against
                <br />
                everything
                <br />
                you hold.
              </h1>
              <p className="mt-6 max-w-[520px] text-[16px] leading-[1.55] text-t2 sm:text-[18px]">
                Basket your SOL, LSTs, LPs, stocks and memecoins into one USDC loan. No maturity, and your LP fees pay it down.
              </p>
            </FadeUp>
            <FadeUp onMount delay={0.18} className="mt-10 flex flex-wrap gap-3">
              <Cta href="/borrow" primary>
                Open a credit line
              </Cta>
              <Cta href="/earn">Earn on USDC</Cta>
            </FadeUp>
            </div>
            <div className="relative lg:flex-1">
              {/* on desktop this box runs from the buttons down to the strip's rule, and the line sits in its middle */}
              <FadeUp onMount delay={0.32} className="mt-8 lg:absolute lg:inset-x-0 lg:top-0 lg:mt-0 lg:flex lg:h-[calc(100%+5rem)] lg:items-center">
                <EarnUpTo className="text-[17px] font-bold tracking-[-0.01em] text-t1" />
              </FadeUp>
            </div>
          </div>

          <FadeUp onMount delay={0.12} y={12} className="lg:self-center">
            <PortfolioGrid />
          </FadeUp>
        </section>

        <FadeUp onMount delay={0.34} className="mt-16 border-y border-line py-6 sm:mt-20">
          <div className="text-[12px] uppercase tracking-[0.06em] text-t3">Collateral on Solana</div>
          <div className="mt-5 flex flex-wrap items-center gap-x-8 gap-y-4 lg:justify-between">
            {collateral.map(([marks, name]) => (
              <span key={name} className="flex items-center gap-2.5 text-[14px] font-medium text-t1">
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

        <main className="pb-32">
          <div className="mt-24 sm:mt-[128px]">
            <CreditLimit />
          </div>

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
