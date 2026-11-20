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
  type Connection,
} from "@solana/web3.js";
import { CLUSTER, deployment, getConnection } from "@/lib/cluster";
import {
  BINS_PER_ARRAY,
  DLMM_PROGRAM_ID,
  KIND_DLMM,
  KIND_LP,
  WHIRLPOOL_PROGRAM_ID,
  compound,
  decodeDlmmPair,
  decodeEvents,
  decodeBinArray,
  dlmmPda,
  fetchCredit,
  getProgram,
  ix,
} from "@/lib/pluribus/sdk";

// Dollars traded each way per harvest. Fees are what the pool earns on this, so a small swap would leave almost nothing to collect
const SWAP_USD = 1_000;
// First 8 bytes of sha256("global:swap")
const SWAP = Buffer.from("f8c69e91e17587c8", "hex");
const MIN_SQRT_PRICE = BigInt("4295048016");
const MAX_SQRT_PRICE = BigInt("79226673515401279992447579055");
const TICK_ARRAY_SIZE = 88;
// First 8 bytes of sha256("global:swap"): Meteora's swap, amount in then the least out it accepts
const DLMM_SWAP = Buffer.from([248, 198, 158, 145, 225, 117, 135, 200]);

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
/**
 * Meteora's swap of `amount` in through `pairKey`, built by hand like the Whirlpool's. Selling token X moves the active bin
 * down and buying it moves it up, so the bin arrays go in the order the swap walks them, from the active one outwards
 */
async function dlmmSwap(connection: Connection, me: PublicKey, pairKey: PublicKey, inputIsX: boolean, most: bigint) {
  const pair = decodeDlmmPair(pairKey, (await connection.getAccountInfo(pairKey))!.data);
  const at = Math.floor(pair.activeId / BINS_PER_ARRAY);
  const walk = (inputIsX ? [at, at - 1, at - 2] : [at, at + 1, at + 2]).map((i) => dlmmPda.binArray(pairKey, i));
  // A swap may only be handed bin arrays that exist
  const exist = await connection.getMultipleAccountsInfo(walk);
  const arrays = walk.filter((_, i) => exist[i]);
  // A swap that runs out of liquidity in the arrays it was handed goes looking further and fails, so it takes at most half
  // of what the bins on its way hold: selling X takes the Y at and below the active bin, buying X the X at and above it
  const step = 1 + pair.binStep / 10_000;
  let room = 0;
  for (const info of exist) {
    if (!info) continue;
    const { index, amounts } = decodeBinArray(info.data);
    amounts.forEach(({ x, y }, i) => {
      const id = index * BINS_PER_ARRAY + i;
      if (inputIsX ? id <= pair.activeId : id >= pair.activeId) room += inputIsX ? y / Math.pow(step, id) : x * Math.pow(step, id);
    });
  }
  const amount = [most, BigInt(Math.floor(room / 2))].reduce((a, b) => (a < b ? a : b));
  if (amount <= BigInt(0)) return null;
  const [inAta, outAta] = [getAssociatedTokenAddressSync(inputIsX ? pair.mintX : pair.mintY, me), getAssociatedTokenAddressSync(inputIsX ? pair.mintY : pair.mintX, me)];
  const data = Buffer.alloc(24);
  DLMM_SWAP.copy(data);
  data.writeBigUInt64LE(amount, 8);
  data.writeBigUInt64LE(BigInt(0), 16);
  // Meteora takes its own program id in place of an optional account it is not given
  const none = { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false };
  const r = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: false });
  const w = (pubkey: PublicKey) => ({ pubkey, isSigner: false, isWritable: true });
  return new TransactionInstruction({
    programId: DLMM_PROGRAM_ID,
    keys: [
      w(pairKey),
      none,
      w(pair.reserveX),
      w(pair.reserveY),
      w(inAta),
      w(outAta),
      r(pair.mintX),
      r(pair.mintY),
      w(pair.oracle),
      none,
      { pubkey: me, isSigner: true, isWritable: false },
      r(TOKEN_PROGRAM_ID),
      r(TOKEN_PROGRAM_ID),
      r(dlmmPda.eventAuthority()),
      r(DLMM_PROGRAM_ID),
      ...arrays.map(w),
    ],
    data,
  });
}

export async function GET() {
  await requestTime();
  return faucet() && deployment ? Response.json({ ok: true }) : notFound();
}

/**
 * Stands in for a busy pool and a bounty hunter on a short timer: the faucet trades SWAP_USD each way through the Whirlpool,
 * which leaves trading fees in every position, then collects the fees of each LP position `owner` has deposited, taking the bounty
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
  // A position set to compound is compounded and any other autopaid, the faucet taking the bounty either way
  const held = (credit?.positions ?? []).map((p, slot) => ({ ...p, compounds: (credit?.compoundSlippageBps[slot] ?? 0) > 0 }));
  const positions = held.filter((p) => p.kind === KIND_LP);
  // Meteora positions have no NFT: the slot names the position account, which says which pair it is in
  const dlmms = held.filter((p) => p.kind === KIND_DLMM);
  if (!positions.length && !dlmms.length) return refuse("No Orca or Meteora position is deposited", 409);

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
  const wsolHeld = await connection.getTokenAccountBalance(ownerA).catch(() => null);
  const wsol = BigInt(wsolHeld?.value.amount ?? 0);

  const span = d.tickSpacing * TICK_ARRAY_SIZE;
  const arrays = (from: number, step: number) =>
    [0, 1, 2].map((i) => {
      const start = Math.floor(from / span) * span + i * step * span;
      return PublicKey.findProgramAddressSync([Buffer.from("tick_array"), whirlpool.toBuffer(), Buffer.from(String(start))], WHIRLPOOL_PROGRAM_ID)[0];
    });
  const common = { whirlpool, authority: me, ownerA, ownerB, vaultA: new PublicKey(d.whirlpoolVaultA), vaultB: new PublicKey(d.whirlpoolVaultB) };

  const trade = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(me, ownerB, me, usdc),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
    createAssociatedTokenAccountIdempotentInstruction(me, ownerA, me, NATIVE_MINT),
    ...(wsol < solNeeded ? [SystemProgram.transfer({ fromPubkey: me, toPubkey: ownerA, lamports: solNeeded * BigInt(5) }), createSyncNativeInstruction(ownerA)] : []),
    // USDC in for SOL, which raises the price, so the tick arrays run upward
    swap({ ...common, tickArrays: arrays(tick + d.tickSpacing, 1), amount: usdcIn, threshold: BigInt(0), exactIn: true, aToB: false }),
    // Then exactly the same USDC back out, which leaves the faucet's USDC where it was and pays the fees in SOL
    swap({ ...common, tickArrays: arrays(tick, -1), amount: usdcIn, threshold: wsol + solNeeded * BigInt(5), exactIn: false, aToB: true }),
  );
  // The Whirlpool is only traded for an account that holds an Orca position, and each Meteora pair it holds is traded below
  if (positions.length) {
    try {
      await sendAndConfirmTransaction(connection, trade, [signer], { commitment: "confirmed" });
    } catch (e) {
      console.error("Fast harvest swap failed", e);
      return refuse("The faucet could not trade the Orca pool, it may be out of SOL or USDC", 502);
    }
  }

  // Each Meteora pair the account holds a position in: SWAP_USD of USDC in for SOL, then that SOL straight back, which
  // leaves the pair's fees in the bins around its price and the faucet's USDC about where it was
  const dlmmPositions = await connection.getMultipleAccountsInfo(dlmms.map((p) => p.mint));
  const pairs = [...new Set(dlmmPositions.flatMap((a) => (a ? [new PublicKey(a.data.subarray(8, 40)).toBase58()] : [])))].map((k) => new PublicKey(k));
  for (const pairKey of pairs) {
    try {
      const pair = decodeDlmmPair(pairKey, (await connection.getAccountInfo(pairKey))!.data);
      const usdcIsX = pair.mintX.equals(usdc);
      const solAta = getAssociatedTokenAddressSync(usdcIsX ? pair.mintY : pair.mintX, me);
      const before = BigInt((await connection.getTokenAccountBalance(solAta).catch(() => null))?.value.amount ?? 0);
      const buy = new Transaction().add(
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }),
        createAssociatedTokenAccountIdempotentInstruction(me, ownerB, me, usdc),
        createAssociatedTokenAccountIdempotentInstruction(me, solAta, me, usdcIsX ? pair.mintY : pair.mintX),
      );
      const buySwap = await dlmmSwap(connection, me, pairKey, usdcIsX, usdcIn);
      // A pair with no liquidity next to its price has no fees to make
      if (!buySwap) continue;
      await sendAndConfirmTransaction(connection, buy.add(buySwap), [signer], { commitment: "confirmed" });
      const got = BigInt((await connection.getTokenAccountBalance(solAta)).value.amount) - before;
      const sellSwap = got > BigInt(0) ? await dlmmSwap(connection, me, pairKey, !usdcIsX, got) : null;
      if (sellSwap) await sendAndConfirmTransaction(connection, new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), sellSwap), [signer], { commitment: "confirmed" });
    } catch (e) {
      console.error("Fast harvest Meteora swap failed", e);
      return refuse("The faucet could not trade the Meteora pair, it may be out of USDC", 502);
    }
  }

  const totals = { repaid: 0, keptUsdc: 0, sol: 0 };
  const harvests = [
    ...positions.map(({ mint, compounds }) => ({ units: 400_000, build: () => (compounds ? compound.compoundOrca(program, d, me, owner, mint, me) : ix.autopay(program, d, me, owner, mint)) })),
    ...dlmms.map(({ mint, compounds }) => ({ units: 800_000, build: () => (compounds ? compound.compoundDlmm(program, d, me, owner, mint, me) : ix.dlmmAutopay(program, d, me, owner, mint, me)) })),
  ];
  for (const { units, build } of harvests) {
    // The SDK adds its own compute budget per call, replaced here by one sized for the kind of position
    const ixs = (await build()).filter((i) => !i.programId.equals(ComputeBudgetProgram.programId));
    const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units }), ...ixs);
    try {
      const signature = await sendAndConfirmTransaction(connection, tx, [signer], { commitment: "confirmed" });
      const logs = (await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 }))?.meta?.logMessages ?? [];
      for (const { name, data } of decodeEvents(logs)) {
        // compounded and autopaid carry no single amount
        const amount = data.amount === undefined ? 0 : Number(data.amount.toString());
        if (name === "repaid") totals.repaid += amount / 10 ** usdcDecimals;
        else if (name === "collateralChanged" && data.mint.toBase58() === d.usdcMint) totals.keptUsdc += amount / 10 ** usdcDecimals;
        else if (name === "collateralChanged" && data.mint.toBase58() === d.solMint) totals.sol += amount / 10 ** solDecimals;
      }
    } catch (e) {
      console.error("Fast harvest autopay failed", e);
      return refuse("The chain rejected the harvest", 502);
    }
  }
  return Response.json({ ...totals, solPrice: price, positions: positions.length + dlmms.length });
}
