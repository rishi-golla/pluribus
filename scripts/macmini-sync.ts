// Copies the Mac mini's deployment into deployments/macmini.json, with the public URLs its Tailscale Funnel serves
// The web app uses that file whenever NEXT_PUBLIC_LOCAL is off, which is how Vercel builds it
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
// An ssh host, as in ~/.ssh/config
const host = process.env.MACMINI_HOST ?? "mac";
const url = (process.env.MACMINI_URL ?? "https://dylans-mac-mini.tail70e062.ts.net:10000").replace(/\/$/, "");

const raw = execFileSync("ssh", [host, "cat ubchackathon2026/deployments/localnet.json"], { encoding: "utf8" });
const d = JSON.parse(raw);
// The paths deploy/macmini/install.sh mounts each service on
d.rpcUrl = `${url}/rpc`;
d.wsUrl = `${url.replace(/^http/, "ws")}/rpc-ws`;
d.indexerUrl = `${url}/indexer`;

const out = path.join(root, "deployments/macmini.json");
fs.writeFileSync(out, `${JSON.stringify(d, null, 2)}\n`);
execFileSync("npm", ["run", "--silent", "sdk:sync"], { cwd: root, stdio: "inherit" });
console.log(`Wrote ${out} for ${url}, commit it so the next Vercel build uses it`);
