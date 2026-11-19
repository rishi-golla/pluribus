"use client";

import { AnimatePresence, motion } from "motion/react";
import { Check, Info, TriangleAlert } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { WalletProvider, useWallet, type WalletContextState } from "@solana/wallet-adapter-react";
import { Keypair, PublicKey, type Signer, type TransactionInstruction, type VersionedTransaction } from "@solana/web3.js";
import { AUTOPAY_PER_MONTH, BORROW_APR, COLLATERAL_VALUE, CREDIT_LIMIT, CURRENT_DEBT, MONTHS, debtDelta, sleep, type AccountEvent, type Month } from "@/lib/account";
import { CLUSTER, deployment, getConnection } from "@/lib/cluster";
import { DemoWalletAdapter } from "@/lib/demo-wallet";
import { fetchEvents, loadLive, monthsOf, type LiveData, type DlmmMarket } from "@/lib/live";
import { MAX_U64, compound, getProgram, ix } from "@/lib/pluribus/sdk";
import { explain, sendInstructions, type Stage } from "@/lib/tx";

/* ---------- Toasts ---------- */

type Toast = { id: number; title: string; detail?: string; tone?: "success" | "info" | "error" };
const ToastCtx = createContext<(t: Omit<Toast, "id">) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

const TOAST_TONES = {
  success: { cls: "bg-green-dim text-green", icon: <Check size={18} strokeWidth={2.25} /> },
  info: { cls: "bg-brand-dim text-brand", icon: <Info size={17} strokeWidth={2} /> },
  error: { cls: "bg-red/12 text-red", icon: <TriangleAlert size={17} strokeWidth={2} /> },
};

function Toaster({ toast }: { toast: Toast | null }) {
  const tone = TOAST_TONES[toast?.tone ?? "success"];
  return (
    <div className="pointer-events-none fixed right-7 top-[108px] z-50">
      <AnimatePresence>
        {toast && (
          <motion.div
            key={toast.id}
            role="status"
            className="glass-tip pointer-events-auto flex items-center gap-3 border border-line-2 py-3 pl-3 pr-5"
            initial={{ opacity: 0, y: -12, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 380, damping: 30 }}
          >
            <span className={`grid size-9 place-items-center ${tone.cls}`}>{tone.icon}</span>
            <div>
              <div className="text-[13.5px] font-medium">{toast.title}</div>
              {toast.detail && <div className="text-[12.5px] text-t2">{toast.detail}</div>}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ---------- Account ---------- */

const TODAY = "2026-11-14";
const SENIOR_PRICE = 1.0412;
const JUNIOR_PRICE = 1.1876;
const POLL_MS = 15_000;
const MAX_SAMPLES = 240;

export type OnStage = (stage: Stage) => void;
/** One reading of the account and pool, kept for the charts while the app is open */
export type Sample = { at: number; collateral: number; limit: number; debt: number; utilization: number; apy: Record<Tranche, number>; supplied: Record<Tranche, number> };
type Tranche = "senior" | "junior";
/** What one test harvest collected, in USDC repaid, USDC kept as collateral and SOL kept as collateral */
export type Harvest = { repaid: number; keptUsdc: number; sol: number; solPrice: number };

export type Live = LiveData & {
  samples: Sample[];
  /** Whether this server can move the demo price feed */
  canSetPrice: boolean;
  /** Whether this server can hand out test tokens */
  canFund: boolean;
  /** Whether this server can trade the pool and harvest on demand, which only a local chain allows */
  canHarvest: boolean;
  /** Trades the pool once each way, then collects the fees on every deposited LP position. Null when it failed */
  harvest: () => Promise<Harvest | null>;
  /** Asks the server's faucet to fill the connected wallet, once per wallet */
  fund: () => Promise<boolean>;
  /** Deposits or withdraws a token, in whole tokens, opening the credit account on the first deposit */
  moveToken: (mint: string, amount: number, deposit: boolean, onStage: OnStage) => Promise<boolean>;
  moveLp: (positionMint: string, deposit: boolean, onStage: OnStage) => Promise<boolean>;
  /**
   * Opens a new Meteora position of `width` bins from `lowerBin` in a listed pair and puts `base` whole base tokens and `usdc`
   * USDC into it, in one transaction. "opened" means a position was opened with nothing to add, and it can be added to from
   * the collateral list
   */
  openDlmm: (pair: string, lowerBin: number, width: number, base: number, usdc: number, onStage: OnStage) => Promise<"funded" | "opened" | "failed">;
  /** Adds whole tokens to a Meteora position the account holds, spread over its range */
  addDlmm: (position: string, base: number, usdc: number, onStage: OnStage) => Promise<boolean>;
  /** Takes `bps` of a Meteora position's liquidity back to the wallet, 10000 being all of it */
  removeDlmm: (position: string, bps: number, onStage: OnStage) => Promise<boolean>;
  /** Closes an emptied Meteora position, returning its fees and rent and freeing its slot */
  closeDlmm: (position: string, onStage: OnStage) => Promise<boolean>;
  setPrice: (mint: string, price: number) => Promise<boolean>;
  /** Turns senior money into junior money, in USDC terms, with no USDC moving */
  convertToJunior: (usdcAmount: number, onStage: OnStage) => Promise<boolean>;
  /** Pays out the queued junior exit, in USDC or, when the pool's cash is lent out, in senior shares */
  claimExit: (inUsdc: boolean, onStage: OnStage) => Promise<boolean>;
  /** Puts the queued junior shares back to work */
  cancelExit: (onStage: OnStage) => Promise<boolean>;
  /** Queues senior money, in USDC terms, behind every exit already waiting, for when the pool's idle cash cannot pay it now */
  queueSeniorExit: (usdcAmount: number, onStage: OnStage) => Promise<boolean>;
  cancelSeniorExit: (ticket: number, onStage: OnStage) => Promise<boolean>;
  /** Pays the head of the senior queue, whoever it belongs to, once the pool's cash covers it */
  settleSeniorHead: (onStage: OnStage) => Promise<boolean>;
  /** Closes the credit account once it has no debt and no collateral, returning its rent */
  closeAccount: (onStage: OnStage) => Promise<boolean>;
  /**
   * Sets what a held LP or Meteora position does with its fees: compound them back into it while the pool's price is within `bps`
   * of the oracle's (up to 1000), or 0 to repay debt through autopay
   */
  setCompound: (position: string, bps: number, onStage: OnStage) => Promise<boolean>;
  /** Sends instructions the wallet alone signs, reporting a failure to the user and reading the chain again after a success */
  send: (build: () => Promise<TransactionInstruction[]>, onStage: OnStage) => Promise<boolean>;
  /** Has the wallet sign a batch of transactions in one prompt, one by one when it cannot sign a batch */
  signAll: (txs: VersionedTransaction[]) => Promise<VersionedTransaction[]>;
  /** Reads the chain again, for what changed outside the app's own transactions */
  reload: () => Promise<void>;
};

type Account = {
  /** Preview shows the demo figures, live shows the connected wallet's on-chain account */
  mode: "preview" | "live";
  /** A wallet is connecting or its account is being read for the first time */
  loading: boolean;
  /** set when a connected wallet's account could not be read, so no page shows the demo figures in its place */
  error: { title: string; detail: string; retry: boolean } | null;
  retry: () => void;
  /** ISO date, yyyy-mm-dd */
  today: string;
  debt: number;
  creditLimit: number;
  liquidationLimit: number;
  collateralValue: number;
  borrowApr: number;
  tier: string;
  autopayPerMonth: number;
  /** USDC in the pool that can be drawn right now */
  poolCash: number;
  walletUsdc: number;
  months: Month[];
  /** Sends a draw or repayment and resolves to whether it was confirmed */
  transact: (kind: "draw" | "repay", amount: number, onStage: OnStage) => Promise<boolean>;
  positions: Record<Tranche, number>;
  sharePrice: Record<Tranche, number>;
  /** Moves USDC into (positive) or out of (negative) a tranche, in USDC terms. Junior money out is only queued for exit */
  adjustPosition: (tranche: Tranche, usdcDelta: number, onStage: OnStage) => Promise<boolean>;
  /** On-chain detail that only exists in live mode */
  live: Live | null;
};

const AccountCtx = createContext<Account | null>(null);
export function useAccount() {
  const a = useContext(AccountCtx);
  if (!a) throw new Error("useAccount must be used inside <AppProviders>");
  return a;
}

const mockWait = async (onStage: OnStage) => {
  onStage("signing");
  await sleep(1100);
  onStage("confirming");
  await sleep(900);
  return true;
};

/** Whole base tokens and USDC as the pair's token X and token Y amounts in base units, whichever way round the pair has them */
function dlmmAmounts(market: DlmmMarket, base: number, quote: number): [bigint, bigint] {
  const [b, q] = [BigInt(Math.round(base * 10 ** market.baseDecimals)), BigInt(Math.round(quote * 1e6))];
  return market.baseIsX ? [b, q] : [q, b];
}

type Loaded = { owner: string; data: LiveData; events: AccountEvent[]; samples: Sample[] };

function AccountProvider({ wallet, children }: { wallet: WalletContextState | null; children: ReactNode }) {
  const toast = useToast();
  const [session, setSession] = useState<AccountEvent[]>([]);
  const [positions, setPositions] = useState({ senior: 25000, junior: 0 });
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [canSetPrice, setCanSetPrice] = useState(false);
  const [canFund, setCanFund] = useState(false);
  const [canHarvest, setCanHarvest] = useState(false);
  const [failed, setFailed] = useState<string>();
  const owner = wallet?.publicKey?.toBase58();
  const current = loaded?.owner === owner ? loaded : null;
  const loading = !!wallet?.connecting || (!!owner && !!deployment && !current && failed !== owner);
  // a connected wallet that could not be read used to fall through to the demo figures, whose buttons report success
  const error = useMemo(() => {
    if (!owner || current) return null;
    if (!deployment) return { title: `No ${CLUSTER} deployment found`, detail: "Run npm run localnet, then reload", retry: false };
    if (failed !== owner) return null;
    return {
      title: "Could not load on-chain data",
      detail: `Nothing is shown until the ${CLUSTER} RPC answers. Trying again every ${POLL_MS / 1000} seconds`,
      retry: true,
    };
  }, [owner, current, failed]);

  const refresh = useCallback(async () => {
    if (!owner || !deployment) return;
    const [data, events] = await Promise.all([loadLive(getConnection(), deployment, new PublicKey(owner)), fetchEvents(owner).catch(() => [])]);
    const { senior, junior, utilization } = data.pool;
    const sample = {
      at: Date.now(),
      collateral: data.collateralValue,
      limit: data.creditLimit,
      debt: data.debt,
      utilization,
      apy: { senior: senior.apy ?? 0, junior: junior?.apy ?? 0 },
      supplied: { senior: senior.assets, junior: junior?.assets ?? 0 },
    };
    setLoaded((prev) => ({ owner, data, events, samples: [...(prev?.owner === owner ? prev.samples : []), sample].slice(-MAX_SAMPLES) }));
  }, [owner]);

  useEffect(() => {
    if (!owner) return;
    if (!deployment) {
      toast({ title: `No ${CLUSTER} deployment found`, detail: "Run npm run localnet, then reload", tone: "error" });
      return;
    }
    let warned = false;
    const tick = () =>
      refresh().catch(() => {
        if (!warned) toast({ title: "Could not load on-chain data", detail: `Check that the ${CLUSTER} RPC is reachable`, tone: "error" });
        warned = true;
        setFailed(owner);
      });
    tick();
    const id = setInterval(tick, POLL_MS);
    return () => clearInterval(id);
  }, [owner, refresh, toast]);

  const retry = useCallback(() => {
    setFailed(undefined);
    refresh().catch(() => setFailed(owner));
  }, [owner, refresh]);

  useEffect(() => {
    if (!owner) return;
    fetch("/api/demo/price").then((r) => setCanSetPrice(r.ok));
    fetch("/api/faucet").then((r) => setCanFund(r.ok));
    fetch("/api/demo/harvest").then((r) => setCanHarvest(r.ok));
  }, [owner]);

  const account = useMemo<Account>(() => {
    if (!current || !wallet?.publicKey || !deployment) {
      const months = MONTHS.map((m) => (m.inProgress ? { ...m, events: [...m.events, ...session] } : m));
      return {
        mode: "preview",
        loading,
        error,
        retry,
        today: TODAY,
        debt: CURRENT_DEBT + session.reduce((s, e) => s + debtDelta(e), 0),
        creditLimit: CREDIT_LIMIT,
        liquidationLimit: CREDIT_LIMIT,
        collateralValue: COLLATERAL_VALUE,
        borrowApr: BORROW_APR,
        tier: "Tier 3",
        autopayPerMonth: AUTOPAY_PER_MONTH,
        poolCash: 2_004_118,
        walletUsdc: 42_180.55,
        months,
        transact: async (kind, amount, onStage) => {
          await mockWait(onStage);
          setSession((s) => [
            ...s,
            {
              id: `${TODAY}-${kind}-${s.length}`,
              date: TODAY,
              kind,
              amount,
              detail: kind === "draw" ? "To 7xKX...q9Fh" : "From 7xKX...q9Fh",
              tx: `${Math.random().toString(36).slice(2, 6)}...${Math.random().toString(36).slice(2, 6)}`,
            },
          ]);
          return true;
        },
        positions,
        sharePrice: { senior: SENIOR_PRICE, junior: JUNIOR_PRICE },
        adjustPosition: async (tranche, delta, onStage) => {
          await mockWait(onStage);
          setPositions((p) => ({ ...p, [tranche]: Math.max(0, p[tranche] + delta) }));
          return true;
        },
        live: null,
      };
    }

    const { data, events, samples } = current;
    const d = deployment;
    const me = wallet.publicKey;
    const program = getProgram(getConnection());
    const usdc = (amount: number) => BigInt(Math.round(amount * 1e6));
    const run = async (
      build: () => Promise<TransactionInstruction[]>,
      onStage: OnStage,
      // Keys the app holds, such as a position being opened, which sign next to the wallet
      signers: Signer[] = [],
      fail: (e: unknown) => void = (e) => toast({ ...explain(e), tone: "error" }),
    ) => {
      try {
        await sendInstructions(getConnection(), wallet, await build(), onStage, signers);
      } catch (e) {
        fail(e);
        return false;
      }
      await refresh().catch(() => {});
      return true;
    };
    const open = async () => (data.hasAccount ? [] : ix.openAccount(program, me));
    const tier = `Tier ${data.tier + 1}`;
    const sharePrice = { senior: data.pool.senior.sharePrice, junior: data.pool.junior?.sharePrice ?? 1 };
    const lent = { senior: data.wallet.shares.senior.amount * sharePrice.senior, junior: data.wallet.shares.junior.amount * sharePrice.junior };

    return {
      mode: "live",
      loading,
      error: null,
      retry,
      today: data.today,
      debt: data.debt,
      creditLimit: data.creditLimit,
      liquidationLimit: data.liquidationLimit,
      collateralValue: data.collateralValue,
      borrowApr: data.borrowApr,
      tier,
      autopayPerMonth: events.filter((e) => e.kind === "autopay" && e.date.startsWith(data.today.slice(0, 7))).reduce((s, e) => s + e.amount, 0),
      // Cash held back for queued senior exits cannot be drawn or withdrawn by anyone else
      poolCash: data.pool.available,
      walletUsdc: data.wallet.usdc,
      months: monthsOf(events, data.today, data.borrowApr, tier),
      // Interest accrues between this reading and the transaction, so a full repayment asks for everything owed
      // That takes slightly more USDC than the debt shown, and a wallet without the margin pays the typed amount instead
      transact: (kind, amount, onStage) =>
        run(() => {
          if (kind === "draw") return ix.draw(program, d, me, usdc(amount));
          const all = amount >= data.debt - 0.005 && data.wallet.usdc >= data.debt * 1.0001;
          return ix.repay(program, d, me, me, all ? MAX_U64 : usdc(amount));
        }, onStage),
      positions: lent,
      sharePrice,
      adjustPosition: (tranche, delta, onStage) =>
        run(() => {
          const which = { junior: tranche === "junior" };
          if (delta > 0) return ix.lendDeposit(program, d, me, usdc(delta), which);
          // Taking the whole position moves every share, so none is left behind by rounding
          const all = -delta >= lent[tranche] - 0.005;
          const shares = all ? BigInt(data.wallet.shares[tranche].raw) : usdc(-delta / sharePrice[tranche]);
            // Junior money leaves through the exit queue: this queues it, and the claim comes after the wait
          if (which.junior) return ix.requestJuniorExit(program, me, shares);
          return ix.lendWithdraw(program, d, me, shares, which);
        }, onStage),
      live: {
        ...data,
        samples,
        canSetPrice,
        canFund,
        canHarvest,
        harvest: async () => {
          const res = await fetch("/api/demo/harvest", { method: "POST", body: JSON.stringify({ address: owner }) });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) {
            toast({ title: body.error ?? "Harvest failed", detail: "Fast harvest stopped", tone: "error" });
            return null;
          }
          await refresh().catch(() => {});
          return body as Harvest;
        },
        fund: async () => {
          toast({ title: "Sending test tokens", detail: "This takes a few seconds", tone: "info" });
          const res = await fetch("/api/faucet", { method: "POST", body: JSON.stringify({ address: owner }) });
          const body = await res.json().catch(() => ({}));
          if (!res.ok) {
            toast({ title: body.error ?? "No test tokens sent", detail: "Try again in a moment", tone: "error" });
            return false;
          }
          const extras = Object.entries((body.tokens ?? {}) as Record<string, number>).map(([symbol, whole]) => `, ${whole} ${symbol}`);
          toast({ title: "Test tokens are in your wallet", detail: `${body.sol} SOL, ${body.stock} NVDAx, ${body.usdc.toLocaleString("en-US")} USDC${extras.join("")}${body.lp ? " and an Orca position" : ""}`, tone: "success" });
          await refresh().catch(() => {});
          return true;
        },
        moveToken: (mint, amount, deposit, onStage) =>
          run(async () => {
            const key = new PublicKey(mint);
            const held = data.collateral.find((c) => c.mint === mint);
            const units = BigInt(Math.round(amount * 10 ** d.assets[mint].decimals));
            // Token-2022 assets like xStocks move through their own token program
            const listed = d.assets[mint].tokenProgram;
            const tokenProgram = listed ? new PublicKey(listed) : undefined;
            if (deposit) return [...(await open()), ...(await ix.depositToken(program, me, key, units, tokenProgram))];
            // Typed amounts are rounded, so taking everything uses the exact balance and leaves no dust
            return ix.withdrawToken(program, d, me, key, held && amount >= Math.floor(held.amount * 1e4) / 1e4 ? BigInt(held.raw) : units);
          }, onStage),
        moveLp: (positionMint, deposit, onStage) =>
          run(async () => {
            const key = new PublicKey(positionMint);
            return deposit ? [...(await open()), ...(await ix.depositLp(program, d, me, key))] : ix.withdrawLp(program, d, me, key);
          }, onStage),
        openDlmm: async (pairKey, lowerBin, width, base, quote, onStage) => {
          const pair = new PublicKey(pairKey);
          const market = data.dlmm.find((m) => m.pair === pairKey);
          if (!market) {
            toast({ title: "This Meteora pair is not listed", detail: "Pick another pair", tone: "error" });
            return "failed";
          }
          // A position is a fresh account that signs its own creation, and it is opened and funded in one transaction:
          // 70 bins and a first credit account fit in about 700 bytes and 430k compute units
          const position = Keypair.generate();
          if (base <= 0 && quote <= 0) {
            const opened = await run(async () => [...(await open()), ...(await ix.dlmmOpen(program, d, me, pair, position.publicKey, lowerBin, width))], onStage, [position]);
            return opened ? "opened" : "failed";
          }
          const [x, y] = dlmmAmounts(market, base, quote);
          const funded = await run(
            async () => [...(await open()), ...(await ix.dlmmOpenAndAdd(program, d, me, pair, position.publicKey, lowerBin, width, x, y))],
            onStage,
            [position],
          );
          return funded ? "funded" : "failed";
        },
        addDlmm: (position, base, quote, onStage) =>
          run(async () => {
            const market = data.dlmm.find((m) => m.pair === data.collateral.find((c) => c.mint === position)?.dlmm?.pair);
            if (!market) throw new Error("This position's pair is not listed");
            const [x, y] = dlmmAmounts(market, base, quote);
            return ix.dlmmAdd(program, d, me, new PublicKey(position), x, y);
          }, onStage),
        removeDlmm: (position, bps, onStage) => run(() => ix.dlmmRemove(program, d, me, new PublicKey(position), bps), onStage),
        closeDlmm: (position, onStage) => run(() => ix.dlmmClose(program, d, me, new PublicKey(position)), onStage),
        setPrice: async (mint, price) => {
          const res = await fetch("/api/demo/price", { method: "POST", body: JSON.stringify({ mint, price }) });
          if (!res.ok) {
            const { error } = await res.json().catch(() => ({ error: undefined }));
            toast({ title: error ?? "Price not set", detail: "Check the price and try again", tone: "error" });
            return false;
          }
          await refresh().catch(() => {});
          return true;
        },
          convertToJunior: (amount, onStage) =>
            run(() => {
              const all = amount >= lent.senior - 0.005;
            return ix.convertToJunior(program, me, all ? BigInt(data.wallet.shares.senior.raw) : usdc(amount / sharePrice.senior));
          }, onStage),
        claimExit: (inUsdc, onStage) => run(() => ix.claimJuniorExit(program, d, me, { inUsdc }), onStage),
        cancelExit: (onStage) => run(() => ix.cancelJuniorExit(program, me, me), onStage),
        queueSeniorExit: (amount, onStage) =>
          run(() => {
            const all = amount >= lent.senior - 0.005;
            return ix.requestSeniorExit(program, me, all ? BigInt(data.wallet.shares.senior.raw) : usdc(amount / sharePrice.senior));
          }, onStage),
        cancelSeniorExit: (ticket, onStage) => run(() => ix.cancelSeniorExit(program, me, ticket), onStage),
        settleSeniorHead: (onStage) => run(() => ix.settleSeniorExit(program, d, me), onStage),
        closeAccount: (onStage) => run(() => ix.closeAccount(program, me), onStage),
          setCompound: (position, bps, onStage) => run(() => compound.setCompound(program, me, new PublicKey(position), bps), onStage),
        send: (build, onStage) => run(build, onStage),
        signAll: async (txs) => {
          if (wallet.signAllTransactions) return wallet.signAllTransactions(txs);
          if (!wallet.signTransaction) throw new Error("This wallet cannot sign transactions without sending them");
          const signed: VersionedTransaction[] = [];
          for (const tx of txs) signed.push(await wallet.signTransaction(tx));
          return signed;
        },
        reload: refresh,
      },
    };
  }, [current, wallet, loading, error, retry, session, positions, canSetPrice, canFund, canHarvest, owner, refresh, toast]);

  return <AccountCtx.Provider value={account}>{children}</AccountCtx.Provider>;
}

/** Holds a page back while the wallet's account loads, so it mounts once with on-chain figures */
export function LiveGate({ children }: { children: ReactNode }) {
  const { loading, error, retry } = useAccount();
  if (error) {
    return (
      <main className="mx-auto max-w-[1280px] px-10 pb-16 pt-9">
        <div className="panel flex h-[320px] flex-col items-center justify-center gap-2 text-center" role="alert">
          <span className="grid size-10 place-items-center bg-red/12 text-red">
            <TriangleAlert size={18} strokeWidth={2} />
          </span>
          <div className="mt-2 text-[15px] font-medium">{error.title}</div>
          <div className="text-[13.5px] text-t2">{error.detail}</div>
          {error.retry && (
            <button
              type="button"
              onClick={retry}
              className="mt-3 h-9 cursor-pointer border border-line-2 bg-s2 px-3.5 text-[13.5px] font-medium text-t1 transition-colors hover:bg-s3"
            >
              Try again now
            </button>
          )}
        </div>
      </main>
    );
  }
  if (!loading) return children;
  return (
    <main className="mx-auto max-w-[1280px] px-10 pb-16 pt-9">
      <div className="panel flex h-[320px] items-center justify-center gap-3 text-t2" role="status">
        <span className="inline-block size-4 animate-spin rounded-full border-2 border-white/15 border-t-t2" aria-hidden />
        Loading your account
      </div>
    </main>
  );
}

function WalletAccount({ children }: { children: ReactNode }) {
  return <AccountProvider wallet={useWallet()}>{children}</AccountProvider>;
}

/** App state for every dashboard, where `preview` pins the demo figures and skips wallets for the landing page frame */
export function AppProviders({ children, preview = false }: { children: ReactNode; preview?: boolean }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const wallets = useMemo(() => (process.env.NEXT_PUBLIC_DEMO_WALLET === "0" ? [] : [new DemoWalletAdapter()]), []);

  const show = useCallback((t: Omit<Toast, "id">) => {
    clearTimeout(timer.current);
    setToast({ ...t, id: Date.now() });
    timer.current = setTimeout(() => setToast(null), 4200);
  }, []);
  // A failed send is already reported where it was awaited, so only connection trouble is reported here
  const onWalletError = useCallback(
    (e: Error) => /Send|Sign/.test(e.name) || show({ title: "Wallet is not connected", detail: "Unlock it and connect again", tone: "error" }),
    [show],
  );

  return (
    <ToastCtx.Provider value={show}>
      {preview ? (
        <AccountProvider wallet={null}>{children}</AccountProvider>
      ) : (
        <WalletProvider wallets={wallets} autoConnect onError={onWalletError}>
          <WalletAccount>{children}</WalletAccount>
        </WalletProvider>
      )}
      <Toaster toast={toast} />
    </ToastCtx.Provider>
  );
}
