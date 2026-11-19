"use client";

import { useInView, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { EXAMPLE_USD, type ExampleKey } from "./PoolFacts";
import { SIDE, cellStates, initialOwners, labelCells, quotas, settle } from "./grid";

// seeds are [column, row] cells each holding grows from, laid out so the board reads corner to corner
// `dim` is the share of a holding's cells drawn gray: riskier holdings lose more of their green.
// It is illustrative, not read from the pool: the board is a picture, the numbers live in the table below it
const PARTS: { key: ExampleKey; name: string; seed: readonly [number, number]; dim: number }[] = [
  { key: "sol", name: "SOL", seed: [6, 6], dim: 0.24 },
  { key: "lst", name: "JitoSOL", seed: [24, 5], dim: 0.27 },
  { key: "lp", name: "SOL-USDC LP", seed: [15, 16], dim: 0.22 },
  { key: "stock", name: "NVDAx", seed: [26, 18], dim: 0.31 },
  { key: "meme", name: "BONK", seed: [6, 26], dim: 0.28 },
  { key: "usdc", name: "USDC", seed: [24, 27], dim: 0.1 },
];
const BASE: number[] = PARTS.map((p) => EXAMPLE_USD[p.key]);
const DIM = PARTS.map((p) => p.dim);
// built at load so the server and the browser draw the same first frame
const START = initialOwners(
  PARTS.map((p) => p.seed),
  BASE,
);
const START_LABELS = labelCells(START, PARTS.length);

const TICK_MS = 800;
// cells that may change hands each tick: enough that holdings visibly push at each other, few enough that nothing jumps
const MOVES = 8;

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

/** The hero's picture: the example portfolio as one board of cells, each holding sized by its value and pushing at its neighbours as prices move */
export function PortfolioGrid() {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.2 });
  // one cell plus its gap, in css pixels; 17 fits the desktop column and stands in until the board is measured
  const [pitch, setPitch] = useState(17);
  const [shown, setShown] = useState(true);
  const [hover, setHover] = useState<number | null>(null);
  const [board, setBoard] = useState({ owner: START, labels: START_LABELS, values: BASE });
  const factors = useRef<Factors>({ sol: 0, stock: 0, meme: 0, own: BASE.map(() => 0) });
  const live = !reduce && inView && shown && hover === null;
  // no lines are drawn between holdings: a channel of gray cells runs along every border and keeps their green apart
  const states = useMemo(() => cellStates(board.owner, DIM), [board.owner]);

  // Cells sized as a fraction of the width land between pixels, and the browser then draws some a pixel wider than others.
  // So the cell and the gap are each a whole number of device pixels, and the board is as wide as those add up to.
  // At a 125% or 150% display a whole device pixel is not a round css length, so the board is zoomed by 1 / ratio
  // and laid out in device pixels, where whole numbers stay whole. Text inside is scaled back up by --scale.
  useEffect(() => {
    const [box, el] = [ref.current, boardRef.current];
    if (!box || !el) return;
    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      const zoomed = CSS.supports("zoom", "0.5");
      // css pixels per unit of the lengths set below
      const unit = zoomed ? 1 : 1 / dpr;
      const gap = Math.max(1, Math.round(2 * dpr));
      const cell = Math.floor((box.clientWidth * dpr + gap) / SIDE);
      el.style.zoom = zoomed ? String(1 / dpr) : "";
      el.style.setProperty("--gap", `${gap * unit}px`);
      el.style.setProperty("--pitch", `${cell * unit}px`);
      el.style.setProperty("--scale", String(zoomed ? dpr : 1));
      setPitch(cell / dpr);
    };
    // fires once on observe, then on every resize; a browser zoom changes the pixel ratio and fires resize
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    window.addEventListener("resize", fit);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", fit);
    };
  }, []);

  useEffect(() => {
    const onChange = () => setShown(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  useEffect(() => {
    if (!live) return;
    const id = setInterval(() => {
      factors.current = drift(factors.current);
      const values = valuesOf(factors.current);
      setBoard((b) => {
        const owner = [...b.owner];
        settle(owner, quotas(values), Math.random, MOVES);
        return { owner, labels: labelCells(owner, PARTS.length, b.labels), values };
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [live]);

  const total = board.values.reduce((a, b) => a + b, 0);

  const pick = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const [k, row] = [Math.floor(((e.clientX - r.left) / r.width) * SIDE), Math.floor(((e.clientY - r.top) / r.height) * SIDE)];
    if (k >= 0 && k < SIDE && row >= 0 && row < SIDE) setHover(board.owner[row * SIDE + k]);
  };

  return (
    <div ref={ref} className="grid-box">
      <div
        ref={boardRef}
        className="grid-board relative touch-none lg:ml-auto"
        role="img"
        aria-label={`An example portfolio as one board, split into ${PARTS.map((p) => p.name).join(", ")}.`}
        onPointerMove={pick}
        onPointerLeave={() => setHover(null)}
      >
        <div className="grid-cells">
          {board.owner.map((o, c) => (
            <span
              key={c}
              className="grid-cell grid-cell-in"
              data-state={states[c]}
              style={{ animationDelay: `${(Math.floor(c / SIDE) + (c % SIDE)) * 9}ms`, opacity: hover !== null && o !== hover ? 0.25 : 1 }}
            />
          ))}
        </div>
        {board.labels.map((c, i) => {
          // a label takes the place of a block of whole cells, so its edges are the grid's own
          const wide = Math.ceil((PARTS[i].name.length * 8.4 + 22) / pitch);
          const tall = pitch >= 15 ? 2 : 3;
          const col = clamp((c % SIDE) - Math.floor(wide / 2), 0, SIDE - wide);
          const row = clamp(Math.floor(c / SIDE) - Math.floor(tall / 2), 0, SIDE - tall);
          return (
            <div
              key={PARTS[i].key}
              className="pointer-events-none absolute flex flex-col justify-center bg-bg leading-[1.15] transition-[left,top,opacity] duration-700 ease-out"
              style={{
                left: `calc(var(--pitch) * ${col})`,
                top: `calc(var(--pitch) * ${row})`,
                width: `calc(var(--pitch) * ${wide} - var(--gap))`,
                height: `calc(var(--pitch) * ${tall} - var(--gap))`,
                paddingInline: "calc(8px * var(--scale, 1))",
                opacity: hover !== null && hover !== i ? 0.3 : 1,
              }}
            >
              <div className="whitespace-nowrap font-semibold text-t1" style={{ fontSize: "calc(12px * var(--scale, 1))" }}>
                {PARTS[i].name}
              </div>
              <div className="tabular-nums text-t2" style={{ fontSize: "calc(11px * var(--scale, 1))" }}>
                {((board.values[i] / total) * 100).toFixed(1)}%
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
