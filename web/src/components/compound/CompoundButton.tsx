"use client";

import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { KV } from "@/components/ui";
import { useCompounder } from "@/components/app/compounder";
import { useAccount, useToast } from "@/components/app/providers";
import { usd } from "@/lib/account";
import { percent } from "@/lib/compound";

/** Working is everything before the wallet is asked: looking, packing */
type Stage = "idle" | "working" | "signing" | "confirming";
/** The bounty the sample figures use when no wallet is connected */
const SAMPLE_BOUNTY_BPS = 200;

const stageText = (stage: Stage, idle: string) =>
  stage === "working" ? "Working..." : stage === "signing" ? "Confirm in wallet..." : stage === "confirming" ? "Confirming on Solana..." : idle;

function Body({ onClose }: { onClose: () => void }) {
  const c = useCompounder();
  const { live } = useAccount();
  const toast = useToast();
  const [stage, setStage] = useState<Stage>("idle");
  const preview = c.mode === "preview";
  const bounty = percent(live ? live.pool.compoundBountyBps : SAMPLE_BOUNTY_BPS);
  const { mode, ensure } = c;
  // looks when the pop-up opens, not on every visit to the page, to spare the rpc
  useEffect(() => {
    if (mode === "live") ensure();
  }, [mode, ensure]);

  const needsSetup = !preview && c.scan.status === "setup";
  const looking = !preview && (c.scan.status === "idle" || c.scan.status === "scanning") && !c.scan.items.length;
  const failed = !preview && c.scan.status === "error" && !c.scan.items.length;
  const blocked = stage !== "idle" || c.working || looking || (!preview && !needsSetup && !failed && c.count === 0);
  const idle = needsSetup ? "Create accounts" : failed ? "Check again" : looking ? "Checking positions..." : c.count || preview ? "Compound all" : "Nothing ready right now";

  const run = async () => {
    if (preview) return toast({ title: "Connect a wallet to compound", detail: "Your share is paid to it", tone: "info" });
    if (failed) return c.rescan();
    setStage("working");
    try {
      const ok = await (needsSetup ? c.setup : c.compoundAll)((s) => setStage(s));
      if (ok && !needsSetup) onClose();
    } finally {
      setStage("idle");
    }
  };

  return (
    <div className="px-[22px] pb-[22px] pt-[18px]">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[15px] font-medium tracking-[-0.01em]">Compound LP fees</h3>
        <button type="button" aria-label="Close" onClick={onClose} className="cursor-pointer text-t3 transition-colors hover:text-t1">
          <X size={16} strokeWidth={1.75} />
        </button>
      </div>
      <p className="text-[13.5px] leading-[1.55] text-t2">
        Some borrowers let anyone put their LP fees back into their positions. Do it for them and {bounty} of those fees is paid to your wallet.{" "}
        <Link href="/docs#compounding" className="text-t1 underline decoration-line-2 underline-offset-2 hover:decoration-t1">
          How it works
        </Link>
      </p>
      <div className="mt-3.5 border-t border-line pt-2">
        <KV k="Ready now">{needsSetup || looking || failed ? "-" : `${c.count} ${c.count === 1 ? "position" : "positions"}`}</KV>
        <KV k="Paid to you">{needsSetup || looking || failed ? "-" : <span className={c.usd > 0 ? "text-green" : ""}>about {usd(c.usd, 2)}</span>}</KV>
      </div>
      {needsSetup && (
        <p className="mt-1 text-[12.5px] leading-[1.55] text-t3">
          Your share is paid in SOL and USDC, and your wallet needs an account for each. Creating them takes one approval, once.
        </p>
      )}
      {failed && (
        <p className="mt-1 text-[12.5px] leading-[1.55] text-red" role="alert">
          {c.scan.error ?? "Could not check for positions"}
        </p>
      )}
      <motion.button
        type="button"
        onClick={run}
        disabled={blocked}
        whileTap={blocked ? undefined : { scale: 0.98 }}
        className={`mt-[18px] flex h-12 w-full items-center justify-center gap-2.5 rounded-[10px] text-[15px] font-medium transition-colors ${
          blocked ? "cursor-not-allowed bg-s3 text-t3" : "cursor-pointer bg-brand text-[#0c0c0c] hover:bg-[#d4ff5e]"
        }`}
      >
        {stage !== "idle" && <span className="inline-block size-4 animate-spin rounded-full border-2 border-white/15 border-t-t2" aria-hidden />}
        {stageText(stage, c.working ? "Working..." : idle)}
      </motion.button>
    </div>
  );
}

/** One button for the Overview: compounds every opted-in position in the pool for the bounty, from a pop-up that says what that is */
export function CompoundButton() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex h-[34px] cursor-pointer items-center whitespace-nowrap rounded-lg border border-line-2 bg-s2 px-3.5 text-[13px] font-medium transition-colors hover:bg-s3"
      >
        Compound
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="fixed inset-0 z-50 grid place-items-center bg-[rgb(12_12_12/0.7)] backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={() => setOpen(false)}
          >
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-label="Compound LP fees"
              className="panel w-[420px]"
              initial={{ y: 12, scale: 0.98 }}
              animate={{ y: 0, scale: 1 }}
              exit={{ y: 8, scale: 0.98 }}
              transition={{ type: "spring", stiffness: 380, damping: 30 }}
              onClick={(e) => e.stopPropagation()}
            >
              <Body onClose={() => setOpen(false)} />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
