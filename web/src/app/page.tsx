import Link from "next/link";
import type { ReactNode } from "react";
import { CreditLimit } from "@/components/landing/CreditLimit";
import { Features } from "@/components/landing/Features";
import { PoolStats } from "@/components/landing/PoolFacts";
import { PortfolioGrid } from "@/components/landing/PortfolioGrid";
import { ProductTour } from "@/components/landing/ProductTour";
import { FadeUp } from "@/components/motion";

const nav = [
  ["Borrow", "/borrow"],
  ["Earn", "/earn"],
  ["Risk", "/docs#credit-limit"],
  ["Docs", "/docs"],
];

// what devnet takes today, by kind
const collateral = [
  ["SOL", ""],
  ["LST", "JitoSOL, JupSOL"],
  ["LP", "Orca, Raydium, Meteora"],
  ["Stocks", "NVDAx, AAPLx"],
  ["Meme", "BONK"],
];

function Cta({ href, primary, size = "lg", children }: { href: string; primary?: boolean; size?: "md" | "lg"; children: ReactNode }) {
  return (
    <Link
      href={href}
      className={`inline-flex items-center justify-center whitespace-nowrap border font-medium transition-colors ${size === "lg" ? "h-12 px-6 text-[15px]" : "h-10 px-4 text-[14px]"} ${
        primary ? "border-brand bg-brand text-[#0c0c0c] hover:bg-[#d4ff5e]" : "border-white/70 text-t1 hover:bg-white/[0.06]"
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
          <header className="flex h-[72px] items-center gap-10 border-b border-line-2">
            <Link href="/" className="text-[22px] font-semibold tracking-[-0.04em]">
              pluribus
            </Link>
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

        <section className="grid items-center gap-14 pt-12 sm:pt-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,560px)]">
          <div>
            <FadeUp onMount delay={0.08} y={20}>
              <h1 className="text-[40px] font-semibold leading-[1.02] tracking-[-0.045em] sm:text-[52px] lg:text-[68px]">Borrow against everything you hold.</h1>
              <p className="mt-6 text-[16px] text-t2 sm:text-[19px]">e pluribus unum: out of many, one.</p>
            </FadeUp>
            <FadeUp onMount delay={0.18} className="mt-10 flex flex-wrap gap-3">
              <Cta href="/borrow" primary>
                Open a credit line
              </Cta>
              <Cta href="/earn">Earn on USDC</Cta>
            </FadeUp>
            <FadeUp onMount delay={0.26}>
              <p className="mt-12 max-w-[500px] border-t border-line pt-6 text-[14.5px] leading-[1.65] text-t2">
                Basket your SOL, LSTs, LPs, stocks and memecoins into one USDC loan. No maturity, and your LP fees pay it down.
              </p>
            </FadeUp>
          </div>

          <FadeUp onMount delay={0.12} y={12}>
            <PortfolioGrid />
          </FadeUp>
        </section>

        <FadeUp onMount delay={0.34} className="mt-16 flex flex-wrap items-center gap-y-2 border-y border-line-2 py-4 text-[13px] uppercase tracking-[0.04em] sm:mt-20">
          <span className="w-full pr-5 text-t3 sm:w-auto">Collateral on Solana</span>
          {collateral.map(([kind, names]) => (
            <span key={kind} className="border-line pr-5 text-t1 sm:border-l sm:pl-5">
              {kind}
              {names && <span className="ml-2 normal-case tracking-normal text-t3">{names}</span>}
            </span>
          ))}
        </FadeUp>

        <main className="pb-32">
          <div className="mt-24 sm:mt-[128px]">
            <CreditLimit />
          </div>

          <div className="mt-24 sm:mt-[144px]">
            <ProductTour />
          </div>

          <FadeUp className="mt-24 sm:mt-[144px]" y={20}>
            <div className="text-[12px] uppercase tracking-[0.06em] text-brand">Under the hood</div>
            <h2 className="mt-4 text-[32px] font-semibold leading-[1.08] tracking-[-0.04em] sm:text-[40px]">
              Credit that understands
              <br />
              what you hold.
            </h2>
          </FadeUp>
          <Features />

          <FadeUp className="mt-20 sm:mt-[96px]">
            <div className="mb-5 text-[12px] uppercase tracking-[0.06em] text-brand">The pool, live</div>
            <div className="grid grid-cols-2 border-y border-line-2 md:grid-cols-4 [&>*:nth-child(3)]:border-l-0 [&>*:nth-child(3)]:pl-0 md:[&>*:nth-child(3)]:border-l md:[&>*:nth-child(3)]:pl-7">
              <PoolStats />
            </div>
          </FadeUp>
        </main>
      </div>
    </div>
  );
}
