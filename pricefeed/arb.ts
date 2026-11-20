// Trades a local chain's own SOL/USDC pools toward SOL's oracle price, as an arbitrage bot would on a real chain
// Nobody else trades a localnet, so without this its Orca whirlpool and Meteora pair would stay at the price setup opened
// them at, and a range centred on the oracle price would sit wholly on one side of the pool. The admin funds the trades:
// it mints the mock USDC and, on a local chain, airdrops itself SOL
import anchor from "@coral-xyz/anchor";
import { Percentage } from "@orca-so/common-sdk";
import {
  IGNORE_CACHE,
  PDAUtil,
  PriceMath,
  SwapUtils,
  TICK_ARRAY_SIZE,
  TickUtil,
  TokenExtensionUtil,
  WhirlpoolContext,
  WhirlpoolIx,
  buildWhirlpoolClient,
  swapQuoteWithParams,
  toTx,
} from "@orca-so/whirlpools-sdk";
import {
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  type Connection,
  type Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import Decimal from "decimal.js";
import { BINS_PER_ARRAY, DLMM_PROGRAM_ID, type Deployment, binArrayIndexes, binForPrice, decodeBinArray, decodeDlmmPair, dlmmPda } from "../sdk/index.ts";

// First 8 bytes of sha256("global:swap"): Meteora's swap, amount in then the least out it accepts
const DLMM_SWAP = Buffer.from([248, 198, 158, 145, 225, 117, 135, 200]);
// The most either side is asked for in one trade, in whole tokens, far beyond what a demo pool holds
const MAX_SOL = 5_000;

type Log = (line: string) => void;

export function makeArb(connection: Connection, d: Deployment, admin: Keypair, log: Log) {
  const me = admin.publicKey;
  const usdc = new PublicKey(d.usdcMint);
  const [ataSol, ataUsdc] = [getAssociatedTokenAddressSync(NATIVE_MINT, me), getAssociatedTokenAddressSync(usdc, me)];
  const ctx = WhirlpoolContext.from(connection, new anchor.Wallet(admin));
  const client = buildWhirlpoolClient(ctx);
  const send = (ixs: TransactionInstruction[]) => sendAndConfirmTransaction(connection, new Transaction().add(...ixs), [admin], { commitment: "confirmed" });

  // Puts `units` of the input token in the admin's account: wrapped SOL, airdropped first when short, or freshly minted USDC
  async function fund(sell: boolean, units: bigint) {
    const ixs = [
      createAssociatedTokenAccountIdempotentInstruction(me, ataSol, me, NATIVE_MINT),
      createAssociatedTokenAccountIdempotentInstruction(me, ataUsdc, me, usdc),
    ];
    if (sell) {
      const have = BigInt(await connection.getBalance(me));
      if (have < units + BigInt(10 * LAMPORTS_PER_SOL)) {
        const sig = await connection.requestAirdrop(me, Number(units) + 100 * LAMPORTS_PER_SOL);
        await connection.confirmTransaction({ signature: sig, ...(await connection.getLatestBlockhash()) }, "confirmed");
      }
      ixs.push(SystemProgram.transfer({ fromPubkey: me, toPubkey: ataSol, lamports: units }), createSyncNativeInstruction(ataSol));
    } else ixs.push(createMintToInstruction(usdc, ataUsdc, me, units));
    await send(ixs);
  }

  // The whirlpool: one swap with the target as its price limit, sized by Orca's own quote
  async function orca(target: number, minBps: number) {
    const pool = await client.getPool(new PublicKey(d.whirlpool), IGNORE_CACHE);
    const data = pool.getData();
    const now = PriceMath.sqrtPriceX64ToPrice(data.sqrtPrice, 9, 6).toNumber();
    if (Math.abs(now / target - 1) * 10_000 < minBps) return;
    const aToB = now > target;
    // The three tick arrays a swap may cross have to exist, so any missing on the way are made first
    const span = data.tickSpacing * TICK_ARRAY_SIZE;
    const starts = [0, 1, 2].map((i) => TickUtil.getStartTickIndex(data.tickCurrentIndex + (aToB ? -i : i) * span, data.tickSpacing));
    await (await pool.initTickArrayForTicks(starts, me, IGNORE_CACHE))?.buildAndExecute();
    const tickArrays = await SwapUtils.getTickArrays(data.tickCurrentIndex, data.tickSpacing, aToB, ctx.program.programId, pool.getAddress(), ctx.fetcher, IGNORE_CACHE);
    const oracle = PDAUtil.getOracle(ctx.program.programId, pool.getAddress()).publicKey;
    const quote = swapQuoteWithParams(
      {
        whirlpoolData: data,
        tokenAmount: new BN(aToB ? MAX_SOL * LAMPORTS_PER_SOL : MAX_SOL * 1_000 * 1e6),
        otherAmountThreshold: new BN(0),
        sqrtPriceLimit: PriceMath.priceToSqrtPriceX64(new Decimal(target), 9, 6),
        aToB,
        amountSpecifiedIsInput: true,
        tickArrays,
        oracleData: await ctx.fetcher.getOracle(oracle, IGNORE_CACHE),
        tokenExtensionCtx: await TokenExtensionUtil.buildTokenExtensionContext(ctx.fetcher, data, IGNORE_CACHE),
      },
      Percentage.fromFraction(0, 100),
    );
    // Only what the swap will spend before it reaches the limit, plus a hair for rounding
    const units = BigInt(quote.estimatedAmountIn.toString()) + 10n;
    if (units > 10n) await fund(aToB, units);
    await toTx(
      ctx,
      WhirlpoolIx.swapIx(ctx.program, {
        ...quote,
        amount: new BN(units.toString()),
        whirlpool: pool.getAddress(),
        tokenAuthority: me,
        tokenOwnerAccountA: ataSol,
        tokenOwnerAccountB: ataUsdc,
        tokenVaultA: data.tokenVaultA,
        tokenVaultB: data.tokenVaultB,
        oracle,
      }),
    ).buildAndExecute();
    const after = PriceMath.sqrtPriceX64ToPrice((await client.getPool(pool.getAddress(), IGNORE_CACHE)).getData().sqrtPrice, 9, 6).toNumber();
    log(`Arbitraged the Orca whirlpool from $${now.toFixed(2)} to $${after.toFixed(2)}`);
  }

  // A Meteora pair: sell or buy just the liquidity sitting between the active bin and the target's bin
  async function meteora(pairKey: PublicKey, target: number, minBps: number) {
    const info = await connection.getAccountInfo(pairKey);
    if (!info) return;
    const pair = decodeDlmmPair(pairKey, info.data);
    const baseIsX = pair.mintX.equals(NATIVE_MINT);
    const goal = binForPrice(target, pair.binStep, baseIsX ? 9 : 6, baseIsX ? 6 : 9, baseIsX);
    const step = 1 + pair.binStep / 10_000;
    // How far apart the pair and the oracle are, in bps, from the number of bins between them; a pair prices in whole
    // bins, so one bin off is as close as it gets and trading it would only swing it to the other side
    if (Math.abs(goal - pair.activeId) <= 1 || Math.abs(Math.pow(step, Math.abs(goal - pair.activeId)) - 1) * 10_000 < minBps) return;
    const [lo, hi] = [Math.min(goal, pair.activeId), Math.max(goal, pair.activeId)];
    const indexes = binArrayIndexes(lo, hi);
    const arrays = indexes.map((i) => dlmmPda.binArray(pairKey, i));
    const infos = await connection.getMultipleAccountsInfo(arrays);
    const held = new Map<number, { x: number; y: number }>();
    infos.forEach((a) => a && decodeBinArray(a.data).amounts.forEach((amt, i) => held.set(decodeBinArray(a.data).index * BINS_PER_ARRAY + i, amt)));
    // Moving the bin id down sells X for the Y in the bins below; up buys the X in the bins above with Y
    const down = goal < pair.activeId;
    let input = 0;
    for (let id = pair.activeId; down ? id > goal : id < goal; id += down ? -1 : 1) {
      const bin = held.get(id);
      if (!bin) continue;
      const price = Math.pow(step, id);
      input += down ? bin.y / price : bin.x * price;
    }
    if (input < 1) {
      log(`Meteora pair ${pairKey.toBase58()} has no liquidity between its price and the oracle's, so it stays at bin ${pair.activeId}`);
      return;
    }
    // The pool's fee comes on top of what the bins take
    const units = BigInt(Math.ceil(input * 1.02));
    const sellX = down;
    const xIsSol = baseIsX;
    // Selling SOL when SOL is the token going in
    await fund(sellX === xIsSol, units);
    const [inAta, outAta] = sellX === xIsSol ? [ataSol, ataUsdc] : [ataUsdc, ataSol];
    const optional = { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false };
    const data = Buffer.alloc(24);
    DLMM_SWAP.copy(data);
    data.writeBigUInt64LE(units, 8);
    data.writeBigUInt64LE(0n, 16);
    // The bin arrays in the order the swap walks them
    const walk = (down ? [...arrays].reverse() : arrays).map((pubkey) => ({ pubkey, isSigner: false, isWritable: true }));
    const swap = new TransactionInstruction({
      programId: DLMM_PROGRAM_ID,
      keys: [
        { pubkey: pairKey, isSigner: false, isWritable: true },
        optional,
        { pubkey: pair.reserveX, isSigner: false, isWritable: true },
        { pubkey: pair.reserveY, isSigner: false, isWritable: true },
        { pubkey: inAta, isSigner: false, isWritable: true },
        { pubkey: outAta, isSigner: false, isWritable: true },
        { pubkey: pair.mintX, isSigner: false, isWritable: false },
        { pubkey: pair.mintY, isSigner: false, isWritable: false },
        { pubkey: pair.oracle, isSigner: false, isWritable: true },
        optional,
        { pubkey: me, isSigner: true, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: dlmmPda.eventAuthority(), isSigner: false, isWritable: false },
        { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
        ...walk,
      ],
      data,
    });
    await send([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), swap]);
    const after = decodeDlmmPair(pairKey, (await connection.getAccountInfo(pairKey))!.data).activeId;
    log(`Arbitraged Meteora pair ${pairKey.toBase58().slice(0, 8)} from bin ${pair.activeId} to ${after}, the oracle's is ${goal}`);
  }

  return async function align(solUsd: number, minBps: number) {
    await orca(solUsd, minBps).catch((e) => log(`Orca arbitrage failed: ${e?.message ?? e}`));
    for (const m of (d.lpMarkets ?? []).filter((m) => m.dexProgram === DLMM_PROGRAM_ID.toBase58())) {
      await meteora(new PublicKey(m.pool), solUsd, minBps).catch((e) => log(`Meteora arbitrage failed: ${e?.message ?? e}`));
    }
  };
}
