"use client";

import { AnimatePresence, motion } from "motion/react";
import { Check, Info } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { CURRENT_DEBT, MONTHS, debtDelta, type AccountEvent, type Month } from "@/lib/account";

/* ---------- Toasts ---------- */

type Toast = { id: number; title: string; detail?: string; tone?: "success" | "info" };
const ToastCtx = createContext<(t: Omit<Toast, "id">) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

function Toaster({ toast }: { toast: Toast | null }) {
  return (
    <div className="pointer-events-none fixed right-7 top-[80px] z-50">
      <AnimatePresence>
        {toast && (
          <motion.div
            key={toast.id}
            role="status"
            className="glass-tip pointer-events-auto flex items-center gap-3 rounded-2xl border border-line-2 py-3 pl-3 pr-5"
            initial={{ opacity: 0, y: -12, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 380, damping: 30 }}
          >
            <span className={`grid size-9 place-items-center rounded-xl ${toast.tone === "info" ? "bg-brand-dim text-brand" : "bg-green-dim text-green"}`}>
              {toast.tone === "info" ? <Info size={17} strokeWidth={2} /> : <Check size={18} strokeWidth={2.25} />}
            </span>
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

type Account = {
  debt: number;
  months: Month[];
  /** Records a confirmed draw or repayment for today. */
  record: (kind: "draw" | "repay", amount: number) => void;
  positions: { senior: number; junior: number };
  sharePrice: { senior: number; junior: number };
  /** Moves USDC into (positive) or out of (negative) a tranche, in USDC terms. */
  adjustPosition: (tranche: "senior" | "junior", usdcDelta: number) => void;
};

const AccountCtx = createContext<Account | null>(null);
export function useAccount() {
  const a = useContext(AccountCtx);
  if (!a) throw new Error("useAccount must be used inside <AppProviders>");
  return a;
}

export function AppProviders({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<AccountEvent[]>([]);
  const [positions, setPositions] = useState({ senior: 25000, junior: 0 });
  const [toast, setToast] = useState<Toast | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const show = useCallback((t: Omit<Toast, "id">) => {
    clearTimeout(timer.current);
    setToast({ ...t, id: Date.now() });
    timer.current = setTimeout(() => setToast(null), 4200);
  }, []);

  const account = useMemo<Account>(() => {
    const months = MONTHS.map((m) => (m.inProgress ? { ...m, events: [...m.events, ...session] } : m));
    return {
      debt: CURRENT_DEBT + session.reduce((s, e) => s + debtDelta(e), 0),
      months,
      record: (kind, amount) =>
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
        ]),
      positions,
      sharePrice: { senior: SENIOR_PRICE, junior: JUNIOR_PRICE },
      adjustPosition: (tranche, delta) => setPositions((p) => ({ ...p, [tranche]: Math.max(0, p[tranche] + delta) })),
    };
  }, [session, positions]);

  return (
    <ToastCtx.Provider value={show}>
      <AccountCtx.Provider value={account}>
        {children}
        <Toaster toast={toast} />
      </AccountCtx.Provider>
    </ToastCtx.Provider>
  );
}
