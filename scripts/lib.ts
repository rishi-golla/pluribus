// Shared by setup, faucet, price and e2e
import fs from "node:fs";
import path from "node:path";
import { IGNORE_CACHE, PDAUtil, PoolUtil, PriceMath, WhirlpoolIx, toTx } from "@orca-so/whirlpools-sdk";
import {
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  createSyncNativeInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import { type Deployment, getProgram, math } from "../sdk/index.ts";
import {
  DEC_A,
  DEC_B,
  PROGRAM,
  TICK_SPACING,
  ataA,
  ataB,
  client,
  cluster,
  connection,
  ctx,
  me,
  root,
  tickArray,
  wallet,
  whirlpool,
} from "./orca-common.ts";

export const program = getProgram(connection);
export const deploymentFile = path.join(root, "deployments", `${cluster}.json`);

export function loadDeployment(): Deployment {
  if (!fs.existsSync(deploymentFile)) throw new Error(`${deploymentFile} is missing, run setup first`);
  return JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
}

export const exists = async (address: PublicKey) => (await connection.getAccountInfo(address)) !== null;

// The first signer pays, and the admin wallet signs alone by default
export const send = (ixs: TransactionInstruction[], signers: Keypair[] = [wallet]) =>
  sendAndConfirmTransaction(connection, new Transaction().add(...ixs), signers, { commitment: "confirmed" });

// A CLI flag that must be a number of zero or more
export function amount(name: string, value: string): number {
  const n = Number(value);
  if (value.trim() === "" || !Number.isFinite(n) || n < 0) {
    throw new Error(`--${name} must be a number of zero or more, got "${value}"`);
  }
  return n;
}

const units = (whole: number, decimals: number) => BigInt(Math.round(whole * 10 ** decimals));

export type FaucetOptions = {
  sol?: number;
  stock?: number;
  usdc?: number;
  // Dollar value of the Orca position to open, over `range` in dollars per SOL
  lp?: number;
  range?: [number, number];
  nftProgram?: PublicKey;
};

// Makes a wallet demo-ready and returns the mint of the Orca position it was given, if any
export async function faucet(d: Deployment, to: PublicKey, o: FaucetOptions): Promise<PublicKey | null> {
  if (o.sol && cluster === "localnet") {
    const signature = await connection.requestAirdrop(to, Number(units(o.sol, 9)));
    await connection.confirmTransaction({ signature, ...(await connection.getLatestBlockhash()) }, "confirmed");
  }

  const mints: TransactionInstruction[] = [];
  for (const [mint, whole] of [
    [d.stockMint, o.stock],
    [d.usdcMint, o.usdc],
  ] as const) {
    if (!whole) continue;
    const key = new PublicKey(mint);
    const account = getAssociatedTokenAddressSync(key, to, true);
    mints.push(
      createAssociatedTokenAccountIdempotentInstruction(me, account, to, key),
      createMintToInstruction(key, account, me, units(whole, d.assets[mint].decimals)),
    );
  }
  if (mints.length) await send(mints);

  return o.lp ? openPosition(to, o.lp, o.range ?? [120, 180], o.nftProgram ?? TOKEN_2022_PROGRAM_ID) : null;
}

// Opens a position as the admin, who holds the mock USDC mint authority, then hands the NFT over
async function openPosition(to: PublicKey, usd: number, range: [number, number], nftProgram: PublicKey) {
  const pool = await client.getPool(whirlpool, IGNORE_CACHE);
  const { sqrtPrice, tokenVaultA, tokenVaultB } = pool.getData();
  const price = PriceMath.sqrtPriceX64ToPrice(sqrtPrice, DEC_A, DEC_B).toNumber();
  const [lower, upper] = range.map((p) => Math.round(math.priceToTick(p) / TICK_SPACING) * TICK_SPACING);
  if (!(lower < upper)) throw new Error(`Range ${range.join("-")} is empty at tick spacing ${TICK_SPACING}`);
  // Value is linear in liquidity
  const liquidity = new BN(Math.floor(usd / math.lpValue(1, lower, upper, price)).toFixed(0));
  const max = PoolUtil.getTokenAmountsFromLiquidity(
    liquidity,
    sqrtPrice,
    PriceMath.tickIndexToSqrtPriceX64(lower),
    PriceMath.tickIndexToSqrtPriceX64(upper),
    true,
  );

  await (await pool.initTickArrayForTicks([lower, upper], me, IGNORE_CACHE, "fixed"))?.buildAndExecute();
  const funding: TransactionInstruction[] = [];
  if (!max.tokenA.isZero()) {
    const lamports = BigInt(max.tokenA.toString());
    const have = await connection.getBalance(me);
    if (BigInt(have) < lamports + BigInt(LAMPORTS_PER_SOL)) {
      throw new Error(`Admin has ${have / LAMPORTS_PER_SOL} SOL, too little to fund a $${usd} position`);
    }
    funding.push(SystemProgram.transfer({ fromPubkey: me, toPubkey: ataA, lamports }), createSyncNativeInstruction(ataA));
  }
  if (!max.tokenB.isZero()) {
    funding.push(createMintToInstruction(pool.getData().tokenMintB, ataB, me, BigInt(max.tokenB.toString())));
  }
  await send(funding);

  const mint = Keypair.generate();
  const position = PDAUtil.getPosition(PROGRAM, mint.publicKey);
  const held = getAssociatedTokenAddressSync(mint.publicKey, me, false, nftProgram);
  const open = {
    whirlpool,
    owner: me,
    funder: me,
    positionPda: position,
    positionTokenAccount: held,
    tickLowerIndex: lower,
    tickUpperIndex: upper,
  };
  await toTx(
    ctx,
    nftProgram.equals(TOKEN_2022_PROGRAM_ID)
      ? WhirlpoolIx.openPositionWithTokenExtensionsIx(ctx.program, {
          ...open,
          positionMint: mint.publicKey,
          withTokenMetadataExtension: true,
        })
      : WhirlpoolIx.openPositionIx(ctx.program, { ...open, positionMintAddress: mint.publicKey }),
  )
    .addSigner(mint)
    .addInstruction(
      WhirlpoolIx.increaseLiquidityIx(ctx.program, {
        liquidityAmount: liquidity,
        tokenMaxA: max.tokenA,
        tokenMaxB: max.tokenB,
        whirlpool,
        position: position.publicKey,
        positionTokenAccount: held,
        positionAuthority: me,
        tokenOwnerAccountA: ataA,
        tokenOwnerAccountB: ataB,
        tokenVaultA,
        tokenVaultB,
        tickArrayLower: tickArray(lower),
        tickArrayUpper: tickArray(upper),
      }),
    )
    .buildAndExecute();

  const account = getAssociatedTokenAddressSync(mint.publicKey, to, true, nftProgram);
  await send([
    createAssociatedTokenAccountIdempotentInstruction(me, account, to, mint.publicKey, nftProgram),
    createTransferCheckedInstruction(held, mint.publicKey, account, me, 1, 0, [], nftProgram),
  ]);
  return mint.publicKey;
}
