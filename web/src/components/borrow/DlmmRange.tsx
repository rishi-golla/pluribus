"use client";

// The pieces of the Meteora position form, laid out the way Meteora's own Create Position panel has them:
// the strategy picker, the liquidity the deposit lays out, the range slider over the pair's liquidity and the price boxes

import { Minus, Plus } from "lucide-react";
import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { money } from "@/lib/account";
import type { DlmmMarket } from "@/lib/live";
import { BID_ASK, CURVE, MAX_BINS, SPOT } from "@/lib/pluribus/sdk";

// The app's own palette: the base token in the brand lime, USDC in its neutral grey
export const BASE_COLOR = "var(--color-brand)";
export const USDC_COLOR = "var(--color-t2)";
/** Positions either side of the active bin the slider reaches, so a range can sit wholly on one side of the price */
export const REACH = MAX_BINS - 1;
/** Meteora's default range: 69 bins centred on the active one, used until the pair is known */
export const DEFAULT_RANGE = { lo: -34, hi: 34 };
/** How far a new range reaches either side of the price, the same as the faucet's Orca positions */
export const LP_SPREAD = 0.3;
/**
 * The pair's price less and plus `LP_SPREAD`, in bins of the pair's own step: with 1% bins that is 63 bins.
 * A position holds at most `MAX_BINS`, so a pair with finer bins gets the widest range centred on the price instead
 */
export function defaultRange(market: DlmmMarket): Range {
  const step = Math.log(1 + market.binStep / 10_000);
  let lo = Math.round(Math.log(1 - LP_SPREAD) / step);
  let hi = Math.round(Math.log(1 + LP_SPREAD) / step);
  if (hi - lo + 1 > MAX_BINS) {
    const half = Math.floor((MAX_BINS - 1) / 2);
    [lo, hi] = [Math.max(lo, -half), Math.min(hi, half)];
  }
  return { lo, hi };
}

export const STRATEGIES = [
  { name: "Spot", value: SPOT, hint: "Even across the range, for any market" },
  { name: "Curve", value: CURVE, hint: "Piled up around the price, for calm markets" },
  { name: "Bid Ask", value: BID_ASK, hint: "Piled up at the edges, to catch swings" },
] as const;
export type Strategy = (typeof STRATEGIES)[number]["name"];

/** A bin id at position `k` from the active bin, positions counting up with the price whichever token is X */
export const idAt = (market: DlmmMarket, k: number) => market.activeId + (market.baseIsX ? k : -k);
/** The position from the active bin of the bin nearest `price` USDC per base token */
export const positionOf = (market: DlmmMarket, price: number) => Math.round(Math.log(price / market.price) / Math.log(1 + market.binStep / 10_000));
export const fmtPrice = (v: number) => (v >= 1 ? money(v, 2) : v.toPrecision(4));

export type Range = { lo: number; hi: number };
/** Moves one edge of a range to position `k`, bringing the other along when the range would pass `MAX_BINS` or turn inside out */
export function moveEdge(range: Range, which: "lo" | "hi", k: number): Range {
  k = Math.max(-REACH, Math.min(REACH, k));
  return which === "lo"
    ? { lo: k, hi: Math.min(REACH, Math.max(range.hi, k), k + MAX_BINS - 1) }
    : { lo: Math.max(-REACH, Math.min(range.lo, k), k - MAX_BINS + 1), hi: k };
}

/** Meteora's weight for a bin: flat for Spot, 2000 at the active bin falling to 200 at each edge for Curve, the reverse for Bid Ask */
function weight(strategy: Strategy, id: number, active: number, lower: number, upper: number) {
  if (strategy === "Spot") return 1;
  const edge = id < active ? active - lower : upper - active;
  const far = edge > 0 ? Math.abs(id - active) / edge : 0;
  return strategy === "Curve" ? 2000 - 1800 * far : 200 + 1800 * far;
}

export type PlannedBin = { id: number; price: number; base: number; usdc: number };

/** Each bin of `lower..=upper` with its strategy weight and the side, or sides for the active bin, it takes */
function weighed(market: DlmmMarket, lower: number, upper: number, strategy: Strategy) {
  return Array.from({ length: Math.max(0, upper - lower + 1) }, (_, i) => {
    const id = lower + i;
    // The active bin takes both tokens, half its weight each
    const w = (id === market.activeId ? 0.5 : 1) * weight(strategy, id, market.activeId, lower, upper);
    const usdc = market.baseIsX ? id <= market.activeId : id >= market.activeId;
    const base = market.baseIsX ? id >= market.activeId : id <= market.activeId;
    return { id, price: market.binPrice(id), w, usdc, base };
  });
}

/**
 * Where a deposit goes once the strategy has spread it: USDC over the bins under the active price and the base token over those
 * above, each bin's share of its side following the strategy's weight. Only for the preview, Meteora works out the real mix
 */
export function plan(market: DlmmMarket, lower: number, upper: number, strategy: Strategy, base: number, usdc: number): PlannedBin[] {
  const bins = weighed(market, lower, upper, strategy);
  const usdcWeight = bins.reduce((s, b) => s + (b.usdc ? b.w : 0), 0);
  const baseWeight = bins.reduce((s, b) => s + (b.base ? b.w / b.price : 0), 0);
  return bins.map((b) => ({
    id: b.id,
    price: b.price,
    usdc: b.usdc && usdcWeight ? (usdc * b.w) / usdcWeight : 0,
    base: b.base && baseWeight ? (base * b.w) / b.price / baseWeight : 0,
  }));
}

/** The other token's amount that gives both sides the same liquidity per unit of strategy weight, as Meteora's Auto-Fill does */
export function autoFill(market: DlmmMarket, lower: number, upper: number, strategy: Strategy, from: "base" | "usdc", amount: number) {
  const bins = weighed(market, lower, upper, strategy);
  const usdcWeight = bins.reduce((s, b) => s + (b.usdc ? b.w : 0), 0);
  const baseWeight = bins.reduce((s, b) => s + (b.base ? b.w / b.price : 0), 0);
  if (!usdcWeight || !baseWeight) return 0;
  return from === "base" ? (amount * usdcWeight) / baseWeight : (amount * baseWeight) / usdcWeight;
}

/** Bars of a strategy's shape, for the picker */
function StrategyIcon({ strategy, on }: { strategy: Strategy; on: boolean }) {
  const heights = { Spot: [7, 7, 7, 7, 7, 7], Curve: [3, 5, 8, 8, 5, 3], "Bid Ask": [8, 5, 3, 3, 5, 8] }[strategy];
  return (
    <span className="flex h-2.5 items-end gap-[1.5px]" aria-hidden>
      {heights.map((h, i) => (
        <i key={i} className="block w-[2px] rounded-[1px]" style={{ height: h + 2, background: on ? (i < 3 ? USDC_COLOR : BASE_COLOR) : "var(--color-t3)" }} />
      ))}
    </span>
  );
}

export function StrategyPicker({ value, onChange }: { value: Strategy; onChange: (s: Strategy) => void }) {
  return (
    <div className="flex rounded-lg border border-line bg-bg p-[3px]" role="radiogroup" aria-label="Strategy">
      {STRATEGIES.map((s) => {
        const on = s.name === value;
        return (
          <button
            key={s.name}
            type="button"
            role="radio"
            aria-checked={on}
            title={s.hint}
            onClick={() => onChange(s.name)}
            className={`flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-md py-[7px] text-[13px] font-medium transition-colors ${
              on ? "bg-s3 text-t1 shadow-[inset_0_0_0_1px_var(--color-line-2)]" : "text-t3 hover:text-t2"
            }`}
          >
            <StrategyIcon strategy={s.name} on={on} />
            {s.name}
          </button>
        );
      })}
    </div>
  );
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)} className="flex cursor-pointer items-center gap-2 text-[12.5px] text-t2">
      <span className={`relative h-[18px] w-8 rounded-full transition-colors ${on ? "bg-brand" : "bg-s3 shadow-[inset_0_0_0_1px_var(--color-line-2)]"}`}>
        <span className={`absolute top-[2px] size-[14px] rounded-full transition-[left] duration-200 ${on ? "left-[16px] bg-[#0c0c0c]" : "left-[2px] bg-t3"}`} />
      </span>
      {label}
    </button>
  );
}

const ticks = <T,>(items: T[], n = 5) => (items.length <= n ? items : Array.from({ length: n }, (_, i) => items[Math.round((i * (items.length - 1)) / (n - 1))]));

/**
 * The liquidity a deposit lays out over its range, one bar per bin in price order: USDC under the pool price and the base token
 * over it, with the pool price marked. With nothing entered it shows the strategy's shape, greyed out
 */
export function DistributionChart({
  market,
  bins,
  shape,
  flip,
  pair,
}: {
  market: DlmmMarket;
  /** The deposit as entered, spread over the range */
  bins: PlannedBin[];
  /** The strategy's shape over the range, shown greyed out until an amount is entered */
  shape: PlannedBin[];
  flip: boolean;
  pair: string;
}) {
  const value = (b: PlannedBin) => b.usdc + b.base * b.price;
  const empty = !bins.some((b) => value(b) > 0);
  const shown = [...(empty ? shape : bins)].sort((a, b) => (flip ? b.price - a.price : a.price - b.price));
  const top = Math.max(...shown.map(value), 1e-12);
  const at = shown.findIndex((b) => b.id === market.activeId);
  const where = (at + 0.5) / shown.length;
  // The label keeps inside the chart when the pool price sits near an edge
  const shift = where < 0.2 ? "-translate-x-2" : where > 0.8 ? "-translate-x-[calc(100%-8px)]" : "-translate-x-1/2";
  const disp = (p: number) => (flip ? 1 / p : p);
  return (
    <div className="relative">
      <div className={`flex h-[112px] items-end gap-px pt-9 transition-opacity ${empty ? "opacity-25" : ""}`}>
        {shown.map((b) => {
          const v = value(b);
          const usdcShare = v > 0 ? b.usdc / v : 0;
          return (
            <div key={b.id} className="flex min-w-0 flex-1 flex-col justify-end transition-[height] duration-300" style={{ height: Math.max(2, (v / top) * 76) }}>
              <i className="block w-full rounded-t-[1px]" style={{ height: `${(1 - usdcShare) * 100}%`, background: BASE_COLOR }} />
              <i className="block w-full" style={{ height: `${usdcShare * 100}%`, background: USDC_COLOR }} />
            </div>
          );
        })}
      </div>
      {empty && (
        <div className="pointer-events-none absolute inset-x-0 top-8 text-center">
          <div className="text-[13.5px] font-medium">No liquidity selected</div>
          <div className="mt-0.5 text-[12px] text-t3">Enter an amount and set a price range</div>
        </div>
      )}
      {at >= 0 && !empty && (
        <div className="pointer-events-none absolute inset-y-0" style={{ left: `${where * 100}%` }}>
          <div className="absolute bottom-0 top-[30px] w-0 border-l border-dashed border-t1/70" />
          <div className={`absolute top-0 ${shift} whitespace-nowrap rounded-md border border-line-2 bg-s3 px-2 py-[3px] text-center text-[10.5px] leading-tight`}>
            <div className="text-t3">Pool price</div>
            <div className="font-medium">
              {fmtPrice(disp(market.price))} {pair}
            </div>
          </div>
        </div>
      )}
      <div className="mt-1.5 flex justify-between text-[11px] text-t3">
        {ticks(shown).map((b) => (
          <span key={b.id}>{fmtPrice(disp(b.price))}</span>
        ))}
      </div>
    </div>
  );
}

/**
 * Two handles over the pair's own liquidity, bin by bin, `REACH` positions either side of the active bin. A range keeps to
 * `MAX_BINS`: dragging one handle further away brings the other along
 */
export function RangeSlider({
  market,
  pool,
  lo,
  hi,
  flip,
  onChange,
}: {
  market: DlmmMarket;
  /** Dollars in each bin of the pair, by bin id, or null while it loads */
  pool: Map<number, number> | null;
  lo: number;
  hi: number;
  flip: boolean;
  onChange: (range: Range) => void;
}) {
  const track = useRef<HTMLDivElement>(null);
  const dragging = useRef<"lo" | "hi" | null>(null);
  const positions = Array.from({ length: 2 * REACH + 1 }, (_, i) => (flip ? REACH - i : i - REACH));
  const values = positions.map((k) => pool?.get(idAt(market, k)) ?? 0);
  const top = Math.max(...values, 1e-12);
  const x = (k: number) => ((flip ? REACH - k : k + REACH) / (2 * REACH)) * 100;

  const move = (which: "lo" | "hi", k: number) => onChange(moveEdge({ lo, hi }, which, k));
  const positionAt = (clientX: number) => {
    const r = track.current!.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    const step = Math.round(frac * 2 * REACH);
    return flip ? REACH - step : step - REACH;
  };
  const down = (e: PointerEvent<HTMLDivElement>) => {
    const k = positionAt(e.clientX);
    dragging.current = Math.abs(k - lo) < Math.abs(k - hi) || (k < lo && Math.abs(k - lo) === Math.abs(k - hi)) ? "lo" : "hi";
    e.currentTarget.setPointerCapture(e.pointerId);
    move(dragging.current, k);
  };
  const key = (which: "lo" | "hi") => (e: KeyboardEvent) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    move(which, (which === "lo" ? lo : hi) + (flip ? -step : step));
  };
  const disp = (p: number) => (flip ? 1 / p : p);

  return (
    <div>
      <div
        ref={track}
        className="relative h-[52px] cursor-pointer touch-none select-none"
        onPointerDown={down}
        onPointerMove={(e) => dragging.current && move(dragging.current, positionAt(e.clientX))}
        onPointerUp={() => (dragging.current = null)}
      >
        <div className="absolute inset-x-0 bottom-[7px] top-0 flex items-end gap-px">
          {positions.map((k, i) => {
            const inside = k >= lo && k <= hi;
            return (
              <i
                key={k}
                className={`block min-w-0 flex-1 rounded-t-[1px] ${k === 0 ? "bg-t1" : inside ? "bg-brand/70" : "bg-t3/35"}`}
                style={{ height: `${pool ? Math.max(6, (values[i] / top) * 100) : 6}%` }}
              />
            );
          })}
        </div>
        <div className="absolute inset-x-0 bottom-[6px] h-[2px] rounded-full bg-line-2" />
        <div className="absolute bottom-[6px] h-[2px] bg-brand" style={{ left: `${Math.min(x(lo), x(hi))}%`, width: `${Math.abs(x(hi) - x(lo))}%` }} />
        {(["lo", "hi"] as const).map((which) => {
          const k = which === "lo" ? lo : hi;
          return (
            <span
              key={which}
              role="slider"
              tabIndex={0}
              aria-label={which === "lo" ? "Lowest bin" : "Highest bin"}
              aria-valuemin={0}
              aria-valuemax={2 * REACH}
              aria-valuenow={k + REACH}
              aria-valuetext={fmtPrice(disp(market.binPrice(idAt(market, k))))}
              onKeyDown={key(which)}
              className="absolute bottom-0 size-[14px] -translate-x-1/2 rounded-full border-2 border-[#0c0c0c] bg-brand shadow-[0_0_0_1px_var(--color-brand)] outline-none focus-visible:ring-2 focus-visible:ring-brand/50"
              style={{ left: `${x(k)}%` }}
            />
          );
        })}
      </div>
      <div className="mt-1.5 flex justify-between text-[11px] text-t3">
        {ticks(positions).map((k) => (
          <span key={k}>{fmtPrice(disp(market.binPrice(idAt(market, k))))}</span>
        ))}
      </div>
    </div>
  );
}

/** A range edge: its price, how far that is from the pool price, and a bin either way */
export function PriceBox({ label, price, pool, onPrice, onStep }: { label: string; price: number; pool: number; onPrice: (p: number) => void; onStep: (d: 1 | -1) => void }) {
  const [draft, setDraft] = useState<{ field: "price" | "pct"; text: string } | null>(null);
  const pct = (price / pool - 1) * 100;
  const commit = () => {
    if (!draft) return;
    const v = Number(draft.text.replace(/[%,+\s]/g, ""));
    setDraft(null);
    if (!Number.isFinite(v)) return;
    const next = draft.field === "price" ? v : pool * (1 + v / 100);
    if (next > 0) onPrice(next);
  };
  const field = (name: "price" | "pct", shown: string, aria: string) => (
    <input
      inputMode="decimal"
      aria-label={aria}
      value={draft?.field === name ? draft.text : shown}
      onFocus={(e) => {
        setDraft({ field: name, text: shown });
        e.target.select();
      }}
      onChange={(e) => setDraft({ field: name, text: e.target.value })}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      className="w-full min-w-0 bg-transparent px-3 text-[14px] font-medium text-t1 outline-none"
    />
  );
  return (
    <div>
      <div className="mb-1.5 text-[12.5px] text-t3">{label}</div>
      <div className="flex h-[46px] items-stretch overflow-hidden rounded-[10px] border border-line bg-bg focus-within:border-line-2">
        <div className="flex flex-1 items-center border-r border-line">{field("price", fmtPrice(price), `${label}`)}</div>
        <div className="flex flex-1 items-center border-r border-line">{field("pct", `${pct >= 0 ? "" : "-"}${Math.abs(pct).toFixed(2)}%`, `${label}, change from the pool price`)}</div>
        <div className="flex w-8 flex-col">
          <button type="button" aria-label={`Raise ${label.toLowerCase()} by one bin`} onClick={() => onStep(1)} className="grid flex-1 cursor-pointer place-items-center text-t3 transition-colors hover:bg-s3 hover:text-t1">
            <Plus size={11} strokeWidth={2} />
          </button>
          <button type="button" aria-label={`Lower ${label.toLowerCase()} by one bin`} onClick={() => onStep(-1)} className="grid flex-1 cursor-pointer place-items-center border-t border-line text-t3 transition-colors hover:bg-s3 hover:text-t1">
            <Minus size={11} strokeWidth={2} />
          </button>
        </div>
      </div>
    </div>
  );
}
