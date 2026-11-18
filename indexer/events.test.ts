import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { PublicKey } from "@solana/web3.js";
import { type StoredEvent, dailyStats, lenderStatement, statement, toStored } from "./events.ts";

const OWNER = "FH2AMV59rwHBVrk4JZxCm2oQBjKFt1XafePbaZgNT2B4";
const KEEPER = "ppJdRigfa8zDA5tKKnS4GPP8j9aGP5o5CXxjstQDusQ";
const FRIEND = "7PYbxSpCp5QKuLNMxQLeKibxD4xT4SJs6hfUJg2ZVHH9";
const DAY = 86_400;
const START = Date.UTC(2026, 10, 1) / 1000;

let count = 0;
const event = (day: number, name: string, data: Record<string, unknown>): StoredEvent => ({
  signature: `sig${++count}`,
  index: 0,
  slot: count,
  time: START + day * DAY,
  name,
  data,
});

const history = [
  event(0, "accountOpened", { owner: OWNER }),
  // One unit of rounding on top of the draw
  event(0, "drawn", { amount: "1000000000", debt: "1000000001" }),
  // Half a dollar of interest built up before the fees came in
  event(10, "repaid", { payer: KEEPER, amount: "50000000", debt: "950500001", source: 1 }),
  event(11, "tierChanged", { from: 0, to: 1 }),
  event(11, "repaid", { payer: FRIEND, amount: "100000000", debt: "850500001", source: 0 }),
  event(12, "repaid", { payer: OWNER, amount: "500000", debt: "850250001", source: 2 }),
  event(13, "liquidated", { liquidator: KEEPER, repaid: "400000000", seized: "1", kind: 2, debt: "450250001" }),
  event(13, "tierChanged", { from: 1, to: 0 }),
  event(13, "badDebt", { loss: "450250002", coveredByReserves: "0", coveredByProtocolFees: "0" }),
  event(14, "drawn", { amount: "10000000", debt: "10000000" }),
];

test("events become statement rows with interest derived from the debt they report", () => {
  const rows = statement(history, OWNER);
  assert.deepEqual(
    rows.map((r) => [r.date, r.kind, r.amount, r.detail]),
    [
      ["2026-11-01", "interest", 0.000001, "Borrow index update"],
      ["2026-11-01", "draw", 1000, "To FH2A...T2B4"],
      ["2026-11-11", "interest", 0.5, "Borrow index update"],
      ["2026-11-11", "autopay", 50, "Orca LP fees"],
      ["2026-11-12", "tier", 0, "Tier 1 to Tier 2"],
      ["2026-11-12", "repay", 100, "From 7PYb...VHH9"],
      ["2026-11-13", "interest", 0.25, "Borrow index update"],
      ["2026-11-13", "repay", 0.5, "From USDC collateral"],
      ["2026-11-14", "repay", 400, "Liquidation by ppJd...DusQ"],
      ["2026-11-14", "tier", 0, "Tier 2 to Tier 1"],
      ["2026-11-14", "interest", 0.000001, "Borrow index update"],
      ["2026-11-14", "repay", 450.250002, "Written off as bad debt"],
      // The write-off cleared the debt, so the next draw carries no interest
      ["2026-11-15", "draw", 10, "To FH2A...T2B4"],
    ],
  );
  assert.deepEqual(rows[3], {
    id: "sig3-0",
    date: "2026-11-11",
    time: START + 10 * DAY,
    kind: "autopay",
    amount: 50,
    detail: "Orca LP fees",
    tx: "sig3",
    source: "orca",
  });
  assert.equal(rows[2].id, "sig3-0-interest");
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
  assert.ok(rows.every((r) => r.kind === "autopay" || !("source" in r)));

  // What the web app does with the rows: the running balance ends on the debt the last event reported
  const signed = (r: (typeof rows)[number]) =>
    Math.round(r.amount * 1e6) * (r.kind === "draw" || r.kind === "interest" ? 1 : r.kind === "tier" ? 0 : -1);
  assert.equal(rows.reduce((sum, r) => sum + signed(r), 0), 10_000_000);
});

test("a history that starts after the account was opened gets no interest row for its unknown opening debt", () => {
  const rows = statement(history.slice(2, 5), OWNER);
  assert.deepEqual(
    rows.map((r) => [r.kind, r.amount]),
    [
      ["autopay", 50],
      ["tier", 0],
      ["repay", 100],
    ],
  );
});

test("daily stats cover 90 days and count liquidation repayments as repays", () => {
  const now = START + 14 * DAY + 3600;
  const stats = dailyStats([...history, event(-200, "drawn", { amount: "7000000", debt: "7000000" })], now);
  assert.equal(stats.length, 90);
  assert.equal(stats[0].date, "2026-08-18");
  assert.equal(stats[89].date, "2026-11-15");
  assert.deepEqual(stats[89], { date: "2026-11-15", draws: 10, repays: 0, autopay: 0, premium: 0, liquidations: 0 });
  assert.deepEqual(stats[88], { date: "2026-11-14", draws: 0, repays: 400, autopay: 0, premium: 0, liquidations: 1 });
  assert.deepEqual(stats[85], { date: "2026-11-11", draws: 0, repays: 0, autopay: 50, premium: 0, liquidations: 0 });
  assert.equal(stats.reduce((sum, d) => sum + d.draws, 0), 1010);
});

// A fee on the account's collateral, booked as debt, then paid off and closed
const premiumHistory = [
  event(0, "accountOpened", { owner: OWNER }),
  event(0, "drawn", { amount: "1000000000", debt: "1000000000" }),
  // A cent of interest built up before the premium came in
  event(5, "premiumBooked", { amount: "2000000", rateBps: 125, debt: "1002010000" }),
  // Half a cent more before the repayment cleared everything
  event(6, "repaid", { payer: OWNER, amount: "1002015000", debt: "0", source: 0 }),
  event(7, "accountClosed", { owner: OWNER }),
];

test("a risk premium is booked as debt like interest, and closing the account ends the statement", () => {
  const rows = statement(premiumHistory, OWNER);
  assert.deepEqual(
    rows.map((r) => [r.date, r.kind, r.amount, r.detail]),
    [
      ["2026-11-01", "draw", 1000, "To FH2A...T2B4"],
      ["2026-11-06", "interest", 0.01, "Borrow index update"],
      ["2026-11-06", "premium", 2, "Rate 1.25%"],
      ["2026-11-07", "interest", 0.005, "Borrow index update"],
      ["2026-11-07", "repay", 1002.015, "From FH2A...T2B4"],
      ["2026-11-08", "closed", 0, "Account closed"],
    ],
  );
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
  // The premium moves the balance up and closing moves nothing, so the chain ends at no debt
  const signed = (r: (typeof rows)[number]) =>
    Math.round(r.amount * 1e6) * (r.kind === "draw" || r.kind === "interest" || r.kind === "premium" ? 1 : r.kind === "tier" || r.kind === "closed" ? 0 : -1);
  assert.equal(rows.reduce((sum, r) => sum + signed(r), 0), 0);

  const stats = dailyStats(premiumHistory, START + 8 * DAY);
  assert.equal(stats[89].date, "2026-11-09");
  assert.deepEqual(stats[84], { date: "2026-11-04", draws: 0, repays: 0, autopay: 0, premium: 0, liquidations: 0 });
  assert.deepEqual(stats[85], { date: "2026-11-05", draws: 0, repays: 0, autopay: 0, premium: 0, liquidations: 0 });
  assert.deepEqual(stats[86], { date: "2026-11-06", draws: 0, repays: 0, autopay: 0, premium: 2, liquidations: 0 });
});

const lending = [
  event(0, "lenderMoved", { lender: FRIEND, usdc: "5000000000", shares: "4950000000", deposit: true, junior: false }),
  // Another lender's money and a borrower event that names the same address
  event(1, "lenderMoved", { lender: OWNER, usdc: "100000000", shares: "100000000", deposit: true, junior: true }),
  event(1, "accountOpened", { owner: FRIEND }),
  event(2, "trancheConverted", { lender: FRIEND, shares: "1000000000", value: "1010000000", minted: "900000000" }),
  event(3, "juniorExitRequested", { owner: FRIEND, shares: "400000000", value: "450000000", unlockAt: String(START + 9 * DAY), deadline: String(START + 12 * DAY) }),
  event(9, "juniorExitClaimed", { owner: FRIEND, shares: "400000000", value: "450000000", fee: "2250000", paid: "447750000", inUsdc: true }),
  event(10, "juniorExitRequested", { owner: FRIEND, shares: "100000000", value: "120000000", unlockAt: String(START + 16 * DAY), deadline: String(START + 19 * DAY) }),
  event(11, "juniorExitCancelled", { owner: FRIEND, shares: "100000000", returned: "100000000", lapsed: false }),
  event(12, "seniorExitRequested", { owner: FRIEND, ticket: "7", shares: "2000000000", value: "2050000000" }),
  // The queue passing someone's cancelled ticket pays nothing
  event(13, "seniorExitSettled", { owner: FRIEND, ticket: "6", shares: "500000000", value: "510000000", paid: "0", cancelled: true }),
  event(14, "seniorExitSettled", { owner: FRIEND, ticket: "7", shares: "2000000000", value: "2050000000", paid: "2040000000", cancelled: false }),
  event(15, "seniorExitCancelled", { owner: FRIEND, ticket: "8", shares: "1000000000", returned: "990000000" }),
  event(16, "lenderMoved", { lender: FRIEND, usdc: "100000000", shares: "98000000", deposit: false, junior: false }),
];

test("lending events become one lender's rows, in USDC and shares", () => {
  const rows = lenderStatement(lending, FRIEND);
  assert.deepEqual(
    rows.map((r) => [r.date, r.kind, r.tranche, r.amount, r.shares, r.detail]),
    [
      ["2026-11-01", "deposit", "senior", 5000, 4950, "USDC supplied"],
      ["2026-11-03", "convert", "junior", 1010, 900, "From 1000 sUSDC"],
      ["2026-11-04", "exit-requested", "junior", 450, 400, "Claimable 2026-11-10 to 2026-11-13"],
      ["2026-11-10", "exit-claimed", "junior", 447.75, 400, "Paid in USDC, fee 2.25"],
      ["2026-11-11", "exit-requested", "junior", 120, 100, "Claimable 2026-11-17 to 2026-11-20"],
      ["2026-11-12", "exit-cancelled", "junior", 0, 100, "Cancelled"],
      ["2026-11-13", "queued", "senior", 2050, 2000, "Ticket 7"],
      ["2026-11-15", "settled", "senior", 2040, 2000, "Ticket 7"],
      ["2026-11-16", "exit-cancelled", "senior", 0, 990, "Ticket 8"],
      ["2026-11-17", "withdraw", "senior", 100, 98, "USDC withdrawn"],
    ],
  );
  assert.deepEqual(rows[0], {
    id: `${lending[0].signature}-0`,
    date: "2026-11-01",
    time: START,
    kind: "deposit",
    tranche: "senior",
    amount: 5000,
    shares: 4950,
    detail: "USDC supplied",
    tx: lending[0].signature,
  });
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
  assert.deepEqual(lenderStatement(lending, OWNER).map((r) => [r.kind, r.tranche, r.amount]), [["deposit", "junior", 100]]);
  assert.deepEqual(lenderStatement(lending, KEEPER), []);
  // A queue exit paid in senior shares reports the USDC it was worth
  const [claim] = lenderStatement([event(0, "juniorExitClaimed", { owner: FRIEND, shares: "1", value: "2000000", fee: "10000", paid: "1990000", inUsdc: false })], FRIEND);
  assert.deepEqual([claim.amount, claim.detail], [1.99, "Paid in sUSDC, fee 0.01"]);
});



// A block recorded from a local validator with getBlock and jsonParsed encoding, cut down to a vote and a liquidation
const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, file), "utf8");
const { slot, block } = JSON.parse(read("fixtures/liquidation-block.json"));

// Events encoded the way the program logs them, so the stored field names and number formats are the real ones
const idl = JSON.parse(read("../sdk/idl/pluribus.json"));
const discriminator = (name: string) => Buffer.from(idl.events.find((e: { name: string }) => e.name === name).discriminator);
const u64 = (v: bigint) => {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(v);
  return out;
};
const logged = (...events: Buffer[]) => [
  `Program ${idl.address} invoke [1]`,
  ...events.map((e) => `Program data: ${e.toString("base64")}`),
  `Program ${idl.address} success`,
];

test("lending events decoded from a transaction's logs reach the lender statement", () => {
  const lender = new PublicKey(FRIEND).toBuffer();
  const stored = toStored({
    signature: "sigLogs",
    slot: 9,
    blockTime: START,
    err: null,
    logs: logged(
      Buffer.concat([discriminator("LenderMoved"), lender, u64(5_000_000_000n), u64(4_950_000_000n), Buffer.from([1, 1])]),
      Buffer.concat([discriminator("JuniorExitRequested"), lender, u64(400_000_000n), u64(450_000_000n), u64(BigInt(START + 9 * DAY)), u64(BigInt(START + 12 * DAY))]),
    ),
  });
  assert.deepEqual(stored.map((e) => [e.name, e.index]), [["lenderMoved", 0], ["juniorExitRequested", 1]]);
  assert.deepEqual([stored[0].data.lender, stored[0].data.usdc, stored[0].data.junior], [FRIEND, "5000000000", true]);
  assert.deepEqual(lenderStatement(stored, FRIEND).map((r) => [r.id, r.kind, r.tranche, r.amount, r.detail]), [
    ["sigLogs-0", "deposit", "junior", 5000, "USDC supplied"],
    ["sigLogs-1", "exit-requested", "junior", 450, "Claimable 2026-11-10 to 2026-11-13"],
  ]);
});

const filter: (stream: unknown) => any = new Function(`${read("streams-filter.js")}; return main;`)();

test("the Streams filter keeps only program transactions, and its output maps to a statement row", () => {
  const out = filter({ data: [block], metadata: { batch_start_range: slot } });
  assert.equal(out.length, 1);
  const [tx] = out;
  assert.deepEqual(Object.keys(tx), ["signature", "slot", "blockTime", "err", "logs"]);
  const [, liquidation] = block.transactions;
  assert.deepEqual([tx.signature, tx.slot, tx.blockTime, tx.err], [liquidation.transaction.signatures[0], slot, block.blockTime, null]);

  const stored = toStored(tx);
  assert.deepEqual(stored.map((e) => e.name), ["liquidated"]);
  const data = stored[0].data;
  assert.deepEqual([data.liquidator, data.kind, typeof data.repaid, typeof data.debt], [KEEPER, 1, "string", "string"]);
  const [row] = statement(stored, OWNER).filter((r) => r.kind === "repay");
  assert.deepEqual([row.amount, row.detail, row.tx], [Number(data.repaid) / 1e6, "Liquidation by ppJd...DusQ", tx.signature]);

  // Raw blocks list accounts as plain strings, and a batch of several blocks has no slot of its own per block
  const raw = structuredClone(block);
  for (const { transaction } of raw.transactions) {
    transaction.message.accountKeys = transaction.message.accountKeys.map((k: any) => k.pubkey);
  }
  const batch = filter({ data: [raw, raw], metadata: { batch_start_range: 1 } });
  assert.deepEqual(batch.map((t: any) => t.slot), [block.parentSlot + 1, block.parentSlot + 1]);

  const votesOnly = { ...block, transactions: [block.transactions[0]] };
  assert.equal(filter({ data: [votesOnly], metadata: { batch_start_range: slot } }), null);
  assert.deepEqual(toStored({ ...tx, err: { InstructionError: [2, { Custom: 6018 }] } }), []);
});
