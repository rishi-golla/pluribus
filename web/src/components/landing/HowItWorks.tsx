"use client";

import { AnimatePresence, motion, useInView } from "motion/react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EASE, Num } from "@/components/motion";
import { CLUSTER } from "@/lib/cluster";
import { ASSET_CLASSES, seeded, type AssetKey } from "./assets";
import { EXAMPLE_USD, usePoolFacts, type Example } from "./PoolFacts";

// The example portfolio drawn as blocks of $125 each
const BLOCK_USD = 125;
const COLS = 12;
const COUNTS = Object.fromEntries(ASSET_CLASSES.map((c) => [c.key, Math.round(EXAMPLE_USD[c.key] / BLOCK_USD)])) as Record<AssetKey, number>;
const TOTAL = Object.values(COUNTS).reduce((a, b) => a + b, 0);
const NO_LOSS: Record<AssetKey, number> = { sol: 0, lp: 0, stock: 0, usdc: 0 };

/** Blocks each class loses in the pool's worst crash for this portfolio, from what it still backs there */
const lostOf = (ex: Example | null) =>
  ex ? (Object.fromEntries(ASSET_CLASSES.map((c) => [c.key, Math.min(COUNTS[c.key], Math.max(0, Math.round((EXAMPLE_USD[c.key] - ex.survived[c.key]) / BLOCK_USD)))])) as Record<AssetKey, number>) : NO_LOSS;

const usd = (blocks: number) => blocks * BLOCK_USD;
const dollars = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
const pct = (v: number, d = 0) => `${(v * 100).toFixed(d)}%`;
// How long each slide stays up before the carousel moves on
const SLIDE_MS = 4500;
const STEP_COUNT = 4;
const SNAP = { type: "spring", stiffness: 520, damping: 42, mass: 0.8 } as const;

type Block = { id: number; kind: AssetKey; color: string; lost: boolean };

function makeBlocks(lost: Record<AssetKey, number>): Block[] {
  const rand = seeded(42);
  const list = ASSET_CLASSES.flatMap((c) => Array.from({ length: COUNTS[c.key] }, () => ({ kind: c.key, color: c.color })));
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  const seen: Partial<Record<AssetKey, number>> = {};
  return list.map((b, id) => {
    seen[b.kind] = (seen[b.kind] ?? 0) + 1;
    return { ...b, id, lost: seen[b.kind]! <= lost[b.kind] };
  });
}

/** The four slides, with every figure from the pool's own settings, or a note when the pool could not be read */
function steps(ex: Example | null | undefined, drawn: number): { title: string; body: ReactNode }[] {
  const unread = ex === null ? ` Could not read the ${CLUSTER} pool, so no figures are shown.` : "";
  const tiers = ex?.tiers.filter((t) => t.discount > 0) ?? [];
  return [
    {
      title: "Bring everything you hold",
      body: (
        <>
          SOL, liquid staking tokens, LP positions from Orca, Raydium and Meteora, tokenized stocks, memecoins and USDC all go into one account. Here each block is ${BLOCK_USD} of an example{" "}
          {dollars(usd(TOTAL))} portfolio.
        </>
      ),
    },
    {
      title: "We crash-test it as a whole",
      body: ex ? (
        <>
          Pluribus replays {ex.scenarios} market crashes on the whole portfolio and keeps the worst one, here the {ex.scenario.toLowerCase()}: SOL falls{" "}
          {pct(ex.falls.sol)}, LP positions are repriced at the crash price, stocks fall {pct(ex.falls.stock)}, and each asset&apos;s liquidation cost comes off. The
          faded blocks are value that might not survive.
        </>
      ) : (
        <>Pluribus replays every crash scenario in the pool on the whole portfolio and keeps the worst one.{unread}</>
      ),
    },
    {
      title: "What survives is your credit line",
      body: ex ? (
        <>
          The blocks still standing back a USDC credit line of {dollars(ex.creditLimit)}. Draw any part of it, with no maturity date. Blocks marked orange back the{" "}
          {dollars(usd(drawn))} drawn here. It is one loan from the lending pool, so every deposit stays in place.
        </>
      ) : (
        <>The blocks still standing back a USDC credit line. Draw any part of it, with no maturity date. It is one loan from the lending pool, so every deposit stays in place.{unread}</>
      ),
    },
    {
      title: "Your LP fees pay it down",
      body: (
        <>
          A keeper collects the fees your LP positions earn and repays your debt with the USDC part.
          {tiers.length > 0 && ` Stay healthy and your rate drops too, ${tiers.map((t) => `by ${pct(t.discount, 1)} after ${t.days} days`).join(" and ")}.`}
        </>
      ),
    },
  ];
}

export function HowItWorks() {
  const ex = usePoolFacts()?.example;
  const lost = useMemo(() => lostOf(ex ?? null), [ex]);
  const blocks = useMemo(() => makeBlocks(lost), [lost]);
  const limitBlocks = TOTAL - Object.values(lost).reduce((a, b) => a + b, 0);
  // Three quarters of the credit line drawn, and LP fees repaying a sixth of that in the last step
  const DRAWN = ex ? Math.floor(limitBlocks * 0.75) : 0;
  const REPAID = Math.round(DRAWN / 6);
  const STEPS = steps(ex, DRAWN);
  const [step, setStep] = useState(0);
  // Which way the text slides: back for the previous arrow or an earlier tab, forward otherwise
  const [dir, setDir] = useState(1);
  const [repaid, setRepaid] = useState(0);
  const [hovered, setHovered] = useState(false);
  const ref = useRef<HTMLElement>(null);
  const inView = useInView(ref, { amount: 0.4 });
  const playing = inView && !hovered;

  const go = (next: number) => {
    setDir(next >= step ? 1 : -1);
    setStep((next + STEP_COUNT) % STEP_COUNT);
  };

  // Moves on by itself while on screen, and starts the slide's timer over after any jump
  useEffect(() => {
    if (!playing) return;
    const timer = setTimeout(() => {
      setDir(1);
      setStep((s) => (s + 1) % STEP_COUNT);
    }, SLIDE_MS);
    return () => clearTimeout(timer);
  }, [playing, step]);

  // In the last step the fees repay the loan one block at a time, and leaving the step puts the debt back
  useEffect(() => {
    if (step !== 3) return;
    const timer = setInterval(() => setRepaid((n) => Math.min(REPAID, n + 1)), 220);
    return () => {
      clearInterval(timer);
      setRepaid(0);
    };
  }, [step, REPAID]);
  const drawn = DRAWN - (step === 3 ? repaid : 0);

  const crashed = step >= 1;
  const compact = step >= 2;
  // Where each surviving block sits in the regrouped grid, so the first `drawn` of them can be marked as backing the loan
  const survivorIndex = new Map(blocks.filter((b) => !b.lost).map((b, i) => [b.id, i]));
  const order = compact ? [...blocks.filter((b) => !b.lost), ...blocks.filter((b) => b.lost)] : blocks;

  // Undefined figures are ones the pool has not given yet, shown as a dash
  const limit = ex?.creditLimit;
  const summary: { label: string; value?: number; of?: number } = [
    { label: "Example portfolio value", value: usd(TOTAL) },
    { label: ex ? `Credit it backs after a ${ex.scenario.toLowerCase()}` : "Credit it backs after the worst crash", value: limit },
    { label: "Credit limit, drawn", value: ex ? usd(DRAWN) : undefined, of: limit },
    { label: "Still owed after LP fees", value: ex ? usd(drawn) : undefined, of: limit },
  ][step];

  return (
    <section ref={ref} aria-labelledby="how-it-works" aria-roledescription="carousel" className="mt-[120px]" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <div className="text-center">
        <h2 id="how-it-works" className="text-[44px] font-medium leading-[1.05] tracking-[-0.045em]">
          Credit from your portfolio,
          <br />
          exactly as it stands.
        </h2>
      </div>

      <div className="mt-14 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-16">
        <div>
          <div>
            <div className="panel p-7">
              <div className="flex items-end justify-between">
                <div>
                  <div className="text-[12.5px] text-t3">{summary.label}</div>
                  <div className="mt-1.5 text-[34px] font-medium tracking-[-0.04em]">
                    {summary.value === undefined ? "—" : <Num value={summary.value} prefix="$" />}
                    {summary.of !== undefined && (
                      <span className="text-[20px] text-t3">
                        {" "}
                        of <Num value={summary.of} prefix="$" />
                      </span>
                    )}
                  </div>
                </div>
                <div className="text-right text-[12.5px] text-t3">1 block = ${BLOCK_USD}</div>
              </div>

              <div className="mt-6 grid gap-1.5" style={{ gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))` }} role="img" aria-label={`${STEPS[step].title}. ${summary.label}: ${summary.value === undefined ? "not read yet" : dollars(summary.value)}`}>
                {order.map((b) => {
                  const rank = survivorIndex.get(b.id);
                  const isDrawn = compact && rank !== undefined && rank < drawn;
                  // Paid off by LP fees in the last step: glows orange once as it turns back to its own color
                  const paidOff = step === 3 && rank !== undefined && rank >= drawn && rank < DRAWN;
                  return (
                    <motion.div
                      key={b.id}
                      layout
                      transition={{
                        layout: SNAP,
                        opacity: { duration: 0.25, ease: EASE },
                        scale: SNAP,
                        filter: { duration: 0.7, ease: "easeOut" },
                        boxShadow: { duration: 0.7, ease: "easeOut" },
                      }}
                      className={`relative aspect-square ${paidOff ? "z-[1]" : ""}`}
                      style={{ backgroundColor: b.color }}
                      animate={{
                        opacity: b.lost && crashed ? (compact ? 0 : 0.16) : 1,
                        scale: b.lost && crashed ? (compact ? 0.3 : 0.82) : 1,
                        filter: paidOff ? ["brightness(1)", "brightness(1.5)", "brightness(1)"] : "brightness(1)",
                        boxShadow: paidOff
                          ? ["0 0 0px rgb(255 162 76 / 0)", "0 0 16px rgb(255 162 76 / 0.75)", "0 0 0px rgb(255 162 76 / 0)"]
                          : "0 0 0px rgb(255 162 76 / 0)",
                      }}
                    >
                      {/* Blocks the loan is drawn against turn the loan's orange */}
                      <motion.span
                        className="absolute inset-0 bg-orange"
                        initial={false}
                        animate={{ opacity: isDrawn ? 1 : 0 }}
                        transition={{ duration: 0.2 }}
                      />
                      {/* A black edge on every block, which reads as a little extra space between them */}
                      <span className="absolute inset-0 border-[3px] border-black" />
                    </motion.div>
                  );
                })}
              </div>

              {/* The loan as one amount against the whole credit line. Its space is always kept, so the card does not jump */}
              <motion.div className="mt-5" initial={false} animate={{ opacity: compact ? 1 : 0, y: compact ? 0 : 6 }} transition={{ duration: 0.25, ease: EASE }} aria-hidden={!compact}>
                <div className="flex items-center justify-between text-[12.5px]">
                  <span className="flex items-center gap-2 text-t2">
                    <span className="size-2.5 bg-orange" />
                    USDC loan
                  </span>
                  <span className="tabular-nums text-t3">
                    {limit === undefined ? (
                      "—"
                    ) : (
                      <>
                        <Num value={usd(drawn)} prefix="$" className="text-t1" /> of {dollars(limit)} credit line
                      </>
                    )}
                  </span>
                </div>
                <div className="mt-2 h-3 bg-white/[0.06]">
                  <motion.div className="h-full bg-orange/80" initial={false} animate={{ width: `${limit ? Math.min(100, (usd(drawn) / limit) * 100) : 0}%` }} transition={SNAP} />
                </div>
              </motion.div>

              <div className="mt-6 grid grid-cols-2 gap-x-6 gap-y-2.5 border-t border-line pt-5">
                {ASSET_CLASSES.map((c) => (
                  <div key={c.key} className="flex items-center justify-between text-[13px]">
                    <span className="flex items-center gap-2 text-t2">
                      <span className="size-2.5" style={{ backgroundColor: c.color }} />
                      {c.label}
                    </span>
                    {crashed && !ex ? (
                      <span className="tabular-nums text-t1">—</span>
                    ) : (
                      <Num value={crashed && ex ? ex.survived[c.key] : EXAMPLE_USD[c.key]} prefix="$" className="tabular-nums text-t1" />
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="min-w-0">
          <div className="grid grid-cols-4 gap-2" role="tablist" aria-label="How it works steps">
            {STEPS.map((st, i) => (
              <button
                key={i}
                type="button"
                role="tab"
                aria-selected={i === step}
                aria-label={st.title}
                onClick={() => go(i)}
                className="group cursor-pointer pb-1 pt-2 text-left"
              >
                <div className="h-[3px] overflow-hidden rounded-full bg-white/10">
                  {i < step && <div className="h-full bg-brand/60" />}
                  {i === step && (
                    <motion.div
                      key={`${step}-${playing}`}
                      className="h-full bg-brand"
                      initial={{ width: playing ? "0%" : "100%" }}
                      animate={{ width: "100%" }}
                      transition={{ duration: playing ? SLIDE_MS / 1000 : 0, ease: "linear" }}
                    />
                  )}
                </div>
                <div className={`mt-2.5 font-mono text-[12px] transition-colors ${i === step ? "text-brand" : "text-t3 group-hover:text-t2"}`}>0{i + 1}</div>
              </button>
            ))}
          </div>

          <div className="relative mt-8 h-[230px] overflow-hidden" aria-live="polite">
            <AnimatePresence initial={false} custom={dir} mode="popLayout">
              <motion.div
                key={step}
                custom={dir}
                variants={{
                  enter: (d: number) => ({ x: d * 56, opacity: 0, filter: "blur(4px)" }),
                  center: { x: 0, opacity: 1, filter: "blur(0px)" },
                  exit: (d: number) => ({ x: d * -56, opacity: 0, filter: "blur(4px)" }),
                }}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{ x: SNAP, opacity: { duration: 0.2 }, filter: { duration: 0.2 } }}
                className="absolute inset-x-0 top-0 max-w-[460px]"
              >
                <h3 className="text-[28px] font-medium leading-[1.1] tracking-[-0.035em]">{STEPS[step].title}</h3>
                <p className="mt-3.5 text-[15.5px] leading-[1.6] text-t2">{STEPS[step].body}</p>
              </motion.div>
            </AnimatePresence>
          </div>

          <div className="flex gap-2">
            {[
              { label: "Previous step", icon: ChevronLeft, to: step - 1 },
              { label: "Next step", icon: ChevronRight, to: step + 1 },
            ].map(({ label, icon: Icon, to }) => (
              <motion.button
                key={label}
                type="button"
                aria-label={label}
                onClick={() => go(to)}
                whileTap={{ scale: 0.9 }}
                className="grid size-9 cursor-pointer place-items-center rounded-full border border-line text-t2 transition-colors hover:border-line-2 hover:text-t1"
              >
                <Icon size={16} strokeWidth={1.75} />
              </motion.button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
