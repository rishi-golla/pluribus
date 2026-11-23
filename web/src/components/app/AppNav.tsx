"use client";

import { Bell, ChevronDown, Search } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { SiteNav } from "@/components/SiteNav";
import { Token } from "@/components/ui";
import { useAccount } from "@/components/app/providers";
import { WalletButton } from "@/components/app/WalletButton";
import { usd } from "@/lib/account";
import { CLUSTER, deployment } from "@/lib/cluster";
import { MARKETS, focusMarket, listed, type Market } from "@/lib/markets";
import { iconSrc } from "@/lib/tokens";

const ic = { size: 16, strokeWidth: 1.75 };
const bar = "flex h-9 w-[220px] items-center gap-2 rounded-lg border border-line bg-s1 pl-3 pr-2.5 text-[13px] text-t3";
const slash = <kbd className="ml-auto rounded border border-line-2 px-1.5 py-px font-mono text-[11px] text-t3">/</kbd>;

/** Finds a market by name, protocol or asset class and opens it in the Overview table */
function MarketSearch() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const term = query.trim().toLowerCase();
  // only markets the overview table has a row for: the listed ones, or all of them when no deployment is loaded
  const hits = term ? MARKETS.filter((m) => (!deployment || listed(m)) && `${m.name} ${m.sub} ${m.cls}`.toLowerCase().includes(term)) : [];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      // a slash typed into another field is text, not the shortcut
      if (e.key !== "/" || e.metaKey || e.ctrlKey || el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return;
      e.preventDefault();
      input.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const go = (m: Market) => {
    focusMarket(m.id);
    setQuery("");
    input.current?.blur();
    router.push("/overview");
  };

  return (
    <div className="relative hidden xl:block">
      <label className={`${bar} cursor-text transition-colors focus-within:border-line-2`}>
        <Search {...ic} className="shrink-0" />
        <input
          ref={input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && hits[0]) go(hits[0]);
            if (e.key === "Escape") {
              setQuery("");
              input.current?.blur();
            }
          }}
          placeholder="Search markets"
          aria-label="Search markets"
          role="combobox"
          aria-expanded={open && !!term}
          aria-controls="market-results"
          autoComplete="off"
          className="w-full min-w-0 bg-transparent text-t1 outline-none placeholder:text-t3"
        />
        {slash}
      </label>
      {open && term && (
        <div id="market-results" role="listbox" aria-label="Markets" className="glass-tip absolute left-0 z-30 mt-2 w-[280px] rounded-[10px] border border-line-2 p-1.5">
          {hits.map((m, i) => (
            <button
              key={m.id}
              type="button"
              role="option"
              aria-selected={i === 0}
              // the input would blur and close the list before a click lands
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => go(m)}
              className={`flex w-full cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 text-left text-[13.5px] text-t1 transition-colors hover:bg-white/[0.05] ${i === 0 ? "bg-white/[0.03]" : ""}`}
            >
              <Token src={iconSrc(m.icon)} size={18} />
              <span className="font-medium">{m.name}</span>
              <span className="truncate text-[12.5px] text-t3">{m.sub}</span>
            </button>
          ))}
          {!hits.length && <div className="px-3 py-2 text-[12.5px] text-t3">No markets match</div>}
        </div>
      )}
    </div>
  );
}

/** App header. Pass `active` to pin a tab (landing preview); otherwise it follows the current route. */
export function AppNav({ active }: { active?: string }) {
  const { live } = useAccount();
  return (
    <SiteNav
      active={active}
      below={
        // always in view on the app pages: nothing here is worth money
        !active && (
          <div className="bg-bg">
            <div role="note" className="flex min-h-7 items-center justify-center border-b border-line bg-orange-dim px-4 py-1 text-center text-[12px] font-medium text-orange sm:px-7">
              You are currently on {CLUSTER === "localnet" ? "Localnet" : "Devnet"} mode. Tokens are mocks with no real value.
            </div>
          </div>
        )
      }
    >
      {/* The landing frame shows its demo price, and the app shows the chain's once a wallet's account is read */}
      {(active || (live && deployment)) && (
        <div className="hidden items-center gap-1.5 px-2 text-[13px] text-t2 lg:flex">
          <Token src="/tokens/sol.webp" size={16} />
          {live && deployment ? usd(live.prices[deployment.solMint]) : "$150.12"}
        </div>
      )}
      {active ? (
        <div className="hidden xl:block">
          <div className={bar}>
              <Search {...ic} />
              Search markets
              {slash}
            </div>
        </div>
      ) : (
        <MarketSearch />
      )}
      <div className="hidden size-9 place-items-center rounded-lg border border-line bg-s1 text-t2 lg:grid">
        <Bell {...ic} />
      </div>
      {active ? (
        <div className="flex h-9 items-center gap-2 rounded-lg border border-line bg-s1 pl-1.5 pr-2.5 text-[13px] font-medium">
          <span className="wallet-avatar size-6 rounded-md" />
          7xKX...q9Fh
          <ChevronDown {...ic} className="text-t3" />
        </div>
      ) : (
        <WalletButton />
      )}
    </SiteNav>
  );
}
