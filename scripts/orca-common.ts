import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import anchor from "@coral-xyz/anchor";
import {
  IGNORE_CACHE,
  ORCA_WHIRLPOOL_PROGRAM_ID as PROGRAM,
  PDAUtil,
  PoolUtil,
  PriceMath,
  TICK_ARRAY_SIZE,
  TickUtil,
  TokenExtensionUtil,
  WhirlpoolContext,
  buildWhirlpoolClient,
  collectFeesQuote,
} from "@orca-so/whirlpools-sdk";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

export { PROGRAM };
export const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: "http://127.0.0.1:8899" },
    usd: { type: "string", default: "10000" },
    // Parsed here because every script imports this module, and each one applies its own defaults
    ledger: { type: "string" },
    // npm run localnet: keep the ledger and the accounts on it instead of starting a fresh chain
    keep: { type: "boolean" },
    to: { type: "string" },
    sol: { type: "string" },
    stock: { type: "string" },
    usdc: { type: "string" },
    lp: { type: "string" },
    range: { type: "string" },
    positions: { type: "string" },
    asset: { type: "string" },
    price: { type: "string" },
  },
});
export const url = args.url;
const local = ["127.0.0.1", "localhost", "[::1]", "0.0.0.0"].includes(new URL(url).hostname);
export const cluster = process.env.CLUSTER ?? /devnet|testnet|mainnet/.exec(url)?.[0] ?? "localnet";
// a private rpc url names no cluster, and guessing localnet there gives a live pool delays of seconds.
// the other way round, a stray CLUSTER on a local run would overwrite that cluster's deployment file
if (local !== (cluster === "localnet")) {
  throw new Error(
    `${url} is ${local ? "a" : "not a"} local validator but the cluster is ${cluster}: ` +
      "set CLUSTER to devnet, testnet or mainnet for a remote rpc, and leave it unset for a local one",
  );
}
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const readKey = (file: string) =>
  Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));

// Persisted per cluster so reruns find the accounts they already created
export function key(name: string, ok: (k: Keypair) => boolean = () => true): Keypair {
  const file = path.join(root, "scripts/.keys", cluster, `${name}.json`);
  if (fs.existsSync(file)) return readKey(file);
  let k = Keypair.generate();
  while (!ok(k)) k = Keypair.generate();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify([...k.secretKey]));
  return k;
}

export const TICK_SPACING = 64;
export const [DEC_A, DEC_B] = [9, 6];
export const SPAN = TICK_SPACING * TICK_ARRAY_SIZE;
export const POSITIONS = ["p1", "p2", "p3"];

// DEMO_ADMIN_SECRET, the pool admin's key in base58 as a wallet exports it or as a JSON byte array, signs instead of the CLI key when set
const adminSecret = process.env.DEMO_ADMIN_SECRET?.trim();
export const wallet = adminSecret
  ? Keypair.fromSecretKey(adminSecret.startsWith("[") ? Uint8Array.from(JSON.parse(adminSecret)) : anchor.utils.bytes.bs58.decode(adminSecret))
  : readKey(path.join(os.homedir(), ".config/solana/id.json"));
export const me = wallet.publicKey;
export const connection = new Connection(url, "confirmed");
export const ctx = WhirlpoolContext.from(connection, new anchor.Wallet(wallet));
export const client = buildWhirlpoolClient(ctx);

// Whirlpool orders mints by raw bytes, and token A must be wSOL
export const usdcKey = key("usdc-mint", (k) => PoolUtil.compareMints(NATIVE_MINT, k.publicKey) < 0);
export const usdc = usdcKey.publicKey;
// Orca's admin is the only funder initialize_config accepts, so the pool hangs off Orca's devnet config
export const config = new PublicKey("FcrweFY1G9HJAHG5inkGB6pKg1HZ6x9UC2WioAfWrGkR");
export const feeTier = PDAUtil.getFeeTier(PROGRAM, config, TICK_SPACING).publicKey;
export const whirlpoolPda = PDAUtil.getWhirlpool(PROGRAM, config, NATIVE_MINT, usdc, TICK_SPACING);
export const whirlpool = whirlpoolPda.publicKey;
export const oracle = PDAUtil.getOracle(PROGRAM, whirlpool).publicKey;
export const ataA = getAssociatedTokenAddressSync(NATIVE_MINT, me);
export const ataB = getAssociatedTokenAddressSync(usdc, me);
export const tickArray = (tick: number) =>
  PDAUtil.getTickArrayFromTickIndex(tick, TICK_SPACING, whirlpool, PROGRAM).publicKey;

// Everything the fixture created, read back from the chain
export async function describe() {
  const pool = await client.getPool(whirlpool, IGNORE_CACHE);
  const data = pool.getData();
  const extensions = await TokenExtensionUtil.buildTokenExtensionContext(ctx.fetcher, data, IGNORE_CACHE);
  const ticks = [data.tickCurrentIndex - SPAN, data.tickCurrentIndex + SPAN];
  const positions = [];
  for (const name of POSITIONS) {
    const mint = key(`${name}-mint`).publicKey;
    const address = PDAUtil.getPosition(PROGRAM, mint).publicKey;
    const position = await client.getPosition(address, IGNORE_CACHE);
    const d = position.getData();
    const tokenProgram = position.getPositionMintTokenProgramId();
    const amounts = PoolUtil.getTokenAmountsFromLiquidity(
      d.liquidity,
      data.sqrtPrice,
      PriceMath.tickIndexToSqrtPriceX64(d.tickLowerIndex),
      PriceMath.tickIndexToSqrtPriceX64(d.tickUpperIndex),
      false,
    );
    const fees = collectFeesQuote({
      whirlpool: data,
      position: d,
      tickLower: position.getLowerTickData(),
      tickUpper: position.getUpperTickData(),
      tokenExtensionCtx: extensions,
    });
    ticks.push(d.tickLowerIndex, d.tickUpperIndex);
    positions.push({
      name,
      position: address,
      positionMint: mint,
      tokenProgram,
      ownerTokenAccount: getAssociatedTokenAddressSync(mint, me, false, tokenProgram),
      tickLowerIndex: d.tickLowerIndex,
      tickUpperIndex: d.tickUpperIndex,
      tickArrayLower: tickArray(d.tickLowerIndex),
      tickArrayUpper: tickArray(d.tickUpperIndex),
      liquidity: d.liquidity.toString(),
      amountA: amounts.tokenA.toString(),
      amountB: amounts.tokenB.toString(),
      // What collect_fees pays out, since the account's fee_owed fields lag until update_fees_and_rewards
      uncollectedFeeA: fees.feeOwedA.toString(),
      uncollectedFeeB: fees.feeOwedB.toString(),
    });
  }
  const starts = [...new Set(ticks.map((t) => TickUtil.getStartTickIndex(t, TICK_SPACING)))].sort((a, b) => a - b);
  return {
    cluster,
    programId: PROGRAM,
    wallet: me,
    config,
    feeTier,
    whirlpool,
    oracle,
    tickSpacing: TICK_SPACING,
    feeRate: data.feeRate,
    protocolFeeRate: data.protocolFeeRate,
    sqrtPrice: data.sqrtPrice.toString(),
    tickCurrentIndex: data.tickCurrentIndex,
    price: PriceMath.sqrtPriceX64ToPrice(data.sqrtPrice, DEC_A, DEC_B).toString(),
    liquidity: data.liquidity.toString(),
    rewardLastUpdatedTimestamp: data.rewardLastUpdatedTimestamp.toString(),
    tokenA: {
      mint: NATIVE_MINT,
      decimals: DEC_A,
      tokenProgram: TOKEN_PROGRAM_ID,
      vault: data.tokenVaultA,
      walletTokenAccount: ataA,
    },
    tokenB: {
      mint: usdc,
      decimals: DEC_B,
      tokenProgram: TOKEN_PROGRAM_ID,
      vault: data.tokenVaultB,
      walletTokenAccount: ataB,
    },
    tickArrays: starts.map((startTickIndex) => ({
      startTickIndex,
      address: PDAUtil.getTickArray(PROGRAM, whirlpool, startTickIndex).publicKey,
    })),
    positions,
  };
}
