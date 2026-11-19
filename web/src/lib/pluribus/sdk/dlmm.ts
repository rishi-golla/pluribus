// Meteora DLMM: the pair and position layouts the program reads, and the addresses its instructions need
// Layouts follow programs/pluribus/src/dlmm.rs and doc_and_refs/DLMM.md
import { PublicKey } from "@solana/web3.js";

export const DLMM_PROGRAM_ID = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
// A position covers at most this many bins, and one bin array holds this many
export const MAX_BINS = 70;
export const BINS_PER_ARRAY = 70;
// Meteora's strategy that spreads both tokens evenly: token Y under the active bin, token X above it
export const SPOT = 6;

const find = (...seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, DLMM_PROGRAM_ID)[0];
const i64 = (v: number) => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(v));
  return b;
};

export const dlmmPda = {
  binArray: (pair: PublicKey, index: number) => find(Buffer.from("bin_array"), pair.toBuffer(), i64(index)),
  reserve: (pair: PublicKey, mint: PublicKey) => find(pair.toBuffer(), mint.toBuffer()),
  oracle: (pair: PublicKey) => find(Buffer.from("oracle"), pair.toBuffer()),
  bitmapExtension: (pair: PublicKey) => find(Buffer.from("bitmap"), pair.toBuffer()),
  eventAuthority: () => find(Buffer.from("__event_authority")),
};

export type DlmmPair = {
  address: PublicKey;
  activeId: number;
  binStep: number;
  // 0 when Meteora has the pair enabled
  status: number;
  mintX: PublicKey;
  mintY: PublicKey;
  reserveX: PublicKey;
  reserveY: PublicKey;
  oracle: PublicKey;
};

// LbPair: active id i32 at 76, bin step u16 at 80, status at 82, mints at 88 and 120, reserves at 152 and 184, oracle at 552
export function decodeDlmmPair(address: PublicKey, data: Buffer): DlmmPair {
  const key = (at: number) => new PublicKey(data.subarray(at, at + 32));
  return {
    address,
    activeId: data.readInt32LE(76),
    binStep: data.readUInt16LE(80),
    status: data[82],
    mintX: key(88),
    mintY: key(120),
    reserveX: key(152),
    reserveY: key(184),
    oracle: key(552),
  };
}

export type DlmmPosition = { address: PublicKey; pair: PublicKey; owner: PublicKey; lower: number; upper: number; shares: bigint[] };

// PositionV2: pair at 8, owner at 40, 70 liquidity shares (u128) from 72, lower and upper bin at 7912 and 7916
export function decodeDlmmPosition(address: PublicKey, data: Buffer): DlmmPosition {
  const shares = Array.from({ length: MAX_BINS }, (_, i) => {
    const at = 72 + 16 * i;
    return data.readBigUInt64LE(at) + (data.readBigUInt64LE(at + 8) << BigInt(64));
  });
  return {
    address,
    pair: new PublicKey(data.subarray(8, 40)),
    owner: new PublicKey(data.subarray(40, 72)),
    lower: data.readInt32LE(7912),
    upper: data.readInt32LE(7916),
    shares,
  };
}

export const holdsLiquidity = (p: DlmmPosition) => p.shares.some((s) => s > BigInt(0));

// The bin arrays covering bins `lower..=upper`, lowest first
export function binArrayIndexes(lower: number, upper: number): number[] {
  const first = Math.floor(lower / BINS_PER_ARRAY);
  const last = Math.floor(upper / BINS_PER_ARRAY);
  return Array.from({ length: last - first + 1 }, (_, i) => first + i);
}

// USDC per whole base token at a bin, from the bin step and the two mints' decimals
// Bin price is (1 + bin_step / 10000) ^ bin_id in base units of token Y per base unit of token X
export function binPrice(binId: number, binStep: number, decimalsX: number, decimalsY: number, baseIsX: boolean): number {
  const perUnit = Math.pow(1 + binStep / 10_000, binId) * 10 ** (decimalsX - decimalsY);
  return baseIsX ? perUnit : 1 / perUnit;
}

// The bin whose price is nearest `price` USDC per whole base token
export function binForPrice(price: number, binStep: number, decimalsX: number, decimalsY: number, baseIsX: boolean): number {
  const perUnit = baseIsX ? price : 1 / price;
  return Math.round(Math.log(perUnit / 10 ** (decimalsX - decimalsY)) / Math.log(1 + binStep / 10_000));
}
