// Sets each listed asset's own liquidation bonus to the values in LIQ_BONUS_BPS (scripts/lib.ts), signed by the pool admin
// The change applies at once, cuts included, and an asset already at its values is left alone
//   npm run liq:bonus -- --url https://api.devnet.solana.com
import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

// The admin key lives only in the repo-root .env as DEMO_ADMIN_SECRET; only that variable is taken from it, and before
// lib.ts loads, since the signer is picked when the scripts' shared module loads
const envFile = path.join(import.meta.dirname, "../.env");
const secret = fs.existsSync(envFile) ? parseEnv(fs.readFileSync(envFile, "utf8")).DEMO_ADMIN_SECRET : undefined;
if (secret) process.env.DEMO_ADMIN_SECRET = secret;

const { ensureLiqBonuses, loadDeployment, program } = await import("./lib.ts");
const { me } = await import("./orca-common.ts");
const { pda } = await import("../sdk/index.ts");

const admin = (await program.account.pool.fetch(pda.pool())).admin;
if (!admin.equals(me)) throw new Error(`${me.toBase58()} is not the pool admin ${admin.toBase58()}: set DEMO_ADMIN_SECRET in .env`);
await ensureLiqBonuses(loadDeployment());
