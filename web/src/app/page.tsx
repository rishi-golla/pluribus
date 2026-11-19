import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { DotWave } from "@/components/landing/DotWave";
import { PoolStats } from "@/components/landing/PoolFacts";
import { PortfolioBlock } from "@/components/landing/PortfolioBlock";
import { ProductTour } from "@/components/landing/ProductTour";
import { Features } from "@/components/landing/Features";
import { FadeUp } from "@/components/motion";
import { Brandmark, Button, Token } from "@/components/ui";

const partners = [
  { name: "Solana", icon: "/tokens/sol.webp" },
  { name: "Pyth", icon: "/tokens/pyth.webp" },
  { name: "Orca", icon: "/tokens/orca.png" },
  { name: "Raydium", icon: "/tokens/ray.webp" },
  { name: "Meteora", icon: "/tokens/met.webp" },
];

export default function Home() {
  return (
    <div className="landing-bg relative overflow-clip">
      <div className="relative z-[1]">
        <FadeUp onMount y={-8} duration={0.6}>
          <header className="flex h-[72px] items-center gap-10 px-10">
            <Brandmark />
            <nav className="flex gap-0.5">
              {[["Borrow", "/borrow"], ["Earn", "/earn"], ["Risk", "/docs#credit-limit"], ["Docs", "/docs"]].map(([l, href]) => (
                <Link key={l} href={href} className="rounded-[9px] px-3.5 py-2 text-sm font-medium text-t2 transition-colors hover:text-t1">
                  {l}
                </Link>
              ))}
            </nav>
            <div className="ml-auto flex items-center gap-2">
              <Button variant="ghost" href="/docs/liquidators">
                Liquidators
              </Button>
              <Button variant="white" href="/overview">
                Launch app
              </Button>
            </div>
          </header>
        </FadeUp>

        <section className="mx-auto grid max-w-[1280px] grid-cols-1 items-center gap-16 px-10 pt-[88px] lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div>
            <FadeUp onMount delay={0.05}>
              <Link
                href="/borrow"
                className="inline-flex h-8 items-center gap-2 rounded-full border border-line-2 bg-white/[0.03] pl-1.5 pr-3 text-[13px] text-t2 transition-colors hover:border-white/20 hover:text-t1"
              >
                <span className="rounded-full bg-brand-dim px-2 py-0.5 text-xs font-medium text-brand">New</span>
                Orca, Raydium and Meteora LPs as collateral
                <ArrowRight size={14} strokeWidth={1.75} />
              </Link>
            </FadeUp>
            <FadeUp onMount delay={0.12} y={20}>
              <h1 className="mt-7 text-[56px] font-medium leading-[0.98] tracking-[-0.055em] lg:text-[76px]">
                Borrow against
                <br />
                <span className="text-brand-fade">
                  everything
                  <br />
                  you hold.
                </span>
              </h1>
              <p className="mt-5 font-mono text-[13px] text-t3">e pluribus unum: out of many, one.</p>
            </FadeUp>
            <FadeUp onMount delay={0.2}>
              <p className="mt-6 max-w-[540px] text-lg leading-[1.55] text-t2">
                Basket your SOL, LSTs, LPs, stocks and memecoins into one USDC loan. No maturity, and your LP fees pay it down.
              </p>
            </FadeUp>
            <FadeUp onMount delay={0.28} className="mt-9 flex gap-3">
              <Button variant="white" size="lg" href="/borrow">
                Open a credit line
              </Button>
              <Button size="lg" href="/earn">
                Earn on your USDC
                <ArrowRight size={15} strokeWidth={1.75} />
              </Button>
            </FadeUp>
          </div>

          <FadeUp onMount delay={0.2} y={12}>
            <PortfolioBlock />
          </FadeUp>
        </section>

        <FadeUp onMount delay={0.36} className="mx-auto mt-20 flex max-w-[1280px] flex-wrap items-center gap-x-11 gap-y-4 px-10 text-sm text-t3">
          <span>Built on</span>
          {partners.map((p) => (
            <span key={p.name} className="flex items-center gap-[9px] text-[15px] font-medium text-t2 transition-colors hover:text-t1">
              <Token src={p.icon} size={20} className="opacity-85 brightness-[1.3] grayscale" />
              {p.name}
            </span>
          ))}
        </FadeUp>

        <main className="mx-auto max-w-[1280px] px-10 pb-32">
          {/* Borrow, Earn and Statements, with a ribbon of dots flowing behind the card */}
          <div className="relative mt-[136px]">
            <div className="pointer-events-none absolute left-1/2 w-screen -translate-x-1/2 top-[58%] h-[600px] -translate-y-1/2">
              <FadeUp y={0} duration={1.4} className="size-full">
                <DotWave className="size-full" seed={2} dir={-1} amplitude={70} />
              </FadeUp>
            </div>
            <div className="relative">
              <ProductTour />
            </div>
          </div>

          {/* Another ribbon, flowing the other way behind the features heading */}
          <div className="relative mt-[120px]">
            <div className="pointer-events-none absolute left-1/2 top-1/2 h-[560px] w-screen -translate-x-1/2 -translate-y-1/2">
              <FadeUp y={0} duration={1.4} className="size-full">
                <DotWave className="size-full" seed={4} dir={-1} amplitude={54} />
              </FadeUp>
            </div>
            <FadeUp className="relative text-center" y={20}>
              <h2 className="text-[44px] font-medium leading-[1.05] tracking-[-0.045em]">
                Credit that understands
                <br />
                what you hold.
              </h2>
              <p className="mt-3.5 text-base text-t2">Built for LP positions and mixed portfolios.</p>
            </FadeUp>
          </div>

          <Features />

          {/* One last ribbon behind the stats */}
          <div className="relative mt-[72px]">
            <div className="pointer-events-none absolute left-1/2 w-screen -translate-x-1/2 top-1/2 h-[520px] -translate-y-1/2">
              <FadeUp y={0} duration={1.4} className="size-full">
                <DotWave className="size-full" seed={3} amplitude={50} thickness={116} />
              </FadeUp>
            </div>
            <FadeUp className="relative grid grid-cols-4 border-y border-line">
              <PoolStats />
            </FadeUp>
          </div>
        </main>
      </div>
    </div>
  );
}
