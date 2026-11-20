"use client";

import { AnimatePresence, motion } from "motion/react";
import { ArrowRight, Check, X } from "lucide-react";
import { useEffect, useState } from "react";
import { KV, Label, Token } from "@/components/ui";
import { Segmented } from "@/components/Segmented";
import { useToast, type Live, type Move } from "@/components/app/providers";
import { displayAmount, healthOf, healthTone, money, usd } from "@/lib/account";
import { deployment } from "@/lib/cluster";
import type { Collateral, DlmmMarket } from "@/lib/live";
import { math } from "@/lib/pluribus/sdk";
import { TOKEN_INFO, iconSrc, tokenIcon } from "@/lib/tokens";
import { DLMM_ICON, DlmmDepositForm, DlmmExitForm, MAX_POSITIONS, health, rangePrice } from "./DlmmForms";

const QUICK = [
  { label: "25%", pct: 0.25 },
  { label: "50%", pct: 0.5 },
  { label: "Max", pct: 1 },
] as const;
// Left in the wallet for fees and the credit account's rent
const SOL_BUFFER = 0.02;
// SOL first, then staked SOL, stocks and USDC, with anything not in TOKEN_INFO after them
const ORDER = Object.keys(TOKEN_INFO);
const rank = (symbol: string) => (ORDER.includes(symbol) ? ORDER.indexOf(symbol) : ORDER.length);

type Mode = "Deposit" | "Withdraw";
type Option = {
  id: string;
  icon: string;
  name: string;
  sub: string;
  right: string;
  symbol: string;
  max?: number;
  /** A Meteora option: the pair to open a position in, or the position the account holds */
  dlmm?: { market?: DlmmMarket; row?: Collateral };
  /** Why it cannot be picked right now */
  off?: boolean;
};

function Form({ live, withdraw, add, onClose }: { live: Live; withdraw?: string; add?: string; onClose: () => void }) {
  const toast = useToast();
  const d = deployment!;
  const [mode, setMode] = useState<Mode>(withdraw ? "Withdraw" : "Deposit");
  // Ids of the picked options, in the order they were picked, or null before anything is clicked
  const [picked, setPicked] = useState<string[] | null>(withdraw ?? add ? [(withdraw ?? add)!] : null);
  // Typed amounts, by option id, kept while an option is unpicked and picked again
  const [raws, setRaws] = useState<Record<string, string>>({});
  const setRaw = (id: string, v: string) => setRaws((r) => ({ ...r, [id]: v }));
  const [status, setStatus] = useState<"idle" | "signing" | "confirming">("idle");
  const deposit = mode === "Deposit";

  const lpOption = (id: string, lower: number, upper: number, value: number): Option => ({
    id,
    icon: "orca.png",
    name: "SOL-USDC",
    sub: `Orca Whirlpool, ${rangePrice(lower)} to ${rangePrice(upper)}`,
    right: usd(value),
    symbol: "LP position",
  });
  // A Meteora position the account holds: added to from the Deposit tab, withdrawn from and closed on the Withdraw tab
  const dlmmOption = (c: Collateral, market: DlmmMarket | undefined, sub: string): Option => {
    const off = deposit && (!market || !!market.closed);
    return {
      id: c.mint,
      icon: DLMM_ICON,
      name: c.symbol,
      sub: `Meteora DLMM, ${rangePrice(c.dlmm!.lower)} to ${rangePrice(c.dlmm!.upper)}${sub}`,
      right: off ? (market?.closed ?? "Pair not listed") : usd(c.value),
      symbol: "Meteora position",
      dlmm: { market, row: c },
      off,
    };
  };
  const options: Option[] = deposit
    ? [
        { id: d.solMint, icon: "sol.webp", name: "SOL", sub: `${money(live.wallet.sol, 4)} in wallet`, right: usd(live.wallet.sol * live.prices[d.solMint]), symbol: "SOL", max: Math.max(0, live.wallet.sol - SOL_BUFFER) },
        ...live.tokenMints
          .map((mint) => ({ mint, symbol: d.assets[mint].symbol, held: live.wallet.tokens[mint] ?? 0 }))
          .sort((a, b) => rank(a.symbol) - rank(b.symbol))
          .map(({ mint, symbol, held }) => ({ id: mint, icon: tokenIcon(symbol), name: symbol, sub: `${money(held, 4)} in wallet`, right: usd(held * (live.prices[mint] ?? 0)), symbol, max: held })),
        ...live.wallet.lps.map((lp) => lpOption(lp.positionMint.toBase58(), lp.priceLower, lp.priceUpper, math.lpValue(lp.liquidity, lp.tickLower, lp.tickUpper, live.prices[d.solMint]))),
        // A new Meteora position, one option per listed pair, greyed out while the pair takes nothing new
        ...live.dlmm.map((market) => ({
          id: `new:${market.pair}`,
          icon: DLMM_ICON,
          name: `${market.symbol}-USDC`,
          sub: `Meteora DLMM, new position at ${usd(market.price)}`,
          right: market.closed ?? "New position",
          symbol: "Meteora position",
          dlmm: { market },
          off: !!market.closed,
        })),
        // Liquidity added to a position already held
        ...live.collateral.flatMap((c) => (c.dlmm ? [dlmmOption(c, live.dlmm.find((m) => m.pair === c.dlmm!.pair), ", add liquidity")] : [])),
      ]
    : live.collateral.map((c) =>
        c.dlmm
          ? dlmmOption(c, live.dlmm.find((m) => m.pair === c.dlmm!.pair), c.dlmm.empty ? ", empty" : "")
          : c.lp
            ? lpOption(c.mint, c.lp.lower, c.lp.upper, c.value)
            : { id: c.mint, icon: tokenIcon(c.symbol), name: c.symbol, sub: `${money(c.amount, 4)} deposited`, right: usd(c.value), symbol: c.symbol, max: c.amount },
      );
  const byId = new Map(options.map((o) => [o.id, o]));
  // Until something is clicked the first pickable option is picked, as it always was
  const first = options.find((o) => !o.off);
  const chosen = (picked ?? (first ? [first.id] : [])).flatMap((id) => byId.get(id) ?? []);
  // A Meteora option has its own form, so it is only ever picked alone
  const dlmmPick = chosen.find((o) => o.dlmm);
  const picks = dlmmPick ? [] : chosen;
  const amountOf = (o: Option) => (o.max === undefined ? 1 : Number(raws[o.id]) || 0);

  const toggle = (o: Option) => {
    if (o.dlmm) return setPicked([o.id]);
    const ids = chosen.filter((c) => !c.dlmm).map((c) => c.id);
    setPicked(ids.includes(o.id) ? ids.filter((id) => id !== o.id) : [...ids, o.id]);
  };

  const pickedIds = new Set(picks.map((o) => o.id));
  const others = live.collateral.filter((c) => !pickedIds.has(c.mint)).map((c) => c.risk);
  const changed = picks.flatMap((o) => {
    if (o.max === undefined) {
      // A deposited LP position comes off the account whole, and one from the wallet goes on whole
      const walletLp = live.wallet.lps.find((lp) => lp.positionMint.toBase58() === o.id);
      return walletLp ? [live.lpRisk(walletLp)] : [];
    }
    const held = live.collateral.find((c) => c.mint === o.id);
    const total = (held?.amount ?? 0) + (deposit ? amountOf(o) : -amountOf(o));
    return total > 0 ? [{ ...(held?.risk ?? live.tokenRisk(o.id, 0)), amount: total }] : [];
  });
  const next = math.limits([...others, ...changed], live.shock, live.prices);
  const now = healthOf(live.debt, live.liquidationLimit);
  const after = healthOf(live.debt, next.liquidationLimit);
  // Every LP deposit and every token not already held takes a slot of its own
  const newSlots = deposit ? picks.filter((o) => o.max === undefined || !live.collateral.some((c) => c.mint === o.id)).length : 0;

  const tokens = picks.filter((o) => o.max !== undefined);
  const blank = tokens.find((o) => amountOf(o) <= 0);
  // A deposit is shown to four decimals, and typing that figure back in has to work
  const over = tokens.find((o) => amountOf(o) > (deposit ? o.max! : Math.round(o.max! * 1e4) / 1e4) + 1e-9);
  const error = !options.length
    ? `Nothing to ${mode.toLowerCase()}`
    : !picks.length
      ? "Pick an asset"
      : blank
        ? `Enter an amount${tokens.length > 1 ? ` of ${blank.symbol}` : ""}`
        : over
          ? deposit
            ? `Exceeds wallet ${over.symbol}`
            : `Exceeds your ${over.symbol} deposit`
          : deposit && live.collateral.length + newSlots > MAX_POSITIONS
            ? newSlots > 1
              ? "Not enough free position slots"
              : "No free position slot"
            : !deposit && live.debt > next.creditLimit
              ? "Debt would exceed the credit limit"
              : null;
  const name = (o: Option) => (o.max === undefined ? "LP position" : `${displayAmount(String(amountOf(o)))} ${o.symbol}`);
  const what = picks.length > 2 ? `${picks.length} assets` : picks.map(name).join(" and ");
  const label = status === "signing" ? "Confirm in wallet..." : status === "confirming" ? "Confirming on Solana..." : (error ?? `${mode} ${what}`);
  const arrow = <ArrowRight size={13} strokeWidth={1.75} className="text-t3" />;

  const submit = async () => {
    if (error || status !== "idle") return;
    const items: Move[] = picks.map((o) => (o.max === undefined ? { positionMint: o.id } : { mint: o.id, amount: amountOf(o) }));
    const ok = await live.moveCollateral(items, deposit, setStatus);
    setStatus("idle");
    if (!ok) return;
    toast({ title: `${deposit ? "Deposited" : "Withdrew"} ${what}`, detail: `Credit limit ${usd(live.creditLimit)} to ${usd(next.creditLimit)}` });
    onClose();
  };

  return (
    <div className="px-[22px] pb-[22px] pt-[18px]">
      <div className="mb-3.5 flex items-center justify-between">
        <h3 className="text-[15px] font-medium tracking-[-0.01em]">Collateral</h3>
        <button type="button" aria-label="Close" onClick={onClose} className="cursor-pointer text-t3 transition-colors hover:text-t1">
          <X size={16} strokeWidth={1.75} />
        </button>
      </div>
      {/* Picking on the left, amounts and what they do on the right, so the list has room and nothing scrolls away */}
      <div className="grid gap-x-7 gap-y-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="min-w-0">
      <Segmented
        label="Action"
        items={["Deposit", "Withdraw"] as const}
        value={mode}
        onChange={(m) => {
          setMode(m);
          setPicked(null);
          setRaws({});
        }}
      />
      <div className="mb-2 mt-[18px] flex items-center justify-between">
        <Label>Assets</Label>
        <Label>Pick several to move them together</Label>
      </div>
      <div role="group" aria-label="Assets" className="thin-scroll -mr-3.5 grid max-h-[calc(100dvh-210px)] content-start gap-2 overflow-y-auto pr-2 [scrollbar-gutter:stable]">
        {options.map((o) => {
          const on = chosen.some((c) => c.id === o.id);
          // A pair or position that takes nothing right now is greyed out and cannot be picked, unless it was opened from its row
          const off = !!o.off && !on;
          return (
            <button
              key={o.id}
              type="button"
              role={o.dlmm ? "radio" : "checkbox"}
              aria-checked={on}
              disabled={off}
              onClick={() => toggle(o)}
              className={`flex w-full items-center gap-3 rounded-[10px] border px-3.5 py-3 text-left transition-colors ${off ? "cursor-not-allowed border-line bg-bg opacity-50" : "cursor-pointer"} ${
                on ? "border-brand/45 bg-brand/5" : off ? "" : "border-line bg-bg hover:border-line-2"
              }`}
            >
              <Token src={iconSrc(o.icon)} size={20} />
              <div>
                <div className="font-medium">{o.name}</div>
                <div className="text-xs text-t3">{o.sub}</div>
              </div>
              <span className="ml-auto font-medium">{o.right}</span>
              {o.dlmm ? (
                <span className={`ml-3 size-4 shrink-0 rounded-full transition-[border-width] duration-200 ${on ? "border-[5px] border-brand" : "border-[1.5px] border-line-2"}`} />
              ) : (
                <span className={`ml-3 grid size-4 shrink-0 place-items-center rounded-[4px] transition-colors duration-200 ${on ? "bg-brand" : "border-[1.5px] border-line-2"}`}>
                  {on && <Check size={11} strokeWidth={3} className="text-[#0c0c0c]" />}
                </span>
              )}
            </button>
          );
        })}
        {!options.length && <div className="rounded-[10px] border border-line bg-bg px-3.5 py-6 text-center text-t3">No collateral deposited yet.</div>}
      </div>
      </div>
      {/* Scrolls on its own, so a long form such as Meteora's leaves the asset list where it is */}
      <div className="thin-scroll min-w-0 md:-mr-3.5 md:max-h-[calc(100dvh-130px)] md:overflow-y-auto md:pr-2 md:[scrollbar-gutter:stable]">
      {!tokens.length && !dlmmPick && (
        <div className="grid min-h-[132px] place-items-center rounded-[10px] border border-dashed border-line px-6 text-center text-[13.5px] text-t3">
          Pick one or more assets on the left to {mode.toLowerCase()} them
        </div>
      )}
      {tokens.map((o, i) => (
        <div key={o.id}>
          <label className={`${i ? "mt-3.5 " : ""}block rounded-[10px] border border-line bg-bg px-4 py-3.5 transition-colors focus-within:border-line-2`}>
            <div className="flex items-center justify-between">
              <Label>{tokens.length > 1 ? `${o.symbol} amount` : "Amount"}</Label>
              <Label>
                {deposit ? "Available" : "Deposited"} {money(o.max!, 4)}
              </Label>
            </div>
            <div className="mt-2.5 flex items-center justify-between gap-3">
              <input
                inputMode="decimal"
                aria-label={`${mode} amount in ${o.symbol}`}
                placeholder="0.00"
                value={displayAmount(raws[o.id] ?? "")}
                onChange={(e) => {
                  const v = e.target.value.replace(/,/g, "");
                  if (/^\d*\.?\d{0,4}$/.test(v)) setRaw(o.id, v);
                }}
                className={`w-full min-w-0 bg-transparent font-medium text-t1 outline-none placeholder:text-t3 ${tokens.length > 1 ? "text-[24px] tracking-[-0.03em]" : "text-[32px] tracking-[-0.035em]"}`}
              />
              <span className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border border-line-2 bg-s3 pl-1.5 pr-2.5 font-medium">
                <Token src={iconSrc(o.icon)} size={20} />
                {o.symbol}
              </span>
            </div>
            <div className="mt-1 text-[12.5px] text-t3">{usd(amountOf(o) * (live.prices[o.id] ?? 0))}</div>
          </label>
          <div className="mt-2.5 flex gap-1.5">
            {QUICK.map((q) => (
              <button
                key={q.label}
                type="button"
                onClick={() => setRaw(o.id, (Math.floor(o.max! * q.pct * 1e4) / 1e4).toString())}
                className="flex-1 cursor-pointer rounded-md border border-line py-1.5 text-center text-xs font-medium text-t2 transition-colors hover:border-line-2 hover:text-t1"
              >
                {q.label}
              </button>
            ))}
          </div>
        </div>
      ))}
      {dlmmPick?.dlmm &&
        (!deposit && dlmmPick.dlmm.row ? (
          <DlmmExitForm key={dlmmPick.id} live={live} row={dlmmPick.dlmm.row} onClose={onClose} />
        ) : (
          <DlmmDepositForm key={dlmmPick.id} live={live} market={dlmmPick.dlmm.market} row={dlmmPick.dlmm.row} onClose={onClose} />
        ))}
      {!dlmmPick && (
        <>
          <div className="mt-[18px]">
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
        </>
      )}
      </div>
      </div>
    </div>
  );
}

/** Deposit and withdraw collateral, starting on a deposited position when one is passed in to withdraw, or a Meteora position to add to */
export function CollateralDialog({ live, open, onClose }: { live: Live; open: { withdraw?: string; add?: string } | null; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
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
            aria-label="Collateral"
            className="panel thin-scroll max-h-[calc(100dvh-32px)] w-[960px] max-w-[calc(100vw-32px)] overflow-y-auto"
            initial={{ y: 12, scale: 0.98 }}
            animate={{ y: 0, scale: 1 }}
            exit={{ y: 8, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 380, damping: 30 }}
            onClick={(e) => e.stopPropagation()}
          >
            <Form live={live} withdraw={open.withdraw} add={open.add} onClose={onClose} />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
