import {
  AnchorError,
  AnchorProvider,
  BorshCoder,
  EventParser,
  Program,
  convertIdlToCamelCase,
  type IdlAccounts,
  type IdlTypes,
} from "@anchor-lang/core";
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  type AccountMeta,
  type AddressLookupTableAccount,
  ComputeBudgetProgram,
  type Connection,
  PublicKey,
  SystemProgram,
  type TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import { Buffer } from "buffer";
import idl from "./idl/pluribus.json";
import type { Pluribus } from "./idl/pluribus";
import { type RiskPosition, dynamicShocks, effectiveAt, lpAmounts, lpValue, tickToPrice } from "./math";

export type { Pluribus };

const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

export type Deployment = {
  cluster: string;
  rpcUrl: string;
  programId: string;
  whirlpoolProgramId: string;
  admin: string;
  usdcMint: string;
  solMint: string;
  stockMint: string;
  shareMint: string;
  juniorMint: string;
  whirlpool: string;
  // Token A is wSOL and token B is USDC
  whirlpoolVaultA: string;
  whirlpoolVaultB: string;
  // A tick array covers 88 * tickSpacing ticks, see `pda.tickArray`
  tickSpacing: number;
  demoMode: boolean;
  // LP markets besides `whirlpool`, such as Raydium CLMM pools, each with the program that owns it and its base token
  lpMarkets?: { pool: string; dexProgram: string; baseMint: string }[];
  // An address lookup table of the accounts transactions keep reusing, see `buildTransaction`
  lookupTable?: string;
  // Indexed by mint, and USDC has no price account because it is fixed at $1
  // A liquid staking token also names the SOL price accounts its backing is valued with, its stake pool or fixed rate
  // Each asset has two price accounts and the program reads one by on-chain state, see `priceAccountFor`:
  // its demo account while the pool is in demo mode and the asset is not live, its Pyth push feed otherwise
  assets: Record<
    string,
    {
      symbol: string;
      name: string;
      decimals: number;
      // The demo price account, a PDA of the program
      priceAccount: string | null;
      // The asset's Pyth feed id in hex and the push oracle's price account for it, derived from the feed id when left out
      feedId?: string;
      pythAccount?: string;
      // `solPriceAccount` is the demo SOL account and `solPythAccount` SOL's Pyth push feed, for a token that is live
      backing?: { solPriceAccount: string; solPythAccount?: string; stakePool?: string; fixedRate?: number };
      // Token-2022 assets, like xStocks: their mint is read in every health check
      tokenProgram?: string;
      // The program quotes this asset per 10^priceExponent whole tokens, for a token worth a fraction of a cent
      priceExponent?: number;
    }
  >;
};

export type PluribusProgram = Program<Pluribus>;
export type Pool = IdlAccounts<Pluribus>["pool"];
export type CreditAccount = IdlAccounts<Pluribus>["creditAccount"];
export type Asset = IdlAccounts<Pluribus>["asset"];
export type LpMarket = IdlAccounts<Pluribus>["lpMarket"];
export type HealthView = IdlTypes<Pluribus>["healthView"];
export type PoolParams = IdlTypes<Pluribus>["poolParams"];
export type JuniorExit = IdlAccounts<Pluribus>["juniorExit"];
export type SeniorExit = IdlAccounts<Pluribus>["seniorExit"];
export type AssetParams = IdlTypes<Pluribus>["assetParams"];
export type Wallet = ConstructorParameters<typeof AnchorProvider>[1];

export const PROGRAM_ID = new PublicKey(idl.address);
export const WHIRLPOOL_PROGRAM_ID = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
// Raydium CLMM on mainnet and devnet, the other dex whose positions the program accepts
export const RAYDIUM_CLMM_PROGRAM_IDS = ["CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", "DRayAUgENGQBKVaX8owNhgzkEDyoHTGVEGHVJT1E9pfH"].map(
  (k) => new PublicKey(k),
);
export const KIND_TOKEN = 1;
export const KIND_LP = 2;
export const MAX_U64 = new BN("18446744073709551615");
const TICK_ARRAY_SIZE = 88;
// Pyth's receiver owns every price update account, and its push oracle keeps one long-lived account per feed id and shard
export const PYTH_RECEIVER_PROGRAM_ID = new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");
export const PYTH_PUSH_ORACLE_PROGRAM_ID = new PublicKey("pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT");
// The shard of push feeds the keeper updates and the program is pointed at
export const PYTH_SHARD = 0;
const feedBytes = (feedId: string | Uint8Array | number[]) =>
  typeof feedId === "string" ? Buffer.from(feedId.replace(/^0x/, ""), "hex") : Buffer.from(feedId);
const shardSeed = (shard: number) => {
  const seed = Buffer.alloc(2);
  seed.writeUInt16LE(shard);
  return seed;
};

// Reads need no wallet, and instruction builders never sign
export function getProgram(connection: Connection, wallet?: Wallet): PluribusProgram {
  const provider = wallet ? new AnchorProvider(connection, wallet, { commitment: "confirmed" }) : { connection };
  return new Program<Pluribus>(idl as unknown as Pluribus, provider);
}

const find = (program: PublicKey, ...seeds: (string | PublicKey | Buffer)[]) =>
  PublicKey.findProgramAddressSync(
    seeds.map((s) => (typeof s === "string" ? Buffer.from(s) : Buffer.isBuffer(s) ? s : s.toBuffer())),
    program,
  )[0];
// A ticket number as the program seeds it: eight bytes, little-endian
const ticketSeed = (ticket: BN | number) => new BN(ticket.toString()).toArrayLike(Buffer, "le", 8);

export const pda = {
  pool: () => find(PROGRAM_ID, "pool"),
  usdcVault: () => find(PROGRAM_ID, "usdc_vault"),
  shareMint: () => find(PROGRAM_ID, "share_mint"),
  juniorMint: () => find(PROGRAM_ID, "junior_mint"),
  // Holds junior shares while they wait in the exit queue
  juniorEscrow: () => find(PROGRAM_ID, "junior_escrow"),
  juniorExit: (owner: PublicKey) => find(PROGRAM_ID, "junior_exit", owner),
  // Holds senior shares while they wait in the withdrawal queue, one exit account per ticket
  seniorEscrow: () => find(PROGRAM_ID, "senior_escrow"),
  seniorExit: (ticket: BN | number) => find(PROGRAM_ID, "senior_exit", ticketSeed(ticket)),
  asset: (mint: PublicKey) => find(PROGRAM_ID, "asset", mint),
  vault: (mint: PublicKey) => find(PROGRAM_ID, "vault", mint),
  lpMarket: (whirlpool: PublicKey) => find(PROGRAM_ID, "lp_market", whirlpool),
  credit: (owner: PublicKey) => find(PROGRAM_ID, "credit", owner),
      demoPrice: (mint: PublicKey) => find(PROGRAM_ID, "demo_price", mint),
    // The push oracle's price account for a Pyth feed id, as 64 hex characters or 32 bytes
    pythFeed: (feedId: string | Uint8Array | number[], shard = PYTH_SHARD) =>
      find(PYTH_PUSH_ORACLE_PROGRAM_ID, shardSeed(shard), feedBytes(feedId)),
  orcaPosition: (positionMint: PublicKey) => find(WHIRLPOOL_PROGRAM_ID, "position", positionMint),
  // Where Orca or Raydium keeps the position an NFT controls
  lpPosition: (dexProgram: PublicKey, positionMint: PublicKey) => find(dexProgram, "position", positionMint),
  // Where the upgradeable loader keeps the program's upgrade authority
  programData: () => find(new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111"), PROGRAM_ID),
  // The tick array that holds `tick`
  tickArray: (whirlpool: PublicKey, tick: number, tickSpacing: number) => {
    const span = tickSpacing * TICK_ARRAY_SIZE;
    return find(WHIRLPOOL_PROGRAM_ID, "tick_array", whirlpool, String(Math.floor(tick / span) * span));
  },
};

export const fetchPool = (program: PluribusProgram) => program.account.pool.fetch(pda.pool());
export const fetchCredit = (program: PluribusProgram, owner: PublicKey) =>
  program.account.creditAccount.fetchNullable(pda.credit(owner));
export const fetchAsset = (program: PluribusProgram, mint: PublicKey) => program.account.asset.fetch(pda.asset(mint));
export const fetchLpMarket = (program: PluribusProgram, whirlpool: PublicKey) =>
  program.account.lpMarket.fetch(pda.lpMarket(whirlpool));
export const fetchAllCredits = (program: PluribusProgram) => program.account.creditAccount.all();
// The owner's queued junior exit, or null when there is none
export const fetchJuniorExit = (program: PluribusProgram, owner: PublicKey) =>
  program.account.juniorExit.fetchNullable(pda.juniorExit(owner));
// The owner's queued senior exits, oldest ticket first, cancelled ones included until the queue skips them
export async function fetchSeniorExits(program: PluribusProgram, owner: PublicKey) {
  // The owner key sits right after the discriminator
  const all = await program.account.seniorExit.all([{ memcmp: { offset: 8, bytes: owner.toBase58() } }]);
  return all.map((e) => e.account).sort((a, b) => a.ticket.cmp(b.ticket));
}
// The exit at the head of the senior queue, or null when nothing waits
export async function fetchSeniorHead(program: PluribusProgram) {
  const pool = await fetchPool(program);
  if (pool.seniorHead.gte(pool.seniorNextTicket)) return null;
  return program.account.seniorExit.fetchNullable(pda.seniorExit(pool.seniorHead));
}

// Dollar price per whole token for every asset, as the program reads it
// Shortcut: demo price accounts only, add a Pyth decoder when a deployment leaves demo mode
// What the program reads from a Pyth receiver price update, scaled like `oracle.rs` does:
// dollars per 10^exponent whole tokens with 6 decimals, the price rounded down and its confidence band up
export type PythQuote = { feedId: string; price: BN; conf: BN; publishTime: number };

const PRICE_UPDATE_DISCRIMINATOR = Buffer.from("22f123639d7ef4cd", "hex");
const E6 = new BN(1_000_000);
const unit = (exponent: number) => new BN(10).pow(new BN(exponent));

// A fully verified PriceUpdateV2 account, or null when the program would not accept the data
// `exponent` is the asset's price exponent, which quotes a token worth a fraction of a cent per 10^exponent tokens
export function decodePriceUpdate(data: Uint8Array, exponent = 0): PythQuote | null {
  const d = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  // Layout: disc 8 | write authority 32 | verification 1 (1 is full) | feed id 32 | price i64 | conf u64 | expo i32 | publish time i64
  if (d.length < 101 || !d.subarray(0, 8).equals(PRICE_UPDATE_DISCRIMINATOR) || d[40] !== 1) return null;
  const price = new BN(d.subarray(73, 81), 10, "le").fromTwos(64);
  const conf = new BN(d.subarray(81, 89), 10, "le");
  const expo = d.readInt32LE(89);
  if (!price.gtn(0) || expo > 0 || expo < -18) return null;
  const scale = new BN(10).pow(new BN(-expo));
  return {
    feedId: d.subarray(41, 73).toString("hex"),
    price: price.mul(E6).mul(unit(exponent)).div(scale),
    conf: conf.mul(E6).mul(unit(exponent)).add(scale).subn(1).div(scale),
    publishTime: new BN(d.subarray(93, 101), 10, "le").fromTwos(64).toNumber(),
  };
}

// The price the program values collateral at: the low end of the quote's band, in dollars per whole token
export const quoteLow = (q: { price: BN; conf: BN }) => Math.max(0, q.price.sub(q.conf).toNumber()) / 1e6;

// Which of an asset's two price accounts the program reads: with the pool in demo mode an asset reads its demo account
// until the admin switches it to its live feed, and with demo mode off every asset reads Pyth
export type PriceSources = { demoMode: boolean; assets: Record<string, Asset | null> };

export async function fetchPriceSources(program: PluribusProgram, d: Deployment, pool?: Pool): Promise<PriceSources> {
  const mints = Object.keys(d.assets).filter((m) => m !== d.usdcMint);
  const [p, assets] = await Promise.all([
    pool ?? fetchPool(program),
    program.account.asset.fetchMultiple(mints.map((m) => pda.asset(new PublicKey(m)))),
  ]);
  return { demoMode: p.demoMode, assets: Object.fromEntries(mints.map((m, i) => [m, assets[i]])) };
}

export const isLive = (s: PriceSources, mint: string) => !s.demoMode || !!s.assets[mint]?.livePrice;

// The account the program reads `mint`'s own price from, or undefined when the deployment lists none for that source
// The push oracle account of an asset's Pyth feed, taken from the deployment or derived from the feed id
function pythAccountOf(d: Deployment, mint: string): string | undefined {
  const a = d.assets[mint];
  return a?.pythAccount ?? (a?.feedId ? pda.pythFeed(a.feedId).toBase58() : undefined);
}

// The account the program reads `mint`'s own price from, or undefined when the deployment lists none for that source
function ownAccount(d: Deployment, mint: string, s: PriceSources): string | undefined {
  return isLive(s, mint) ? pythAccountOf(d, mint) : (d.assets[mint]?.priceAccount ?? undefined);
}

// The SOL account a staking token's backing is valued with: it follows the token's own source, so a live token never
// reads a demo SOL price
function backingAccount(d: Deployment, mint: string, s: PriceSources): string | undefined {
  const b = d.assets[mint]?.backing;
  if (!b) return undefined;
  return isLive(s, mint) ? (b.solPythAccount ?? pythAccountOf(d, d.solMint)) : b.solPriceAccount;
}

export function priceAccountFor(d: Deployment, mint: string, s: PriceSources): PublicKey {
  const key = ownAccount(d, mint, s);
  if (!key) throw new Error(`No ${isLive(s, mint) ? "Pyth" : "demo"} price account for ${mint} in the ${d.cluster} deployment`);
  return new PublicKey(key);
}

export function backingAccountFor(d: Deployment, mint: string, s: PriceSources): PublicKey | null {
  const key = backingAccount(d, mint, s);
  return key ? new PublicKey(key) : null;
}

// Dollar price per whole token for every asset, as the program reads it
// Shortcut: a staking token's backing is fixed rates only, a stake pool's rate would need its account read too
export async function fetchPrices(program: PluribusProgram, d: Deployment): Promise<Record<string, number>> {
  const sources = await fetchPriceSources(program, d);
  const mints = Object.keys(d.assets).filter((m) => ownAccount(d, m, sources));
  const keys = [...new Set(mints.flatMap((m) => [ownAccount(d, m, sources)!, backingAccount(d, m, sources) ?? ""]).filter(Boolean))];
  const infos = await program.provider.connection.getMultipleAccountsInfo(keys.map((k) => new PublicKey(k)));
  const info = new Map(keys.map((k, i) => [k, infos[i]]));

  // A demo account holds the price as written, a Pyth one as the program rescales it, both per the asset's priced unit
  const low = (key: string | undefined, live: boolean, exponent = 0): number | undefined => {
    const data = key ? info.get(key)?.data : undefined;
    if (!data) return undefined;
    try {
      const q = live ? decodePriceUpdate(data, exponent) : program.coder.accounts.decode("demoPrice", data);
      return q ? quoteLow(q) / 10 ** exponent : undefined;
    } catch {
      return undefined;
    }
  };
  const prices: Record<string, number> = { [d.usdcMint]: 1 };
  for (const m of mints) {
    const asset = sources.assets[m];
    let price = low(ownAccount(d, m, sources), isLive(sources, m), asset?.priceExponent ?? 0);
    if (price === undefined) continue;
    // A per-share feed on a scaled token is multiplied by the mint's corporate-action multiplier, in tokens per share scaled by 1e9
    if (asset?.params.uiMultiplier) price = (price * asset.mult.toNumber()) / 1e9;
    // A staking token is worth no more than its SOL backing, as the program values it
    const fixed = d.assets[m].backing?.fixedRate;
    const sol = low(backingAccount(d, m, sources), isLive(sources, m));
    if (fixed && sol !== undefined) price = Math.min(price, fixed * sol);
    prices[m] = price;
  }
  return prices;
}

// The accounts a health check reads, in slot order
// `skip` is the mint of a position that the same instruction empties, since its accounts must not be listed
export function healthAccounts(
  _program: PluribusProgram,
  d: Deployment,
  credit: CreditAccount,
  opts: { skip?: PublicKey; lps?: Map<string, LpLocation>; sources: PriceSources },
): AccountMeta[] {
  const keys: PublicKey[] = [];
  for (const p of credit.positions) {
    if (opts.skip?.equals(p.mint)) continue;
    if (p.kind === KIND_TOKEN) {
      keys.push(pda.asset(p.mint));
      // A Token-2022 asset's mint and vault: its issuer can pause it, scale balances, or move tokens out of the vault
      if (d.assets[p.mint.toBase58()]?.tokenProgram === TOKEN_2022) keys.push(p.mint, pda.vault(p.mint));
      if (p.mint.toBase58() !== d.usdcMint) keys.push(priceAccountFor(d, p.mint.toBase58(), opts.sources));
      // A staking token's backing: the SOL price its own source calls for, then its stake pool when it has one
      const backing = backingAccountFor(d, p.mint.toBase58(), opts.sources);
      if (backing) keys.push(backing);
      const stakePool = d.assets[p.mint.toBase58()]?.backing?.stakePool;
      if (stakePool) keys.push(new PublicKey(stakePool));
    } else if (p.kind === KIND_LP) {
      // Without `lps` from `locateLps` every LP is taken to be an Orca position in the main whirlpool
      const at = opts.lps?.get(p.mint.toBase58());
      const base = at?.baseMint.toBase58() ?? d.solMint;
      keys.push(
        at?.market ?? pda.lpMarket(new PublicKey(d.whirlpool)),
        at?.position ?? pda.orcaPosition(p.mint),
        pda.asset(new PublicKey(base)),
        priceAccountFor(d, base, opts.sources),
      );
    }
  }
  return keys.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false }));
}

// Where an LP position lives: its market, the dex's position account, the pool, the dex and the market's base token
export type LpLocation = { market: PublicKey; position: PublicKey; pool: PublicKey; dexProgram: PublicKey; baseMint: PublicKey };

// Finds each LP position of `credit` on Orca or Raydium, keyed by NFT mint
// With only the main whirlpool listed every position is in it, so nothing is fetched
export async function locateLps(connection: Connection, d: Deployment, credit: CreditAccount): Promise<Map<string, LpLocation>> {
  const lps = credit.positions.filter((p) => p.kind === KIND_LP);
  const markets = [{ pool: d.whirlpool, dexProgram: WHIRLPOOL_PROGRAM_ID.toBase58(), baseMint: d.solMint }, ...(d.lpMarkets ?? [])];
  const orcaOnly = !d.lpMarkets?.length;
  const programs = orcaOnly ? [WHIRLPOOL_PROGRAM_ID] : [...new Set(markets.map((m) => m.dexProgram))].map((k) => new PublicKey(k));
  const candidates = lps.flatMap((p) => programs.map((dexProgram) => ({ mint: p.mint, dexProgram, position: pda.lpPosition(dexProgram, p.mint) })));
  const accounts = orcaOnly || !candidates.length ? [] : await connection.getMultipleAccountsInfo(candidates.map((c) => c.position));
  const found = new Map<string, LpLocation>();
  candidates.forEach((c, i) => {
    if (found.has(c.mint.toBase58())) return;
    let pool = new PublicKey(d.whirlpool);
    if (!orcaOnly) {
      const account = accounts[i];
      if (!account?.owner.equals(c.dexProgram)) return;
      pool = decodeLpPosition(c.dexProgram, account.data).pool;
    }
    const market = markets.find((m) => m.pool === pool.toBase58());
    if (!market) return;
    found.set(c.mint.toBase58(), { market: pda.lpMarket(pool), position: c.position, pool, dexProgram: c.dexProgram, baseMint: new PublicKey(market.baseMint) });
  });
  return found;
}

// The deployment's address lookup table while it is active, or null when it has none
// Read again every few minutes, so one that is extended or shut down is picked up without a restart
const tables = new Map<string, { table: AddressLookupTableAccount | null; at: number }>();
export async function fetchLookupTable(connection: Connection, d: Deployment): Promise<AddressLookupTableAccount | null> {
  if (!d.lookupTable) return null;
  const cached = tables.get(d.lookupTable);
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.table;
  const { value } = await connection.getAddressLookupTable(new PublicKey(d.lookupTable));
  const table = value?.isActive() ? value : null;
  tables.set(d.lookupTable, { table, at: Date.now() });
  return table;
}

// A v0 transaction for `instructions`, its accounts shortened through the deployment's lookup table
// A legacy transaction lists every account in full, which a health check over several Token-2022, staking or LP
// positions can push past the 1232-byte limit, and then nobody could liquidate that account
export async function buildTransaction(
  connection: Connection,
  d: Deployment,
  payer: PublicKey,
  instructions: TransactionInstruction[],
  recentBlockhash: string,
): Promise<VersionedTransaction> {
  const table = await fetchLookupTable(connection, d);
  const message = new TransactionMessage({ payerKey: payer, recentBlockhash, instructions }).compileToV0Message(table ? [table] : []);
  return new VersionedTransaction(message);
}

// Every address the protocol's transactions keep reusing, for the lookup table
export function lookupAddresses(d: Deployment): PublicKey[] {
  const k = (s: string) => new PublicKey(s);
  const keys = [
    PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    SystemProgram.programId,
    ComputeBudgetProgram.programId,
    WHIRLPOOL_PROGRAM_ID,
    pda.pool(),
    pda.usdcVault(),
    pda.shareMint(),
    pda.juniorMint(),
    pda.juniorEscrow(),
    pda.seniorEscrow(),
    k(d.whirlpool),
    pda.lpMarket(k(d.whirlpool)),
    k(d.whirlpoolVaultA),
    k(d.whirlpoolVaultB),
  ];
  for (const [mint, a] of Object.entries(d.assets)) {
    keys.push(k(mint), pda.asset(k(mint)), pda.vault(k(mint)));
    // Both price accounts, since the admin can switch an asset between its demo price and its feed
    if (a.priceAccount) keys.push(k(a.priceAccount));
    const feed = pythAccountOf(d, mint);
    if (feed) keys.push(k(feed));
    if (a.backing) {
      keys.push(k(a.backing.solPriceAccount));
      const sol = a.backing.solPythAccount ?? pythAccountOf(d, d.solMint);
      if (sol) keys.push(k(sol));
    }
    if (a.backing?.stakePool) keys.push(k(a.backing.stakePool));
  }
  for (const m of d.lpMarkets ?? []) keys.push(k(m.pool), pda.lpMarket(k(m.pool)), k(m.dexProgram));
  return [...new Map(keys.map((key) => [key.toBase58(), key])).values()];
}

// The program's own numbers for an account, or null when the owner has not opened one
export async function fetchHealth(program: PluribusProgram, d: Deployment, owner: PublicKey): Promise<HealthView | null> {
  const credit = await fetchCredit(program, owner);
  if (!credit) return null;
  const view = await program.methods
    .health()
    .accountsStrict({ credit: pda.credit(owner), pool: pda.pool() })
    .remainingAccounts(
      healthAccounts(program, d, credit, {
        lps: await locateLps(program.provider.connection, d, credit),
        sources: await fetchPriceSources(program, d),
      }),
    )
    .instruction();
  // Nothing is signed: any funded account can stand in as the fee payer
  const message = new TransactionMessage({
    payerKey: new PublicKey(d.admin),
    recentBlockhash: PublicKey.default.toBase58(),
    // Five LP positions cost more than the default 200000 compute units
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), view],
  }).compileToV0Message();
  const { value } = await program.provider.connection.simulateTransaction(new VersionedTransaction(message), {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "confirmed",
  });
  const data = value.returnData?.data[0];
  if (value.err || !data) {
    const reason = decodeError(value.logs ?? [])?.message ?? JSON.stringify(value.err);
    throw new Error(`Health view failed: ${reason}`);
  }
  return program.coder.types.decode("healthView", Buffer.from(data, "base64"));
}

export type PositionInfo = {
  slot: number;
  kind: "token" | "lp";
  // Token mint, or the Orca position NFT mint
  mint: PublicKey;
  // Token base units, or 1 for an LP position
  amount: BN;
  // Input for `math.limits`
  risk: RiskPosition;
};

// An account's positions with everything `math.limits` needs to value them
export async function fetchPositions(program: PluribusProgram, d: Deployment, credit: CreditAccount): Promise<PositionInfo[]> {
  const held = credit.positions.map((p, slot) => ({ ...p, slot })).filter((p) => p.kind !== 0);
  const lps = held.filter((p) => p.kind === KIND_LP);
  const where = await locateLps(program.provider.connection, d, credit);
  const located = lps.map((p) => where.get(p.mint.toBase58()));
  // An LP is priced with its market's base token
  const mintOf = (p: (typeof held)[number]) => (p.kind === KIND_LP ? (where.get(p.mint.toBase58())?.baseMint.toBase58() ?? d.solMint) : p.mint.toBase58());
  const priced = [...new Set(held.map(mintOf))];
  const [assets, markets, pool, lpAccounts] = await Promise.all([
    program.account.asset.fetchMultiple(priced.map((m) => pda.asset(new PublicKey(m)))),
    lps.length ? program.account.lpMarket.fetchMultiple(located.map((l) => l?.market ?? pda.lpMarket(new PublicKey(d.whirlpool)))) : [],
    fetchPool(program),
    lps.length ? program.provider.connection.getMultipleAccountsInfo(located.map((l, i) => l?.position ?? pda.orcaPosition(lps[i].mint))) : [],
  ]);
  // A listing still in its activation delay backs no new debt, the same as a paused one
  const now = Date.now() / 1000;
  const waiting = (activeAt: BN) => now < effectiveAt(pool, activeAt);
  return held.map((p) => {
    const lp = p.kind === KIND_LP;
    const mint = mintOf(p);
    const asset = assets[priced.indexOf(mint)];
    if (!asset) throw new Error(`Asset ${mint} is not whitelisted`);
    const shockBps = dynamicShocks(asset, pool.params);
    const base = { mint, group: asset.params.group, paused: asset.params.paused || waiting(asset.activeAt), shockBps };
    let risk: RiskPosition;
    if (lp) {
      const i = lps.indexOf(p);
      const [data, market] = [lpAccounts[i]?.data, markets[i]];
      if (!data || !market) throw new Error(`LP position for ${p.mint.toBase58()} is missing`);
      const raw = decodeLpPosition(market.dexProgram, data);
      const liquidity = raw.liquidity;
      // With USDC first the range is turned around to price the base token in USDC, as the program does
      const [tickLower, tickUpper] = market.baseFirst ? [raw.tickLower, raw.tickUpper] : [-raw.tickUpper, -raw.tickLower];
      risk = {
        ...base,
        liquidity,
        tickLower,
        tickUpper,
        usdcGroup: pool.usdcGroup,
        liqCostBps: market.liqCostBps,
        paused: base.paused || market.paused || waiting(market.activeAt),
      };
    } else {
      risk = { ...base, liqCostBps: asset.params.liqCostBps, amount: Number(p.amount.toString()) / 10 ** asset.decimals };
    }
    return { slot: p.slot, kind: lp ? "lp" : "token", mint: p.mint, amount: p.amount, risk };
  });
}

const coder = new BorshCoder(convertIdlToCamelCase(idl as unknown as Pluribus));
const events = new EventParser(PROGRAM_ID, coder);

// The program's Anchor events found in a transaction's logs
export function decodeEvents(logs: string[]): { name: string; data: any }[] {
  return [...events.parseLogs(logs)];
}

// The program or Anchor error a failed transaction logged, if any
export function decodeError(logs: string[]): { code: number; name: string; message: string } | null {
  const e = AnchorError.parse(logs)?.error;
  return e ? { code: e.errorCode.number, name: e.errorCode.code, message: e.errorMessage } : null;
}

// Layout: disc 8 | whirlpool 32 | position mint 32 | liquidity u128 | tick lower i32 | tick upper i32
export function decodeOrcaPosition(data: Buffer) {
  return {
    whirlpool: new PublicKey(data.subarray(8, 40)),
    liquidity: new BN(data.subarray(72, 88), "le"),
    tickLower: data.readInt32LE(88),
    tickUpper: data.readInt32LE(92),
  };
}

// A position of either dex, its ticks as the pool keeps them
// Raydium layout: disc 8 | bump 1 | nft mint 32 | pool 32 | tick lower i32 | tick upper i32 | liquidity u128
export function decodeLpPosition(dexProgram: PublicKey, data: Buffer) {
  if (dexProgram.equals(WHIRLPOOL_PROGRAM_ID)) {
    const p = decodeOrcaPosition(data);
    return { pool: p.whirlpool, liquidity: p.liquidity, tickLower: p.tickLower, tickUpper: p.tickUpper };
  }
  return {
    pool: new PublicKey(data.subarray(41, 73)),
    liquidity: new BN(data.subarray(81, 97), "le"),
    tickLower: data.readInt32LE(73),
    tickUpper: data.readInt32LE(77),
  };
}

export type OrcaPosition = {
  positionMint: PublicKey;
  position: PublicKey;
  tokenAccount: PublicKey;
  tokenProgram: PublicKey;
  liquidity: BN;
  tickLower: number;
  tickUpper: number;
  // Dollars per SOL at the range bounds
  priceLower: number;
  priceUpper: number;
  // Whole tokens and dollars at the whirlpool's current price, fees left out
  sol: number;
  usdc: number;
  value: number;
};

// Orca positions in the whitelisted pool whose NFT sits in `owner`'s wallet
// Shortcut: one getMultipleAccounts call, so a wallet with over 100 single-unit tokens needs chunking
export async function listOrcaPositions(connection: Connection, d: Deployment, owner: PublicKey): Promise<OrcaPosition[]> {
  const whirlpool = new PublicKey(d.whirlpool);
  const programs = [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID];
  const [pool, ...owned] = await Promise.all([
    connection.getAccountInfo(whirlpool),
    ...programs.map((programId) => connection.getTokenAccountsByOwner(owner, { programId })),
  ]);
  if (!pool) throw new Error(`Whirlpool ${d.whirlpool} not found`);
  // Sqrt price is a Q64.64 at offset 65
  const sqrt = Number(new BN(pool.data.subarray(65, 81), "le").toString()) / 2 ** 64;
  const price = sqrt * sqrt * 1000;

  // Token account layout: mint 32 | owner 32 | amount u64
  const nfts = owned.flatMap((r, i) =>
    r.value
      .filter((t) => new BN(t.account.data.subarray(64, 72), "le").eqn(1))
      .map((t) => ({
        tokenAccount: t.pubkey,
        tokenProgram: programs[i],
        positionMint: new PublicKey(t.account.data.subarray(0, 32)),
      })),
  );
  const accounts = await connection.getMultipleAccountsInfo(nfts.map((n) => pda.orcaPosition(n.positionMint)));
  return nfts.flatMap((n, i) => {
    const account = accounts[i];
    if (!account?.owner.equals(WHIRLPOOL_PROGRAM_ID)) return [];
    const p = decodeOrcaPosition(account.data);
    if (!p.whirlpool.equals(whirlpool)) return [];
    return [
      {
        ...n,
        position: pda.orcaPosition(n.positionMint),
        liquidity: p.liquidity,
        tickLower: p.tickLower,
        tickUpper: p.tickUpper,
        priceLower: tickToPrice(p.tickLower),
        priceUpper: tickToPrice(p.tickUpper),
        ...lpAmounts(p.liquidity, p.tickLower, p.tickUpper, price),
        value: lpValue(p.liquidity, p.tickLower, p.tickUpper, price),
      },
    ];
  });
}
