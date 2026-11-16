import { Connection } from "@solana/web3.js";
import type { Deployment } from "./pluribus/sdk";

// Devnet unless told otherwise, so a fresh clone runs against the live deployment with no setup
// npm run localnet switches a dev server to the local chain for as long as it runs
export const CLUSTER = process.env.NEXT_PUBLIC_CLUSTER === "localnet" ? "localnet" : "devnet";

// A glob instead of a static import, so the app still builds before a deployment file has been synced
const files = import.meta.glob<Deployment>("./pluribus/deployments/*.json", { eager: true, import: "default" });
export const deployment: Deployment | undefined = files[`./pluribus/deployments/${CLUSTER}.json`];

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || deployment?.rpcUrl || "http://127.0.0.1:8899";

let connection: Connection | undefined;
export const getConnection = () => (connection ??= new Connection(RPC_URL, "confirmed"));
