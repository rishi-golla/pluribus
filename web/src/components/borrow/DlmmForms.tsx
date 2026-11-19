"use client";

import { motion } from "motion/react";
import { ArrowRight, Info } from "lucide-react";
import { useState, type ReactNode } from "react";
import { KV, Label, Token } from "@/components/ui";
import { useToast, type Live } from "@/components/app/providers";
import { displayAmount, healthOf, healthTone, money, shortKey, usd } from "@/lib/account";
import { deployment } from "@/lib/cluster";
import type { Collateral, DlmmMarket, Risk } from "@/lib/live";
import { MAX_BINS, math } from "@/lib/pluribus/sdk";
import { iconSrc, tokenIcon } from "@/lib/tokens";

export const MAX_POSITIONS = 5;
export const DLMM_ICON = "met.webp";
export const health = (h: number) => (Number.isFinite(h) ? h.toFixed(2) : "No debt");
export const rangePrice = (v: number) => money(v, v >= 100 ? 0 : 2);
const DEFAULT_WIDTH = 30;
// Left in the wallet when SOL goes into a position: the position's rent, which comes back on close, bin arrays the range may
// be the first to touch, which Meteora keeps, and fees
const SOL_RESERVE = 0.25;
const PERCENTS = [25, 50, 75, 100] as const;
const arrow = <ArrowRight size={13} strokeWidth={1.75} className="text-t3" />;

type Status = "idle" | "signing" | "confirming";

/** Which of the two tokens a range can take: USDC goes in the bins under the active price, the base token in those above it */
function rangeSides(market: DlmmMarket, lower: number, upper: number) {
  const [usdc, base] = market.baseIsX ? [lower <= market.activeId, upper >= market.activeId] : [upper >= market.activeId, lower <= market.activeId];
  return { usdc, base };
}

/**
 * What a range holds once Meteora's Spot strategy has filled it, as bins the SDK can value: USDC evenly over the bins at or under the
 * active price and the base token evenly over those at or over it. Only for the preview, the program works out the real mix
 */
export function spotBins(market: DlmmMarket, lower: number, upper: number, base: number, usdc: number): math.DlmmBin[] {
  const ids = Array.from({ length: upper - lower + 1 }, (_, i) => lower + i);
  const usdcSide = (id: number) => (market.baseIsX ? id <= market.activeId : id >= market.activeId);
  const baseSide = (id: number) => (market.baseIsX ? id >= market.activeId : id <= market.activeId);
  const [nUsdc, nBase] = [ids.filter(usdcSide).length, ids.filter(baseSide).length];
  return ids.flatMap((id) => {
    const price = market.binPrice(id);
    const liquidity = (usdcSide(id) && nUsdc ? usdc / nUsdc : 0) + (baseSide(id) && nBase ? (base / nBase) * price : 0);
    return liquidity > 0 ? [{ price, usdc: liquidity }] : [];
  });
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
      className={`mt-[18px] flex h-12 w-full items-center justify-center gap-2.5 text-[15px] font-medium transition-colors ${
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
    <div className="mt-3 flex gap-2 border border-line bg-bg px-3.5 py-3 text-[12.5px] leading-[1.5] text-t3">
      <Info size={14} strokeWidth={1.75} className="mt-px shrink-0" />
      <div>{children}</div>
    </div>
  );
}

function AmountBox({
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
  return (
    <label className={`block border border-line bg-bg px-4 py-3 transition-colors focus-within:border-line-2 ${off ? "opacity-55" : ""}`}>
      <div className="flex items-center justify-between">
        <Label>{symbol}</Label>
        <Label>Available {money(max, 4)}</Label>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2.5">
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
          className="w-full min-w-0 bg-transparent text-[24px] font-medium tracking-[-0.03em] text-t1 outline-none placeholder:text-t3"
        />
        <button
          type="button"
          disabled={!!off}
          onClick={() => onChange((Math.floor(max * 1e4) / 1e4).toString())}
          className="cursor-pointer border border-line px-2 py-0.5 text-xs font-medium text-t2 transition-colors hover:border-line-2 hover:text-t1 disabled:cursor-not-allowed"
        >
          Max
        </button>
        <span className="inline-flex h-8 shrink-0 items-center gap-2 border border-line-2 bg-s3 pl-1.5 pr-2.5 text-[13.5px] font-medium">
          <Token src={iconSrc(icon)} size={18} />
          {symbol}
        </span>
      </div>
      <div className="mt-1 text-[12.5px] text-t3">{off ?? usd((Number(value) || 0) * price)}</div>
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
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [rawBase, setRawBase] = useState("");
  const [rawUsdc, setRawUsdc] = useState("");
  const [status, setStatus] = useState<Status>("idle");

  const baseSymbol = market?.symbol ?? "SOL";
  const baseHeld = !market ? 0 : market.baseMint === d.solMint ? Math.max(0, live.wallet.sol - SOL_RESERVE) : (live.wallet.tokens[market.baseMint] ?? 0);
  const lowerBin = row?.dlmm ? row.dlmm.lowerBin : market ? market.activeId - Math.floor(width / 2) : 0;
  const upperBin = row?.dlmm ? row.dlmm.upperBin : lowerBin + width - 1;
  const sides = market ? rangeSides(market, lowerBin, upperBin) : { base: false, usdc: false };
  // A side the range has no bins for takes nothing
  const [base, usdc] = [sides.base ? Number(rawBase) || 0 : 0, sides.usdc ? Number(rawUsdc) || 0 : 0];
  const risk = market ? market.risk([...(row ? binsOf(row.risk) : []), ...spotBins(market, lowerBin, upperBin, base, usdc)]) : null;
  const next = limitsWith(live, row?.mint ?? null, risk);
  const [low, high] = market ? [market.binPrice(lowerBin), market.binPrice(upperBin)].sort((a, b) => a - b) : [0, 0];

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
    const result = row ? ((await live.addDlmm(row.mint, base, usdc, setStatus)) ? "funded" : "failed") : await live.openDlmm(market.pair, lowerBin, width, base, usdc, setStatus);
    setStatus("idle");
    if (result === "failed") return;
    // A position that opened without its liquidity has already been reported, with what to do next
    if (result === "funded") toast({ title: row ? "Added liquidity" : "Opened a Meteora position", detail: `Credit limit ${usd(live.creditLimit)} to ${usd(next.creditLimit)}` });
    onClose();
  };

  return (
    <>
      {!row && market && (
        <div className="mt-3.5 border border-line bg-bg px-4 py-3">
          <div className="flex items-center justify-between">
            <Label>Range width</Label>
            <span className="text-[13.5px] font-medium">{width === 1 ? "1 bin" : `${width} bins`}</span>
          </div>
          <input
            type="range"
            min={1}
            max={MAX_BINS}
            value={width}
            aria-label="Range width in bins"
            onChange={(e) => setWidth(Number(e.target.value))}
            className="mt-2.5 w-full cursor-pointer accent-brand"
          />
          <div className="mt-1 flex justify-between text-xs text-t3">
            <span>Narrower earns more fees</span>
            <span>Wider holds its value longer</span>
          </div>
        </div>
      )}
      <div className="mt-3 grid gap-2">
        <AmountBox
          symbol={baseSymbol}
          icon={tokenIcon(baseSymbol)}
          value={rawBase}
          onChange={setRawBase}
          max={baseHeld}
          price={market?.price ?? 0}
          off={market && !sides.base ? "This range is under the active price, so it takes no " + baseSymbol : undefined}
        />
        <AmountBox
          symbol="USDC"
          icon={tokenIcon("USDC")}
          value={rawUsdc}
          onChange={setRawUsdc}
          max={live.wallet.usdc}
          price={1}
          off={market && !sides.usdc ? "This range is over the active price, so it takes no USDC" : undefined}
        />
      </div>
      {market && (
        <div className="mt-3">
          <KV k="Price range">
            {usd(low)} to {usd(high)}
          </KV>
          <KV k="Active price">{usd(market.price)}</KV>
          <KV k="Bin step">{money(market.binStep / 100, 2)}%</KV>
        </div>
      )}
      <Impact live={live} next={next} />
      {!row && (
        <Note>
          This opens a new position that the Pluribus pool holds, because a Meteora position can never change owner, so one already in your wallet cannot be deposited. Opening it
          costs about 0.06 SOL in rent, returned when you close it, plus 0.07 SOL for each bin array nobody has created yet.
        </Note>
      )}
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
          <div className="mt-3.5 border border-line bg-bg px-4 py-3">
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
                className={`flex-1 cursor-pointer border py-1.5 text-center text-xs font-medium transition-colors hover:text-t1 ${
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
