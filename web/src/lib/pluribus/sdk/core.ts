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
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  type AccountMeta,
  ComputeBudgetProgram,
  type Connection,
  PublicKey,
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
  // Indexed by mint, and USDC has no price account because it is fixed at $1
  // A liquid staking token also names the SOL price account its backing is valued with, its stake pool or fixed rate
  assets: Record<
    string,
    {
      symbol: string;
      name: string;
      decimals: number;
      priceAccount: string | null;
      backing?: { solPriceAccount: string; stakePool?: string; fixedRate?: number };
      // Token-2022 assets, like xStocks: their mint is read in every health check
      tokenProgram?: string;
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
export type AssetParams = IdlTypes<Pluribus>["assetParams"];
export type Wallet = ConstructorParameters<typeof AnchorProvider>[1];

export const PROGRAM_ID = new PublicKey(idl.address);
export const WHIRLPOOL_PROGRAM_ID = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
export const KIND_TOKEN = 1;
export const KIND_LP = 2;
export const MAX_U64 = new BN("18446744073709551615");
const TICK_ARRAY_SIZE = 88;

// Reads need no wallet, and instruction builders never sign
export function getProgram(connection: Connection, wallet?: Wallet): PluribusProgram {
  const provider = wallet ? new AnchorProvider(connection, wallet, { commitment: "confirmed" }) : { connection };
  return new Program<Pluribus>(idl as unknown as Pluribus, provider);
}

const find = (program: PublicKey, ...seeds: (string | PublicKey)[]) =>
  PublicKey.findProgramAddressSync(
    seeds.map((s) => (typeof s === "string" ? Buffer.from(s) : s.toBuffer())),
    program,
  )[0];

export const pda = {
  pool: () => find(PROGRAM_ID, "pool"),
  usdcVault: () => find(PROGRAM_ID, "usdc_vault"),
  shareMint: () => find(PROGRAM_ID, "share_mint"),
  juniorMint: () => find(PROGRAM_ID, "junior_mint"),
  // Holds junior shares while they wait in the exit queue
  juniorEscrow: () => find(PROGRAM_ID, "junior_escrow"),
  juniorExit: (owner: PublicKey) => find(PROGRAM_ID, "junior_exit", owner),
  asset: (mint: PublicKey) => find(PROGRAM_ID, "asset", mint),
  vault: (mint: PublicKey) => find(PROGRAM_ID, "vault", mint),
  lpMarket: (whirlpool: PublicKey) => find(PROGRAM_ID, "lp_market", whirlpool),
  credit: (owner: PublicKey) => find(PROGRAM_ID, "credit", owner),
  demoPrice: (mint: PublicKey) => find(PROGRAM_ID, "demo_price", mint),
  orcaPosition: (positionMint: PublicKey) => find(WHIRLPOOL_PROGRAM_ID, "position", positionMint),
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

// Dollar price per whole token for every asset, as the program reads it
// Shortcut: demo price accounts only, add a Pyth decoder when a deployment leaves demo mode
export async function fetchPrices(program: PluribusProgram, d: Deployment): Promise<Record<string, number>> {
  const mints = Object.keys(d.assets).filter((m) => d.assets[m].priceAccount);
  const accounts = await program.account.demoPrice.fetchMultiple(mints.map((m) => d.assets[m].priceAccount!));
  const prices: Record<string, number> = { [d.usdcMint]: 1 };
  mints.forEach((m, i) => {
    const a = accounts[i];
    if (a) prices[m] = a.price.sub(a.conf).toNumber() / 1e6;
  });
  // A staking token is worth no more than its SOL backing, as the program values it
  // Shortcut: fixed rates only, a stake pool's rate would need its account read too
  for (const m of mints) {
    const fixed = d.assets[m].backing?.fixedRate;
    if (fixed && prices[m] !== undefined && prices[d.solMint] !== undefined) prices[m] = Math.min(prices[m], fixed * prices[d.solMint]);
  }
  return prices;
}

const priceAccount = (d: Deployment, mint: string) => {
  const key = d.assets[mint]?.priceAccount;
  if (!key) throw new Error(`No price account for ${mint} in the ${d.cluster} deployment`);
  return new PublicKey(key);
};

// The accounts a health check reads, in slot order
// `skip` is the mint of a position that the same instruction empties, since its accounts must not be listed
export function healthAccounts(
  _program: PluribusProgram,
  d: Deployment,
  credit: CreditAccount,
  opts: { skip?: PublicKey } = {},
): AccountMeta[] {
  const keys: PublicKey[] = [];
  for (const p of credit.positions) {
    if (opts.skip?.equals(p.mint)) continue;
    if (p.kind === KIND_TOKEN) {
      keys.push(pda.asset(p.mint));
      if (d.assets[p.mint.toBase58()]?.tokenProgram === TOKEN_2022) keys.push(p.mint);
      if (p.mint.toBase58() !== d.usdcMint) keys.push(priceAccount(d, p.mint.toBase58()));
      // A staking token's backing: the SOL price, then its stake pool when it has one
      const backing = d.assets[p.mint.toBase58()]?.backing;
      if (backing) keys.push(new PublicKey(backing.solPriceAccount));
      if (backing?.stakePool) keys.push(new PublicKey(backing.stakePool));
    } else if (p.kind === KIND_LP) {
      keys.push(
        pda.lpMarket(new PublicKey(d.whirlpool)),
        pda.orcaPosition(p.mint),
        pda.asset(new PublicKey(d.solMint)),
        priceAccount(d, d.solMint),
      );
    }
  }
  return keys.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false }));
}

// The program's own numbers for an account, or null when the owner has not opened one
export async function fetchHealth(program: PluribusProgram, d: Deployment, owner: PublicKey): Promise<HealthView | null> {
  const credit = await fetchCredit(program, owner);
  if (!credit) return null;
  const view = await program.methods
    .health()
    .accountsStrict({ credit: pda.credit(owner), pool: pda.pool() })
    .remainingAccounts(healthAccounts(program, d, credit))
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
  const priced = [...new Set(held.map((p) => (p.kind === KIND_LP ? d.solMint : p.mint.toBase58())))];
  const [assets, market, pool, orca] = await Promise.all([
    program.account.asset.fetchMultiple(priced.map((m) => pda.asset(new PublicKey(m)))),
    lps.length ? fetchLpMarket(program, new PublicKey(d.whirlpool)) : null,
    fetchPool(program),
    program.provider.connection.getMultipleAccountsInfo(lps.map((p) => pda.orcaPosition(p.mint))),
  ]);
  // A listing still in its activation delay backs no new debt, the same as a paused one
  const now = Date.now() / 1000;
  const waiting = (activeAt: BN) => now < effectiveAt(pool, activeAt);
  return held.map((p) => {
    const lp = p.kind === KIND_LP;
    const mint = lp ? d.solMint : p.mint.toBase58();
    const asset = assets[priced.indexOf(mint)];
    if (!asset) throw new Error(`Asset ${mint} is not whitelisted`);
    const shockBps = dynamicShocks(asset, pool.params);
    const base = { mint, group: asset.params.group, paused: asset.params.paused || waiting(asset.activeAt), shockBps };
    let risk: RiskPosition;
    if (lp) {
      const data = orca[lps.indexOf(p)]?.data;
      if (!data || !market) throw new Error(`Orca position for ${p.mint.toBase58()} is missing`);
      const { liquidity, tickLower, tickUpper } = decodeOrcaPosition(data);
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
