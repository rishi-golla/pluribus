import { PublicKey, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { compound, type Deployment } from "./pluribus/sdk";

/** The least bounty, in dollars, worth a transaction */
export const MIN_BOUNTY_USD = 0.01;
/** The RPC does the heavy lifting here, so simulations and sends go a couple at a time */
export const CONCURRENCY = 2;

export const MAX_TOLERANCE_BPS = compound.MAX_COMPOUND_SLIPPAGE_BPS;
/** Tolerances offered as one tap, in bps */
export const TOLERANCES = [50, 100, 200] as const;

/** 100 bps as "1%", and 50 as "0.5%" */
export const percent = (bps: number) => `${+(bps / 100).toFixed(2)}%`;

/**
 * The instructions that make the token accounts a bounty is paid into, for the base token of every market and USDC. The program
 * wants them to exist before it compounds, and the SDK only simulates against accounts that do, so they come first
 */
export async function bountyAccounts(connection: Connection, d: Deployment, payer: PublicKey, recipient: PublicKey): Promise<TransactionInstruction[]> {
  const bases = [d.solMint, ...(d.lpMarkets ?? []).map((m) => m.baseMint)];
  // The SDK only reads each item's base token, so a bare one stands in for a compoundable position
  const items = bases.map((m) => ({ baseMint: new PublicKey(m) }) as compound.Harvestable);
  return compound.bountyAccountSetup(connection, d, payer, recipient, items);
}

