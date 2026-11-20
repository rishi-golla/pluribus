"use client";

import { motion } from "motion/react";
import { ArrowLeftRight, ArrowRight, ChevronDown, Info, RotateCcw, Wallet } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { KV, Label, Token } from "@/components/ui";
import { useToast, type Live } from "@/components/app/providers";
import { displayAmount, healthOf, healthTone, money, shortKey, usd } from "@/lib/account";
import { deployment } from "@/lib/cluster";
import { fetchPairLiquidity, type PairLiquidity } from "@/lib/dlmmBins";
import type { Collateral, DlmmMarket, Risk } from "@/lib/live";
import { MAX_BINS, binArrayIndexes, math } from "@/lib/pluribus/sdk";
import { iconSrc, tokenIcon } from "@/lib/tokens";
import {
  BASE_COLOR,
  DEFAULT_RANGE,
  defaultRange,
  DistributionChart,
  PriceBox,
  REACH,
  RangeSlider,
  STRATEGIES,
  StrategyPicker,
  Switch,
  USDC_COLOR,
  autoFill,
  fmtPrice,
  idAt,
  moveEdge,
  plan,
  positionOf,
  type Range,
  type Strategy,
} from "./DlmmRange";

export const MAX_POSITIONS = 16;
export const DLMM_ICON = "met.webp";
export const health = (h: number) => (Number.isFinite(h) ? h.toFixed(2) : "No debt");
export const rangePrice = (v: number) => money(v, v >= 100 ? 0 : 2);
/** Rent for an account of `bytes`: 6960 lamports a byte, counting its 128-byte header */
const rentSol = (bytes: number) => ((bytes + 128) * 6960) / 1e9;
/** A Meteora position's rent, which comes back when it is closed */
const POSITION_RENT = rentSol(8120);
/** A bin array's rent, paid by whoever touches it first and kept by Meteora */
const BIN_ARRAY_RENT = rentSol(10_136);
/** Left in the wallet besides the rent: transaction fees and the wrapped SOL account, closed again in the same transaction */
const FEE_BUFFER = 0.02;
const QUICK = [
  { label: "25%", pct: 0.25 },
  { label: "50%", pct: 0.5 },
  { label: "Max", pct: 1 },
] as const;
const PERCENTS = [25, 50, 75, 100] as const;
/** A typed amount, floored to what the input shows */
const trim = (v: number, dp: number) => (v > 0 ? String(Math.floor(v * 10 ** dp) / 10 ** dp) : "");
const arrow = <ArrowRight size={13} strokeWidth={1.75} className="text-t3" />;

type Status = "idle" | "signing" | "confirming";

/** Which of the two tokens a range can take: USDC goes in the bins under the active price, the base token in those above it */
function rangeSides(market: DlmmMarket, lower: number, upper: number) {
  const [usdc, base] = market.baseIsX ? [lower <= market.activeId, upper >= market.activeId] : [upper >= market.activeId, lower <= market.activeId];
  return { usdc, base };
}

const binsOf = (risk: Risk) => ("bins" in risk ? risk.bins : []);

/** The account's limits with one position swapped for `risk`, or taken out when it is null */
function limitsWith(live: Live, replaced: string | null, risk: Risk | null) {
  const others = live.collateral.filter((c) => c.mint !== replaced).map((c) => c.risk);
  return math.limits(risk ? [...others, risk] : others, live.shock, live.prices);
}

function Impact({ live, next }: { live: Live; next: ReturnType<typeof math.limits> }) {
  const [now, after] = [healthOf(live.debt, live.liquidationLimit), healthOf(live.debt, next.liquidationLimit)];
  return (
    <div className="mt-3.5">
      <KV k="Credit limit">
        {usd(live.creditLimit)}
        {arrow}
        {usd(next.creditLimit)}
      </KV>
      <KV k="Health factor">
        <span className={healthTone(now)}>{health(now)}</span>
        {arrow}
        <span className={healthTone(after)}>{health(after)}</span>
      </KV>
    </div>
  );
}

function Submit({ label, error, status, onClick }: { label: string; error: string | null; status: Status; onClick: () => void }) {
  const text = status === "signing" ? "Confirm in wallet..." : status === "confirming" ? "Confirming on Solana..." : (error ?? label);
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={!!error || status !== "idle"}
      whileTap={!error && status === "idle" ? { scale: 0.98 } : undefined}
      className={`mt-[18px] flex h-12 w-full items-center justify-center gap-2.5 rounded-[10px] text-[15px] font-medium transition-colors ${
        error ? "cursor-not-allowed bg-s3 text-t3" : "cursor-pointer bg-brand text-[#0c0c0c] hover:bg-[#d4ff5e]"
      }`}
    >
      {status !== "idle" && <span className="inline-block size-4 animate-spin rounded-full border-2 border-[#09090b]/25 border-t-[#09090b]" aria-hidden />}
      {text}
    </motion.button>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <div className="mt-3 flex gap-2 rounded-[10px] border border-line bg-bg px-3.5 py-3 text-[12.5px] leading-[1.5] text-t3">
      <Info size={14} strokeWidth={1.75} className="mt-px shrink-0" />
      <div>{children}</div>
    </div>
  );
}

/** One token of the deposit, laid out as Meteora's amount cards are: the token, the amount and its worth, then the wallet balance and quick picks */
function TokenCard({
  symbol,
  icon,
  value,
  onChange,
  max,
  price,
  off,
}: {
  symbol: string;
  icon: string;
  value: string;
  onChange: (v: string) => void;
  max: number;
  price: number;
  /** Why this side takes nothing, which greys it out */
  off?: string;
}) {
  const amount = Number(value) || 0;
  return (
    <label className={`block rounded-[10px] border border-line bg-bg px-3.5 pb-2.5 pt-3 transition-colors focus-within:border-line-2 ${off ? "opacity-55" : ""}`}>
      <div className="flex items-center gap-2.5">
        <Token src={iconSrc(icon)} size={24} />
        <span className="text-[15px] font-medium">{symbol}</span>
        <div className="ml-auto min-w-0 flex-1 text-right">
          <input
            inputMode="decimal"
            aria-label={`${symbol} to add`}
            placeholder="0.00"
            disabled={!!off}
            value={displayAmount(value)}
            onChange={(e) => {
              const v = e.target.value.replace(/,/g, "");
              if (/^\d*\.?\d{0,4}$/.test(v)) onChange(v);
            }}
            className="w-full min-w-0 bg-transparent text-right text-[20px] font-medium tracking-[-0.02em] text-t1 outline-none placeholder:text-t3"
          />
          <div className="text-[12px] text-t3">{usd(amount * price)}</div>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between text-[12px] text-t3">
        <span className="flex items-center gap-1.5">
          <Wallet size={12} strokeWidth={1.75} />
          {money(max, 4)}
        </span>
        {off ? (
          <span>{off}</span>
        ) : (
          <span className="flex gap-1">
            {QUICK.map((q) => (
              <button
                key={q.label}
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  onChange(trim(max * q.pct, 4));
                }}
                className="cursor-pointer rounded px-1.5 py-0.5 font-medium text-t2 transition-colors hover:bg-s3 hover:text-t1"
              >
                {q.label}
              </button>
            ))}
          </span>
        )}
      </div>
    </label>
  );
}

/**
 * Puts tokens into a Meteora position. Without `row` it opens a new position of the chosen width centred on the pair's active bin,
 * which the pool then owns; with `row` it adds to the position the account already holds, over the range it already has
 */
export function DlmmDepositForm({ live, market, row, onClose }: { live: Live; market: DlmmMarket | undefined; row?: Collateral; onClose: () => void }) {
  const toast = useToast();
  const d = deployment!;
  // Null until the range is moved, so it follows the pair's own default whenever the pair loads or the reset is pressed
  const [picked, setRange] = useState<Range | null>(null);
  const range = picked ?? (market ? defaultRange(market) : DEFAULT_RANGE);
  const [strategy, setStrategy] = useState<Strategy>("Spot");
  const [autoOn, setAutoOn] = useState(true);
  const [raw, setRaw] = useState({ base: "", usdc: "" });
  // The side typed last: with Auto-Fill on the other one follows it
  const [lead, setLead] = useState<"base" | "usdc">("base");
  const [flip, setFlip] = useState(false);
  const [details, setDetails] = useState(false);
  const [pool, setPool] = useState<PairLiquidity | null>(null);
  const [status, setStatus] = useState<Status>("idle");

  const baseSymbol = market?.symbol ?? "SOL";
  const lowerBin = row?.dlmm ? row.dlmm.lowerBin : market ? Math.min(idAt(market, range.lo), idAt(market, range.hi)) : 0;
  const upperBin = row?.dlmm ? row.dlmm.upperBin : market ? Math.max(idAt(market, range.lo), idAt(market, range.hi)) : 0;
  const width = upperBin - lowerBin + 1;

  // The pair's liquidity over everything the slider reaches, or over the position's own range, and which bin arrays exist
  const [from, to] = row?.dlmm ? [lowerBin, upperBin] : market ? [market.activeId - REACH, market.activeId + REACH] : [0, -1];
  useEffect(() => {
    if (!market || to < from) return;
    let alive = true;
    fetchPairLiquidity(market, from, to).then(
      (p) => alive && setPool(p),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [market, from, to]);

  const sides = market ? rangeSides(market, lowerBin, upperBin) : { base: false, usdc: false };
  const auto = autoOn && sides.base && sides.usdc;
  const typed = { base: Number(raw.base) || 0, usdc: Number(raw.usdc) || 0 };
  const filled = (side: "base" | "usdc", amount: number) => (market ? autoFill(market, lowerBin, upperBin, strategy, side, amount) : 0);
  // A side the range has no bins for takes nothing
  const base = !sides.base ? 0 : auto && lead === "usdc" ? filled("usdc", typed.usdc) : typed.base;
  const usdc = !sides.usdc ? 0 : auto && lead === "base" ? filled("base", typed.base) : typed.usdc;
  const edit = (side: "base" | "usdc") => (v: string) => {
    setLead(side);
    setRaw((r) => ({ ...r, [side]: v }));
  };
  const toggleAuto = (on: boolean) => {
    // Turned off, both amounts stay where Auto-Fill left them
    if (!on) setRaw({ base: trim(base, 4), usdc: trim(usdc, 4) });
    setAutoOn(on);
  };

  const planned = market ? plan(market, lowerBin, upperBin, strategy, base, usdc) : [];
  const shape = market ? plan(market, lowerBin, upperBin, strategy, sides.base ? 1 : 0, sides.usdc ? (sides.base ? filled("base", 1) : market.price) : 0) : [];
  const fresh = planned.flatMap((b) => {
    const value = b.usdc + b.base * b.price;
    return value > 0 ? [{ price: b.price, usdc: value }] : [];
  });
  const risk = market ? market.risk([...(row ? binsOf(row.risk) : []), ...fresh]) : null;
  const next = limitsWith(live, row?.mint ?? null, risk);

  // A new position pays its own rent, which comes back on close, and each bin array of the range nobody has created yet
  const arrays = binArrayIndexes(lowerBin, upperBin);
  const newArrays = pool ? arrays.filter((i) => pool.missing.has(i)).length : arrays.length;
  const cost = (row ? 0 : POSITION_RENT) + newArrays * BIN_ARRAY_RENT;
  const baseHeld = !market ? 0 : market.baseMint === d.solMint ? Math.max(0, live.wallet.sol - cost - FEE_BUFFER) : (live.wallet.tokens[market.baseMint] ?? 0);

  const pairLabel = flip ? `${baseSymbol}/USDC` : `USDC/${baseSymbol}`;
  const disp = (p: number) => (flip ? 1 / p : p);
  const priceAt = (k: number) => (market ? market.binPrice(idAt(market, k)) : 0);
  // Shown lowest first: flipped, the lowest shown price is the range's highest dollar price
  const edges = (flip ? [["Min Price", "hi"], ["Max Price", "lo"]] : [["Min Price", "lo"], ["Max Price", "hi"]]) as [string, "lo" | "hi"][];
  const [low, high] = market ? [market.binPrice(lowerBin), market.binPrice(upperBin)].map(disp).sort((a, b) => a - b) : [0, 0];

  const error = !market
    ? "This pair is no longer listed"
    : market.closed
      ? market.closed
      : !row && live.collateral.length >= MAX_POSITIONS
        ? "No free position slot"
        : base <= 0 && usdc <= 0
          ? "Enter an amount"
          : base > baseHeld + 1e-9
            ? `Not enough ${baseSymbol}`
            : usdc > live.wallet.usdc + 1e-9
              ? "Not enough USDC"
              : null;

  const submit = async () => {
    if (error || status !== "idle" || !market) return;
    const value = STRATEGIES.find((s) => s.name === strategy)!.value;
    const result = row
      ? (await live.addDlmm(row.mint, base, usdc, setStatus, value))
        ? "funded"
        : "failed"
      : await live.openDlmm(market.pair, lowerBin, width, base, usdc, setStatus, value);
    setStatus("idle");
    if (result === "failed") return;
    // A position that opened without its liquidity has already been reported, with what to do next
    if (result === "funded") toast({ title: row ? "Added liquidity" : "Opened a Meteora position", detail: `Credit limit ${usd(live.creditLimit)} to ${usd(next.creditLimit)}` });
    onClose();
  };

  return (
    <>
      <div className="mb-2 mt-[18px] flex items-center justify-between">
        <Label>Amount</Label>
        <Switch on={autoOn} onChange={toggleAuto} label="Auto-Fill" />
      </div>
      <div className="grid gap-2">
        <TokenCard
          symbol={baseSymbol}
          icon={tokenIcon(baseSymbol)}
          value={sides.base && auto && lead === "usdc" ? trim(base, 4) : raw.base}
          onChange={edit("base")}
          max={baseHeld}
          price={market?.price ?? 0}
          off={market && !sides.base ? "Range is under the pool price" : undefined}
        />
        <TokenCard
          symbol="USDC"
          icon={tokenIcon("USDC")}
          value={sides.usdc && auto && lead === "base" ? trim(usdc, 2) : raw.usdc}
          onChange={edit("usdc")}
          max={live.wallet.usdc}
          price={1}
          off={market && !sides.usdc ? "Range is over the pool price" : undefined}
        />
      </div>

      <div className="mb-2 mt-[18px]">
        <Label>Strategy</Label>
      </div>
      <StrategyPicker value={strategy} onChange={setStrategy} />

      {market && (
        <>
          <div className="mb-1 mt-[18px] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Label>Price Range</Label>
              {!row && (
                <button type="button" aria-label="Reset the price range" onClick={() => setRange(null)} className="cursor-pointer text-t3 transition-colors hover:text-t1">
                  <RotateCcw size={12} strokeWidth={1.75} />
                </button>
              )}
            </div>
            <button type="button" onClick={() => setFlip((f) => !f)} className="flex cursor-pointer items-center gap-1.5 text-[12.5px] text-t3 transition-colors hover:text-t1">
              {pairLabel}
              <ArrowLeftRight size={12} strokeWidth={1.75} />
            </button>
          </div>
          <div className="mb-1 flex gap-3 text-[11.5px] text-t3">
            <span className="flex items-center gap-1.5">
              <i className="size-2 rounded-full" style={{ background: BASE_COLOR }} />
              {baseSymbol}
            </span>
            <span className="flex items-center gap-1.5">
              <i className="size-2 rounded-full" style={{ background: USDC_COLOR }} />
              USDC
            </span>
          </div>
          <DistributionChart market={market} bins={planned} shape={shape} flip={flip} pair={pairLabel} />
          {row ? (
            <div className="mt-2">
              <KV k="Price range">
                {fmtPrice(low)} to {fmtPrice(high)} {pairLabel}
              </KV>
            </div>
          ) : (
            <>
              <div className="mt-3">
                <RangeSlider market={market} pool={pool?.value ?? null} lo={range.lo} hi={range.hi} flip={flip} onChange={setRange} />
              </div>
              <div className="mt-3 grid gap-2.5">
                {edges.map(([label, which]) => (
                  <PriceBox
                    key={label}
                    label={label}
                    price={disp(priceAt(range[which]))}
                    pool={disp(market.price)}
                    onPrice={(p) => setRange(moveEdge(range, which, positionOf(market, flip ? 1 / p : p)))}
                    onStep={(step) => setRange(moveEdge(range, which, range[which] + (flip ? -step : step)))}
                  />
                ))}
              </div>
            </>
          )}
          <div className="mt-2.5 flex items-center justify-between text-[12.5px]">
            <span className="text-t3">
              Total bins <span className="font-medium text-t1">{width}</span>
              <span> of {MAX_BINS}</span>
            </span>
            <span className="text-t3">Bin step {money(market.binStep / 100, 2)}%</span>
          </div>
        </>
      )}

      {market && (
        <div className="mt-3.5 border-t border-line pt-3 text-[12.5px]">
          <div className="flex justify-between py-0.5">
            <span className="text-t2">{row ? "Cost to add liquidity" : "Cost required to create 1 position"}</span>
            <span className="font-medium">{money(cost, 4)} SOL</span>
          </div>
          {!row && (
            <div className="flex justify-between py-0.5">
              <span className="text-t2">Refunded upon closing the position</span>
              <span className="font-medium">{money(POSITION_RENT, 4)} SOL</span>
            </div>
          )}
          <button type="button" onClick={() => setDetails((v) => !v)} className="mt-1 flex cursor-pointer items-center gap-1 text-t3 transition-colors hover:text-t1">
            View details
            <ChevronDown size={12} strokeWidth={1.75} className={`transition-transform ${details ? "rotate-180" : ""}`} />
          </button>
          {details && (
            <div className="mt-1.5 grid gap-0.5 text-t3">
              {!row && (
                <div className="flex justify-between">
                  <span>Position rent, back when you close it</span>
                  <span>{money(POSITION_RENT, 4)} SOL</span>
                </div>
              )}
              <div className="flex justify-between">
                <span>
                  {newArrays} new bin {newArrays === 1 ? "array" : "arrays"}, kept by Meteora
                </span>
                <span>{money(newArrays * BIN_ARRAY_RENT, 4)} SOL</span>
              </div>
              {!row && (
                <Note>
                  The Pluribus pool holds this position, because a Meteora position can never change owner, so one already in your wallet cannot be deposited.
                </Note>
              )}
            </div>
          )}
        </div>
      )}
      <Impact live={live} next={next} />
      <Submit label={row ? "Add liquidity" : "Open position and add liquidity"} error={error} status={status} onClick={submit} />
    </>
  );
}

/** Takes a share of a Meteora position's liquidity back to the wallet, or closes it once it holds none */
export function DlmmExitForm({ live, row, onClose }: { live: Live; row: Collateral; onClose: () => void }) {
  const toast = useToast();
  const [pct, setPct] = useState(100);
  const [status, setStatus] = useState<Status>("idle");
  const dlmm = row.dlmm!;
  const baseSymbol = row.symbol.split("-")[0];
  const left = 1 - pct / 100;
  const scaled: Risk = "bins" in row.risk ? { ...row.risk, bins: row.risk.bins.map((b) => ({ ...b, usdc: b.usdc * left })) } : row.risk;
  const next = limitsWith(live, row.mint, dlmm.empty ? null : scaled);
  const error = !dlmm.empty && live.debt > next.creditLimit ? "Debt would exceed the credit limit" : null;

  const submit = async () => {
    if (error || status !== "idle") return;
    const ok = dlmm.empty ? await live.closeDlmm(row.mint, setStatus) : await live.removeDlmm(row.mint, Math.round(pct * 100), setStatus);
    setStatus("idle");
    if (!ok) return;
    if (dlmm.empty) toast({ title: "Closed the position", detail: "Its rent and any fees went to your wallet" });
    else if (pct === 100) toast({ title: "Withdrew all liquidity", detail: "Close the position to get its rent back and free its slot", tone: "info" });
    else toast({ title: `Withdrew ${pct}% of the position`, detail: `Credit limit ${usd(live.creditLimit)} to ${usd(next.creditLimit)}` });
    onClose();
  };

  return (
    <>
      <div className="mt-3.5">
        <KV k="Position">{shortKey(row.mint)}</KV>
        <KV k="Price range">
          {usd(dlmm.lower)} to {usd(dlmm.upper)}
        </KV>
        <KV k="Value">{usd(row.value)}</KV>
        <KV k="Holds">{dlmm.empty ? "No liquidity" : `${money(dlmm.sol, 4)} ${baseSymbol} + ${money(dlmm.usdc)} USDC`}</KV>
      </div>
      {dlmm.empty ? (
        <Note>This position holds no liquidity. Closing it sends its rent and any unclaimed fees to your wallet and frees its slot.</Note>
      ) : (
        <>
          <div className="mt-3.5 rounded-[10px] border border-line bg-bg px-4 py-3">
            <div className="flex items-center justify-between">
              <Label>Withdraw</Label>
              <span className="text-[13.5px] font-medium">{pct}%</span>
            </div>
            <input
              type="range"
              min={1}
              max={100}
              value={pct}
              aria-label="Share of the position to withdraw"
              onChange={(e) => setPct(Number(e.target.value))}
              className="mt-2.5 w-full cursor-pointer accent-brand"
            />
          </div>
          <div className="mt-2.5 flex gap-1.5">
            {PERCENTS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPct(p)}
                className={`flex-1 cursor-pointer rounded-md border py-1.5 text-center text-xs font-medium transition-colors hover:text-t1 ${
                  pct === p ? "border-brand/45 bg-brand/5 text-t1" : "border-line text-t2 hover:border-line-2"
                }`}
              >
                {p === 100 ? "All" : `${p}%`}
              </button>
            ))}
          </div>
          <div className="mt-3">
            <KV k="You receive about">
              {money(dlmm.sol * (pct / 100), 4)} {baseSymbol} + {money(dlmm.usdc * (pct / 100))} USDC
            </KV>
          </div>
        </>
      )}
      <Impact live={live} next={next} />
      <Submit label={dlmm.empty ? "Close position" : `Withdraw ${pct}%`} error={error} status={status} onClick={submit} />
    </>
  );
}
