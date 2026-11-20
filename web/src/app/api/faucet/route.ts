import { connection as requestTime } from "next/server";
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { CLUSTER, deployment, getConnection } from "@/lib/cluster";
import { listOrcaPositions } from "@/lib/pluribus/sdk";

// Whole tokens per wallet, and devnet SOL is scarce, so a grant there only covers fees and a small deposit
const GRANT = { sol: CLUSTER === "localnet" ? 10 : 0.05, stock: 50, usdc: 5_000 };
// A USDC-only grant that can be asked for again, refused while the wallet still holds this much
const USDC_TOP_UP = 50_000;
// Whole tokens of the other listed mocks, by symbol, sent only while the faucet wallet holds enough of them
const EXTRAS: Record<string, number> = { JitoSOL: 10, JupSOL: 10, AAPLx: 20, BONK: 100_000_000 };

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

/** Sends a wallet SOL, mock stock, mock USDC, the other mocks the faucet holds and one ready-made Orca position while any are left */
export async function POST(request: Request) {
  const signer = faucet();
  if (!signer || !deployment) return notFound();
  const d = deployment;

  const { address, usdc } = await request.json().catch(() => ({}));
  let to: PublicKey;
  let stockAccount: PublicKey;
  try {
    to = new PublicKey(address);
    stockAccount = getAssociatedTokenAddressSync(new PublicKey(d.stockMint), to);
  } catch {
    return refuse("Not a wallet address");
  }

  const connection = getConnection();
  const from = signer.publicKey;
  if (usdc) return topUpUsdc(signer, to);
  // One grant per wallet: this token account is created below and stays behind after its balance is deposited
  if (await connection.getAccountInfo(stockAccount)) return refuse("This wallet already has test tokens", 409);

  const extras = Object.entries(d.assets).flatMap(([mint, a]) => (EXTRAS[a.symbol] ? [{ mint, whole: EXTRAS[a.symbol] }] : []));
  // Token-2022 mocks like the xStock live under their own token program
  const programOf = (mint: string) => new PublicKey(d.assets[mint].tokenProgram ?? TOKEN_PROGRAM_ID.toBase58());
  const held = await Promise.all(
    extras.map(({ mint }) =>
      connection.getTokenAccountBalance(getAssociatedTokenAddressSync(new PublicKey(mint), from, false, programOf(mint))).then(
        (b) => Number(b.value.amount) / 10 ** b.value.decimals,
        () => 0,
      ),
    ),
  );
  // A faucet stocked before these mocks were added still hands out the rest
  const stocked = extras.filter((e, i) => held[i] >= e.whole);

  const ixs = [SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: Math.round(GRANT.sol * LAMPORTS_PER_SOL) })];
  for (const { mint: address, whole } of [{ mint: d.stockMint, whole: GRANT.stock }, { mint: d.usdcMint, whole: GRANT.usdc }, ...stocked]) {
    const mint = new PublicKey(address);
    const program = programOf(address);
    const { decimals } = d.assets[address];
    const account = getAssociatedTokenAddressSync(mint, to, false, program);
    ixs.push(
      createAssociatedTokenAccountIdempotentInstruction(from, account, to, mint, program),
      createTransferCheckedInstruction(getAssociatedTokenAddressSync(mint, from, false, program), mint, account, from, BigInt(whole * 10 ** decimals), decimals, [], program),
    );
  }
  const [position] = await listOrcaPositions(connection, d, from);
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
    const tokens = Object.fromEntries(stocked.map((e) => [d.assets[e.mint].symbol, e.whole]));
    return Response.json({ signature, ...GRANT, tokens, lp: !!position });
  } catch {
    return refuse("The faucet is out of tokens or the chain rejected the transfer", 502);
  }
}

/** Sends 50,000 mock USDC, for lending or repaying, unless the wallet already holds that much */
async function topUpUsdc(signer: Keypair, to: PublicKey) {
  const d = deployment!;
  const connection = getConnection();
  const mint = new PublicKey(d.usdcMint);
  const { decimals } = d.assets[d.usdcMint];
  const account = getAssociatedTokenAddressSync(mint, to);
  const held = await connection.getTokenAccountBalance(account).then(
    (b) => Number(b.value.amount) / 10 ** b.value.decimals,
    () => 0,
  );
  if (held >= USDC_TOP_UP) return refuse(`This wallet already holds ${USDC_TOP_UP.toLocaleString("en-US")} USDC or more`, 409);
  const ixs = [
    createAssociatedTokenAccountIdempotentInstruction(signer.publicKey, account, to, mint),
    createTransferCheckedInstruction(getAssociatedTokenAddressSync(mint, signer.publicKey), mint, account, signer.publicKey, BigInt(USDC_TOP_UP * 10 ** decimals), decimals),
  ];
  try {
    const signature = await sendAndConfirmTransaction(connection, new Transaction().add(...ixs), [signer], { commitment: "confirmed" });
    return Response.json({ signature, usdc: USDC_TOP_UP });
  } catch {
    return refuse("The faucet is out of USDC or the chain rejected the transfer", 502);
  }
}
