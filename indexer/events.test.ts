import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { type StoredEvent, dailyStats, statement, toStored } from "./events.ts";

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
  assert.deepEqual(stats[89], { date: "2026-11-15", draws: 10, repays: 0, autopay: 0, liquidations: 0 });
  assert.deepEqual(stats[88], { date: "2026-11-14", draws: 0, repays: 400, autopay: 0, liquidations: 1 });
  assert.deepEqual(stats[85], { date: "2026-11-11", draws: 0, repays: 0, autopay: 50, liquidations: 0 });
  assert.equal(stats.reduce((sum, d) => sum + d.draws, 0), 1010);
});

// A block recorded from a local validator with getBlock and jsonParsed encoding, cut down to a vote and a liquidation
const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, file), "utf8");
const { slot, block } = JSON.parse(read("fixtures/liquidation-block.json"));
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
