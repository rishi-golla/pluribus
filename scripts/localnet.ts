// Boots a local validator with Orca and Pluribus preloaded, sets everything up and keeps it running
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { DLMM_PROGRAM_ID, PROGRAM_ID, WHIRLPOOL_PROGRAM_ID } from "../sdk/index.ts";
import { args, connection, key, me, root, url, wallet } from "./orca-common.ts";

const orca = path.join(root, "programs/pluribus/tests/fixtures/orca");
const dlmm = path.join(root, "programs/pluribus/tests/fixtures/dlmm");
const port = Number(new URL(url).port);
// Every port sits in the 2000 above this, which for 8899 is the stock layout
// A chain on another RPC port then never collides with one on the default
const base = port - 899;
// Running under npm skips the shell profile that puts the Agave tools and Anchor on PATH
const home = os.homedir();
const env = {
  ...process.env,
  PATH: `${home}/.local/share/solana/install/active_release/bin:${home}/.avm/bin:${home}/.cargo/bin:${process.env.PATH}`,
};
// A dev server reads this file ahead of every other setting, so the web app follows the local chain while it is up
const webEnv = path.join(root, "web/.env.development.local");

// A fresh clone has neither binary: Orca's is too large to commit and ours is build output
if (!fs.existsSync(path.join(orca, "whirlpool.so"))) {
  console.log("Fetching the Orca Whirlpool program from devnet");
  const dump = ["program", "dump", WHIRLPOOL_PROGRAM_ID.toBase58(), path.join(orca, "whirlpool.so")];
  execFileSync("solana", [...dump, "--url", "https://api.devnet.solana.com"], { env, stdio: "inherit" });
}
// Meteora's DLMM, so the chain has a pair to list next to the whirlpool, as devnet does
// The devnet build, since mainnet's makes pairs the program will not list
if (!fs.existsSync(path.join(dlmm, "lb_clmm.so"))) {
  console.log("Fetching the Meteora DLMM program from devnet");
  const dump = ["program", "dump", DLMM_PROGRAM_ID.toBase58(), path.join(dlmm, "lb_clmm.so")];
  execFileSync("solana", [...dump, "--url", "https://api.devnet.solana.com"], { env, stdio: "inherit" });
}
if (!fs.existsSync(path.join(root, "target/deploy/pluribus.so"))) {
  console.log("Building the Pluribus program, which takes a few minutes the first time");
  // The program keypair is not in the repo, and the validator loads the binary at the declared id anyway
  execFileSync("anchor", ["build", "--ignore-keys"], { cwd: root, env, stdio: "inherit" });
}
const ledger = args.ledger ?? path.join(root, "test-ledger");
// A server keeps its chain across restarts, so users and addresses survive, and only sets it up the first time
// Written once setup finishes, so a chain whose setup failed partway is started over instead of kept half done
const ready = path.join(ledger, "pluribus-ready");
const keep = Boolean(args.keep) && fs.existsSync(ready) && fs.existsSync(path.join(root, "deployments/localnet.json"));
// Orca's devnet upgrade authority, kept so the program account matches the snapshot
const orcaAuthority = "8rHQUMS8qg4qrQriPpTbrZqk2yjLrUHSLpA6MzgMSiM";
// Meteora's devnet upgrade authority, for the same reason
const dlmmAuthority = "DHLXnJdACTY83yKwnUkeoDjqi4QBbsYGa1v8tJL76ViX";

const validator = spawn(
  "solana-test-validator",
  [
    ...(keep ? [] : ["--reset"]),
    "--quiet",
    // Hours of history instead of about a minute, for the indexer and anything else that reads past transactions
    ...["--limit-ledger-size", "2000000"],
    ...["--ledger", ledger],
    ...["--rpc-port", String(port), "--faucet-port", String(base + 1900)],
    ...["--gossip-port", String(base), "--dynamic-port-range", `${base}-${base + 2000}`],
    ...["--upgradeable-program", WHIRLPOOL_PROGRAM_ID.toBase58(), path.join(orca, "whirlpool.so"), orcaAuthority],
    ...["--account", "-", path.join(orca, "config.json"), "--account", "-", path.join(orca, "fee_tier.json")],
    // A pair can only be made from a preset Meteora published: a 10 bps one from devnet and a 1% one from mainnet,
    // which dlmm-market uses so a 70-bin position reaches 30% either side of the price
    ...["--upgradeable-program", DLMM_PROGRAM_ID.toBase58(), path.join(dlmm, "lb_clmm.so"), dlmmAuthority],
    ...["--account", "-", path.join(dlmm, "preset_bin_step_10.json")],
    ...["--account", "-", path.join(dlmm, "preset_bin_step_100.json")],
    ...["--upgradeable-program", PROGRAM_ID.toBase58(), path.join(root, "target/deploy/pluribus.so"), me.toBase58()],
  ],
  { env, stdio: "inherit" },
);
validator.on("exit", (code) => {
  console.error(`Validator exited with code ${code}`);
  process.exit(1);
});
// The web app goes back to devnet once this chain is gone
process.on("exit", () => fs.existsSync(webEnv) && fs.unlinkSync(webEnv));
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
  if (keep) console.log(`Kept the chain in ${ledger}, so setup is skipped`);
  else {
    await import("./orca-fixture.ts");
    await import("./setup.ts");
    await import("./faucet-stock.ts");
    await import("./dlmm-market.ts");
  }
  execFileSync("npm", ["run", "--silent", "sdk:sync"], { cwd: root, stdio: "inherit" });
  fs.writeFileSync(ready, `${new Date().toISOString()}\n`);
  const secret = JSON.stringify([...key("faucet").secretKey]);
  fs.writeFileSync(webEnv, `# Written by npm run localnet and removed when it stops\nNEXT_PUBLIC_LOCAL=1\nFAUCET_SECRET=${secret}\n`);
  console.log(`Ready: Pluribus localnet at ${url}, stop it with ctrl-c`);
} catch (e) {
  validator.kill();
  throw e;
}
