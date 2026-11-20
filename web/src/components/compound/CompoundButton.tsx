"use client";

import { motion } from "motion/react";
import { useState } from "react";
import { useCompounder } from "@/components/app/compounder";
import { useAccount, useToast } from "@/components/app/providers";
import { percent } from "@/lib/compound";

/** Working is everything before the wallet is asked: making accounts, looking, packing */
type Stage = "idle" | "working" | "signing" | "confirming";
/** The bounty the hint uses when no wallet is connected */
const SAMPLE_BOUNTY_BPS = 200;

const label = (stage: Stage) =>
  stage === "working" ? "Checking positions..." : stage === "signing" ? "Confirm in wallet..." : stage === "confirming" ? "Confirming..." : "Collect fees";

/**
 * One button for the Overview: collects the fees of every position worth it, compounding those whose owners chose that and
 * autopaying the rest, and the bounty goes to the connected wallet
 */
export function CompoundButton() {
  const c = useCompounder();
  const { live } = useAccount();
  const toast = useToast();
  const [stage, setStage] = useState<Stage>("idle");
  const bounty = percent(live ? live.pool.compoundBountyBps : SAMPLE_BOUNTY_BPS);
  const busy = stage !== "idle" || c.working;

  const run = async () => {
    if (c.mode === "preview") return toast({ title: "Connect a wallet to collect fees", detail: `${bounty} of the fees is paid to it`, tone: "info" });
    setStage("working");
    try {
      // makes the bounty's token accounts when missing, looks, sends, and says how it went in a toast
      await c.compoundAll(setStage);
    } finally {
      setStage("idle");
    }
  };

  return (
    <motion.button
      type="button"
      onClick={run}
      disabled={busy}
      whileTap={busy ? undefined : { scale: 0.97 }}
      title={`Collect borrowers' LP fees: they repay debt or go back into the position, as each owner chose. ${bounty} of them is paid to your wallet.`}
      className={`inline-flex h-[34px] items-center gap-2 whitespace-nowrap rounded-lg border border-line-2 bg-s2 px-3.5 text-[13px] font-medium transition-colors ${
        busy ? "cursor-not-allowed text-t3" : "cursor-pointer hover:bg-s3"
      }`}
    >
      {busy && <span className="inline-block size-3.5 animate-spin rounded-full border-2 border-white/15 border-t-t2" aria-hidden />}
      {label(stage)}
    </motion.button>
  );
}
