// Feeds the indexer from plain RPC in the shape the Streams filter produces, so it works without QuickNode
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { Connection } from "@solana/web3.js";
import { PROGRAM_ID } from "../sdk/index.ts";
import { sign } from "./sign.ts";

const PAGE = 1000;
// Small enough that a public RPC's rate limit lets a batch of transaction lookups through
const BATCH = 5;
const POLL_MS = 2000;

const follow = process.argv.includes("--follow");
const webhook = `http://127.0.0.1:${process.env.PORT ?? 8787}/webhook`;
const token = process.env.STREAMS_TOKEN;

function rpcUrl(): string {
  if (process.env.RPC_URL) return process.env.RPC_URL;
  const file = path.join(import.meta.dirname, "../deployments", `${process.env.CLUSTER ?? "localnet"}.json`);
  if (!fs.existsSync(file)) throw new Error(`${file} is missing, set RPC_URL or CLUSTER`);
  return JSON.parse(fs.readFileSync(file, "utf8")).rpcUrl;
}
const connection = new Connection(rpcUrl(), "confirmed");

async function post(payload: unknown) {
  const body = JSON.stringify(payload);
  const [nonce, timestamp] = [randomUUID(), String(Math.floor(Date.now() / 1000))];
  const res = await fetch(webhook, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // Compressed and signed like a Streams delivery, so the indexer's handling of both is used
      "content-encoding": "gzip",
      ...(token && { "x-qn-nonce": nonce, "x-qn-timestamp": timestamp, "x-qn-signature": sign(token, nonce, timestamp, body) }),
    },
    body: gzipSync(body),
  }).catch((e) => {
    throw new Error(`Indexer at ${webhook} is not reachable: ${e.cause?.message ?? e.message}`);
  });
  if (!res.ok) throw new Error(`Indexer at ${webhook} answered ${res.status}: ${await res.text()}`);
}

// Public RPCs throttle hard, so a failed call is retried with a growing pause before giving up
async function patiently<T>(call: () => Promise<T>): Promise<T> {
  for (let wait = 1000; ; wait *= 2) {
    try {
      return await call();
    } catch (e) {
      if (wait > 32_000) throw e;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

// Sends every program transaction newer than `newest` and returns the latest signature sent
async function replay(newest?: string): Promise<string | undefined> {
  const found = [];
  for (let before: string | undefined; ; ) {
    const page = await patiently(() => connection.getSignaturesForAddress(PROGRAM_ID, { before, until: newest, limit: PAGE }));
    found.push(...page);
    if (page.length < PAGE) break;
    before = page[page.length - 1].signature;
  }
  // The RPC lists newest first
  found.reverse();
  for (let i = 0; i < found.length; i += BATCH) {
    const batch = found.slice(i, i + BATCH);
    const txs = await Promise.all(
      batch.map((s) => patiently(() => connection.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 }))),
    );
    await post(
      batch.map(({ signature, slot, blockTime, err }, j) => {
        const tx = txs[j];
        if (!tx) throw new Error(`The RPC has no transaction for signature ${signature}`);
        return { signature, slot, blockTime: tx.blockTime ?? blockTime ?? null, err, logs: tx.meta?.logMessages ?? [] };
      }),
    );
  }
  if (found.length) console.log(`Replayed ${found.length} transactions up to slot ${found[found.length - 1].slot}`);
  return found.length ? found[found.length - 1].signature : newest;
}

let newest = await replay();
while (follow) {
  await new Promise((r) => setTimeout(r, POLL_MS));
  // An RPC or indexer hiccup must not end a long-running follow
  newest = await replay(newest).catch((e) => (console.error(`Replay failed, retrying: ${e.message}`), newest));
}
