// Creates a Meteora DLMM SOL/USDC pair with the deployment's mock USDC, lists it as a Pluribus LP market and records it in
// deployments/<cluster>.json with the pair's own accounts for the lookup table
// Safe to rerun: a pair that exists is reused, a market that is listed is only activated
//   npm run dlmm:market -- --url https://api.devnet.solana.com
import fs from "node:fs";
import path from "node:path";
import { NATIVE_MINT, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { Buffer } from "buffer";
import { DLMM_PROGRAM_ID, binArrayIndexes, binForPrice, decodeDlmmPair, dlmmPda, fetchPrices, ix, pda } from "../sdk/index.ts";
import { deploymentFile, demoActivateNow, ensureLookupTable, loadDeployment, program, send } from "./lib.ts";
import { connection, me, root } from "./orca-common.ts";

// The haircut on a position for the cost of selling it, the same as the other SOL/USDC markets
const LIQ_COST_BPS = 500;
// The preset bin step to use, in bps: 10 bps a bin covers a 70-bin position over about 7%
const BIN_STEP = 10;
// Bin arrays made on each side of the active one, so positions near the price can be opened at once
const ARRAYS_EACH_SIDE = 1;

// First 8 bytes of sha256("global:initialize_lb_pair2") and sha256("account:PresetParameter2")
const INITIALIZE_LB_PAIR2 = Buffer.from([73, 59, 36, 120, 237, 83, 108, 198]);
const PRESET_PARAMETER2 = Buffer.from([171, 236, 148, 115, 162, 113, 222, 174]);
// First 8 bytes of sha256("global:initialize_bin_array")
const INITIALIZE_BIN_ARRAY = Buffer.from([35, 86, 19, 185, 78, 212, 75, 211]);

const d = loadDeployment();
const [sol, usdc] = [NATIVE_MINT, new PublicKey(d.usdcMint)];
const existing = d.lpMarkets?.find((m) => m.dexProgram === DLMM_PROGRAM_ID.toBase58());

// The preset Meteora has published for the bin step, which every permissionless pair is created from
async function preset(binStep: number): Promise<PublicKey> {
  const all = await connection.getProgramAccounts(DLMM_PROGRAM_ID, {
    filters: [{ memcmp: { offset: 0, bytes: PRESET_PARAMETER2.toString("base64"), encoding: "base64" } }],
  });
  // PresetParameter2: bin step u16 at 8, base factor u16 at 10
  const found = all.find((a) => a.account.data.readUInt16LE(8) === binStep);
  if (!found) {
    const steps = all.map((a) => a.account.data.readUInt16LE(8)).join(", ");
    throw new Error(`No DLMM preset with a ${binStep} bps bin step on this cluster, only ${steps}`);
  }
  return found.pubkey;
}

// A pair made from a preset sits at the preset and its two mints in byte order
function pairAddress(presetKey: PublicKey, x: PublicKey, y: PublicKey) {
  const [lo, hi] = Buffer.compare(x.toBuffer(), y.toBuffer()) < 0 ? [x, y] : [y, x];
  return PublicKey.findProgramAddressSync([presetKey.toBuffer(), lo.toBuffer(), hi.toBuffer()], DLMM_PROGRAM_ID)[0];
}

let pairKey = existing ? new PublicKey(existing.pool) : null;
if (!pairKey) {
  const presetKey = await preset(BIN_STEP);
  // SOL is token X, so the bin price is USDC per SOL and the base token comes first
  pairKey = pairAddress(presetKey, sol, usdc);
  if (!(await connection.getAccountInfo(pairKey))) {
    const price = (await fetchPrices(program, d))[sol.toBase58()];
    const activeId = binForPrice(price, BIN_STEP, 9, 6, true);
    const data = Buffer.alloc(8 + 4 + 96);
    INITIALIZE_LB_PAIR2.copy(data);
    data.writeInt32LE(activeId, 8);
    const optional = { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false };
    const create = new TransactionInstruction({
      programId: DLMM_PROGRAM_ID,
      keys: [
        { pubkey: pairKey, isSigner: false, isWritable: true },
        optional,
        { pubkey: sol, isSigner: false, isWritable: false },
        { pubkey: usdc, isSigner: false, isWritable: false },
        { pubkey: dlmmPda.reserve(pairKey, sol), isSigner: false, isWritable: true },
        { pubkey: dlmmPda.reserve(pairKey, usdc), isSigner: false, isWritable: true },
        { pubkey: dlmmPda.oracle(pairKey), isSigner: false, isWritable: true },
        { pubkey: presetKey, isSigner: false, isWritable: false },
        { pubkey: me, isSigner: true, isWritable: true },
        optional,
        optional,
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: dlmmPda.eventAuthority(), isSigner: false, isWritable: false },
        { pubkey: DLMM_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data,
    });
    await send([create]);
    console.log(`Created DLMM pair ${pairKey.toBase58()} at bin ${activeId}, about $${price} per SOL`);
  }
}

const pair = decodeDlmmPair(pairKey, (await connection.getAccountInfo(pairKey))!.data);
// The bin arrays around the price, which liquidity needs before it can go in
const around = binArrayIndexes(pair.activeId - 70 * ARRAYS_EACH_SIDE, pair.activeId + 70 * ARRAYS_EACH_SIDE);
const arrays = around.map((i) => dlmmPda.binArray(pairKey!, i));
const made = await connection.getMultipleAccountsInfo(arrays);
const create = around.flatMap((index, i) => {
  if (made[i]) return [];
  const data = Buffer.alloc(16);
  INITIALIZE_BIN_ARRAY.copy(data);
  data.writeBigInt64LE(BigInt(index), 8);
  return [
    new TransactionInstruction({
      programId: DLMM_PROGRAM_ID,
      keys: [
        { pubkey: pairKey!, isSigner: false, isWritable: false },
        { pubkey: arrays[i], isSigner: false, isWritable: true },
        { pubkey: me, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    }),
  ];
});
if (create.length) {
  await send(create);
  console.log(`Created ${create.length} bin arrays around bin ${pair.activeId}`);
}

if (!(await connection.getAccountInfo(pda.lpMarket(pairKey)))) {
  await send(await ix.initLpMarket(program, me, pairKey, sol, LIQ_COST_BPS));
  console.log(`Listed as LP market ${pda.lpMarket(pairKey).toBase58()}`);
}

const market = {
  pool: pairKey.toBase58(),
  dexProgram: DLMM_PROGRAM_ID.toBase58(),
  baseMint: sol.toBase58(),
  // What every liquidity instruction names besides the position, for the lookup table
  accounts: [pair.reserveX, pair.reserveY, pair.oracle, ...arrays].map((k) => k.toBase58()),
};
d.lpMarkets = [...(d.lpMarkets ?? []).filter((m) => m.pool !== market.pool), market];
// A new listing waits out the activation delay, 8 days on devnet, which a demo pool skips
await demoActivateNow(d);
await ensureLookupTable(d);
fs.writeFileSync(deploymentFile, JSON.stringify(d, null, 2) + "\n");
const web = path.join(root, "web/src/lib/pluribus/deployments");
if (fs.existsSync(web)) fs.copyFileSync(deploymentFile, path.join(web, path.basename(deploymentFile)));
console.log(`Wrote ${deploymentFile}`);
