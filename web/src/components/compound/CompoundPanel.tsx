"use client";

import { Play, RefreshCw, ShieldCheck, Square } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Label, StatusDot, Tag } from "@/components/ui";
import { useCompounder, type CompoundLog, type Compounder } from "@/components/app/compounder";
import { useAccount, useToast, type OnStage } from "@/components/app/providers";
import { shortKey, usd } from "@/lib/account";
import { AUTO_MS, FUND_SOL, percent } from "@/lib/compound";

/** Working is everything before the wallet is asked: looking, packing, funding */
type Stage = "idle" | "working" | "signing" | "confirming";
const SAMPLE_BOUNTY_BPS = 200;
const TONES: Record<CompoundLog["tone"], string> = { ok: "text-green", info: "text-t2", error: "text-red" };
const SECONDARY = "inline-flex h-9 cursor-pointer items-center justify-center gap-2 whitespace-nowrap border border-line-2 bg-s2 px-3.5 text-[13.5px] font-medium transition-colors hover:bg-s3 disabled:cursor-not-allowed disabled:opacity-50";
const PRIMARY = "inline-flex h-9 cursor-pointer items-center justify-center gap-2 whitespace-nowrap bg-brand px-3.5 text-[13.5px] font-medium text-[#09090b] transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-s3 disabled:text-t3";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const stageText = (stage: Stage, idle: string) =>
  stage === "working" ? "Working..." : stage === "signing" ? "Confirm in wallet..." : stage === "confirming" ? "Confirming on Solana..." : idle;

/** The compounder's figures for a page, which looks again when its last look is old and answers with sample figures with no wallet */
function useLook() {
  const c = useCompounder();
  const { mode, ensure } = c;
  useEffect(() => {
    if (mode === "live") ensure();
  }, [mode, ensure]);
  return c;
}

/** What the last look found, as a line */
function summary(c: Compounder) {
  if (c.mode === "preview") return `${plural(c.count, "position", "positions")} ready, about ${usd(c.usd)} of bounty`;
  if (c.scan.status === "setup") return "Needs your bounty token accounts first";
  if (c.scan.status === "error" && !c.scan.items.length) return c.scan.error ?? "Could not check";
  if (c.scan.status === "scanning" && !c.scan.items.length) return "Checking positions...";
  return c.count ? `${plural(c.count, "position", "positions")} ready, about ${usd(c.usd)} of bounty` : "Nothing ready right now";
}

function Spinner() {
  return <span className="inline-block size-4 animate-spin rounded-full border-2 border-[#09090b]/25 border-t-[#09090b]" aria-hidden />;
}

function AutoCard({ c, stage, onStart }: { c: Compounder; stage: Stage; onStart: () => void }) {
  const { auto } = c;
  const idle = !auto.running && !auto.busy;
  return (
    <div className="border border-line bg-bg p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 font-medium">
          Auto-compound
          <Tag tone={auto.running ? "green" : "neutral"}>
            <StatusDot />
            {auto.running ? (auto.busy ? "Working" : "Running") : auto.busy ? "Finishing" : "Off"}
          </Tag>
        </div>
        {auto.running ? (
          <button type="button" onClick={auto.stop} className={SECONDARY}>
            <Square size={14} strokeWidth={1.75} />
            Stop
          </button>
        ) : (
          <button type="button" onClick={onStart} disabled={stage !== "idle" || !idle || auto.returning} className={PRIMARY}>
            {stage !== "idle" ? <Spinner /> : <Play size={14} strokeWidth={1.75} />}
            {stageText(stage, "Start")}
          </button>
        )}
      </div>
      <p className="mt-2.5 text-[13px] leading-[1.55] text-t2">
        Runs while this tab is open. A throwaway key in this browser looks every {AUTO_MS / 60_000} minutes and compounds for you, with the bounty paid to your wallet. Starting it takes one wallet prompt that sends the key{" "}
        <b className="font-medium text-t1">{FUND_SOL} SOL</b> for fees.
      </p>
      <div className="mt-3 flex items-start gap-2 bg-s2 px-3 py-2.5 text-[12.5px] leading-[1.5] text-t2">
        <ShieldCheck size={14} strokeWidth={1.75} className="mt-px shrink-0 text-green" />
        The session key only pays transaction fees and compounds. It holds no deposits or credit, and it never has your funds: bounties go straight to your wallet.
      </div>
      {auto.address && (
        <div className="mt-3 flex items-center justify-between gap-3 text-[13px]">
          <span className="text-t2">
            Session key <span className="font-medium text-t1">{shortKey(auto.address)}</span>
            <span className="text-t3"> · {auto.sol !== null ? `${auto.sol.toFixed(4)} SOL` : "..."}</span>
          </span>
          <button
            type="button"
            onClick={() => void auto.returnSol()}
            disabled={auto.returning}
            title="Send the key's remaining SOL back to your wallet and forget it"
            className="cursor-pointer text-t2 transition-colors hover:text-t1 hover:underline disabled:cursor-not-allowed disabled:opacity-50 disabled:no-underline"
          >
            {auto.returning ? "Returning..." : "Return SOL"}
          </button>
        </div>
      )}
      <div className="mt-3 grid grid-cols-3 gap-px overflow-hidden border border-line bg-line">
        {[
          ["Compounded", plural(auto.totals.positions, "position", "positions")],
          ["Bounty earned", usd(auto.totals.usd, 4)],
          ["Failed", String(auto.totals.failed)],
        ].map(([k, v]) => (
          <div key={k} className="bg-s1 px-3 py-2">
            <Label>{k}</Label>
            <div className="mt-0.5 text-[14px] font-medium tracking-[-0.01em]">{v}</div>
          </div>
        ))}
      </div>
      <ul className="mt-3 max-h-[128px] space-y-1 overflow-y-auto text-[12.5px]" aria-label="Auto-compound log" aria-live="polite">
        {auto.log.map((l) => (
          <li key={l.id} className="flex gap-2.5">
            <span className="shrink-0 tabular-nums text-t3">{new Date(l.at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" })}</span>
            <span className={TONES[l.tone]}>{l.text}</span>
          </li>
        ))}
        {!auto.log.length && <li className="text-t3">Nothing yet. Rounds and results show up here.</li>}
      </ul>
    </div>
  );
}

/** Compounds every opted-in position in the pool for the bounty, in one go or on a timer, for any connected wallet */
export function CompoundPanel() {
  const c = useLook();
  const { live } = useAccount();
  const toast = useToast();
  const [allStage, setAllStage] = useState<Stage>("idle");
  const [autoStage, setAutoStage] = useState<Stage>("idle");
  const [setupStage, setSetupStage] = useState<Stage>("idle");
  const preview = c.mode === "preview";
  const bountyBps = live ? live.pool.compoundBountyBps : SAMPLE_BOUNTY_BPS;
  const scanning = c.scan.status === "scanning";
  const needsSetup = !preview && c.scan.status === "setup";

  const connect = () => toast({ title: "Connect a wallet to compound", detail: "The bounty is paid to it", tone: "info" });
  const run = async (set: (s: Stage) => void, action: (onStage: OnStage) => Promise<boolean>) => {
    if (preview) return connect();
    set("working");
    try {
      await action((s) => set(s));
    } finally {
      set("idle");
    }
  };

  return (
    <section id="compound" className="panel mt-4 scroll-mt-24">
      <div className="flex items-center justify-between px-[22px] pt-[18px]">
        <h3 className="flex items-center gap-2 text-[15px] font-medium tracking-[-0.01em]">
          Compound for everyone
          {!preview && c.scan.status === "ready" && <Tag tone={c.count ? "green" : "neutral"}>{c.count ? `${c.count} ready` : "None ready"}</Tag>}
          {preview && <Tag tone="green">{c.count} ready</Tag>}
        </h3>
        <button
          type="button"
          onClick={() => (preview ? connect() : c.rescan())}
          disabled={scanning || needsSetup}
          className="inline-flex cursor-pointer items-center gap-1.5 text-[13px] text-t2 transition-colors hover:text-t1 disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw size={13} strokeWidth={1.75} className={scanning ? "animate-spin" : ""} />
          {scanning ? "Checking" : "Check now"}
        </button>
      </div>
      <div className="px-[22px] pb-[22px] pt-3">
        <p className="max-w-[760px] text-[13.5px] leading-[1.55] text-t2">
          Borrowers can let anyone put the fees of their LP and Meteora positions back into them. Whoever compounds is paid {percent(bountyBps)} of the fees, and you do not need a position of your own to do it.
        </p>
        <div className="mt-4 grid grid-cols-3 gap-px overflow-hidden border border-line bg-line">
          {[
            ["Ready now", needsSetup ? "-" : plural(c.count, "position", "positions")],
            ["Estimated bounty", needsSetup ? "-" : usd(c.usd, 2)],
            ["Paid to whoever compounds", `${percent(bountyBps)} of fees`],
          ].map(([k, v]) => (
            <div key={k} className="bg-s1 px-3.5 py-3">
              <Label>{k}</Label>
              <div className={`mt-1 text-[17px] font-medium tracking-[-0.02em] ${k === "Estimated bounty" && c.usd > 0 ? "text-green" : ""}`}>{v}</div>
            </div>
          ))}
        </div>
        {!preview && c.scan.status === "error" && (
          <div className="mt-3 text-[13px] text-red" role="alert">
            {c.scan.error ?? "Could not check for positions"}. Check now to try again.
          </div>
        )}
        {needsSetup ? (
          <div className="mt-4 flex items-center justify-between gap-4 border border-line bg-bg p-4">
            <p className="text-[13px] leading-[1.55] text-t2">
              The bounty is paid into token accounts of your own for SOL and USDC. Creating them takes one wallet prompt and a little rent, once, and then the positions ready to compound show up here.
            </p>
            <button type="button" onClick={() => run(setSetupStage, c.setup)} disabled={setupStage !== "idle"} className={`${PRIMARY} shrink-0`}>
              {setupStage !== "idle" && <Spinner />}
              {stageText(setupStage, "Create accounts")}
            </button>
          </div>
        ) : (
          <div className="mt-4 grid grid-cols-2 gap-4">
            <div className="flex flex-col border border-line bg-bg p-4">
              <div className="font-medium">Compound all</div>
              <p className="mt-2.5 text-[13px] leading-[1.55] text-t2">
                Packs every position that is ready into as few transactions as fit and signs them all in one wallet prompt. The bounty goes to your wallet, and a batch that fails does not stop the rest.
              </p>
              <div className="mt-auto flex items-center justify-between gap-3 pt-4">
                <span className="text-[13px] text-t2">{summary(c)}</span>
                <button
                  type="button"
                  onClick={() => run(setAllStage, c.compoundAll)}
                  disabled={allStage !== "idle" || c.working || (!preview && (c.count === 0 || scanning))}
                  className={`${PRIMARY} shrink-0`}
                >
                  {allStage !== "idle" && <Spinner />}
                  {stageText(allStage, c.working && allStage === "idle" ? "Working..." : "Compound all")}
                </button>
              </div>
            </div>
            <AutoCard c={c} stage={autoStage} onStart={() => run(setAutoStage, c.auto.start)} />
          </div>
        )}
      </div>
    </section>
  );
}

/** A compact line for the Borrow page: what is ready and a way to compound it or open the full panel */
export function CompoundStrip() {
  const c = useLook();
  const toast = useToast();
  const [stage, setStage] = useState<Stage>("idle");
  const preview = c.mode === "preview";
  const run = async () => {
    if (preview) return toast({ title: "Connect a wallet to compound", detail: "The bounty is paid to it", tone: "info" });
    setStage("working");
    try {
      await c.compoundAll((s) => setStage(s));
    } finally {
      setStage("idle");
    }
  };
  return (
    <div className="mt-3.5 flex items-center justify-between gap-3 border border-line px-3.5 py-3">
      <div className="min-w-0">
        <div className="text-[13px] font-medium">Compound for everyone</div>
        <div className="mt-0.5 truncate text-[12.5px] text-t3">{summary(c)}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Link href="/overview#compound" className="text-[12.5px] text-t2 transition-colors hover:text-t1 hover:underline">
          Auto-compound
        </Link>
        <button
          type="button"
          onClick={run}
          disabled={stage !== "idle" || c.working || (!preview && (c.count === 0 || c.scan.status === "setup"))}
          className="h-7 cursor-pointer whitespace-nowrap border border-line-2 bg-s2 px-2.5 text-[12.5px] font-medium transition-colors hover:bg-s3 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {stageText(stage, "Compound all")}
        </button>
      </div>
    </div>
  );
}
