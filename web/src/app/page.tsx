import { ArrowRight } from "lucide-react";
import { BorrowPreview } from "@/components/dashboard/BorrowPreview";
import { Features } from "@/components/landing/Features";
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
  { label: "Total supplied", value: "$10.0M" },
  { label: "Credit drawn", value: "$8.0M" },
  { label: "Collateral types", value: "4" },
  { label: "Bad debt", value: "$0" },
];

export default function Home() {
  return (
    <div className="relative">
      <div className="landing-grid pointer-events-none absolute inset-x-0 top-0 h-[980px]" />
      <div className="landing-halo pointer-events-none absolute left-1/2 top-[560px] h-[620px] w-[1300px] -translate-x-1/2" />

      <div className="relative z-[1]">
        <header className="flex h-[72px] items-center gap-10 px-10">
          <Brandmark />
          <nav className="flex gap-0.5">
            {["Borrow", "Earn", "Risk", "Docs"].map((l) => (
              <a key={l} href="#" className="rounded-[9px] px-3.5 py-2 text-sm font-medium text-t2 transition-colors hover:text-t1">
                {l}
              </a>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Button variant="ghost" href="#">
              Architecture
            </Button>
            <Button variant="white" href="#">
              Launch app
            </Button>
          </div>
        </header>

        <section className="pt-[92px] text-center">
          <a
            href="#"
            className="inline-flex h-8 items-center gap-2 rounded-full border border-line-2 bg-white/[0.03] pl-1.5 pr-3 text-[13px] text-t2 transition-colors hover:text-t1"
          >
            <span className="rounded-full bg-brand-dim px-2 py-0.5 text-xs font-medium text-brand">New</span>
            Tokenized stocks and CLMM LPs as collateral
            <ArrowRight size={14} strokeWidth={1.75} />
          </a>
          <h1 className="mt-7 text-[84px] font-medium leading-[0.98] tracking-[-0.055em]">
            Borrow against
            <br />
            <span className="text-fade">everything you hold.</span>
          </h1>
          <p className="mx-auto mt-[26px] max-w-[620px] text-lg leading-[1.55] text-t2">
            One credit line for your SOL, LSTs, LP positions and tokenized stocks. Every asset is valued under one crash scenario, there&apos;s no maturity, and
            your LP fees pay the loan down.
          </p>
          <div className="mt-9 flex justify-center gap-3">
            <Button variant="white" size="lg" href="#">
              Open a credit line
            </Button>
            <Button size="lg" href="#">
              Earn up to 24.2% APY
              <ArrowRight size={15} strokeWidth={1.75} />
            </Button>
          </div>
        </section>

        <div className="shot-frame relative mx-auto mt-[72px] w-[1180px] rounded-[20px] p-2">
          <div className="relative h-[640px] overflow-hidden rounded-[14px] border border-line-2 bg-bg">
            <div className="pointer-events-none w-[1440px] origin-top-left scale-[0.8083]" aria-hidden inert>
              <BorrowPreview />
            </div>
            <div className="absolute inset-x-0 bottom-0 h-[220px] bg-gradient-to-b from-transparent to-bg" />
          </div>
        </div>

        <div className="mt-10 flex items-center justify-center gap-11 text-sm text-t3">
          <span>Built on</span>
          {partners.map((p) => (
            <span key={p.name} className="flex items-center gap-[9px] text-[15px] font-medium text-t2">
              <Token src={p.icon} size={20} className="opacity-85 brightness-[1.3] grayscale" />
              {p.name}
            </span>
          ))}
        </div>

        <main className="mx-auto max-w-[1280px] px-10 pb-16">
          <div className="mt-[104px] text-center">
            <h2 className="text-[44px] font-medium leading-[1.05] tracking-[-0.045em]">
              Credit that understands
              <br />
              what you actually hold.
            </h2>
            <p className="mt-3.5 text-base text-t2">Built from the ground up for concentrated liquidity and multi-asset portfolios.</p>
          </div>

          <Features />

          <div className="mt-[72px] grid grid-cols-4 border-y border-line">
            {stats.map((s, i) => (
              <div key={s.label} className={i === 0 ? "py-7" : "border-l border-line py-7 pl-7"}>
                <div className="text-[12.5px] text-t3">{s.label}</div>
                <div className="mt-2 text-[40px] font-medium tracking-[-0.045em]">{s.value}</div>
              </div>
            ))}
          </div>
        </main>
      </div>
    </div>
  );
}
