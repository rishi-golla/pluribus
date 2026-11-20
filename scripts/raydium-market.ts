// Creates a Raydium CLMM SOL/USDC pool on devnet with the deployment's mock USDC, seeds it with one position,
// lists it as a Pluribus LP market and records it in deployments/<cluster>.json
// Usage: ADMIN_KEYPAIR=<admin key file> RPC_URL=https://api.devnet.solana.com npx tsx scripts/raydium-market.ts
// Safe to rerun: a market already recorded in the deployment is only checked
import fs from "node:fs";
import path from "node:path";
import BN from "bn.js";
import Decimal from "decimal.js";
import { DEVNET_PROGRAM_ID, PoolInfoLayout, Raydium, TxVersion } from "@raydium-io/raydium-sdk-v2";
import { NATIVE_MINT, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createMintToInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { AddressLookupTableProgram, Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { type Deployment, fetchPrices, getProgram, ix, lookupAddresses, pda } from "../sdk/index.ts";

const file = process.env.ADMIN_KEYPAIR;
const url = process.env.RPC_URL;
if (!file || !url) throw new Error("Set ADMIN_KEYPAIR to the pool admin's key file and RPC_URL to the cluster");
if (!/devnet/.test(url)) throw new Error("Raydium's CLMM program is only reachable on devnet or mainnet, and this script is for devnet");
const deploymentFile = path.join(import.meta.dirname, "../deployments/devnet.json");
const d: Deployment = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
const connection = new Connection(url, "confirmed");
const program = getProgram(connection);
const send = (tx: Transaction) => sendAndConfirmTransaction(connection, tx, [admin], { commitment: "confirmed" });
const CLMM = DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID;
// The same haircut the main Orca market carries
const LIQ_COST_BPS = 500;
// The seed position: this much SOL over this price range, with USDC for the other side
const SEED_SOL = 0.3;
const RANGE = [120, 180] as const;

const raydium = await Raydium.load({ connection, owner: admin, cluster: "devnet", disableLoadToken: true, disableFeatureCheck: true, blockhashCommitment: "confirmed" });
let market = d.lpMarkets?.find((m) => m.dexProgram === CLMM.toBase58());

// RAYDIUM_POOL resumes with a pool an earlier run created but did not finish setting up
let poolId = process.env.RAYDIUM_POOL ? new PublicKey(process.env.RAYDIUM_POOL) : null;

if (!market && !poolId) {
  const solPrice = (await fetchPrices(program, d))[d.solMint];
  const configs = await raydium.api.getClmmConfigs();
  // A 64-tick spacing, like the main whirlpool, or the closest one devnet offers
  const config = [...configs].sort((a, b) => Math.abs(a.tickSpacing - 64) - Math.abs(b.tickSpacing - 64))[0];
  const token = (address: string, decimals: number, symbol: string) => ({
    chainId: 101,
    address,
    programId: TOKEN_PROGRAM_ID.toBase58(),
    logoURI: "",
    symbol,
    name: symbol,
    decimals,
    tags: [],
    extensions: {},
  });
  const { execute, extInfo } = await raydium.clmm.createPool({
    programId: CLMM,
    mint1: token(d.solMint, 9, "SOL"),
    mint2: token(d.usdcMint, 6, "USDC"),
    ammConfig: { ...config, id: new PublicKey(config.id), fundOwner: "", description: "" },
    initialPrice: new Decimal(solPrice),
    txVersion: TxVersion.V0,
  });
  const created = await execute({ sendAndConfirm: true });
  poolId = new PublicKey(extInfo.address.id);
  console.log(`Raydium pool ${poolId.toBase58()} at $${solPrice}, tick spacing ${config.tickSpacing}, tx ${created.txId}`);
}

if (!market && poolId) {
  // The admin holds the mock USDC mint authority, so the seed position's USDC is minted for it
  const usdc = new PublicKey(d.usdcMint);
  const adminUsdc = getAssociatedTokenAddressSync(usdc, admin.publicKey);
  await send(
    new Transaction().add(
      createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, adminUsdc, admin.publicKey, usdc),
      createMintToInstruction(usdc, adminUsdc, admin.publicKey, 1_000 * 1e6),
    ),
  );

  // Read straight from the pool account: the SDK's own reader fails on a new pool that has no tick arrays yet
  const raw = PoolInfoLayout.decode((await connection.getAccountInfo(poolId))!.data);
  const config = await connection.getAccountInfo(raw.configId);
  // AmmConfig layout: disc 8 | bump 1 | index u16 | owner 32 | protocol fee u32 | trade fee u32 | tick spacing u16
  const spacing = config!.data.readUInt16LE(8 + 1 + 2 + 32 + 4 + 4);
  const mint = (address: PublicKey, decimals: number) => ({ address: address.toBase58(), programId: TOKEN_PROGRAM_ID.toBase58(), decimals });
  const poolInfo = {
    id: poolId.toBase58(),
    programId: CLMM.toBase58(),
    mintA: mint(raw.mintA, raw.mintDecimalsA),
    mintB: mint(raw.mintB, raw.mintDecimalsB),
    config: { id: raw.configId.toBase58(), tickSpacing: spacing },
  };
  const poolKeys = { vault: { A: raw.vaultA, B: raw.vaultB } };
  const solFirst = poolInfo.mintA.address === d.solMint;
  // Ticks price token B in token A in base units, so with USDC first a SOL price p sits at 1 / p
  const tickOf = (price: number) => {
    const raw = solFirst ? price * 10 ** (6 - 9) : (1 / price) * 10 ** (9 - 6);
    return Math.log(raw) / Math.log(1.0001);
  };
  const [a, b] = RANGE.map(tickOf).sort((x, y) => x - y);
  const tickLower = Math.floor(a / spacing) * spacing;
  const tickUpper = Math.ceil(b / spacing) * spacing;
  const opened = await raydium.clmm.openPositionFromBase({
    poolInfo,
    poolKeys,
    tickLower,
    tickUpper,
    base: solFirst ? "MintA" : "MintB",
    baseAmount: new BN(Math.round(SEED_SOL * 1e9)),
    otherAmountMax: new BN(1_000 * 1e6),
    ownerInfo: { useSOLBalance: true },
    txVersion: TxVersion.V0,
  });
  const seeded = await opened.execute({ sendAndConfirm: true });
  console.log(`Seed position ${opened.extInfo.nftMint.toBase58()} over ticks ${tickLower}..${tickUpper}, tx ${seeded.txId}`);

  market = { pool: poolId.toBase58(), dexProgram: CLMM.toBase58(), baseMint: d.solMint };
  d.lpMarkets = [...(d.lpMarkets ?? []), market];
}

if (!market) throw new Error("No Raydium pool to list");
const pool = new PublicKey(market.pool);
if (!(await connection.getAccountInfo(pda.lpMarket(pool)))) {
  const signature = await send(new Transaction().add(...(await ix.initLpMarket(program, admin.publicKey, pool, NATIVE_MINT, LIQ_COST_BPS))));
  console.log(`Listed as LP market ${pda.lpMarket(pool).toBase58()}, tx ${signature}`);
}
const listed = await program.account.lpMarket.fetch(pda.lpMarket(pool));
console.log(`LP market: liquidation cost ${listed.liqCostBps} bps, base first ${listed.baseFirst}, backs debt from ${new Date(listed.activeAt.toNumber() * 1000).toISOString()}`);

// Every new address the protocol's transactions reuse goes into the lookup table, 20 per transaction
if (d.lookupTable) {
  const table = (await connection.getAddressLookupTable(new PublicKey(d.lookupTable))).value;
  const known = new Set((table?.state.addresses ?? []).map((k) => k.toBase58()));
  const missing = lookupAddresses(d).filter((k) => !known.has(k.toBase58()));
  for (let i = 0; i < missing.length; i += 20) {
    const addresses = missing.slice(i, i + 20);
    await send(new Transaction().add(AddressLookupTableProgram.extendLookupTable({ lookupTable: new PublicKey(d.lookupTable), authority: admin.publicKey, payer: admin.publicKey, addresses })));
  }
  console.log(`Lookup table: ${missing.length} addresses added`);
}

fs.writeFileSync(deploymentFile, JSON.stringify(d, null, 2) + "\n");
console.log(`Wrote ${deploymentFile}, run npm run sdk:sync for the web app`);
