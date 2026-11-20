// SOL's price from Pyth's push feed on mainnet, read over plain RPC with no key, so a new local chain starts at the real price
// Falls back to `fallback` when mainnet cannot be reached or the feed is stale, so setup never depends on it
import { Connection } from "@solana/web3.js";
import { decodePriceUpdate, pda } from "../sdk/index.ts";

export const SOL_FEED = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

export async function mainnetSolPrice(fallback = 150): Promise<number> {
  try {
    const mainnet = new Connection(process.env.MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
    const info = await mainnet.getAccountInfo(pda.pythFeed(SOL_FEED));
    const q = info && decodePriceUpdate(info.data);
    if (q && Date.now() / 1000 - q.publishTime < 600) return Math.round(Number(q.price.toString()) / 1e4) / 100;
    console.warn(`Mainnet SOL price is stale, starting at $${fallback}`);
  } catch (e) {
    console.warn(`Could not read SOL's price from mainnet (${(e as Error).message}), starting at $${fallback}`);
  }
  return fallback;
}
