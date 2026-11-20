import type { WalletContextState } from "@solana/wallet-adapter-react";
import { Transaction, type Connection, type TransactionInstruction, type Signer } from "@solana/web3.js";
import { CLUSTER, deployment } from "./cluster";
import { buildTransaction } from "./pluribus/sdk";
import idl from "./pluribus/sdk/idl/pluribus.json";

export type Stage = "signing" | "confirming";

const NEXT_STEP: Record<string, string> = {
  ZeroAmount: "Enter a larger amount",
  Paused: "Try again once it is resumed",
  DepositCap: "Deposit a smaller amount",
  TooManyPositions: "Withdraw a position to free a slot",
  InsufficientCollateral: "Withdraw a smaller amount",
  StalePrice: "Wait for a fresh price, then try again",
  PriceTooUncertain: "Wait for a steadier price, then try again",
  ExceedsCreditLimit: "Repay debt or add collateral first",
  InsufficientLiquidity: "Try a smaller amount, or wait for repayments",
  CompoundOff: "Its owner has turned compounding off, so check again",
  CompoundOn: "Its fees are compounded instead, so autopay leaves it alone",
  PoolPriceOff: "Try again when the pool's price is back near the oracle's",
};

/** Whether a legacy transaction stays within Solana's 1232-byte packet once signed */
function fits(tx: Transaction) {
  try {
    return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length <= 1232;
  } catch {
    // web3.js throws instead of returning an oversized transaction
    return false;
  }
}

/** Sends the instructions through the wallet as one transaction and waits until it is confirmed */
export async function sendInstructions(
  connection: Connection,
  wallet: Pick<WalletContextState, "publicKey" | "sendTransaction" | "signTransaction">,
  instructions: TransactionInstruction[],
  onStage: (stage: Stage) => void,
  // Keys the app holds itself, such as the position being opened, which must sign next to the wallet
  signers: Signer[] = [],
) {
  const latest = await connection.getLatestBlockhash();
  if (!wallet.publicKey) throw new Error("Connect a wallet first");
  const legacy = new Transaction({ feePayer: wallet.publicKey, ...latest }).add(...instructions);
  // A v0 transaction through the deployment's lookup table keeps health checks over many positions within the size limit.
  // Extension wallets such as Phantom read the table from their own network before signing, and a local chain's table
  // exists nowhere else, so they refuse. On the local chain a plain transaction goes out whenever it fits
  const tx =
    deployment && !(CLUSTER === "localnet" && fits(legacy))
      ? await buildTransaction(connection, deployment, wallet.publicKey, instructions, latest.blockhash)
      : legacy;
  // These sign first, so the wallet adds its own signature to a message that no longer changes
  if (signers.length) {
    if (tx instanceof Transaction) tx.partialSign(...signers);
    else tx.sign(signers);
  }
  onStage("signing");
  // Extension wallets such as Phantom do not list a local chain among their networks, so asking them to send fails before
  // anything is signed. On the local chain the wallet only signs and the app sends the transaction itself
  const signature =
    CLUSTER === "localnet" && wallet.signTransaction
      ? await connection.sendRawTransaction((await wallet.signTransaction(tx)).serialize())
      : await wallet.sendTransaction(tx, connection);
  onStage("confirming");
  const { value } = await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  if (value.err) throw new Error(JSON.stringify(value.err));
  return signature;
}

/** A plain message for a failed transaction, using the IDL text when the program rejected it */
export function explain(e: unknown): { title: string; detail: string } {
  const err = e as { message?: string; logs?: string[]; error?: { logs?: string[] } };
  const text = [err.message, ...(err.logs ?? []), ...(err.error?.logs ?? [])].join("\n");
  const hex = text.match(/custom program error: 0x([0-9a-f]+)/i);
  const code = hex ? parseInt(hex[1], 16) : Number(text.match(/"Custom":(\d+)/)?.[1]);
  const known = idl.errors.find((x) => x.code === code);
  if (known) return { title: known.msg, detail: NEXT_STEP[known.name] ?? "Check the details and try again" };
  // SPL Token uses code 1 for a balance that is too low
  if (code === 1) return { title: "Not enough tokens in your wallet", detail: "Lower the amount and try again" };
  if (/reject|declin|denied|cancel/i.test(text)) return { title: "Request declined in the wallet", detail: "Approve it in your wallet to continue" };
  // Wallet adapter errors carry a class name and often no message, and they fail before the transaction reaches the chain
  const name = (e as { name?: string }).name ?? "";
  if (/^Wallet(Send|Sign)Transaction/.test(name) || /Blockhash not found/i.test(text)) {
    return { title: "Your wallet could not send this transaction", detail: `Check that your wallet is set to ${CLUSTER}, the network this app is using` };
  }
  return { title: "Transaction failed", detail: "Check your SOL balance for fees, then try again" };
}
