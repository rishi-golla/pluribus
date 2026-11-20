"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PublicKey, SystemProgram, type Keypair } from "@solana/web3.js";
import { useAccount, useToast, type OnStage } from "@/components/app/providers";
import { usd } from "@/lib/account";
import { deployment, getConnection } from "@/lib/cluster";
import { AUTO_MS, CONCURRENCY, FEE_LAMPORTS, FUND_SOL, MIN_BOUNTY_USD, MIN_SESSION_SOL, bountyAccounts, forgetSession, loadSession, sessionFor } from "@/lib/compound";
import { compound, getProgram } from "@/lib/pluribus/sdk";
import { explain, sendAsKeypair } from "@/lib/tx";

type Harvestable = compound.Harvestable;
export type CompoundLog = { id: number; at: number; tone: "ok" | "info" | "error"; text: string };
export type CompoundTotals = { rounds: number; batches: number; positions: number; failed: number; usd: number };
/** What the last look at the chain found: setup means the wallet has no token accounts for the bounty yet, so nothing can be checked */
export type Scan = { status: "idle" | "scanning" | "setup" | "ready" | "error"; items: Harvestable[]; at: number | null; error: string | null };

export type Auto = {
  /** Whether the session key is looking for positions every few minutes */
  running: boolean;
  /** A round is looking or sending right now, which can outlast a stop by a moment */
  busy: boolean;
  /** The session key's address and SOL, once it has been made */
  address: string | null;
  sol: number | null;
  /** Newest first */
  log: CompoundLog[];
  totals: CompoundTotals;
  /** Funds the session key with one wallet prompt when it has too little SOL, then starts looking */
  start: (onStage: OnStage) => Promise<boolean>;
  stop: () => void;
  /** Stops, then sends the session key's SOL back to the wallet and forgets the key */
  returnSol: () => Promise<boolean>;
  returning: boolean;
};

export type Compounder = {
  /** Preview shows sample figures with no wallet, live reads the chain */
  mode: "preview" | "live";
  scan: Scan;
  /** Positions that can be compounded now and what the bounty would pay the wallet for them, in dollars */
  count: number;
  usd: number;
  /** Looks again when the last look is old, for pages that show the figures */
  ensure: () => void;
  /** Looks again now, though not more than every few seconds */
  rescan: () => void;
  /** Makes the wallet's token accounts for the bounty, which looking needs */
  setup: (onStage: OnStage) => Promise<boolean>;
  /** Compounds everything found, signed with one wallet prompt */
  compoundAll: (onStage: OnStage) => Promise<boolean>;
  /** Compound all is in flight */
  working: boolean;
  auto: Auto;
};

const IDLE: Scan = { status: "idle", items: [], at: null, error: null };
const NO_TOTALS: CompoundTotals = { rounds: 0, batches: 0, positions: 0, failed: 0, usd: 0 };
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
  auto: { running: false, busy: false, address: null, sol: null, log: [], totals: NO_TOTALS, start: async () => false, stop: () => {}, returnSol: async () => false, returning: false },
};
const Ctx = createContext<Compounder>(PREVIEW);
export const useCompounder = () => useContext(Ctx);

// A look this recent is what compound all uses as is, and what a page showing the figures does not look again over
const FRESH_MS = 90_000;
const ENSURE_MS = 120_000;
const RESCAN_MS = 8_000;
const MAX_LOG = 40;

const sum = (items: Harvestable[]) => items.reduce((s, i) => s + i.usd, 0);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Why a look or a batch failed, in a line */
function reason(error: string) {
  if (/429|too many requests|rate.?limit/i.test(error)) return "The RPC is rate limiting, so it waits before trying again";
  const known = explain({ message: error });
  return known.title === "Transaction failed" ? error.slice(0, 120) : known.title;
}

/** Looks for positions to compound and compounds them, for one wallet at a time, for as long as the app is open */
export function CompounderProvider({ children }: { children: ReactNode }) {
  const { live } = useAccount();
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
  const [session, setSession] = useState<{ address: string; sol: number | null } | null>(null);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [returning, setReturning] = useState(false);
  const [log, setLog] = useState<CompoundLog[]>([]);
  const [totals, setTotals] = useState(NO_TOTALS);
  // Another wallet starts from nothing, since none of this is theirs
  if (prev !== owner) {
    setPrev(owner);
    setScan(IDLE);
    setWorking(false);
    setSession(null);
    setRunning(false);
    setBusy(false);
    setLog([]);
    setTotals(NO_TOTALS);
  }

  const looking = useRef<Promise<Harvestable[]> | null>(null);
  const lastLook = useRef<{ owner: string; at: number; items: Harvestable[] }>({ owner: "", at: 0, items: [] });
  const stopped = useRef(true);
  const wake = useRef<(() => void) | null>(null);
  const loopDone = useRef<Promise<void> | null>(null);
  const logId = useRef(0);
  const note = useCallback((tone: CompoundLog["tone"], text: string) => {
    setLog((l) => [{ id: ++logId.current, at: Date.now(), tone, text }, ...l].slice(0, MAX_LOG));
  }, []);

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

  /* ---------- Auto-compound ---------- */

  const stop = useCallback(() => {
    stopped.current = true;
    setRunning(false);
    wake.current?.();
  }, []);
  // A wallet switch or leaving the app ends the loop, since it signs for nobody else
  useEffect(() => stop, [owner, stop]);

  /** One round of looking, packing and sending, signed by the session key with the bounty going to the wallet. Whether it worked */
  const round = useCallback(
    async (kp: Keypair, me: PublicKey) => {
      const d = deployment;
      if (!d) return false;
      const connection = getConnection();
      try {
        const lamports = await connection.getBalance(kp.publicKey);
        setSession((s) => s && { ...s, sol: lamports / 1e9 });
        if (lamports / 1e9 < MIN_SESSION_SOL) {
          note("error", `The session key is down to ${(lamports / 1e9).toFixed(4)} SOL, too little for fees. Stopped, top it up to continue`);
          stop();
          return true;
        }
        const found = await compound.findHarvestable(getProgram(connection), d, kp.publicKey, me, { concurrency: CONCURRENCY, minUsd: MIN_BOUNTY_USD });
        setTotals((t) => ({ ...t, rounds: t.rounds + 1 }));
        if (stopped.current) return true;
        if (!found.length) {
          note("info", "Nothing worth compounding");
          return true;
        }
        note("info", `${found.length} ${found.length === 1 ? "position" : "positions"} to compound, about ${usd(sum(found), 4)} of bounty`);
        // The session key pays for any token account the bounty needs and the wallet owns it
        const missing = await compound.bountyAccountSetup(connection, d, kp.publicKey, me, found);
        if (missing.length) await sendAsKeypair(connection, kp, missing);
        const packed = await compound.packHarvests(connection, d, kp.publicKey, found);
        const results = await compound.sendHarvests(connection, packed, { keypair: kp }, { concurrency: CONCURRENCY });
        for (const r of results) {
          const n = `${r.items.length} ${r.items.length === 1 ? "position" : "positions"}`;
          if (r.error) {
            note("error", `A batch of ${n} failed: ${reason(r.error)}`);
            setTotals((t) => ({ ...t, failed: t.failed + r.items.length }));
          } else {
            note("ok", `Collected ${n}, ${usd(sum(r.items), 4)} of bounty`);
            setTotals((t) => ({ ...t, batches: t.batches + 1, positions: t.positions + r.items.length, usd: t.usd + sum(r.items) }));
          }
        }
        const after = await connection.getBalance(kp.publicKey).catch(() => null);
        if (after !== null) setSession((s) => s && { ...s, sol: after / 1e9 });
        await liveRef.current?.reload().catch(() => {});
        return true;
      } catch (e) {
        note("error", reason(message(e)));
        return false;
      }
    },
    [note, stop],
  );

  const loop = useCallback(
    async (kp: Keypair, me: PublicKey) => {
      let failures = 0;
      while (!stopped.current) {
        setBusy(true);
        const ok = await round(kp, me);
        setBusy(false);
        failures = ok ? 0 : failures + 1;
        if (stopped.current) break;
        // Waits longer after each failed round, up to four times as long, so a struggling RPC is not hammered
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, AUTO_MS * 2 ** Math.min(failures, 2));
          wake.current = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake.current = null;
      }
    },
    [round],
  );

  const start = useCallback(
    async (onStage: OnStage) => {
      const l = liveRef.current;
      // Already running, or a round from the last run is still finishing
      if (!l || !deployment || !stopped.current || loopDone.current) return false;
      const me = new PublicKey(l.owner);
      const connection = getConnection();
      const kp = sessionFor(l.owner);
      try {
        let lamports = await connection.getBalance(kp.publicKey);
        setSession({ address: kp.publicKey.toBase58(), sol: lamports / 1e9 });
        if (lamports / 1e9 < MIN_SESSION_SOL) {
          const funded = await l.send(async () => [SystemProgram.transfer({ fromPubkey: me, toPubkey: kp.publicKey, lamports: Math.round(FUND_SOL * 1e9) })], onStage);
          if (!funded) return false;
          lamports = await connection.getBalance(kp.publicKey);
          setSession({ address: kp.publicKey.toBase58(), sol: lamports / 1e9 });
        }
      } catch (e) {
        toast({ title: "Could not start auto-compound", detail: reason(message(e)), tone: "error" });
        return false;
      }
      stopped.current = false;
      setRunning(true);
      note("info", `Started, looking every ${AUTO_MS / 60_000} minutes while this tab is open`);
      const done = loop(kp, me).finally(() => {
        if (loopDone.current === done) loopDone.current = null;
      });
      loopDone.current = done;
      return true;
    },
    [loop, note, toast],
  );

  const returnSol = useCallback(async () => {
    const l = liveRef.current;
    if (!l) return false;
    const kp = loadSession(l.owner);
    if (!kp) return true;
    stop();
    setReturning(true);
    try {
      // A round in flight signs with this key, so it finishes first
      await loopDone.current?.catch(() => {});
      const connection = getConnection();
      const lamports = (await connection.getBalance(kp.publicKey)) - FEE_LAMPORTS;
      if (lamports > 0) await sendAsKeypair(connection, kp, [SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: new PublicKey(l.owner), lamports })]);
      forgetSession(l.owner);
      setSession(null);
      note("info", lamports > 0 ? `Sent ${(lamports / 1e9).toFixed(4)} SOL back to your wallet` : "The session key had nothing left");
      toast({ title: lamports > 0 ? "SOL is back in your wallet" : "Session key cleared", detail: lamports > 0 ? `${(lamports / 1e9).toFixed(4)} SOL returned` : "It had nothing left to return", tone: "success" });
      await l.reload().catch(() => {});
      return true;
    } catch (e) {
      toast({ title: "Could not return the SOL", detail: reason(message(e)), tone: "error" });
      return false;
    } finally {
      setReturning(false);
    }
  }, [note, stop, toast]);

  // A session key from an earlier visit is still in storage, and its SOL can be returned or put to work again
  useEffect(() => {
    if (!owner) return;
    const kp = loadSession(owner);
    if (!kp) return;
    let active = true;
    const address = kp.publicKey.toBase58();
    getConnection()
      .getBalance(kp.publicKey)
      .then(
        (lamports) => active && setSession((s) => s ?? { address, sol: lamports / 1e9 }),
        () => active && setSession((s) => s ?? { address, sol: null }),
      );
    return () => {
      active = false;
    };
  }, [owner]);

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
      auto: { running, busy, address: session?.address ?? null, sol: session?.sol ?? null, log, totals, start, stop, returnSol, returning },
    };
  }, [owner, scan, ensure, rescan, setup, compoundAll, working, running, busy, session, log, totals, start, stop, returnSol, returning]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
