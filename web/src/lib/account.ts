/** Demo account and protocol figures, taken from ARCHITECTURE.pdf examples. */
export const CREDIT_LIMIT = 31294;
export const CURRENT_DEBT = 14500;
export const BORROW_APR = 0.096;
export const AUTOPAY_PER_MONTH = 212.4;
export const COLLATERAL_VALUE = 48230;

export const money = (v: number, decimals = 2) => v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
export const usd = (v: number, decimals = 2) => `$${money(v, decimals)}`;
/** Health is the liquidation limit over the debt, so liquidation starts at 1, and debt that rounds to no cents counts as none */
export const healthOf = (debt: number, limit: number) => (debt >= 0.005 ? limit / debt : Infinity);
export const healthTone = (h: number) => (h >= 1.5 ? "text-green" : h >= 1.2 ? "text-orange" : "text-red");
/** Position (0-100) on the 1.00 / 1.50 / 2.00 / 3.00+ health scale, which is piecewise linear. */
export const healthPos = (h: number) => (h <= 1 ? 0 : h <= 2 ? ((h - 1) / 0.5) * 33.333 : Math.min(100, 66.667 + (h - 2) * 33.333));
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const shortKey = (key: string) => `${key.slice(0, 4)}...${key.slice(-4)}`;

/** Shows a raw numeric input string with thousands separators, keeping whatever decimals were typed. */
export const displayAmount = (raw: string) => {
  const [int, dec] = raw.split(".");
  const grouped = (int || "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return dec !== undefined ? `${grouped}.${dec}` : grouped;
};

export type EventKind = "draw" | "repay" | "autopay" | "interest" | "premium" | "tier" | "closed";
export type AccountEvent = {
  id: string;
  /** ISO date, yyyy-mm-dd */
  date: string;
  kind: EventKind;
  /** Always positive; direction comes from `kind`. */
  amount: number;
  detail: string;
  source?: "orca" | "raydium";
  tx: string;
};

/** Signed effect on debt. */
export const debtDelta = (e: AccountEvent) =>
  e.kind === "draw" || e.kind === "interest" || e.kind === "premium" ? e.amount : e.kind === "tier" || e.kind === "closed" ? 0 : -e.amount;

const ev = (date: string, kind: EventKind, amount: number, detail: string, tx: string, source?: AccountEvent["source"]): AccountEvent => ({
  id: `${date}-${kind}-${tx}`,
  date,
  kind,
  amount,
  detail,
  source,
  tx,
});

const WALLET = "7xKX...q9Fh";

export type Month = { key: string; label: string; short: string; avgApr: number; tier: string; inProgress?: boolean; events: AccountEvent[] };

/** Oldest first. Totals for October match the approved statement mockup. */
export const MONTHS: Month[] = [
  {
    key: "2026-08",
    label: "August 2026",
    short: "Aug",
    avgApr: 0.1042,
    tier: "Tier 2",
    events: [
      ev("2026-08-06", "draw", 2000, `To ${WALLET}`, "7Qe1...Bn4d"),
      ev("2026-08-12", "repay", 96.1, `From ${WALLET}`, "2Vy8...Lp0s"),
      ev("2026-08-15", "interest", 34.9, "Borrow index update", "9Ka3...Uw7e"),
      ev("2026-08-22", "repay", 104.6, `From ${WALLET}`, "4Rt6...Hm2x"),
      ev("2026-08-31", "interest", 35.3, "Borrow index update", "6Pz0...Cc5r"),
    ],
  },
  {
    key: "2026-09",
    label: "September 2026",
    short: "Sep",
    avgApr: 0.0998,
    tier: "Tier 2",
    events: [
      ev("2026-09-05", "draw", 1500, `To ${WALLET}`, "3Hd9...Ya1k"),
      ev("2026-09-09", "repay", 132.4, `From ${WALLET}`, "8Lm2...Qe6t"),
      ev("2026-09-10", "interest", 38.2, "Borrow index update", "1Wc7...Rn3p"),
      ev("2026-09-18", "repay", 600, `From ${WALLET}`, "5Gx4...Td8v"),
      ev("2026-09-21", "repay", 118.9, `From ${WALLET}`, "0Bs5...Kf2m"),
      ev("2026-09-24", "interest", 38.6, "Borrow index update", "7Nj1...Zp9a"),
      ev("2026-09-28", "repay", 125.3, `From ${WALLET}`, "2Ur8...Mx4c"),
      ev("2026-09-30", "interest", 38.8, "Borrow index update", "9Dk6...Ve0b"),
    ],
  },
  {
    key: "2026-10",
    label: "October 2026",
    short: "Oct",
    avgApr: 0.0971,
    tier: "Tier 3",
    events: [
      ev("2026-10-03", "draw", 1500, `To ${WALLET}`, "1fGh...Jd5K"),
      ev("2026-10-07", "repay", 166.5, `From ${WALLET}`, "4cBu...Rw9Z"),
      ev("2026-10-08", "interest", 40.4, "Borrow index update", "3Tq9...Wb6n"),
      ev("2026-10-11", "tier", 0, "Tier 2 to Tier 3, -0.40% APR", "6pYe...Hn3S"),
      ev("2026-10-12", "repay", 200, `From ${WALLET}`, "5Mv1...Yc8q"),
      ev("2026-10-15", "repay", 1000, `From ${WALLET}`, "8vNa...Lx4D"),
      ev("2026-10-16", "interest", 40.4, "Borrow index update", "0Xe4...Gs2h"),
      ev("2026-10-19", "repay", 97.3, `From ${WALLET}`, "2qRs...Tm8c"),
      ev("2026-10-22", "draw", 2500, `To ${WALLET}`, "9mWd...Ke2P"),
      ev("2026-10-24", "interest", 40.4, "Borrow index update", "7Rb2...Np5u"),
      ev("2026-10-26", "repay", 850, `From ${WALLET}`, "1Kc8...Fq3j"),
      ev("2026-10-28", "repay", 148.6, `From ${WALLET}`, "3kLp...Vb71"),
      ev("2026-10-31", "interest", 41.2, "Borrow index update", "5Ht2...9aQe"),
    ],
  },
  {
    key: "2026-11",
    label: "November 2026",
    short: "Nov",
    avgApr: 0.096,
    tier: "Tier 3",
    inProgress: true,
    events: [
      ev("2026-11-02", "draw", 172, `To ${WALLET}`, "6Fa3...Pe1w"),
      ev("2026-11-04", "repay", 71.2, `From ${WALLET}`, "8Jw7...Ld4s"),
      ev("2026-11-08", "interest", 40.4, "Borrow index update", "2Ym5...Cx8r"),
      ev("2026-11-09", "repay", 88, `From ${WALLET}`, "4Qn0...Hb6t"),
      ev("2026-11-13", "repay", 53.2, `From ${WALLET}`, "0Vs9...Ke3m"),
    ],
  },
];

export type MonthSummary = {
  opening: number;
  draws: number;
  interest: number;
  repayments: number;
  autopay: number;
  closing: number;
  /** Newest first, with the balance after each event. */
  rows: (AccountEvent & { balance: number })[];
};

/** Openings are derived backwards from today's debt so every month chains exactly. The risk premium is booked as debt like interest, so it counts in the interest total. */
export function summarize(months: Month[], currentDebt: number): Record<string, MonthSummary> {
  const out: Record<string, MonthSummary> = {};
  let closing = currentDebt;
  for (let m = months.length - 1; m >= 0; m--) {
    const events = [...months[m].events].sort((a, b) => a.date.localeCompare(b.date));
    const sum = (k: EventKind) => events.filter((e) => e.kind === k).reduce((s, e) => s + e.amount, 0);
    const opening = closing - events.reduce((s, e) => s + debtDelta(e), 0);
    let bal = opening;
    const rows = events.map((e) => ({ ...e, balance: (bal += debtDelta(e)) }));
    out[months[m].key] = { opening, draws: sum("draw"), interest: sum("interest") + sum("premium"), repayments: sum("repay"), autopay: sum("autopay"), closing, rows: rows.reverse() };
    closing = opening;
  }
  return out;
}
