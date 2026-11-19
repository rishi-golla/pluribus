"use client";

import { AnimatePresence, motion } from "motion/react";
import { ChevronDown, X } from "lucide-react";
import { useEffect, useState } from "react";
import { KV, Label } from "@/components/ui";
import { Segmented } from "@/components/Segmented";
import { useToast, type Live } from "@/components/app/providers";
import { MAX_TOLERANCE_BPS, TOLERANCES, percent } from "@/lib/compound";

/** The bounty the sample figures use when no wallet is connected */
const SAMPLE_BOUNTY_BPS = 200;

type Mode = "Repay debt" | "Compound";
/** A position whose fees can be set: its id (the NFT mint, or the Meteora position account), its name and what it does now */
export type CompoundTarget = { id: string; name: string; sub: string; bps: number; dlmm: boolean };

/** What a position does with its fees, as a small button that opens the setting */
export function CompoundPill({ bps, onOpen }: { bps: number; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onOpen();
      }}
      title="Change what this position's fees do"
      className={`mt-2 inline-flex h-[22px] cursor-pointer items-center gap-1 whitespace-nowrap rounded border border-line-2 px-2 text-[11px] font-medium transition-colors hover:bg-s2 hover:text-t1 ${bps ? "text-brand" : "text-t2"}`}
    >
      {bps ? `Fees: compound within ${percent(bps)}` : "Fees: repay debt"}
      <ChevronDown size={11} strokeWidth={2} />
    </button>
  );
}

function Form({ live, target, onClose }: { live: Live | null; target: CompoundTarget; onClose: () => void }) {
  const toast = useToast();
  const preset = (TOLERANCES as readonly number[]).includes(target.bps) ? target.bps : target.bps > 0 ? ("custom" as const) : 100;
  const [mode, setMode] = useState<Mode>(target.bps > 0 ? "Compound" : "Repay debt");
  const [picked, setPicked] = useState<number | "custom">(preset);
  const [custom, setCustom] = useState(preset === "custom" ? String(target.bps / 100) : "");
  const [status, setStatus] = useState<"idle" | "signing" | "confirming">("idle");
  const bounty = live ? live.pool.compoundBountyBps : SAMPLE_BOUNTY_BPS;

  const bps = mode === "Repay debt" ? 0 : picked === "custom" ? Math.round(Number(custom) * 100) : picked;
  const error =
    mode === "Compound" && picked === "custom" && !(bps >= 1 && bps <= MAX_TOLERANCE_BPS)
      ? `Enter ${percent(1)} to ${percent(MAX_TOLERANCE_BPS)}`
      : bps === target.bps
        ? "No change"
        : null;
  const label = status === "signing" ? "Confirm in wallet..." : status === "confirming" ? "Confirming on Solana..." : (error ?? "Save");

  const submit = async () => {
    if (error || status !== "idle") return;
    if (!live) {
      toast({ title: "Connect a wallet to change this", detail: "Each position has its own setting", tone: "info" });
      onClose();
      return;
    }
    const ok = await live.setCompound(target.id, bps, setStatus);
    setStatus("idle");
    if (!ok) return;
    toast(
      bps
        ? { title: `Compounding within ${percent(bps)}`, detail: `${target.name} fees go back into the position, and ${percent(bounty)} of them pays whoever compounds` }
        : { title: "Fees repay debt", detail: `${target.name} goes back to autopay` },
    );
    onClose();
  };

  return (
    <div className="px-[22px] pb-[22px] pt-[18px]">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-[15px] font-medium tracking-[-0.01em]">Position fees</h3>
        <button type="button" aria-label="Close" onClick={onClose} className="cursor-pointer text-t3 transition-colors hover:text-t1">
          <X size={16} strokeWidth={1.75} />
        </button>
      </div>
      <div className="mb-3.5 text-[13px] text-t3">
        {target.name}, {target.sub}
      </div>
      <Segmented label="Fees" items={["Repay debt", "Compound"] as const} value={mode} onChange={setMode} />
      {mode === "Repay debt" ? (
        <p className="mt-3.5 text-[13px] leading-[1.55] text-t2">
          Autopay collects this position&apos;s fees. The USDC part repays your debt, and the rest stays in your account as collateral.
        </p>
      ) : (
        <>
          <div className="mb-2 mt-[18px]">
            <Label>Compound only while the pool&apos;s price is within</Label>
          </div>
          <div role="radiogroup" aria-label="Tolerance" className="flex gap-1.5">
            {[...TOLERANCES, "custom" as const].map((t) => {
              const on = t === picked;
              return (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setPicked(t)}
                  className={`h-9 flex-1 cursor-pointer rounded-md border text-[13px] font-medium transition-colors ${on ? "border-brand/45 bg-brand/5 text-t1" : "border-line text-t2 hover:border-line-2 hover:text-t1"}`}
                >
                  {t === "custom" ? "Custom" : percent(t)}
                </button>
              );
            })}
          </div>
          {picked === "custom" && (
            <label className="mt-2.5 flex items-center justify-between gap-3 rounded-[10px] border border-line bg-bg px-4 py-2.5 transition-colors focus-within:border-line-2">
              <input
                inputMode="decimal"
                aria-label={`Tolerance in percent, up to ${percent(MAX_TOLERANCE_BPS)}`}
                placeholder="0.75"
                value={custom}
                onChange={(e) => /^\d{0,2}\.?\d{0,2}$/.test(e.target.value) && setCustom(e.target.value)}
                className="w-full min-w-0 bg-transparent text-[20px] font-medium tracking-[-0.02em] text-t1 outline-none placeholder:text-t3"
              />
              <span className="text-t3">% of the oracle price, up to {percent(MAX_TOLERANCE_BPS)}</span>
            </label>
          )}
          <p className="mt-3 text-[12.5px] leading-[1.55] text-t3">
            A looser tolerance lets compounding run more often, but exposes more of the fees to price manipulation.
          </p>
          <div className="mt-2">
            <KV k="Paid to whoever compounds" dense>
              {percent(bounty)} of the fees
            </KV>
          </div>
          <p className="mt-1 text-[12.5px] leading-[1.55] text-t3">
            The rest goes back into the position, anything its range cannot take stays as collateral, and compounding can only raise your health. While it is on, autopay leaves this position alone.
          </p>
        </>
      )}
      <motion.button
        type="button"
        onClick={submit}
        disabled={!!error || status !== "idle"}
        whileTap={!error && status === "idle" ? { scale: 0.98 } : undefined}
        className={`mt-[18px] flex h-12 w-full items-center justify-center gap-2.5 rounded-[10px] text-[15px] font-medium transition-colors ${
          error ? "cursor-not-allowed bg-s3 text-t3" : "cursor-pointer bg-brand text-[#0c0c0c] hover:bg-[#d4ff5e]"
        }`}
      >
        {status !== "idle" && <span className="inline-block size-4 animate-spin rounded-full border-2 border-[#09090b]/25 border-t-[#09090b]" aria-hidden />}
        {label}
      </motion.button>
    </div>
  );
}

/** Sets what one LP or Meteora position does with its fees, for the owner, with `live` null for the sample figures */
export function CompoundDialog({ live, target, onClose }: { live: Live | null; target: CompoundTarget | null; onClose: () => void }) {
  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [target, onClose]);

  return (
    <AnimatePresence>
      {target && (
        <motion.div
          className="fixed inset-0 z-50 grid place-items-center bg-[rgb(12_12_12/0.7)] backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onClick={onClose}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Position fees"
            className="panel w-[420px]"
            initial={{ y: 12, scale: 0.98 }}
            animate={{ y: 0, scale: 1 }}
            exit={{ y: 8, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 380, damping: 30 }}
            onClick={(e) => e.stopPropagation()}
          >
            <Form key={target.id} live={live} target={target} onClose={onClose} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
