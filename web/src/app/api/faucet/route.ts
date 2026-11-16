import { connection as requestTime } from "next/server";
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { CLUSTER, deployment, getConnection } from "@/lib/cluster";
import { listOrcaPositions } from "@/lib/pluribus/sdk";

// Whole tokens per wallet, and devnet SOL is scarce, so a grant there only covers fees and a small deposit
const GRANT = { sol: CLUSTER === "localnet" ? 10 : 0.05, stock: 50, usdc: 5_000 };

// A wallet stocked by npm run faucet:stock, which holds mock tokens and no authority over anything
function faucet() {
  const secret = process.env.FAUCET_SECRET;
  return secret ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret))) : null;
}
const notFound = () => new Response(null, { status: 404 });
const refuse = (error: string, status = 400) => Response.json({ error }, { status });

/** Tells the client whether the test token button can be shown */
export async function GET() {
  // Read the env var per request instead of freezing its build-time value into a static response
  await requestTime();
  return faucet() && deployment ? Response.json({ ok: true }) : notFound();
}

/** Sends a wallet SOL, mock stock, mock USDC and one ready-made Orca position while any are left */
export async function POST(request: Request) {
  const signer = faucet();
  if (!signer || !deployment) return notFound();

  const { address } = await request.json().catch(() => ({}));
  let to: PublicKey;
  let stockAccount: PublicKey;
  try {
    to = new PublicKey(address);
    stockAccount = getAssociatedTokenAddressSync(new PublicKey(deployment.stockMint), to);
  } catch {
    return refuse("Not a wallet address");
  }

  const connection = getConnection();
  const from = signer.publicKey;
  // One grant per wallet: this token account is created below and stays behind after its balance is deposited
  if (await connection.getAccountInfo(stockAccount)) return refuse("This wallet already has test tokens", 409);

  const ixs = [SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: Math.round(GRANT.sol * LAMPORTS_PER_SOL) })];
  for (const [address, whole] of [
    [deployment.stockMint, GRANT.stock],
    [deployment.usdcMint, GRANT.usdc],
  ] as const) {
    const mint = new PublicKey(address);
    const { decimals } = deployment.assets[address];
    const account = getAssociatedTokenAddressSync(mint, to);
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(from, account, to, mint),
      createTransferCheckedInstruction(getAssociatedTokenAddressSync(mint, from), mint, account, from, BigInt(whole * 10 ** decimals), decimals),
    );
  }
  const [position] = await listOrcaPositions(connection, deployment, from);
  if (position) {
    const { positionMint: mint, tokenProgram } = position;
    const account = getAssociatedTokenAddressSync(mint, to, false, tokenProgram);
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(from, account, to, mint, tokenProgram),
      createTransferCheckedInstruction(position.tokenAccount, mint, account, from, 1, 0, [], tokenProgram),
    );
  }

  try {
    const signature = await sendAndConfirmTransaction(connection, new Transaction().add(...ixs), [signer], { commitment: "confirmed" });
    return Response.json({ signature, ...GRANT, lp: !!position });
  } catch {
    return refuse("The faucet is out of tokens or the chain rejected the transfer", 502);
  }
}
