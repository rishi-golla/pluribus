"use client";

import { Bell, ChevronDown, Search } from "lucide-react";
import { SiteNav } from "@/components/SiteNav";
import { Tag, Token } from "@/components/ui";
import { useAccount } from "@/components/app/providers";
import { WalletButton } from "@/components/app/WalletButton";
import { usd } from "@/lib/account";
import { CLUSTER, deployment } from "@/lib/cluster";

const ic = { size: 16, strokeWidth: 1.75 };

/** App header. Pass `active` to pin a tab (landing preview); otherwise it follows the current route. */
export function AppNav({ active }: { active?: string }) {
  const { mode, loading, live, error } = useAccount();
  return (
    <SiteNav
      active={active}
      below={
        // always in view on the app pages: nothing here is worth money and nobody has audited the program
        !active && (
          <div className="bg-bg">
            <div role="note" className="flex h-7 items-center justify-center border-b border-line bg-orange-dim px-7 text-[12px] font-medium text-orange">
              {CLUSTER === "localnet" ? "Local chain" : "Devnet"} demo. Tokens are mocks with no value
              {deployment?.demoMode ? ", prices are set by hand" : ""}, and the program is unaudited.
            </div>
          </div>
        )
      }
    >
      {!active && mode === "preview" && !loading && !error && <Tag>Preview data</Tag>}
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
      <div className="flex h-9 w-[220px] items-center gap-2 rounded-lg border border-line bg-s1 pl-3 pr-2.5 text-[13px] text-t3">
        <Search {...ic} />
        Search markets
        <kbd className="ml-auto rounded border border-line-2 px-1.5 py-px font-mono text-[11px] text-t3">/</kbd>
      </div>
      <div className="grid size-9 place-items-center rounded-lg border border-line bg-s1 text-t2">
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
