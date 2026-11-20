"use client";

import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PublicKey } from "@solana/web3.js";
import { useAccount, useToast, type OnStage } from "@/components/app/providers";
import { usd } from "@/lib/account";
import { deployment, getConnection } from "@/lib/cluster";
import { CONCURRENCY, MIN_BOUNTY_USD, bountyAccounts } from "@/lib/compound";
import { compound, getProgram } from "@/lib/pluribus/sdk";
import { explain } from "@/lib/tx";

type Harvestable = compound.Harvestable;
/** What the last look at the chain found: setup means the wallet has no token accounts for the bounty yet, so nothing can be checked */
export type Scan = { status: "idle" | "scanning" | "setup" | "ready" | "error"; items: Harvestable[]; at: number | null; error: string | null };

export type Compounder = {
  /** Preview shows sample figures with no wallet, live reads the chain */
  mode: "preview" | "live";
  scan: Scan;
  /** Positions whose fees are worth collecting now and what the bounty would pay the wallet for them, in dollars */
  count: number;
  usd: number;
  /** Looks again when the last look is old, for pages that show the figures */
  ensure: () => void;
  /** Looks again now, though not more than every few seconds */
  rescan: () => void;
  /** Makes the wallet's token accounts for the bounty, which looking needs */
  setup: (onStage: OnStage) => Promise<boolean>;
  /** Collects everything found, compounding or autopaying each position as its owner chose, signed with one wallet prompt */
  compoundAll: (onStage: OnStage) => Promise<boolean>;
  /** Compound all is in flight */
  working: boolean;
};

const IDLE: Scan = { status: "idle", items: [], at: null, error: null };
// Sample figures for the page with no wallet
const PREVIEW: Compounder = {
  mode: "preview",
  scan: { status: "ready", items: [], at: null, error: null },
  count: 3,
  usd: 4.62,
  ensure: () => {},
  rescan: () => {},
  setup: async () => false,
  compoundAll: async () => false,
  working: false,
};
const Ctx = createContext<Compounder>(PREVIEW);
export const useCompounder = () => useContext(Ctx);

// A look this recent is what compound all uses as is, and what a page showing the figures does not look again over
const FRESH_MS = 90_000;
const ENSURE_MS = 120_000;
const RESCAN_MS = 8_000;

const sum = (items: Harvestable[]) => items.reduce((s, i) => s + i.usd, 0);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Why a look or a batch failed, in a line */
function reason(error: string) {
  if (/429|too many requests|rate.?limit/i.test(error)) return "The RPC is rate limiting, so it waits before trying again";
  const known = explain({ message: error });
  return known.title === "Transaction failed" ? error.slice(0, 120) : known.title;
}

/** Finds the positions whose fees are worth the bounty and collects them, for the connected wallet */
export function CompounderProvider({ children }: { children: ReactNode }) {
  const { live: read, signedOut } = useAccount();
  // Signed out, the account read is an empty viewer's, which has no fees to find and no wallet to sign with
  const live = signedOut ? null : read;
  const toast = useToast();
  const owner = live?.owner ?? null;
  const liveRef = useRef(live);
  // Before any page's effects run, so a page that asks to look is answered for the wallet it shows
  useLayoutEffect(() => {
    liveRef.current = live;
  });

  const [prev, setPrev] = useState(owner);
  const [scan, setScan] = useState<Scan>(IDLE);
  const [working, setWorking] = useState(false);
  // Another wallet starts from nothing, since none of this is theirs
  if (prev !== owner) {
    setPrev(owner);
    setScan(IDLE);
    setWorking(false);
  }

  const looking = useRef<Promise<Harvestable[]> | null>(null);
  const lastLook = useRef<{ owner: string; at: number; items: Harvestable[] }>({ owner: "", at: 0, items: [] });

  /* ---------- Looking ---------- */

  const scanNow = useCallback((): Promise<Harvestable[]> => {
    if (looking.current) return looking.current;
    const l = liveRef.current;
    const d = deployment;
    if (!l || !d) return Promise.resolve([]);
    const who = l.owner;
    const me = new PublicKey(who);
    const connection = getConnection();
    // A wallet that was switched while this was reading has no use for what it found
    const put = (s: Scan) => liveRef.current?.owner === who && setScan(s);
    put({ ...IDLE, status: "scanning", items: lastLook.current.owner === who ? lastLook.current.items : [] });
    const p = (async () => {
      try {
        // The program wants the bounty's token accounts to exist, and a simulation without them finds nothing
        if ((await bountyAccounts(connection, d, me, me)).length) {
          lastLook.current = { owner: who, at: Date.now(), items: [] };
          put({ status: "setup", items: [], at: Date.now(), error: null });
          return [];
        }
        const items = await compound.findHarvestable(getProgram(connection), d, me, me, { concurrency: CONCURRENCY, minUsd: MIN_BOUNTY_USD });
        lastLook.current = { owner: who, at: Date.now(), items };
        put({ status: "ready", items, at: Date.now(), error: null });
        return items;
      } catch (e) {
        // Not remembered, so the next page to ask tries again
        lastLook.current = { owner: who, at: 0, items: [] };
        put({ status: "error", items: [], at: Date.now(), error: reason(message(e)) });
        return [];
      } finally {
        looking.current = null;
      }
    })();
    looking.current = p;
    return p;
  }, []);

  const ensure = useCallback(() => {
    const last = lastLook.current;
    if (looking.current || (last.owner === liveRef.current?.owner && Date.now() - last.at < ENSURE_MS)) return;
    void scanNow();
  }, [scanNow]);

  const rescan = useCallback(() => {
    if (looking.current || Date.now() - lastLook.current.at < RESCAN_MS) return;
    void scanNow();
  }, [scanNow]);

  const setup = useCallback(
    async (onStage: OnStage) => {
      const l = liveRef.current;
      const d = deployment;
      if (!l || !d) return false;
      const me = new PublicKey(l.owner);
      const missing = await bountyAccounts(getConnection(), d, me, me);
      if (missing.length && !(await l.send(async () => missing, onStage))) return false;
      toast({ title: "Bounty accounts are ready", detail: "Looking for positions to compound", tone: "success" });
      void scanNow();
      return true;
    },
    [scanNow, toast],
  );

  /* ---------- Compound all ---------- */

  const compoundAll = useCallback(
    async (onStage: OnStage) => {
      const l = liveRef.current;
      const d = deployment;
      if (!l || !d) return false;
      const me = new PublicKey(l.owner);
      const connection = getConnection();
      setWorking(true);
      try {
        // looking simulates each compound against the bounty's token accounts, so a wallet without them makes them first
        const accounts = await bountyAccounts(connection, d, me, me);
        if (accounts.length && !(await l.send(async () => accounts, onStage))) return false;
        const fresh = !accounts.length && lastLook.current.owner === l.owner && Date.now() - lastLook.current.at < FRESH_MS;
        const items = fresh ? lastLook.current.items : await scanNow();
        if (!items.length) {
          toast({ title: "Nothing to collect right now", detail: "A position shows up once its fees are worth the bounty", tone: "info" });
          return false;
        }
        const missing = await compound.bountyAccountSetup(connection, d, me, me, items);
        if (missing.length && !(await l.send(async () => missing, onStage))) return false;
        const packed = await compound.packHarvests(connection, d, me, items);
        // The wallet signs every batch in one prompt, and one that fails on chain leaves the others alone
        const results = await compound.sendHarvests(
          connection,
          packed,
          {
            signAllTransactions: async (txs) => {
              onStage("signing");
              const signed = await l.signAll(txs);
              onStage("confirming");
              return signed;
            },
          },
          { concurrency: CONCURRENCY },
        );
        const done = results.filter((r) => !r.error);
        const bad = results.filter((r) => r.error);
        const positions = done.reduce((s, r) => s + r.items.length, 0);
        if (!done.length) {
          toast({ title: "No compound went through", detail: reason(bad[0]?.error ?? "Transaction failed"), tone: "error" });
        } else {
          const failed = bad.reduce((s, r) => s + r.items.length, 0);
          toast({
            title: `Collected the fees of ${positions} ${positions === 1 ? "position" : "positions"}`,
            detail: `${usd(done.reduce((s, r) => s + sum(r.items), 0), 4)} of bounty${failed ? `, ${failed} left for the next try` : ""}`,
            tone: failed ? "info" : "success",
          });
        }
        await l.reload().catch(() => {});
        void scanNow();
        return !!done.length;
      } catch (e) {
        toast({ ...explain(e), tone: "error" });
        return false;
      } finally {
        setWorking(false);
      }
    },
    [scanNow, toast],
  );

  const value = useMemo<Compounder>(() => {
    if (!owner) return PREVIEW;
    return {
      mode: "live",
      scan,
      count: scan.items.length,
      usd: sum(scan.items),
      ensure,
      rescan,
      setup,
      compoundAll,
      working,
    };
  }, [owner, scan, ensure, rescan, setup, compoundAll, working]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
