import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Fetches what the Raydium tests run against: the CLMM programs the protocol accepts, too large to commit, and one fee tier
// The tests build pools and positions on those programs themselves, so no pool needs copying
const MAINNET_PROGRAM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const DEVNET_PROGRAM = "DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH";
// The 0.25% fee tier of mainnet, which spaces ticks by 60, and which is only read as data
const AMM_CONFIG = "E64NGkDLLCdQ2yFNPcavaKptrEgmiQaNykUuLC1Qgwyp";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "programs/pluribus/tests/fixtures/raydium");
const mainnet = process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const devnet = process.env.DEVNET_RPC_URL ?? "https://api.devnet.solana.com";
// Running under npm skips the shell profile that puts the Agave tools on PATH
const env = {
  ...process.env,
  PATH: `${os.homedir()}/.local/share/solana/install/active_release/bin:${process.env.PATH}`,
};
const solana = (url: string, ...a: string[]) =>
  execFileSync("solana", [...a, "--url", url], { env, cwd: dir, stdio: ["ignore", "ignore", "inherit"] });

fs.mkdirSync(dir, { recursive: true });
solana(mainnet, "program", "dump", MAINNET_PROGRAM, "raydium_clmm.so");
solana(devnet, "program", "dump", DEVNET_PROGRAM, "raydium_clmm_devnet.so");
solana(mainnet, "account", AMM_CONFIG, "--output", "json", "-o", "amm_config.json");
console.log(`wrote raydium_clmm.so, raydium_clmm_devnet.so and amm_config.json to ${dir}`);
