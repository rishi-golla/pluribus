import { Connection } from "@solana/web3.js";
import type { Deployment } from "./pluribus/sdk";

// NEXT_PUBLIC_LOCAL=1 points the app at the chain and services on this machine, which npm run localnet sets while it runs
// Without it the app uses the Mac mini's, which is what the Vercel build does
export const LOCAL = process.env.NEXT_PUBLIC_LOCAL === "1";
// Both the local chain and the Mac mini run a local validator, so devnet is only used when asked for by name
export const CLUSTER = process.env.NEXT_PUBLIC_CLUSTER === "devnet" ? "devnet" : "localnet";
export const TARGET = CLUSTER === "devnet" ? "devnet" : LOCAL ? "localnet" : "macmini";

// A glob instead of a static import, so the app still builds before a deployment file has been synced
const files = import.meta.glob<Deployment>("./pluribus/deployments/*.json", { eager: true, import: "default" });
export const deployment: Deployment | undefined = files[`./pluribus/deployments/${TARGET}.json`];

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || deployment?.rpcUrl || "http://127.0.0.1:8899";
// web3.js guesses the websocket as the RPC port plus one, which is wrong behind a proxy that serves both on one port
const WS_URL = process.env.NEXT_PUBLIC_WS_URL || deployment?.wsUrl || undefined;
export const INDEXER_URL = process.env.NEXT_PUBLIC_INDEXER_URL || deployment?.indexerUrl || (LOCAL ? "http://127.0.0.1:8787" : undefined);

let connection: Connection | undefined;
export const getConnection = () => (connection ??= new Connection(RPC_URL, { commitment: "confirmed", wsEndpoint: WS_URL }));
