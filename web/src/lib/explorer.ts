import { CLUSTER, RPC_URL } from "@/lib/cluster";

export const explorer = (tx: string) => `https://explorer.solana.com/tx/${tx}?cluster=${CLUSTER === "devnet" ? "devnet" : `custom&customUrl=${encodeURIComponent(RPC_URL)}`}`;

// Indexed events carry the whole signature, the demo ones a shortened one that links nowhere
export const isSignature = (tx: string) => tx.length > 40;
