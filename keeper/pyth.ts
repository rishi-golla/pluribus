// Keeps Pyth push-feed accounts fresh: fetches the latest signed updates from Hermes and posts them to the push oracle's
// price accounts, which are the accounts the program reads for every asset that is priced from Pyth
import anchor from "@coral-xyz/anchor";
import { HermesClient } from "@pythnetwork/hermes-client";
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";
import type { Connection, Keypair } from "@solana/web3.js";
import { PYTH_SHARD, decodePriceUpdate, pda } from "../sdk/index.ts";

export const HERMES_URL = process.env.HERMES_URL ?? "https://hermes.pyth.network";
// The public endpoint serves price updates only with an access token, sent as a bearer token
const token = process.env.HERMES_ACCESS_TOKEN || undefined;
const hermes = new HermesClient(HERMES_URL, { accessToken: token });
let warned = false;
const latestUpdates = (ids: string[], parsed: boolean) =>
  hermes.getLatestPriceUpdates(ids, { encoding: "base64", parsed }).catch((e) => {
    if (/status: 40[13]/.test(String(e?.message))) throw new Error(`Hermes at ${HERMES_URL} refused the request, set HERMES_ACCESS_TOKEN to a token it accepts`);
    throw e;
  });
// Priority fee on top of the base fee, so an update lands within a slot or two when the cluster is busy
const PRIORITY_MICRO_LAMPORTS = 10_000;

// When each feed's push account was last published, or 0 for one that is missing or not a full update
export async function feedTimes(connection: Connection, feedIds: string[]): Promise<Map<string, number>> {
  const infos = await connection.getMultipleAccountsInfo(feedIds.map((id) => pda.pythFeed(id)));
  return new Map(feedIds.map((id, i) => [id, (infos[i] && decodePriceUpdate(infos[i].data)?.publishTime) || 0]));
}

export type Pushed = { feedId: string; publishTime: number };

// Posts the latest Hermes update of every feed in `feedIds` whose push account is more than `maxAgeSecs` behind `now`,
// skipping those where Hermes has nothing newer, such as a stock feed while its market is closed
// One verified Wormhole message carries all of them, so it costs a few transactions however many feeds there are
export async function pushFeeds(connection: Connection, payer: Keypair, feedIds: string[], maxAgeSecs: number, now: number): Promise<Pushed[]> {
  // Without a token Hermes serves no prices, so the feeds are left to whoever else posts them
  if (!token) {
    if (!warned) console.log(`Pyth feeds are not posted: set HERMES_ACCESS_TOKEN to a token for ${HERMES_URL} to turn that on`);
    warned = true;
    return [];
  }
  const times = await feedTimes(connection, feedIds);
  const stale = feedIds.filter((id) => now - times.get(id)! > maxAgeSecs);
  if (!stale.length) return [];

  const latest = await latestUpdates(stale, true);
  const fresh = new Map((latest.parsed ?? []).map((p) => [p.id.replace(/^0x/, ""), p.price.publish_time]));
  const newer = stale.filter((id) => (fresh.get(id) ?? 0) > times.get(id)!);
  if (!newer.length) return [];
  // Only the feeds that moved are posted, since an update that is not newer than the account is rejected
  const update = newer.length === stale.length ? latest : await latestUpdates(newer, false);

  const wallet = new anchor.Wallet(payer) as unknown as ConstructorParameters<typeof PythSolanaReceiver>[0]["wallet"];
  const receiver = new PythSolanaReceiver({ connection, wallet });
  // The encoded VAA accounts the update needs are closed again in the last transaction, which returns their rent
  const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: true });
  await builder.addUpdatePriceFeed(update.binary.data, PYTH_SHARD);
  const txs = await builder.buildVersionedTransactions({ computeUnitPriceMicroLamports: PRIORITY_MICRO_LAMPORTS });
  await receiver.provider.sendAll(txs, { commitment: "confirmed" });
  return newer.map((feedId) => ({ feedId, publishTime: fresh.get(feedId) ?? 0 }));
}
