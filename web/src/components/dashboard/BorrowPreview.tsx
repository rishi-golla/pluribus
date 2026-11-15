import { ArrowRight, Award, Bell, ChevronDown, Info, Search, ShieldCheck, TrendingUp } from "lucide-react";
import { Brandmark, Chip, KV, Label, Segmented, StatusDot, Swatch, Tag, Token } from "@/components/ui";
import { PortfolioChart } from "./PortfolioChart";

const ic = { size: 16, strokeWidth: 1.75 };

function AppNav() {
  const links = ["Borrow", "Earn", "Statements", "Docs"];
  return (
    <header className="flex h-16 items-center gap-10 border-b border-line bg-[rgb(7_8_10/0.7)] px-7 backdrop-blur-md">
      <Brandmark />
      <nav className="flex gap-0.5">
        {links.map((l) => (
          <a key={l} className={`rounded-[9px] px-3.5 py-2 text-sm font-medium ${l === "Borrow" ? "bg-s3 text-t1" : "text-t2"}`}>
            {l}
          </a>
        ))}
      </nav>
      <div className="ml-auto flex items-center gap-2">
        <div className="flex items-center gap-1.5 px-2 text-[13px] text-t2">
          <Token src="/tokens/sol.webp" size={16} />
          $150.12 <span className="text-green">+2.41%</span>
        </div>
        <div className="flex h-9 w-[220px] items-center gap-2 rounded-[10px] border border-line bg-s1 pl-3 pr-2.5 text-[13px] text-t3">
          <Search {...ic} />
          Search markets
          <kbd className="ml-auto rounded-[5px] border border-line-2 px-1.5 py-px font-mono text-[11px] text-t3">/</kbd>
        </div>
        <div className="grid size-9 place-items-center rounded-[10px] border border-line bg-s1 text-t2">
          <Bell {...ic} />
        </div>
        <div className="flex h-9 items-center gap-2 rounded-[10px] border border-line bg-s1 pl-1.5 pr-2.5 text-[13px] font-medium">
          <span className="wallet-avatar size-6 rounded-[7px]" />
          7xKX...q9Fh
          <ChevronDown {...ic} className="text-t3" />
        </div>
      </div>
    </header>
  );
}

function CreditHero() {
  return (
    <section className="panel grid grid-cols-[1.5fr_1px_1fr_1px_1fr]">
      <div className="px-[26px] py-6">
        <Label>
          Available to borrow <Info />
        </Label>
        <div className="mt-2.5 flex items-baseline gap-2.5">
          <div className="text-[40px] font-medium leading-[1.05] tracking-[-0.04em] tabular-nums">$16,794.00</div>
          <Tag tone="green" className="ml-1.5">
            <TrendingUp />
            +$412.80 today
          </Tag>
        </div>
        <div className="mt-[22px] flex h-2.5 gap-[3px] overflow-hidden rounded-full">
          <i className="block h-full w-[46.3%] rounded-[3px] bg-brand" />
          <i className="stripes block h-full flex-1 rounded-[3px]" />
        </div>
        <div className="mt-3.5 flex gap-5 whitespace-nowrap text-[13px] text-t2 [&_b]:ml-1 [&_b]:font-medium [&_b]:text-t1">
          <span className="inline-flex items-center">
            <Swatch color="var(--color-brand)" className="mr-[7px]" />
            Borrowed<b>$14,500.00</b>
          </span>
          <span className="inline-flex items-center">
            <Swatch color="rgba(255,255,255,0.2)" className="mr-[7px]" />
            Available<b>$16,794.00</b>
          </span>
          <span className="ml-auto inline-flex items-center">
            Credit limit<b>$31,294.00</b>
          </span>
        </div>
      </div>
      <div className="self-stretch bg-line" />
      <div className="px-[26px] py-6">
        <div className="flex items-center justify-between">
          <Label>
            Health factor <Info />
          </Label>
          <Tag tone="green">
            <StatusDot />
            Healthy
          </Tag>
        </div>
        <div className="mt-2.5 text-[40px] font-medium leading-[1.05] tracking-[-0.04em] text-green tabular-nums">2.16</div>
        <div className="health-scale relative mt-[22px] h-1.5 rounded-full">
          <span className="absolute -top-[5px] left-[72%] h-4 w-1 rounded-[2px] bg-white shadow-[0_0_0_3px_var(--color-s1)]" />
        </div>
        <div className="mt-2 flex justify-between text-[11.5px] text-t3">
          <span>1.00 Liquidation</span>
          <span>1.50</span>
          <span>2.00</span>
          <span>3.00+</span>
        </div>
      </div>
      <div className="self-stretch bg-line" />
      <div className="px-[26px] py-6">
        <div className="flex items-center justify-between">
          <Label>
            Your borrow rate <Info />
          </Label>
          <Tag tone="brand">
            <Award />
            Tier 3
          </Tag>
        </div>
        <div className="mt-2.5 text-[40px] font-medium leading-[1.05] tracking-[-0.04em] tabular-nums">
          9.60%<span className="ml-1.5 text-lg font-normal tracking-[-0.01em] text-t3">APR</span>
        </div>
        <div className="mt-3">
          <KV k="Base rate" dense>7.80%</KV>
          <KV k="Risk premium" dense>+2.90%</KV>
          <KV k="Loyalty, 142 healthy days" dense>
            <span className="text-green">-1.10%</span>
          </KV>
        </div>
      </div>
    </section>
  );
}

function PortfolioPanel() {
  const stats = [
    { label: "Collateral value", color: "var(--color-brand)", value: "$48,230.00" },
    { label: "Credit limit", color: "#ededef", value: "$31,294.00" },
    { label: "Debt", color: "var(--color-orange)", value: "$14,500.00" },
  ];
  return (
    <div className="panel">
      <div className="flex items-center justify-between px-[22px] pt-[18px]">
        <h3 className="text-[15px] font-medium tracking-[-0.01em]">Portfolio</h3>
        <div className="flex items-center gap-2.5">
          <Segmented small items={["Value", "Credit", "Debt"]} active="Value" />
          <Segmented small items={["7D", "30D", "90D", "1Y"]} active="90D" />
        </div>
      </div>
      <div className="px-[22px] pb-[22px] pt-3.5">
        <div className="flex items-center gap-7">
          {stats.map((s) => (
            <div key={s.label}>
              <Label>
                <Swatch color={s.color} />
                {s.label}
              </Label>
              <div className="mt-1 text-2xl font-medium tracking-[-0.03em]">{s.value}</div>
            </div>
          ))}
        </div>
        <PortfolioChart />
      </div>
    </div>
  );
}

function DrawPanel() {
  const arrow = <ArrowRight size={13} strokeWidth={1.75} className="text-t3" />;
  return (
    <div className="panel">
      <div className="px-[22px] pb-[22px] pt-[18px]">
        <Segmented items={["Draw", "Repay"]} active="Draw" />
        <div className="mt-4 rounded-[14px] border border-line bg-bg px-4 py-3.5">
          <div className="flex items-center justify-between">
            <Label>Amount</Label>
            <Label>Available 16,794.00</Label>
          </div>
          <div className="mt-2.5 flex items-center justify-between">
            <span className="text-[32px] font-medium tracking-[-0.035em]">5,000.00</span>
            <span className="inline-flex h-9 items-center gap-2 rounded-full border border-line-2 bg-s3 pl-1.5 pr-2.5 font-medium">
              <Token src="/tokens/usdc.webp" size={20} />
              USDC
              <ChevronDown {...ic} className="text-t3" />
            </span>
          </div>
          <div className="mt-1 text-[12.5px] text-t3">$5,000.00</div>
        </div>
        <div className="mt-2.5 flex gap-1.5">
          {["25%", "30%", "50%", "Max"].map((q) => (
            <div key={q} className={`flex-1 rounded-lg border py-1.5 text-center text-xs font-medium ${q === "30%" ? "border-line-2 bg-s3 text-t1" : "border-line text-t2"}`}>
              {q}
            </div>
          ))}
        </div>
        <div className="mt-[18px]">
          <KV k="Health factor">
            <span className="text-green">2.16</span>
            {arrow}
            <span>1.60</span>
          </KV>
          <KV k="Credit used">
            46.3%{arrow}62.3%
          </KV>
          <KV k="Borrow APR">9.60%</KV>
          <KV k="Est. monthly interest">$156.40</KV>
          <KV k="Covered by autopay">
            <span className="text-green">~100%</span>
          </KV>
        </div>
        <div className="mt-[18px] flex h-12 w-full items-center justify-center rounded-xl bg-[#f4f4f5] text-[15px] font-medium text-[#09090b]">Draw 5,000 USDC</div>
        <div className="mt-3 flex items-center justify-center gap-1.5 text-xs text-t3">
          <ShieldCheck size={13} strokeWidth={1.75} />
          No maturity. Repay any time, no fees.
        </div>
      </div>
    </div>
  );
}

/** The Borrow dashboard rendered at its native 1440px width. Used live in the app and scaled down on the landing page. */
export function BorrowPreview() {
  return (
    <div className="relative bg-bg">
      <div className="app-ambient pointer-events-none absolute inset-x-0 top-0 h-[520px]" />
      <div className="relative">
        <AppNav />
        <main className="mx-auto max-w-[1280px] px-10 pb-16 pt-9">
          <div className="mb-7 flex items-end justify-between">
            <div>
              <h1 className="text-[32px] font-medium leading-[1.1] tracking-[-0.035em]">Credit Line</h1>
              <p className="mt-2 text-[14.5px] text-t2">Borrow USDC against your whole Solana portfolio. No maturity, repaid by your LP fees.</p>
            </div>
            <div className="flex gap-2">
              <Chip>
                Pool liquidity <b>$2,004,118</b>
              </Chip>
              <Chip>
                Borrow APR from <b>7.80%</b>
              </Chip>
            </div>
          </div>
          <CreditHero />
          <section className="mt-4 grid grid-cols-[minmax(0,1fr)_384px] gap-4">
            <PortfolioPanel />
            <DrawPanel />
          </section>
        </main>
      </div>
    </div>
  );
}
