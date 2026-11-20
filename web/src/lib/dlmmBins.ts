import { PublicKey } from "@solana/web3.js";
import { getConnection } from "./cluster";
import type { DlmmMarket } from "./live";
import { BINS_PER_ARRAY, binArrayIndexes, decodeBinArray, dlmmPda } from "./pluribus/sdk";

/** What a Meteora pair holds over a stretch of bins: each bin's worth in dollars, and the bin arrays nobody has created yet */
export type PairLiquidity = { value: Map<number, number>; missing: Set<number> };

/** Reads the pair's bin arrays covering bins `lower..=upper`, which the range slider draws and the creation cost counts */
export async function fetchPairLiquidity(market: DlmmMarket, lower: number, upper: number): Promise<PairLiquidity> {
  const pair = new PublicKey(market.pair);
  const indexes = binArrayIndexes(lower, upper);
  const infos = await getConnection().getMultipleAccountsInfo(indexes.map((i) => dlmmPda.binArray(pair, i)));
  const value = new Map<number, number>();
  const missing = new Set<number>();
  const baseUnit = 10 ** market.baseDecimals;
  infos.forEach((info, k) => {
    if (!info) return void missing.add(indexes[k]);
    const { index, amounts } = decodeBinArray(info.data);
    amounts.forEach(({ x, y }, i) => {
      const id = index * BINS_PER_ARRAY + i;
      const [base, usdc] = market.baseIsX ? [x, y] : [y, x];
      value.set(id, (base / baseUnit) * market.binPrice(id) + usdc / 1e6);
    });
  });
  return { value, missing };
}
