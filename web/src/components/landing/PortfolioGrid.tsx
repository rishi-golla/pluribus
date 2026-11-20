"use client";

import { useInView, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState, type PointerEvent } from "react";
import { EXAMPLE_USD, type ExampleKey } from "./PoolFacts";
import { CELLS, SIDE, balance, layout, type Site } from "./grid";

// `seed` is the [column, row] a holding sits around, laid out so the board reads corner to corner.
// `band` is how far its gray edge reaches in from a border, in cells: riskier holdings keep less of their green.
// The bands are illustrative, not read from the pool: the board is a picture, the numbers live in the table below it.
const PARTS: { key: ExampleKey; name: string; seed: readonly [number, number]; band: number }[] = [
  { key: "sol", name: "SOL", seed: [7, 7], band: 1.2 },
  { key: "lst", name: "JitoSOL", seed: [24, 6], band: 1.3 },
  { key: "lp", name: "SOL-USDC LP", seed: [15, 16], band: 1.1 },
  { key: "stock", name: "NVDAx", seed: [26, 18], band: 1.5 },
  { key: "meme", name: "BONK", seed: [6, 26], band: 1.9 },
  { key: "usdc", name: "USDC", seed: [23, 27], band: 1.0 },
];
const TOTAL = PARTS.reduce((sum, p) => sum + EXAMPLE_USD[p.key], 0);
// each holding at rest, owning its share of the portfolio
const HOME: Site[] = balance(
  PARTS.map((p) => ({ x: p.seed[0], y: p.seed[1], weight: 0, band: p.band })),
  PARTS.map((p) => EXAMPLE_USD[p.key] / TOTAL),
);

// Each holding pushes harder and eases off on its own slow wave, a long one with a shorter one on top, and drifts a
// little around its seat. So a border creeps one way for a while, is pushed back, and turns as it goes.
// `push` is how far the weight swings, `period` the long wave in seconds, `roam` the drift in cells, `orbit` its length in seconds.
const WAVES = [
  { push: 15, period: 46, roam: 1.0, orbit: 71, phase: 0.0 },
  { push: 17, period: 34, roam: 1.1, orbit: 53, phase: 2.1 },
  { push: 13, period: 55, roam: 0.9, orbit: 83, phase: 4.0 },
  { push: 16, period: 40, roam: 1.0, orbit: 61, phase: 1.2 },
  { push: 16, period: 28, roam: 0.9, orbit: 47, phase: 5.1 },
  { push: 10, period: 61, roam: 0.8, orbit: 97, phase: 3.3 },
];
const TURN = 2 * Math.PI;
const sitesAt = (seconds: number): Site[] =>
  HOME.map((s, i) => {
    const w = WAVES[i];
    const swell = Math.sin((TURN * seconds) / w.period + w.phase) + 0.4 * Math.sin((TURN * seconds) / (w.period * 0.41) + w.phase * 1.7);
    return {
      ...s,
      x: s.x + w.roam * Math.cos((TURN * seconds) / w.orbit + w.phase),
      y: s.y + w.roam * Math.sin((TURN * seconds) / (w.orbit * 1.3) + w.phase * 2),
      weight: s.weight + w.push * swell,
    };
  });

// Ten steps a second: a border moves a fraction of a cell each step, so cells along it turn one after another.
const TICK_MS = 100;
// a label follows the middle of its holding's green, and stays put until that has moved this many cells
const LABEL_SLACK = 1.2;

const cellAt = ([x, y]: [number, number]) => Math.floor(y) * SIDE + Math.floor(x);
// the first frame, the same on the server and in the browser
const START = layout(sitesAt(0));
const START_BOARD = { owner: START.owner, states: START.states, counts: START.counts, labels: START.centers.map(cellAt) };
type Board = typeof START_BOARD;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** The hero's picture: the example portfolio as one board of cells, each holding pushing at its neighbours for room */
export function PortfolioGrid() {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const boardRef = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.2 });
  // one cell plus its gap, in css pixels; 17 fits the desktop column and stands in until the board is measured
  const [pitch, setPitch] = useState(17);
  const [shown, setShown] = useState(true);
  const [hover, setHover] = useState<number | null>(null);
  const [board, setBoard] = useState<Board>(START_BOARD);
  // seconds of motion so far; it only runs while the board is live, so the waves pick up where they stopped
  const clock = useRef(0);
  const live = !reduce && inView && shown && hover === null;

  // Cells sized as a fraction of the width land between pixels, and the browser then draws some a pixel wider than others.
  // So the cell and the gap are each a whole number of pixels, and the board is as wide as those add up to.
  // At a 1x, 2x or 3x display whole css pixels are whole device pixels too, and they are used as they are: a half css
  // pixel there can still be drawn a device pixel off. At a 125% or 150% display a whole device pixel is not a round
  // css length, so the board is zoomed by 1 / ratio and laid out in device pixels. Text inside is scaled back up by --scale.
  useEffect(() => {
    const [box, el] = [ref.current, boardRef.current];
    if (!box || !el) return;
    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      const zoomed = !Number.isInteger(dpr) && CSS.supports("zoom", "0.5");
      // layout units per css pixel: device pixels when zoomed, css pixels otherwise
      const per = zoomed ? dpr : 1;
      // one css pixel between cells: enough to read as a grid, thin enough to leave the shapes in charge
      const gap = Math.max(1, Math.round(per));
      const cell = Math.floor((box.clientWidth * per + gap) / SIDE);
      el.style.zoom = zoomed ? String(1 / dpr) : "";
      el.style.setProperty("--gap", `${gap}px`);
      el.style.setProperty("--pitch", `${cell}px`);
      el.style.setProperty("--scale", String(per));
      setPitch(cell / per);
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
      clock.current += TICK_MS / 1000;
      const next = layout(sitesAt(clock.current));
      setBoard((b) => {
        const labels = b.labels.map((cell, i) => {
          const [x, y] = next.centers[i];
          const moved = Math.hypot(x - ((cell % SIDE) + 0.5), y - (Math.floor(cell / SIDE) + 0.5));
          return moved > LABEL_SLACK ? cellAt(next.centers[i]) : cell;
        });
        // most steps move no cell at all, and those need no redraw
        const same = labels.every((l, i) => l === b.labels[i]) && next.states.every((s, c) => s === b.states[c] && next.owner[c] === b.owner[c]);
        return same ? b : { owner: next.owner, states: next.states, counts: next.counts, labels };
      });
    }, TICK_MS);
    return () => clearInterval(id);
  }, [live]);

  const pick = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const [k, row] = [Math.floor(((e.clientX - r.left) / r.width) * SIDE), Math.floor(((e.clientY - r.top) / r.height) * SIDE)];
    if (k >= 0 && k < SIDE && row >= 0 && row < SIDE) setHover(board.owner[row * SIDE + k]);
  };

  return (
    <div ref={ref} className="grid-box">
      <div
        ref={boardRef}
        className="grid-board relative touch-none md:ml-auto"
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
              data-state={board.states[c]}
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
              className="pointer-events-none absolute flex flex-col justify-center bg-bg leading-[1.15] transition-[left,top,opacity] duration-1000 ease-in-out"
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
                {((board.counts[i] / CELLS) * 100).toFixed(1)}%
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
