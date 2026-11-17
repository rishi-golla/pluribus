import { connection as requestTime } from "next/server";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { CLUSTER, deployment, getConnection } from "@/lib/cluster";
import { KIND_LP, WHIRLPOOL_PROGRAM_ID, decodeEvents, fetchCredit, getProgram, ix } from "@/lib/pluribus/sdk";

// Dollars traded each way per harvest. Fees are what the pool earns on this, so a small swap would leave almost nothing to collect
const SWAP_USD = 1_000;
// First 8 bytes of sha256("global:swap")
const SWAP = Buffer.from("f8c69e91e17587c8", "hex");
const MIN_SQRT_PRICE = BigInt("4295048016");
const MAX_SQRT_PRICE = BigInt("79226673515401279992447579055");
const TICK_ARRAY_SIZE = 88;

// Test only: it spends the faucet's SOL on swap fees every second, which devnet cannot spare
function faucet() {
  const secret = process.env.FAUCET_SECRET;
  return CLUSTER === "localnet" && secret ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret))) : null;
}
const notFound = () => new Response(null, { status: 404 });
const refuse = (error: string, status = 400) => Response.json({ error }, { status });

const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
};
const u128 = (n: bigint) => Buffer.concat([u64(n & ((BigInt(1) << BigInt(64)) - BigInt(1))), u64(n >> BigInt(64))]);

/** Whirlpool's own swap, built by hand because the web app does not ship the Orca SDK */
function swap(o: {
  whirlpool: PublicKey;
  authority: PublicKey;
  ownerA: PublicKey;
  ownerB: PublicKey;
  vaultA: PublicKey;
  vaultB: PublicKey;
  tickArrays: PublicKey[];
  amount: bigint;
  threshold: bigint;
  exactIn: boolean;
  aToB: boolean;
}) {
  const [oracle] = PublicKey.findProgramAddressSync([Buffer.from("oracle"), o.whirlpool.toBuffer()], WHIRLPOOL_PROGRAM_ID);
  const w = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
  return new TransactionInstruction({
    programId: WHIRLPOOL_PROGRAM_ID,
    keys: [
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: o.authority, isSigner: true, isWritable: false },
      w(o.whirlpool),
      w(o.ownerA),
      w(o.vaultA),
      w(o.ownerB),
      w(o.vaultB),
      ...o.tickArrays.map(w),
      w(oracle),
    ],
    data: Buffer.concat([
      SWAP,
      u64(o.amount),
      u64(o.threshold),
      u128(o.aToB ? MIN_SQRT_PRICE : MAX_SQRT_PRICE),
      Buffer.from([o.exactIn ? 1 : 0, o.aToB ? 1 : 0]),
    ]),
  });
}

/** Tells the client whether the fast harvest button can be shown */
export async function GET() {
  await requestTime();
  return faucet() && deployment ? Response.json({ ok: true }) : notFound();
}

/**
 * Stands in for a busy pool and a keeper on a short timer: the faucet trades SWAP_USD each way through the Whirlpool,
 * which leaves trading fees in every position, then runs the permissionless autopay on each LP position `owner` has deposited
 */
export async function POST(request: Request) {
  const signer = faucet();
  if (!signer || !deployment) return notFound();
  const d = deployment;

  const { address } = await request.json().catch(() => ({}));
  let owner: PublicKey;
  try {
    owner = new PublicKey(address);
  } catch {
    return refuse("Not a wallet address");
  }

  const connection = getConnection();
  const program = getProgram(connection);
  const credit = await fetchCredit(program, owner);
  const lps = (credit?.positions ?? []).filter((p) => p.kind === KIND_LP).map((p) => p.mint);
  if (!lps.length) return refuse("No LP position is deposited", 409);

  const whirlpool = new PublicKey(d.whirlpool);
  const info = await connection.getAccountInfo(whirlpool);
  if (!info) return refuse("The Whirlpool is missing", 502);
  // Whirlpool layout: sqrt_price at byte 65 and tick_current_index at byte 81
  const sqrtPrice = info.data.readBigUInt64LE(65) + (info.data.readBigUInt64LE(73) << BigInt(64));
  const tick = info.data.readInt32LE(81);
  const solDecimals = d.assets[d.solMint].decimals;
  const usdcDecimals = d.assets[d.usdcMint].decimals;
  const price = (Number(sqrtPrice) / 2 ** 64) ** 2 * 10 ** (solDecimals - usdcDecimals);

  const me = signer.publicKey;
  const usdc = new PublicKey(d.usdcMint);
  const ownerA = getAssociatedTokenAddressSync(NATIVE_MINT, me);
  const ownerB = getAssociatedTokenAddressSync(usdc, me);
  const usdcIn = BigInt(SWAP_USD * 10 ** usdcDecimals);
  // Buying the USDC back costs a little more SOL than selling it gave, so the faucet keeps some wSOL on hand
  const solNeeded = BigInt(Math.ceil((2 * SWAP_USD * 10 ** solDecimals) / price));
  const held = await connection.getTokenAccountBalance(ownerA).catch(() => null);
  const wsol = BigInt(held?.value.amount ?? 0);

  const span = d.tickSpacing * TICK_ARRAY_SIZE;
  const arrays = (from: number, step: number) =>
    [0, 1, 2].map((i) => {
      const start = Math.floor(from / span) * span + i * step * span;
      return PublicKey.findProgramAddressSync([Buffer.from("tick_array"), whirlpool.toBuffer(), Buffer.from(String(start))], WHIRLPOOL_PROGRAM_ID)[0];
    });
  const common = { whirlpool, authority: me, ownerA, ownerB, vaultA: new PublicKey(d.whirlpoolVaultA), vaultB: new PublicKey(d.whirlpoolVaultB) };

  const trade = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    createAssociatedTokenAccountIdempotentInstruction(me, ownerA, me, NATIVE_MINT),
    ...(wsol < solNeeded ? [SystemProgram.transfer({ fromPubkey: me, toPubkey: ownerA, lamports: solNeeded * BigInt(5) }), createSyncNativeInstruction(ownerA)] : []),
    // USDC in for SOL, which raises the price, so the tick arrays run upward
    swap({ ...common, tickArrays: arrays(tick + d.tickSpacing, 1), amount: usdcIn, threshold: BigInt(0), exactIn: true, aToB: false }),
    // Then exactly the same USDC back out, which leaves the faucet's USDC where it was and pays the fees in SOL
    swap({ ...common, tickArrays: arrays(tick, -1), amount: usdcIn, threshold: wsol + solNeeded * BigInt(5), exactIn: false, aToB: true }),
  );
  try {
    await sendAndConfirmTransaction(connection, trade, [signer], { commitment: "confirmed" });
  } catch (e) {
    console.error("Fast harvest swap failed", e);
    return refuse("The faucet could not trade the pool, it may be out of SOL or USDC", 502);
  }

  const totals = { repaid: 0, keptUsdc: 0, sol: 0 };
  for (const mint of lps) {
    // The SDK adds its own compute budget per call, and one autopay fits the default anyway
    const ixs = (await ix.autopay(program, d, me, owner, mint)).filter((i) => !i.programId.equals(ComputeBudgetProgram.programId));
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ...ixs);
    try {
      const signature = await sendAndConfirmTransaction(connection, tx, [signer], { commitment: "confirmed" });
      const logs = (await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }))?.meta?.logMessages ?? [];
      for (const { name, data } of decodeEvents(logs)) {
        const amount = Number(data.amount.toString());
        if (name === "repaid") totals.repaid += amount / 10 ** usdcDecimals;
        else if (name === "collateralChanged" && data.mint.toBase58() === d.usdcMint) totals.keptUsdc += amount / 10 ** usdcDecimals;
        else if (name === "collateralChanged" && data.mint.toBase58() === d.solMint) totals.sol += amount / 10 ** solDecimals;
      }
    } catch (e) {
      console.error("Fast harvest autopay failed", e);
      return refuse("The chain rejected the harvest", 502);
    }
  }
  return Response.json({ ...totals, solPrice: price, positions: lps.length });
}
