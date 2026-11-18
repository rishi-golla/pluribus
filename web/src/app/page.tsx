import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { DotField } from "@/components/landing/DotField";
import { DotWave } from "@/components/landing/DotWave";
import { HowItWorks } from "@/components/landing/HowItWorks";
import { PoolStats } from "@/components/landing/PoolFacts";
import { ProductTour } from "@/components/landing/ProductTour";
import { Features } from "@/components/landing/Features";
import { FadeUp } from "@/components/motion";
import { Brandmark, Button, Token } from "@/components/ui";

const partners = [
  { name: "Solana", icon: "/tokens/sol.webp" },
  { name: "Pyth", icon: "/tokens/pyth.webp" },
  { name: "Orca", icon: "/tokens/orca.png" },
  { name: "Raydium", icon: "/tokens/ray.webp" },
];

export default function Home() {
  return (
    <div className="landing-bg relative overflow-clip">
      {/* A faint undertone behind the hero, cleared around the headline so the text stays crisp */}
      <FadeUp onMount y={0} duration={1.2} className="pointer-events-none absolute inset-x-0 top-0 h-[760px]">
        <DotField className="landing-dots-hero size-full" strength={0.4} blocks={0.015} clear={{ y: 380, rx: 560, ry: 250 }} />
      </FadeUp>
      <div className="relative z-[1]">
        <FadeUp onMount y={-8} duration={0.6}>
          <header className="flex h-[72px] items-center gap-10 px-10">
            <Brandmark />
            <nav className="flex gap-0.5">
              {[["Borrow", "/borrow"], ["Earn", "/earn"], ["Risk", "#"], ["Docs", "#"]].map(([l, href]) => (
                <Link key={l} href={href} className="rounded-[9px] px-3.5 py-2 text-sm font-medium text-t2 transition-colors hover:text-t1">
                  {l}
                </Link>
              ))}
            </nav>
            <div className="ml-auto flex items-center gap-2">
              <Button variant="ghost" href="#">
                Architecture
              </Button>
              <Button variant="white" href="/overview">
                Launch app
              </Button>
            </div>
          </header>
        </FadeUp>

        <section className="pt-[92px] text-center">
          <FadeUp onMount delay={0.05}>
            <Link
              href="/borrow"
              className="inline-flex h-8 items-center gap-2 rounded-full border border-line-2 bg-white/[0.03] pl-1.5 pr-3 text-[13px] text-t2 transition-colors hover:border-white/20 hover:text-t1"
            >
              <span className="rounded-full bg-brand-dim px-2 py-0.5 text-xs font-medium text-brand">New</span>
              Tokenized stocks and CLMM LPs as collateral
              <ArrowRight size={14} strokeWidth={1.75} />
            </Link>
          </FadeUp>
          <FadeUp onMount delay={0.12} y={20}>
            <h1 className="mt-7 text-[84px] font-medium leading-[0.98] tracking-[-0.055em]">
              Borrow against
              <br />
              <span className="text-brand-fade">everything you hold.</span>
            </h1>
          </FadeUp>
          <FadeUp onMount delay={0.2}>
            <p className="mx-auto mt-[26px] max-w-[620px] text-lg leading-[1.55] text-t2">
              One credit line for your SOL, LSTs, LP positions and tokenized stocks. Every asset is valued under one crash scenario, there&apos;s no maturity, and
              your LP fees pay the loan down.
            </p>
          </FadeUp>
          <FadeUp onMount delay={0.28} className="mt-9 flex justify-center gap-3">
            <Button variant="white" size="lg" href="/borrow">
              Open a credit line
            </Button>
            <Button size="lg" href="/earn">
              Earn on your USDC
              <ArrowRight size={15} strokeWidth={1.75} />
            </Button>
          </FadeUp>
        </section>

        <FadeUp onMount delay={0.36} className="mt-16 flex items-center justify-center gap-11 text-sm text-t3">
          <span>Built on</span>
          {partners.map((p) => (
            <span key={p.name} className="flex items-center gap-[9px] text-[15px] font-medium text-t2 transition-colors hover:text-t1">
              <Token src={p.icon} size={20} className="opacity-85 brightness-[1.3] grayscale" />
              {p.name}
            </span>
          ))}
        </FadeUp>

        <main className="mx-auto max-w-[1280px] px-10 pb-32">
          {/* A quiet ribbon of dots in the gap above How it works */}
          <div className="relative">
            <div className="pointer-events-none absolute left-1/2 w-screen -translate-x-1/2 -top-[230px] h-[560px]">
              <FadeUp y={0} duration={1.4} className="size-full">
                <DotWave className="size-full" seed={1} />
              </FadeUp>
            </div>
            <div className="relative">
              <HowItWorks />
            </div>
          </div>

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
                what you actually hold.
              </h2>
              <p className="mt-3.5 text-base text-t2">Built from the ground up for concentrated liquidity and multi-asset portfolios.</p>
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
