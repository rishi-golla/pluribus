"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bell, ChevronDown, Search } from "lucide-react";
import { Brandmark, Tag, Token } from "@/components/ui";
import { useAccount } from "@/components/app/providers";
import { WalletButton } from "@/components/app/WalletButton";
import { usd } from "@/lib/account";
import { deployment } from "@/lib/cluster";

const ic = { size: 16, strokeWidth: 1.75 };
const LINKS = [
  { href: "/overview", label: "Overview" },
  { href: "/borrow", label: "Borrow" },
  { href: "/earn", label: "Earn" },
  { href: "/statements", label: "Statements" },
];

/** App header. Pass `active` to pin a tab (landing preview); otherwise it follows the current route. */
export function AppNav({ active }: { active?: string }) {
  const pathname = usePathname();
  const current = active ?? pathname;
  const { mode, loading, live } = useAccount();
  return (
    <header className="sticky top-0 z-40 flex h-16 items-center gap-10 border-b border-line bg-[rgb(7_8_10/0.7)] px-7 backdrop-blur-md">
      <Brandmark />
      <nav className="flex gap-0.5">
        {LINKS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className={`rounded-[9px] px-3.5 py-2 text-sm font-medium transition-colors ${current === l.href ? "bg-s3 text-t1" : "text-t2 hover:text-t1"}`}
          >
            {l.label}
          </Link>
        ))}
        <a href="#" className="rounded-[9px] px-3.5 py-2 text-sm font-medium text-t2 transition-colors hover:text-t1">
          Docs
        </a>
      </nav>
      <div className="ml-auto flex items-center gap-2">
        {!active && mode === "preview" && !loading && <Tag>Preview data</Tag>}
        <div className="flex items-center gap-1.5 px-2 text-[13px] text-t2">
          <Token src="/tokens/sol.webp" size={16} />
          {live && deployment ? (
            usd(live.prices[deployment.solMint])
          ) : (
            <>
              $150.12 <span className="text-green">+2.41%</span>
            </>
          )}
        </div>
        <div className="flex h-9 w-[220px] items-center gap-2 rounded-[10px] border border-line bg-s1 pl-3 pr-2.5 text-[13px] text-t3">
          <Search {...ic} />
          Search markets
          <kbd className="ml-auto rounded-[5px] border border-line-2 px-1.5 py-px font-mono text-[11px] text-t3">/</kbd>
        </div>
        <div className="grid size-9 place-items-center rounded-[10px] border border-line bg-s1 text-t2">
          <Bell {...ic} />
        </div>
        {active ? (
          <div className="flex h-9 items-center gap-2 rounded-[10px] border border-line bg-s1 pl-1.5 pr-2.5 text-[13px] font-medium">
            <span className="wallet-avatar size-6 rounded-[7px]" />
            7xKX...q9Fh
            <ChevronDown {...ic} className="text-t3" />
          </div>
        ) : (
          <WalletButton />
        )}
      </div>
    </header>
  );
}
