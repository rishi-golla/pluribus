"use client";

import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, Copy, Droplets, LogOut, Wallet } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { WalletReadyState } from "@solana/wallet-adapter-base";
import { useWallet } from "@solana/wallet-adapter-react";
import { Token } from "@/components/ui";
import { useAccount, useToast } from "@/components/app/providers";
import { DEMO_WALLET } from "@/lib/demo-wallet";
import { shortKey } from "@/lib/account";

const ic = { size: 16, strokeWidth: 1.75 };
const item = "flex w-full cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 text-left text-[13.5px] transition-colors hover:bg-white/[0.05]";

export function WalletButton() {
  const { wallets, publicKey, connecting, select, disconnect } = useWallet();
  const toast = useToast();
  const { live } = useAccount();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const ready = wallets.filter((w) => w.readyState === WalletReadyState.Installed || w.readyState === WalletReadyState.Loadable);
  const address = publicKey?.toBase58();

  // The blurred header traps fixed children inside its own box, so a full-screen backdrop cannot catch outside clicks here
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => (e instanceof KeyboardEvent ? e.key === "Escape" : !root.current?.contains(e.target as Node)) && setOpen(false);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  const copy = async () => {
    await navigator.clipboard.writeText(address!);
    toast({ title: "Address copied", detail: shortKey(address!), tone: "info" });
  };

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={`flex h-9 cursor-pointer items-center gap-2 rounded-lg border border-line bg-s1 pr-2.5 text-[13px] font-medium transition-colors hover:border-line-2 ${address ? "pl-1.5" : "pl-3"}`}
      >
        {address ? <span className="wallet-avatar size-6 rounded-md" /> : <Wallet {...ic} className="text-t2" />}
        {address ? shortKey(address) : connecting ? "Connecting..." : "Connect wallet"}
        <ChevronDown {...ic} className={`text-t3 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      <AnimatePresence>
        {open && (
            <motion.div
              role="menu"
              className="glass-tip absolute right-0 z-30 mt-2 w-56 rounded-[10px] border border-line-2 p-1.5"
              initial={{ opacity: 0, y: -6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.98 }}
              transition={{ duration: 0.18 }}
              onClick={() => setOpen(false)}
            >
              {address ? (
                <>
                  <button type="button" role="menuitem" onClick={copy} className={item}>
                    <Copy {...ic} className="text-t3" />
                    Copy address
                  </button>
                  {live?.canFund && (
                    <>
                      <button type="button" role="menuitem" onClick={() => live.fund()} className={item}>
                        <Droplets {...ic} className="text-t3" />
                        Get test tokens
                      </button>
                      <button type="button" role="menuitem" onClick={() => live.fundUsdc()} className={item}>
                        <Token src="/tokens/usdc.webp" size={16} />
                        Get 50,000 USDC
                      </button>
                    </>
                  )}
                  <button type="button" role="menuitem" onClick={() => disconnect()} className={item}>
                    <LogOut {...ic} className="text-t3" />
                    Disconnect
                  </button>
                </>
              ) : (
                <>
                  {ready.map((w) => (
                    <button key={w.adapter.name} type="button" role="menuitem" onClick={() => select(w.adapter.name)} className={item}>
                      {w.adapter.name === DEMO_WALLET ? <span className="wallet-avatar size-5 rounded" /> : <Token src={w.adapter.icon} size={20} className="!rounded-md [&_img]:rounded-md" />}
                      {w.adapter.name}
                    </button>
                  ))}
                  {!ready.length && <div className="px-3 py-2 text-[12.5px] text-t3">No wallet found. Install Phantom or Solflare, then reload.</div>}
                </>
              )}
            </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
