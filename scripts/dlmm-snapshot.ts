import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Connection, PublicKey } from "@solana/web3.js";

// Copies a live Meteora DLMM pair and the program itself out of mainnet for programs/pluribus/tests/dlmm.rs
// Everything is read in one call so the pair, its bin arrays and its reserves agree with each other
const { values: args } = parseArgs({
  options: {
    url: { type: "string", default: "https://api.mainnet-beta.solana.com" },
    // SOL/USDC with a bin step of 4 bps
    pair: { type: "string", default: "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6" },
    // Bin arrays kept on each side of the active one
    arrays: { type: "string", default: "2" },
  },
});

const PROGRAM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const BINS_PER_ARRAY = 70;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "programs/pluribus/tests/fixtures/dlmm");
const connection = new Connection(args.url, "confirmed");

const pda = (...seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM)[0];
const i64 = (v: number) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(v));
  return b;
};

const pair = new PublicKey(args.pair);
const pairInfo = await connection.getAccountInfo(pair);
if (!pairInfo?.owner.equals(PROGRAM)) throw new Error(`${pair.toBase58()} is not a DLMM pair`);
// LbPair: active id i32 at 76, bin step u16 at 80, token X mint at 88, token Y mint at 120, reserves at 152 and 184
const key = (at: number) => new PublicKey(pairInfo.data.subarray(at, at + 32));
const [activeId, binStep] = [pairInfo.data.readInt32LE(76), pairInfo.data.readUInt16LE(80)];
const [mintX, mintY, reserveX, reserveY] = [key(88), key(120), key(152), key(184)];
const activeArray = Math.floor(activeId / BINS_PER_ARRAY);
const span = Number(args.arrays);
const binArrays = Array.from({ length: 2 * span + 1 }, (_, i) => activeArray - span + i).map((index) => ({
  index,
  address: pda(Buffer.from("bin_array"), pair.toBuffer(), i64(index)),
}));

const accounts: Record<string, PublicKey> = {
  lb_pair: pair,
  token_x_mint: mintX,
  token_y_mint: mintY,
  reserve_x: reserveX,
  reserve_y: reserveY,
  oracle: pda(Buffer.from("oracle"), pair.toBuffer()),
};
for (const b of binArrays) accounts[`bin_array_${b.index}`] = b.address;

const names = Object.keys(accounts);
const { context, value: infos } = await connection.getMultipleAccountsInfoAndContext(Object.values(accounts));
fs.mkdirSync(dir, { recursive: true });
const written: Record<string, { address: string; file: string }> = {};
names.forEach((name, i) => {
  const info = infos[i];
  if (!info) throw new Error(`${name} ${accounts[name].toBase58()} does not exist`);
  const file = `${name}.json`;
  // The shape `solana account --output json` writes, which the Orca fixtures use too
  const account = {
    lamports: info.lamports,
    data: [info.data.toString("base64"), "base64"],
    owner: info.owner.toBase58(),
    executable: info.executable,
    space: info.data.length,
  };
  fs.writeFileSync(path.join(dir, file), JSON.stringify({ pubkey: accounts[name].toBase58(), account }, null, 2) + "\n");
  written[name] = { address: accounts[name].toBase58(), file };
});

// The program's code sits in its program data account after a 45-byte header, and is too large to commit
const programData = PublicKey.findProgramAddressSync([PROGRAM.toBuffer()], LOADER)[0];
const code = await connection.getAccountInfo(programData);
if (!code) throw new Error("the DLMM program data account does not exist");
fs.writeFileSync(path.join(dir, "lb_clmm.so"), code.data.subarray(45));

const decimals = (name: string) => infos[names.indexOf(name)]!.data[44];
const [decimalsX, decimalsY] = [decimals("token_x_mint"), decimals("token_y_mint")];
const manifest = {
  cluster: "mainnet",
  slot: context.slot,
  programId: PROGRAM.toBase58(),
  program: "lb_clmm.so",
  lbPair: pair.toBase58(),
  binStep,
  activeId,
  // Whole token Y per whole token X at the active bin
  price: ((1 + binStep / 10_000) ** activeId * 10 ** (decimalsX - decimalsY)).toString(),
  tokenX: { mint: mintX.toBase58(), decimals: decimalsX, reserve: reserveX.toBase58() },
  tokenY: { mint: mintY.toBase58(), decimals: decimalsY, reserve: reserveY.toBase58() },
  oracle: accounts.oracle.toBase58(),
  eventAuthority: pda(Buffer.from("__event_authority")).toBase58(),
  binArrays: binArrays.map((b) => ({ index: b.index, address: b.address.toBase58() })),
  accounts: written,
};
fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`wrote ${names.length} accounts and lb_clmm.so (${code.data.length - 45} bytes) to ${dir}`);
