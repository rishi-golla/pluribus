import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { Percentage } from "@orca-so/common-sdk";
import {
  IGNORE_CACHE,
  PDAUtil,
  PoolUtil,
  PriceMath,
  TickUtil,
  WhirlpoolIx,
  swapQuoteByInputToken,
  toTx,
} from "@orca-so/whirlpools-sdk";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMint,
  createMintToInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import Decimal from "decimal.js";
import {
  DEC_A,
  DEC_B,
  PROGRAM,
  SPAN,
  TICK_SPACING,
  args,
  ataA,
  ataB,
  client,
  cluster,
  config,
  connection,
  ctx,
  describe,
  feeTier,
  key,
  me,
  oracle,
  root,
  tickArray,
  usdc,
  usdcKey,
  wallet,
  whirlpool,
  whirlpoolPda,
} from "./orca-common.ts";

const usd = new Decimal(args.usd);
const exists = async (a: PublicKey) => (await connection.getAccountInfo(a)) !== null;
const raw = (x: Decimal) => new BN(x.floor().toFixed(0));

assert(
  (await exists(config)) && (await exists(feeTier)),
  `${config} and ${feeTier} are missing; clone them from devnet into the validator`,
);
if (!(await exists(usdc))) await createMint(connection, wallet, me, null, DEC_B, usdcKey);

if (!(await exists(whirlpool))) {
  await toTx(
    ctx,
    WhirlpoolIx.initializePoolIx(ctx.program, {
      initSqrtPrice: PriceMath.priceToSqrtPriceX64(new Decimal(150), DEC_A, DEC_B),
      whirlpoolsConfig: config,
      whirlpoolPda,
      tokenMintA: NATIVE_MINT,
      tokenMintB: usdc,
      tokenVaultAKeypair: key("vault-a"),
      tokenVaultBKeypair: key("vault-b"),
      feeTierKey: feeTier,
      tickSpacing: TICK_SPACING,
      funder: me,
    }),
  ).buildAndExecute();
}
const pool = await client.getPool(whirlpool, IGNORE_CACHE);
const { tokenVaultA, tokenVaultB } = pool.getData();
assert(pool.getData().tokenMintA.equals(NATIVE_MINT));

const tick = (price: number) =>
  Math.round(PriceMath.priceToTickIndex(new Decimal(price), DEC_A, DEC_B) / TICK_SPACING) * TICK_SPACING;
const [minTick, maxTick] = TickUtil.getFullRangeTickIndex(TICK_SPACING);
const specs = [
  { name: "p1", lower: tick(120), upper: tick(180), tokenProgram: TOKEN_PROGRAM_ID },
  { name: "p2", lower: tick(145.5), upper: tick(154.5), tokenProgram: TOKEN_2022_PROGRAM_ID },
  { name: "p3", lower: minTick, upper: maxTick, tokenProgram: TOKEN_2022_PROGRAM_ID },
].map((s) => {
  const mint = key(`${s.name}-mint`);
  return {
    ...s,
    mint,
    position: PDAUtil.getPosition(PROGRAM, mint.publicKey),
    tokenAccount: getAssociatedTokenAddressSync(mint.publicKey, me, false, s.tokenProgram),
  };
});

// Fixed arrays keep rent and layout constant, and the current array's neighbours only exist so swaps can name three
const current = pool.getData().tickCurrentIndex;
const ticks = [...specs.flatMap((s) => [s.lower, s.upper]), current - SPAN, current + SPAN];
await (await pool.initTickArrayForTicks(ticks, me, IGNORE_CACHE, "fixed"))?.buildAndExecute();

await sendAndConfirmTransaction(
  connection,
  new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(me, ataA, me, NATIVE_MINT),
    createAssociatedTokenAccountIdempotentInstruction(me, ataB, me, usdc),
  ),
  [wallet],
);

// Tops the wallet's token accounts up to at least `a` wSOL and `b` USDC
async function fund(a: BN, b: BN) {
  const [haveA, haveB] = await Promise.all(
    [ataA, ataB].map(async (t) => new BN((await connection.getTokenAccountBalance(t)).value.amount)),
  );
  const tx = new Transaction();
  if (a.gt(haveA)) {
    const lamports = BigInt(a.sub(haveA).toString());
    const sol = (await connection.getBalance(me)) / LAMPORTS_PER_SOL;
    const need = Number(lamports) / LAMPORTS_PER_SOL + 0.5;
    if (sol < need) throw new Error(`wallet has ${sol} SOL, needs ${need}; fund it or lower --usd`);
    tx.add(SystemProgram.transfer({ fromPubkey: me, toPubkey: ataA, lamports }), createSyncNativeInstruction(ataA));
  }
  if (b.gt(haveB)) tx.add(createMintToInstruction(usdc, ataB, me, BigInt(b.sub(haveB).toString())));
  if (tx.instructions.length) await sendAndConfirmTransaction(connection, tx, [wallet]);
}

const x64 = (x: BN) => new Decimal(x.toString()).div(new Decimal(2).pow(64));
for (const s of specs) {
  if (await exists(s.position.publicKey)) continue;
  const { sqrtPrice } = await pool.refreshData();
  const [sqrtLower, sqrtUpper] = [s.lower, s.upper].map(PriceMath.tickIndexToSqrtPriceX64);
  // Raw sqrt prices: value in USDC units = l * (p * (1/sp - 1/su) + (sp - sl)), with sp clamped to the range
  const [sp, sl, su] = [sqrtPrice, sqrtLower, sqrtUpper].map(x64);
  const sc = Decimal.min(Decimal.max(sp, sl), su);
  const perLiquidity = sp.pow(2).mul(sc.pow(-1).sub(su.pow(-1))).add(sc.sub(sl));
  const liquidity = raw(usd.mul(10 ** DEC_B).div(perLiquidity));
  const max = PoolUtil.getTokenAmountsFromLiquidity(liquidity, sqrtPrice, sqrtLower, sqrtUpper, true);
  const value = new Decimal(max.tokenA.toString()).mul(sp.pow(2)).add(max.tokenB.toString()).div(10 ** DEC_B);
  assert(value.sub(usd).abs().lt(usd.mul(0.01)), `${s.name} is worth ${value}, wanted ${usd}`);

  await fund(max.tokenA, max.tokenB);
  const open = {
    whirlpool,
    owner: me,
    funder: me,
    positionPda: s.position,
    positionTokenAccount: s.tokenAccount,
    tickLowerIndex: s.lower,
    tickUpperIndex: s.upper,
  };
  await toTx(
    ctx,
    s.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)
      ? WhirlpoolIx.openPositionWithTokenExtensionsIx(ctx.program, {
          ...open,
          positionMint: s.mint.publicKey,
          withTokenMetadataExtension: true,
        })
      : WhirlpoolIx.openPositionIx(ctx.program, { ...open, positionMintAddress: s.mint.publicKey }),
  )
    .addSigner(s.mint)
    .addInstruction(
      WhirlpoolIx.increaseLiquidityIx(ctx.program, {
        liquidityAmount: liquidity,
        tokenMaxA: max.tokenA,
        tokenMaxB: max.tokenB,
        whirlpool,
        position: s.position.publicKey,
        positionTokenAccount: s.tokenAccount,
        positionAuthority: me,
        tokenOwnerAccountA: ataA,
        tokenOwnerAccountB: ataB,
        tokenVaultA,
        tokenVaultB,
        tickArrayLower: tickArray(s.lower),
        tickArrayUpper: tickArray(s.upper),
      }),
    )
    .buildAndExecute();
}

// Sizes are fractions of a position's value, and sells and buys cancel so reruns do not drift
const p2 = specs[1];
for (const [mint, fraction] of [
  [NATIVE_MINT, 0.075],
  [usdc, 0.12],
  [NATIVE_MINT, 0.09],
  [usdc, 0.045],
] as const) {
  const { sqrtPrice } = await pool.refreshData();
  const sell = mint.equals(NATIVE_MINT);
  const price = PriceMath.sqrtPriceX64ToPrice(sqrtPrice, DEC_A, DEC_B);
  const amount = raw(sell ? usd.mul(fraction).div(price).mul(10 ** DEC_A) : usd.mul(fraction).mul(10 ** DEC_B));
  await fund(sell ? amount : new BN(0), sell ? new BN(0) : amount);
  const quote = await swapQuoteByInputToken(
    pool,
    mint,
    amount,
    Percentage.fromFraction(1, 100),
    PROGRAM,
    ctx.fetcher,
    IGNORE_CACHE,
  );
  const end = quote.estimatedEndTickIndex;
  assert(end >= p2.lower && end < p2.upper, `swap would end at tick ${end}, outside p2`);
  await toTx(
    ctx,
    WhirlpoolIx.swapIx(ctx.program, {
      ...quote,
      whirlpool,
      tokenAuthority: me,
      tokenOwnerAccountA: ataA,
      tokenOwnerAccountB: ataB,
      tokenVaultA,
      tokenVaultB,
      oracle,
    }),
  ).buildAndExecute();
}

const outFile = path.join(root, "scripts/out", `${cluster}.json`);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(await describe(), null, 2) + "\n");
console.log(`wrote ${outFile}`);
