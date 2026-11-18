// Program events as the indexer stores them, and the rows and daily totals the web app reads
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { decodeEvents } from "../sdk/index.ts";

// One transaction as the Streams filter and the replay script deliver it
export type Tx = { signature: string; slot: number; blockTime: number | null; err: unknown; logs: string[] };

export type StoredEvent = {
  signature: string;
  // Position of the event among the transaction's Pluribus events
  index: number;
  slot: number;
  // Unix seconds
  time: number;
  name: string;
  // Addresses as base58 and integers as decimal strings
  data: Record<string, any>;
};

// The web app's `AccountEvent` plus `time`
export type Row = {
  id: string;
  date: string;
  time: number;
  kind: "draw" | "repay" | "autopay" | "interest" | "premium" | "tier" | "closed";
  amount: number;
  detail: string;
  tx: string;
  source?: "orca";
};

// JSON has no big integers or addresses
const plain = (v: unknown) => (BN.isBN(v) ? v.toString() : v instanceof PublicKey ? v.toBase58() : v);

export function toStored(tx: Tx): StoredEvent[] {
  // A failed transaction changed nothing, whatever it logged before failing
  if (tx.err) return [];
  return decodeEvents(tx.logs).map((e, index) => ({
    signature: tx.signature,
    index,
    slot: tx.slot,
    time: tx.blockTime ?? Math.floor(Date.now() / 1000),
    name: e.name,
    data: Object.fromEntries(Object.entries(e.data).map(([field, v]) => [field, plain(v)])),
  }));
}

const usdc = (units: bigint) => Number(units) / 1e6;
const short = (address: string) => `${address.slice(0, 4)}...${address.slice(-4)}`;

// A lender's `amount` is USDC and `shares` is the tranche's share token, which has USDC's decimals
export type LenderRow = {
  id: string;
  date: string;
  time: number;
  kind: "deposit" | "withdraw" | "convert" | "exit-requested" | "exit-claimed" | "exit-cancelled" | "queued" | "settled";
  tranche: "senior" | "junior";
  amount: number;
  shares: number;
  detail: string;
  tx: string;
};

const LENDER_EVENTS = new Set([
  "lendermoved",
  "trancheconverted",
  "juniorexitrequested",
  "juniorexitclaimed",
  "juniorexitcancelled",
  "seniorexitrequested",
  "seniorexitsettled",
  "seniorexitcancelled",
]);

// The lender a lending event is about, which the program names `lender` in two events and `owner` in the rest
export function lenderOf(e: StoredEvent): string | undefined {
  return LENDER_EVENTS.has(e.name.toLowerCase()) ? (e.data.lender ?? e.data.owner) : undefined;
}

// Lending rows for one address, given its events oldest first
export function lenderStatement(events: StoredEvent[], owner: string): LenderRow[] {
  const rows: LenderRow[] = [];
  for (const e of events) {
    if (lenderOf(e) !== owner) continue;
    const d = e.data;
    const row = (kind: LenderRow["kind"], tranche: LenderRow["tranche"], amount: bigint, shares: bigint, detail: string) =>
      rows.push({
        id: `${e.signature}-${e.index}`,
        date: day(e.time),
        time: e.time,
        kind,
        tranche,
        amount: usdc(amount),
        shares: usdc(shares),
        detail,
        tx: e.signature,
      });
    switch (e.name.toLowerCase()) {
      case "lendermoved":
        row(d.deposit ? "deposit" : "withdraw", d.junior ? "junior" : "senior", BigInt(d.usdc), BigInt(d.shares), d.deposit ? "USDC supplied" : "USDC withdrawn");
        break;
      case "trancheconverted":
        // The money lands in the junior tranche, so the shares shown are the junior ones it minted
        row("convert", "junior", BigInt(d.value), BigInt(d.minted), `From ${usdc(BigInt(d.shares))} sUSDC`);
        break;
      case "juniorexitrequested":
        row("exit-requested", "junior", BigInt(d.value), BigInt(d.shares), `Claimable ${day(Number(d.unlockAt))} to ${day(Number(d.deadline))}`);
        break;
      case "juniorexitclaimed":
        row("exit-claimed", "junior", BigInt(d.paid), BigInt(d.shares), `${d.inUsdc ? "Paid in USDC" : "Paid in sUSDC"}, fee ${usdc(BigInt(d.fee))}`);
        break;
      case "juniorexitcancelled":
        // The USDC worth of the returned shares is not in the event
        row("exit-cancelled", "junior", 0n, BigInt(d.returned), d.lapsed ? "Claim window lapsed" : "Cancelled");
        break;
      case "seniorexitrequested":
        row("queued", "senior", BigInt(d.value), BigInt(d.shares), `Ticket ${d.ticket}`);
        break;
      case "seniorexitsettled":
        // The queue passing a cancelled ticket pays nothing, and the cancellation already has its own row
        if (!d.cancelled) row("settled", "senior", BigInt(d.paid), BigInt(d.shares), `Ticket ${d.ticket}`);
        break;
      case "seniorexitcancelled":
        row("exit-cancelled", "senior", 0n, BigInt(d.returned), `Ticket ${d.ticket}`);
        break;
    }
  }
  return rows;
}

const day = (time: number) => new Date(time * 1000).toISOString().slice(0, 10);

// Statement rows for one credit account, given its events oldest first
export function statement(events: StoredEvent[], owner: string): Row[] {
  const rows: Row[] = [];
  // Unknown until the account is seen being opened, or until an event reports it
  let debt: bigint | null = null;
  for (const e of events) {
    const d = e.data;
    const row = (kind: Row["kind"], amount: bigint, detail: string, source?: "orca") =>
      rows.push({
        id: `${e.signature}-${e.index}${kind === "interest" ? "-interest" : ""}`,
        date: day(e.time),
        time: e.time,
        kind,
        amount: usdc(amount),
        detail,
        tx: e.signature,
        ...(source && { source }),
      });
    // Interest is never an event, so it is whatever the debt grew by beyond the event's own amount
    const settle = (after: bigint, change: bigint) => {
      if (debt !== null && after > debt + change) row("interest", after - debt - change, "Borrow index update");
      debt = after;
    };
    switch (e.name.toLowerCase()) {
      case "accountopened":
        debt = 0n;
        break;
      case "drawn":
        settle(BigInt(d.debt), BigInt(d.amount));
        row("draw", BigInt(d.amount), `To ${short(owner)}`);
        break;
      case "repaid":
        settle(BigInt(d.debt), -BigInt(d.amount));
        if (d.source === 1) row("autopay", BigInt(d.amount), "Orca LP fees", "orca");
        else row("repay", BigInt(d.amount), d.source === 2 ? "From USDC collateral" : `From ${short(d.payer)}`);
        break;
      case "liquidated":
        settle(BigInt(d.debt), -BigInt(d.repaid));
        row("repay", BigInt(d.repaid), `Liquidation by ${short(d.liquidator)}`);
        break;
      case "baddebt":
        // A write-off clears the debt, and showing it as a repayment keeps the running balance exact
        settle(0n, -BigInt(d.loss));
        row("repay", BigInt(d.loss), "Written off as bad debt");
        break;
        case "premiumbooked":
          // Booked as debt like interest, so it moves the balance the same way
          settle(BigInt(d.debt), BigInt(d.amount));
          row("premium", BigInt(d.amount), `Rate ${(d.rateBps / 100).toFixed(2)}%`);
          break;
        case "tierchanged":
          // The app counts tiers from 1
          row("tier", 0n, `Tier ${d.from + 1} to Tier ${d.to + 1}`);
          break;
        case "accountclosed":
          // Only an account with no debt can close
          debt = 0n;
          row("closed", 0n, "Account closed");
          break;
    }
  }
  return rows;
}

export type DayStats = { date: string; draws: number; repays: number; autopay: number; premium: number; liquidations: number };

// One entry per day for the 90 days ending at `now`, oldest first
export function dailyStats(events: StoredEvent[], now = Date.now() / 1000): DayStats[] {
  const days = Array.from({ length: 90 }, (_, i) => ({
    date: day(now - (89 - i) * 86_400),
    draws: 0n,
    repays: 0n,
    autopay: 0n,
    premium: 0n,
    liquidations: 0,
  }));
  const byDate = new Map(days.map((d) => [d.date, d]));
  for (const e of events) {
    const d = byDate.get(day(e.time));
    if (!d) continue;
    const name = e.name.toLowerCase();
    if (name === "drawn") d.draws += BigInt(e.data.amount);
    else if (name === "repaid") d[e.data.source === 1 ? "autopay" : "repays"] += BigInt(e.data.amount);
    else if (name === "premiumbooked") d.premium += BigInt(e.data.amount);
    else if (name === "liquidated") {
      d.repays += BigInt(e.data.repaid);
      d.liquidations += 1;
    }
  }
  return days.map((d) => ({ ...d, draws: usdc(d.draws), repays: usdc(d.repays), autopay: usdc(d.autopay), premium: usdc(d.premium) }));
}
