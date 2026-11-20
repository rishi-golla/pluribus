// Grows the pool account to the program's current layout, right after an upgrade that appended fields to `Pool`
// Usage: ADMIN_KEYPAIR=<admin key file> RPC_URL=https://api.devnet.solana.com npx tsx scripts/migrate-pool.ts
// Safe to rerun: a pool already at size is left alone
import fs from "node:fs";
import { Connection, Keypair, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { getProgram, ix, pda } from "../sdk/index.ts";

const file = process.env.ADMIN_KEYPAIR;
const url = process.env.RPC_URL;
if (!file || !url) throw new Error("Set ADMIN_KEYPAIR to the pool admin's key file and RPC_URL to the cluster");
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
const connection = new Connection(url, "confirmed");
const program = getProgram(connection);

const before = (await connection.getAccountInfo(pda.pool()))?.data.length;
if (before === undefined) throw new Error(`No pool at ${pda.pool().toBase58()} on ${url}`);
const signature = await sendAndConfirmTransaction(connection, new Transaction().add(...(await ix.migratePool(program, admin.publicKey))), [admin], {
  commitment: "confirmed",
});
const after = (await connection.getAccountInfo(pda.pool()))!.data.length;
const pool = await program.account.pool.fetch(pda.pool());
console.log(`Pool ${pda.pool().toBase58()}: ${before} -> ${after} bytes, tx ${signature}`);
console.log(`Senior queue: head ${pool.seniorHead}, next ticket ${pool.seniorNextTicket}, reserved ${pool.seniorReserved}`);
