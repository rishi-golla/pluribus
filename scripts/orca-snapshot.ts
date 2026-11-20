import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, root, url } from "./orca-common.ts";

const dir = path.join(root, "programs/pluribus/tests/fixtures/orca");
// Running under npm skips the shell profile that puts the Agave tools on PATH
const env = {
  ...process.env,
  PATH: `${os.homedir()}/.local/share/solana/install/active_release/bin:${process.env.PATH}`,
};
const solana = (...a: string[]) =>
  execFileSync("solana", [...a, "--url", url], { env, stdio: ["ignore", "ignore", "inherit"] });

const state = await describe();
const accounts: Record<string, { toBase58(): string }> = {
  config: state.config,
  fee_tier: state.feeTier,
  whirlpool: state.whirlpool,
  token_mint_a: state.tokenA.mint,
  token_mint_b: state.tokenB.mint,
  token_vault_a: state.tokenA.vault,
  token_vault_b: state.tokenB.vault,
  wallet_token_account_a: state.tokenA.walletTokenAccount,
  wallet_token_account_b: state.tokenB.walletTokenAccount,
};
for (const t of state.tickArrays) accounts[`tick_array_${t.startTickIndex}`] = t.address;
for (const p of state.positions) {
  accounts[`${p.name}_position`] = p.position;
  accounts[`${p.name}_mint`] = p.positionMint;
  accounts[`${p.name}_token_account`] = p.ownerTokenAccount;
}

fs.mkdirSync(dir, { recursive: true });
solana("program", "dump", state.programId.toBase58(), path.join(dir, "whirlpool.so"));
const manifest = { ...state, program: "whirlpool.so", accounts: {} as Record<string, object> };
for (const [name, address] of Object.entries(accounts)) {
  const file = `${name}.json`;
  solana("account", address.toBase58(), "--output", "json", "-o", path.join(dir, file));
  manifest.accounts[name] = { address, file };
}
fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`wrote ${Object.keys(accounts).length} accounts to ${dir}`);
