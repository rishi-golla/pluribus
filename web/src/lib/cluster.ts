import { Connection } from "@solana/web3.js";
import type { Deployment } from "./pluribus/sdk";

export const CLUSTER = process.env.NEXT_PUBLIC_CLUSTER === "devnet" ? "devnet" : "localnet";

// A glob instead of a static import, so the app still builds before a deployment file has been synced
const files = import.meta.glob<Deployment>("./pluribus/deployments/*.json", { eager: true, import: "default" });
export const deployment: Deployment | undefined = files[`./pluribus/deployments/${CLUSTER}.json`];

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || deployment?.rpcUrl || "http://127.0.0.1:8899";

let connection: Connection | undefined;
export const getConnection = () => (connection ??= new Connection(RPC_URL, "confirmed"));
