// Grows the pool, the assets and the credit accounts created before fields were appended to them, right after a program upgrade
// The admin pays the extra rent, and accounts the program has not grown yet fail every instruction that reads them
// Safe to rerun: an account already at the current size is left alone, and DRY_RUN=1 only counts what would grow
//   npm run migrate:accounts -- --url https://api.devnet.solana.com
import { ComputeBudgetProgram } from "@solana/web3.js";
import { PROGRAM_ID, ix, pda } from "../sdk/index.ts";
import { program, send } from "./lib.ts";
import { connection, me } from "./orca-common.ts";

const dry = process.env.DRY_RUN === "1";
// Each growth takes a few thousand compute units and about 50 bytes of transaction, so this fits one transaction with room to spare
const BATCH = 8;

const pool = await connection.getAccountInfo(pda.pool());
if (!pool) throw new Error(`No pool at ${pda.pool().toBase58()}, nothing to migrate`);
if (pool.data.length < program.account.pool.size) {
  console.log(`Pool: ${pool.data.length} -> ${program.account.pool.size} bytes${dry ? ", dry run" : ""}`);
  if (!dry) await send(await ix.migratePool(program, me));
}

// Accounts of an older layout cannot be decoded, so they are found by discriminator and measured by length
const discriminator = (name: string) => program.idl.accounts?.find((a) => a.name.toLowerCase() === name)?.discriminator;
const kinds = [
  { name: "Asset", disc: discriminator("asset"), size: program.account.asset.size },
  { name: "Credit account", disc: discriminator("creditaccount"), size: program.account.creditAccount.size },
];
const all = await connection.getProgramAccounts(PROGRAM_ID);
for (const { name, disc, size } of kinds) {
  if (!disc) throw new Error(`The IDL has no ${name} account`);
  const old = all.filter((a) => a.account.data.length < size && disc.every((b, i) => a.account.data[i] === b));
  console.log(`${name}: ${old.length} of ${all.filter((a) => disc.every((b, i) => a.account.data[i] === b)).length} below ${size} bytes${dry ? ", dry run" : ""}`);
  if (dry) continue;
  for (let i = 0; i < old.length; i += BATCH) {
    const batch = old.slice(i, i + BATCH);
    const ixs = [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })];
    for (const { pubkey } of batch) ixs.push(...(await ix.migrateAccount(program, me, pubkey)));
    await send(ixs);
    console.log(`Grew ${batch.map((a) => a.pubkey.toBase58()).join(", ")}`);
  }
}
