// Stores Pluribus events pushed by QuickNode Streams or the replay script and serves them to the web app
import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { PublicKey } from "@solana/web3.js";
import { pda } from "../sdk/index.ts";
import { type StoredEvent, type Tx, dailyStats, lenderOf, lenderStatement, statement, toStored } from "./events.ts";
import { sign } from "./sign.ts";

const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error(`PORT must be a port number, got "${process.env.PORT}"`);
}
const file = path.resolve(process.env.INDEXER_DATA ?? path.join(import.meta.dirname, "indexer-data/events.jsonl"));
const token = process.env.STREAMS_TOKEN;
const MAX_BODY = 64 * 1024 * 1024;
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };

const events: StoredEvent[] = [];
const seen = new Set<string>();
let lastSlot = 0;

function remember(e: StoredEvent) {
  events.push(e);
  seen.add(`${e.signature}:${e.index}`);
  lastSlot = Math.max(lastSlot, e.slot);
}

fs.mkdirSync(path.dirname(file), { recursive: true });
if (fs.existsSync(file)) {
  for (const [i, line] of fs.readFileSync(file, "utf8").split("\n").entries()) {
    if (!line) continue;
    try {
      remember(JSON.parse(line));
    } catch {
      // A crash in the middle of an append leaves half a line behind
      console.warn(`Skipped line ${i + 1} of ${file}: not valid JSON`);
    }
  }
}

// Streams may deliver the filter's result as it is or wrapped in `data`, one or many at a time
function transactions(body: any): Tx[] {
  if (Array.isArray(body)) return body.flatMap(transactions);
  if (body && typeof body === "object") {
    if (typeof body.signature === "string") {
      const ok =
        Number.isInteger(body.slot) &&
        Array.isArray(body.logs) &&
        body.logs.every((l: unknown) => typeof l === "string") &&
        (body.blockTime == null || Number.isInteger(body.blockTime));
      if (!ok) throw new Error(`Transaction ${body.signature} needs an integer slot, a blockTime and a list of log lines`);
      return [body];
    }
    if ("data" in body) return transactions(body.data);
  }
  return [];
}

function store(txs: Tx[]): number {
  const fresh = new Map<string, StoredEvent>();
  for (const tx of txs) {
    lastSlot = Math.max(lastSlot, tx.slot);
    for (const e of toStored(tx)) {
      const id = `${e.signature}:${e.index}`;
      if (!seen.has(id)) fresh.set(id, e);
    }
  }
  // Written before it is remembered, so the sender retries a failed write instead of it being lost
  if (fresh.size) fs.appendFileSync(file, [...fresh.values()].map((e) => JSON.stringify(e) + "\n").join(""));
  for (const e of fresh.values()) remember(e);
  return fresh.size;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("Body is too large");
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  return (req.headers["content-encoding"] === "gzip" ? gunzipSync(raw, { maxOutputLength: MAX_BODY }) : raw).toString("utf8");
}

function authorized(req: http.IncomingMessage, body: string): boolean {
  if (!token) return true;
  const [nonce, timestamp, signature] = ["x-qn-nonce", "x-qn-timestamp", "x-qn-signature"].map((h) => req.headers[h]);
  if (typeof nonce !== "string" || typeof timestamp !== "string" || typeof signature !== "string") return false;
  const [want, got] = [Buffer.from(sign(token, nonce, timestamp, body), "hex"), Buffer.from(signature, "hex")];
  return want.length === got.length && timingSafeEqual(want, got);
}

async function webhook(req: http.IncomingMessage): Promise<[number, unknown]> {
  let body: string;
  try {
    body = await readBody(req);
  } catch (e) {
    return [400, { error: `Could not read the body: ${(e as Error).message}` }];
  }
  if (!authorized(req, body)) return [401, { error: "Missing or wrong Streams signature" }];
  let txs: Tx[];
  try {
    txs = transactions(JSON.parse(body));
  } catch (e) {
    return [400, { error: `Bad payload: ${(e as Error).message}` }];
  }
  return [200, { ok: true, stored: store(txs) }];
}

function route(req: http.IncomingMessage): [number, unknown] | Promise<[number, unknown]> {
  const { pathname } = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "OPTIONS") return [204, undefined];
  if (req.method === "POST" && pathname === "/webhook") return webhook(req);
  if (req.method !== "GET") return [405, { error: "Method not allowed" }];
  if (pathname === "/health") return [200, { ok: true, lastSlot, events: events.length }];
  if (pathname === "/stats") return [200, dailyStats(events)];
  const [, kind, owner] = /^\/(accounts|lenders)\/([^/]+)\/events$/.exec(pathname) ?? [];
  if (!owner) return [404, { error: "Not found" }];
  let key: PublicKey;
  try {
    key = new PublicKey(owner);
  } catch {
    return [400, { error: `Not a valid address: "${owner}"` }];
  }
  // Slot order, with arrival order deciding inside a slot
  const history = (belongs: (e: StoredEvent) => boolean) => events.filter(belongs).sort((a, b) => a.slot - b.slot);
  if (kind === "lenders") {
    const lender = key.toBase58();
    return [200, lenderStatement(history((e) => lenderOf(e) === lender), lender)];
  }
  const credit = pda.credit(key).toBase58();
  return [200, statement(history((e) => e.data.account === credit), owner)];
}

const server = http.createServer(async (req, res) => {
  let [status, body]: [number, unknown] = [500, { error: "Internal error" }];
  try {
    [status, body] = await route(req);
  } catch (e) {
    console.error(`Request ${req.method} ${req.url} failed: ${(e as Error).message}`);
  }
  res.writeHead(status, { ...CORS, "content-type": "application/json" });
  res.end(body === undefined ? undefined : JSON.stringify(body));
});

server.listen(port, () => console.log(`Indexer listening on port ${port} with ${events.length} events from ${file}`));
