import { Keypair, PublicKey, type Connection, type TransactionInstruction } from "@solana/web3.js";
import { compound, type Deployment } from "./pluribus/sdk";

/** SOL the wallet puts into the auto-compound session key: transaction fees for a long time, never user funds */
export const FUND_SOL = 0.01;
/** Below this the session key is out of fees for a round and stops */
export const MIN_SESSION_SOL = 0.002;
/** Lamports one signature costs, which a transfer that empties the session key leaves behind */
export const FEE_LAMPORTS = 5_000;
/** How often the session key looks for something to compound while it runs */
export const AUTO_MS = 3 * 60_000;
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
  const items = bases.map((m) => ({ baseMint: new PublicKey(m) }) as compound.Compoundable);
  return compound.bountyAccountSetup(connection, d, payer, recipient, items);
}

/* ---------- Session key ---------- */

// One per wallet, so another wallet in the same browser never touches it
const storageKey = (owner: string) => `pluribus-compound-session:${owner}`;

/** The wallet's session key, or null when none was made */
export function loadSession(owner: string): Keypair | null {
  try {
    const saved = localStorage.getItem(storageKey(owner));
    return saved ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(saved))) : null;
  } catch {
    return null;
  }
}

/** The wallet's session key, made and saved first when it has none */
export function sessionFor(owner: string): Keypair {
  const saved = loadSession(owner);
  if (saved) return saved;
  const made = Keypair.generate();
  localStorage.setItem(storageKey(owner), JSON.stringify([...made.secretKey]));
  return made;
}

/** Drops the session key, once its SOL is back in the wallet */
export function forgetSession(owner: string) {
  localStorage.removeItem(storageKey(owner));
}
