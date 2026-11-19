"use client";

import { useInView, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { Num } from "@/components/motion";
import { CLUSTER } from "@/lib/cluster";
import { EXAMPLE_USD, usePoolFacts, type ExampleKey } from "./PoolFacts";
import { LOST, SIDE, borderPath, cellStates, initialOwners, labelCells, quotas, settle } from "./grid";

// seeds are [column, row] cells each holding grows from, laid out so the board reads corner to corner
const PARTS: { key: ExampleKey; name: string; seed: readonly [number, number] }[] = [
  { key: "sol", name: "SOL", seed: [4, 4] },
  { key: "lst", name: "JitoSOL", seed: [15, 3] },
  { key: "lp", name: "SOL-USDC LP", seed: [9, 10] },
  { key: "stock", name: "NVDAx", seed: [16, 11] },
  { key: "meme", name: "BONK", seed: [4, 16] },
  { key: "usdc", name: "USDC", seed: [15, 17] },
];
const BASE: number[] = PARTS.map((p) => EXAMPLE_USD[p.key]);
// built at load so the server and the browser draw the same first frame
const START = initialOwners(
  PARTS.map((p) => p.seed),
  BASE,
);
const START_LABELS = labelCells(START, PARTS.length);

const TICK_MS = 800;
const PULSE_MS = 24_000;
const PULSE_LEN_MS = 2_600;

// price drift: SOL moves the staking token fully and the LP by half, the stock and the memecoin move alone, USDC holds
type Factors = { sol: number; stock: number; meme: number; own: number[] };
const STEP = { sol: 0.014, stock: 0.01, meme: 0.03, own: 0.005 };
// pulled back toward today's prices each tick, so holdings jostle around their sizes instead of wandering off
const PULL = 0.08;
const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
const step = (x: number, s: number) => x * (1 - PULL) + s * gauss();
const drift = (f: Factors): Factors => ({ sol: step(f.sol, STEP.sol), stock: step(f.stock, STEP.stock), meme: step(f.meme, STEP.meme), own: f.own.map((x) => step(x, STEP.own)) });
const valuesOf = (f: Factors) => {
  const x = [f.sol, f.sol, f.sol / 2, f.stock, f.meme];
  return BASE.map((b, i) => (i < x.length ? b * Math.exp(x[i] + f.own[i]) : b));
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const dollars = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
const pct = (v: number) => `${Math.round(v * 100)}%`;

/** The hero's picture: the example portfolio as one board of cells, sized by value and split by what a crash leaves borrowable */
export function PortfolioGrid() {
  const facts = usePoolFacts();
  const ex = facts?.example;
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.2 });
  const [shown, setShown] = useState(true);
  const [hover, setHover] = useState<number | null>(null);
  const [board, setBoard] = useState({ owner: START, labels: START_LABELS, values: BASE });
  const [pulsing, setPulsing] = useState(false);
  const [scanned, setScanned] = useState(false);
  const factors = useRef<Factors>({ sol: 0, stock: 0, meme: 0, own: BASE.map(() => 0) });
  const live = !reduce && inView && shown && hover === null;

  // each holding's share that counts toward the credit line and the share still standing at the liquidation line
  const ratios = useMemo(
    () => (ex ? PARTS.map((p) => ({ credit: ex.credit[p.key] / EXAMPLE_USD[p.key], liquidation: ex.liquidation[p.key] / EXAMPLE_USD[p.key] })) : null),
    [ex],
  );
  const states = useMemo(
    () =>
      ratios &&
      cellStates(
        board.owner,
        ratios.map((r) => clamp(1 - r.liquidation, 0, 1)),
        ratios.map((r) => clamp(r.liquidation - r.credit, 0, 1)),
      ),
    [board.owner, ratios],
  );
  const path = useMemo(() => borderPath(board.owner), [board.owner]);

  useEffect(() => {
    const onChange = () => setShown(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  // the first fill sweeps corner to corner, later changes land in place
  useEffect(() => {
    if (!ex) return;
    const t = setTimeout(() => setScanned(true), 1_800);
    return () => clearTimeout(t);
  }, [ex]);

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => {
      factors.current = drift(factors.current);
      const values = valuesOf(factors.current);
      setBoard((b) => {
        const owner = [...b.owner];
        // a few cells a tick, so holdings push at each other instead of jumping
        settle(owner, quotas(values), Math.random, 3);
        return { owner, labels: labelCells(owner, PARTS.length, b.labels), values };
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [live]);

  // every so often a scan line runs the worst crash across the board and lights up what it takes
  useEffect(() => {
    if (!live || !ex) return;
    let off: ReturnType<typeof setTimeout> | undefined;
    const id = setInterval(() => {
      setPulsing(true);
      off = setTimeout(() => setPulsing(false), PULSE_LEN_MS);
    }, PULSE_MS);
    return () => {
      clearInterval(id);
      clearTimeout(off);
      setPulsing(false);
    };
  }, [live, ex]);

  const total = board.values.reduce((a, b) => a + b, 0);
  const credit = ratios ? board.values.reduce((s, v, i) => s + v * ratios[i].credit, 0) : undefined;
  const part = hover === null ? undefined : PARTS[hover];
  const readout = part
    ? {
        label: `${part.name} borrowable`,
        value: ratios ? board.values[hover!] * ratios[hover!].credit : undefined,
        note: ratios ? `${dollars(board.values[hover!])} held, ${pct(ratios[hover!].credit)} LTV` : `${dollars(board.values[hover!])} held`,
      }
    : {
        label: "Credit line",
        value: credit,
        note: ex === null ? `Couldn't read the ${CLUSTER} pool.` : ex ? `Worst of ${ex.scenarios} crash scenarios: ${ex.scenario.toLowerCase()}` : "Crash-testing with the pool's settings",
      };

  const pick = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const [k, row] = [Math.floor(((e.clientX - r.left) / r.width) * SIDE), Math.floor(((e.clientY - r.top) / r.height) * SIDE)];
    if (k >= 0 && k < SIDE && row >= 0 && row < SIDE) setHover(board.owner[row * SIDE + k]);
  };

  return (
    <div ref={ref}>
      <div className="mb-3 flex items-baseline justify-between border-b border-line pb-3 text-[11.5px] uppercase tracking-[0.05em] text-t3">
        <span className={pulsing ? "text-brand" : undefined}>{pulsing && ex ? `Stress test: ${ex.scenario}` : "Example portfolio"}</span>
        <span>
          Collateral <Num value={total} prefix="$" className="text-t1" />
        </span>
      </div>

      <div
        className="relative aspect-square touch-none outline outline-1 outline-white/25"
        role="img"
        aria-label={`Example ${dollars(total)} portfolio of ${PARTS.map((p) => p.name).join(", ")}. ${readout.label}: ${readout.value === undefined ? "not read yet" : dollars(readout.value)}.`}
        onPointerMove={pick}
        onPointerLeave={() => setHover(null)}
      >
        <div className="grid size-full grid-cols-20">
          {board.owner.map((o, c) => {
            const [r, k] = [Math.floor(c / SIDE), c % SIDE];
            const state = states?.[c];
            return (
              <div key={c} className="grid-cell-in p-px" style={{ animationDelay: `${(r + k) * 16}ms` }}>
                <span
                  className="grid-cell block size-full"
                  data-state={state ?? "pending"}
                  data-flash={pulsing && state === LOST ? "" : undefined}
                  style={
                    {
                      "--col": k,
                      opacity: hover !== null && o !== hover ? 0.25 : 1,
                      transitionDelay: scanned ? undefined : `${(r + k) * 14}ms`,
                    } as CSSProperties
                  }
                />
              </div>
            );
          })}
        </div>
        <svg viewBox={`0 0 ${SIDE} ${SIDE}`} className="pointer-events-none absolute inset-0 size-full" aria-hidden>
          <path d={path} fill="none" stroke="var(--color-t1)" strokeWidth={2} strokeLinecap="square" vectorEffect="non-scaling-stroke" />
        </svg>
        {pulsing && <div className="grid-scan pointer-events-none absolute inset-y-0 w-[2px] bg-brand" aria-hidden />}
        {board.labels.map((c, i) => (
          <div
            key={PARTS[i].key}
            className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 border border-white/70 bg-bg/90 px-2.5 py-1.5 leading-tight transition-[left,top,opacity] duration-700 ease-out"
            style={{
              left: `${clamp((((c % SIDE) + 0.5) / SIDE) * 100, 10, 90)}%`,
              top: `${clamp(((Math.floor(c / SIDE) + 0.5) / SIDE) * 100, 6, 94)}%`,
              opacity: hover !== null && hover !== i ? 0.3 : 1,
            }}
          >
            <div className="whitespace-nowrap text-[12.5px] font-semibold text-t1">{PARTS[i].name}</div>
            <div className="text-[12px] tabular-nums text-t2">{((board.values[i] / total) * 100).toFixed(1)}%</div>
          </div>
        ))}
      </div>

      <div className="mt-5 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between sm:gap-6">
        <div className="min-w-0">
          <div className="text-[11.5px] uppercase tracking-[0.05em] text-t3">
            {/* token names keep their case, NVDAx is not NVDAX */}
            {part ? (
              <>
                <span className="normal-case">{part.name}</span> borrowable
              </>
            ) : (
              readout.label
            )}
          </div>
          <div className="mt-2 text-[40px] font-semibold leading-none tracking-[-0.04em] text-brand">
            {readout.value === undefined ? "—" : <Num value={readout.value} prefix="$" countUp />}
          </div>
          <div className="mt-2 text-[12px] text-t3">{readout.note}</div>
        </div>
        <ul className="shrink-0 space-y-1.5 text-[12px] text-t2">
          <li className="flex items-center gap-2.5">
            <span className="grid-cell size-3" data-state="0" />
            Borrowable
          </li>
          <li className="flex items-center gap-2.5">
            <span className="grid-cell size-3" data-state="1" />
            Buffer before liquidation
          </li>
          <li className="flex items-center gap-2.5">
            <span className="grid-cell size-3" data-state="2" />
            Crash haircut
          </li>
        </ul>
      </div>
    </div>
  );
}
