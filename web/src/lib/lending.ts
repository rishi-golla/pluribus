/** One lending event of a wallet, as the indexer serves it. `amount` is USDC and `shares` the tranche's share token */
export type LenderEvent = {
  id: string;
  /** ISO date, yyyy-mm-dd */
  date: string;
  /** Unix seconds */
  time: number;
  kind: "deposit" | "withdraw" | "convert" | "exit-requested" | "exit-claimed" | "exit-cancelled" | "queued" | "settled";
  tranche: "senior" | "junior";
  amount: number;
  shares: number;
  detail: string;
  tx: string;
};

/** The wallet's lending history, oldest first. Null when no indexer is configured or it did not answer */
export async function fetchLending(owner: string): Promise<LenderEvent[] | null> {
  const url = process.env.NEXT_PUBLIC_INDEXER_URL;
  if (!url) return null;
  const res = await fetch(`${url}/lenders/${owner}/events`);
  return res.ok ? res.json() : null;
}

const demo = (date: string, kind: LenderEvent["kind"], amount: number, shares: number, detail: string, tx: string): LenderEvent => ({
  id: `${date}-${kind}-${tx}`,
  date,
  time: Date.parse(`${date}T12:00:00Z`) / 1000,
  kind,
  tranche: "senior",
  amount,
  shares,
  detail,
  tx,
});

/** What the preview shows, ending on the preview's 25,000 USDC senior position */
export const DEMO_LENDING: LenderEvent[] = [
  demo("2026-09-02", "deposit", 25000, 24390.24, "USDC supplied", "4Hd8...Qm2x"),
  demo("2026-10-06", "deposit", 5000, 4833.25, "USDC supplied", "8Lw2...Tf6c"),
  demo("2026-11-03", "withdraw", 5000, 4806.77, "USDC withdrawn", "2Rn5...Yh1k"),
];
