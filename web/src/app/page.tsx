import Link from "next/link";
import { ArrowRight, MousePointerClick } from "lucide-react";
import { BorrowPreview } from "@/components/landing/BorrowPreview";
import { Features } from "@/components/landing/Features";
import { FadeUp, Num } from "@/components/motion";
import { Brandmark, Button, Token } from "@/components/ui";

const partners = [
  { name: "Solana", icon: "/tokens/sol.webp" },
  { name: "Pyth", icon: "/tokens/pyth.webp" },
  { name: "Orca", icon: "/tokens/orca.png" },
  { name: "Raydium", icon: "/tokens/ray.webp" },
  { name: "Meteora", icon: "/tokens/met.webp" },
  { name: "Jupiter", icon: "/tokens/jup.webp" },
];

const stats = [
  { label: "Total supplied", value: 10, decimals: 1, prefix: "$", suffix: "M" },
  { label: "Credit drawn", value: 8, decimals: 1, prefix: "$", suffix: "M" },
  { label: "Collateral types", value: 4 },
  { label: "Bad debt", value: 0, prefix: "$" },
];

export default function Home() {
  return (
    <div className="relative">
      <div className="landing-grid pointer-events-none absolute inset-x-0 top-0 h-[980px]" />
      <FadeUp onMount y={0} delay={0.45} duration={1.6} className="pointer-events-none absolute left-1/2 top-[560px] h-[620px] w-[1300px] -translate-x-1/2">
        <div className="landing-halo size-full" />
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
              <span className="text-fade">everything you hold.</span>
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
              Earn up to 24.2% APY
              <ArrowRight size={15} strokeWidth={1.75} />
            </Button>
          </FadeUp>
        </section>

        <FadeUp onMount delay={0.4} y={48} duration={1.1}>
          <div className="shot-frame relative mx-auto mt-[72px] w-[1180px] rounded-[20px] p-2">
            <div className="absolute -top-4 left-1/2 z-10 -translate-x-1/2">
              <span className="inline-flex h-8 items-center gap-2 whitespace-nowrap rounded-full border border-line-2 bg-s2/90 px-3 text-[12.5px] text-t2 shadow-[0_8px_24px_rgb(0_0_0/0.5)] backdrop-blur">
                <MousePointerClick size={14} strokeWidth={1.75} className="text-brand" />
                Live preview. Pick an amount and draw, or hover the chart.
              </span>
            </div>
            <div className="relative h-[804px] overflow-hidden rounded-[14px] border border-line-2 bg-bg">
              <div className="w-[1440px] origin-top-left scale-[0.8083]">
                <BorrowPreview />
              </div>
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-b from-transparent to-bg" />
            </div>
          </div>
        </FadeUp>

        <FadeUp className="mt-10 flex items-center justify-center gap-11 text-sm text-t3">
          <span>Built on</span>
          {partners.map((p) => (
            <span key={p.name} className="flex items-center gap-[9px] text-[15px] font-medium text-t2 transition-colors hover:text-t1">
              <Token src={p.icon} size={20} className="opacity-85 brightness-[1.3] grayscale" />
              {p.name}
            </span>
          ))}
        </FadeUp>

        <main className="mx-auto max-w-[1280px] px-10 pb-16">
          <FadeUp className="mt-[104px] text-center" y={20}>
            <h2 className="text-[44px] font-medium leading-[1.05] tracking-[-0.045em]">
              Credit that understands
              <br />
              what you actually hold.
            </h2>
            <p className="mt-3.5 text-base text-t2">Built from the ground up for concentrated liquidity and multi-asset portfolios.</p>
          </FadeUp>

          <Features />

          <FadeUp className="mt-[72px] grid grid-cols-4 border-y border-line">
            {stats.map((s, i) => (
              <div key={s.label} className={i === 0 ? "py-7" : "border-l border-line py-7 pl-7"}>
                <div className="text-[12.5px] text-t3">{s.label}</div>
                <div className="mt-2 text-[40px] font-medium tracking-[-0.045em]">
                  <Num value={s.value} decimals={s.decimals} prefix={s.prefix} suffix={s.suffix} countUp />
                </div>
              </div>
            ))}
          </FadeUp>
        </main>
      </div>
    </div>
  );
}
