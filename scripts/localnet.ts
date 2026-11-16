// Boots a local validator with Orca and Pluribus preloaded, sets everything up and keeps it running
import { execFileSync, spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { PROGRAM_ID, WHIRLPOOL_PROGRAM_ID } from "../sdk/index.ts";
import { args, connection, me, root, url, wallet } from "./orca-common.ts";

const orca = path.join(root, "programs/pluribus/tests/fixtures/orca");
const port = Number(new URL(url).port);
// Every port sits in the 2000 above this, which for 8899 is the stock layout
// A chain on another RPC port then never collides with one on the default
const base = port - 899;
// Running under npm skips the shell profile that puts the Agave tools on PATH
const env = {
  ...process.env,
  PATH: `${os.homedir()}/.local/share/solana/install/active_release/bin:${process.env.PATH}`,
};
// Orca's devnet upgrade authority, kept so the program account matches the snapshot
const orcaAuthority = "8rHQUMS8qg4qrQriPpTbrZqk2yjLrUHSLpA6MzgMSiM";

const validator = spawn(
  "solana-test-validator",
  [
    "--reset",
    "--quiet",
    // Hours of history instead of about a minute, for the indexer and anything else that reads past transactions
    ...["--limit-ledger-size", "2000000"],
    ...["--ledger", args.ledger ?? path.join(root, "test-ledger")],
    ...["--rpc-port", String(port), "--faucet-port", String(base + 1900)],
    ...["--gossip-port", String(base), "--dynamic-port-range", `${base}-${base + 2000}`],
    ...["--upgradeable-program", WHIRLPOOL_PROGRAM_ID.toBase58(), path.join(orca, "whirlpool.so"), orcaAuthority],
    ...["--account", "-", path.join(orca, "config.json"), "--account", "-", path.join(orca, "fee_tier.json")],
    ...["--upgradeable-program", PROGRAM_ID.toBase58(), path.join(root, "target/deploy/pluribus.so"), me.toBase58()],
  ],
  { env, stdio: "inherit" },
);
validator.on("exit", (code) => {
  console.error(`Validator exited with code ${code}`);
  process.exit(1);
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => validator.kill(signal));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function landed() {
  const message = new TransactionMessage({
    payerKey: me,
    recentBlockhash: (await connection.getLatestBlockhash()).blockhash,
    instructions: [SystemProgram.transfer({ fromPubkey: me, toPubkey: me, lamports: 1 })],
  });
  const tx = new VersionedTransaction(message.compileToV0Message());
  tx.sign([wallet]);
  const signature = await connection.sendTransaction(tx);
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    if ((await connection.getSignatureStatus(signature)).value?.confirmationStatus) return true;
  }
  return false;
}

try {
  // A fresh validator silently drops versioned transactions for its first seconds, and the Orca SDK sends those
  // So the chain counts as up once one has landed
  while (!(await landed().catch(() => false))) await sleep(500);
  await import("./orca-fixture.ts");
  await import("./setup.ts");
  execFileSync("npm", ["run", "--silent", "sdk:sync"], { cwd: root, stdio: "inherit" });
  console.log(`Ready: Pluribus localnet at ${url}, stop it with ctrl-c`);
} catch (e) {
  validator.kill();
  throw e;
}
