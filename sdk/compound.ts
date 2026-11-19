// Bounty-paid compounding: anyone puts the fees of positions whose owners opted in back into those positions,
// and is paid the pool's `compoundBountyBps` share of them
import {
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  type Connection,
  type Keypair,
  PublicKey,
  type TransactionInstruction,
  type VersionedTransaction,
} from "@solana/web3.js";
import { Buffer } from "buffer";
import {
  type CreditAccount,
  type Deployment,
  KIND_DLMM,
  KIND_LP,
  type PluribusProgram,
  WHIRLPOOL_PROGRAM_ID,
  buildTransaction,
  decodeOrcaPosition,
  fetchAllCredits,
  fetchPool,
  fetchPriceSources,
  fetchPrices,
  locateLps,
  pda,
  priceAccountFor,
} from "./core";

const key = (s: string) => new PublicKey(s);
const ata = (mint: PublicKey, owner: PublicKey) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_PROGRAM_ID);

// The most a borrower can let a position compound at, and the most the bounty can be, both in bps
export const MAX_COMPOUND_SLIPPAGE_BPS = 1_000;
export const MAX_COMPOUND_BOUNTY_BPS = 500;

// Owner: lets anyone compound a held position while the pool price is within `slippageBps` of the oracle's, or 0 to have
// its fees repay debt through autopay instead
export async function setCompound(program: PluribusProgram, owner: PublicKey, position: PublicKey, slippageBps: number) {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_COMPOUND_SLIPPAGE_BPS) {
    throw new Error(`Compound tolerance must be 0 to ${MAX_COMPOUND_SLIPPAGE_BPS} bps`);
  }
  return [await program.methods.setCompound(position, slippageBps).accountsStrict({ owner, credit: pda.credit(owner) }).instruction()];
}

// Admin: the share of compounded fees the caller is paid
export async function setCompoundBounty(program: PluribusProgram, admin: PublicKey, bountyBps: number) {
  return [await program.methods.setCompoundBounty(bountyBps).accountsStrict({ admin, pool: pda.pool() }).instruction()];
}

// Compounds a held Orca position in the main whirlpool, paying the bounty to `recipient`'s token accounts, which must exist
export async function compoundOrca(
  program: PluribusProgram,
  d: Deployment,
  caller: PublicKey,
  owner: PublicKey,
  positionMint: PublicKey,
  recipient: PublicKey,
): Promise<TransactionInstruction[]> {
  const [whirlpool, usdc, sol, position] = [key(d.whirlpool), key(d.usdcMint), key(d.solMint), pda.orcaPosition(positionMint)];
  const [mint, account] = await program.provider.connection.getMultipleAccountsInfo([positionMint, position]);
  if (!mint || !account) throw new Error(`Orca position for ${positionMint.toBase58()} not found`);
  const { tickLower, tickUpper } = decodeOrcaPosition(account.data);
  const sources = await fetchPriceSources(program, d);
  return [
    await program.methods
      .compoundOrca()
      .accountsStrict({
        caller,
        credit: pda.credit(owner),
        pool: pda.pool(),
        lpMarket: pda.lpMarket(whirlpool),
        whirlpool,
        position,
        positionMint,
        vaultNft: getAssociatedTokenAddressSync(positionMint, pda.pool(), true, mint.owner),
        tickArrayLower: pda.tickArray(whirlpool, tickLower, d.tickSpacing),
        tickArrayUpper: pda.tickArray(whirlpool, tickUpper, d.tickSpacing),
        baseAsset: pda.asset(sol),
        baseMint: sol,
        baseVault: pda.vault(sol),
        basePrice: priceAccountFor(d, sol.toBase58(), sources),
        whirlpoolVaultA: key(d.whirlpoolVaultA),
        usdcAsset: pda.asset(usdc),
        usdcCollateralVault: pda.vault(usdc),
        whirlpoolVaultB: key(d.whirlpoolVaultB),
        usdcMint: usdc,
        bountyBase: ata(sol, recipient),
        bountyUsdc: ata(usdc, recipient),
        tokenProgram: TOKEN_PROGRAM_ID,
        whirlpoolProgram: WHIRLPOOL_PROGRAM_ID,
      })
      .instruction(),
  ];
}

export type Compoundable = {
  owner: PublicKey;
  position: PublicKey;
  dex: "orca" | "raydium" | "meteora";
  baseMint: PublicKey;
  // The instructions without a compute limit, so several can share one transaction
  ixs: TransactionInstruction[];
  // What the bounty would pay the recipient right now, from a simulation, in base units and in dollars
  bountyBase: bigint;
  bountyUsdc: bigint;
  usd: number;
  units: number;
};

type Builder = (owner: PublicKey, position: PublicKey, credit: CreditAccount, recipient: PublicKey) => Promise<{ dex: Compoundable["dex"]; baseMint: PublicKey; ixs: TransactionInstruction[] } | null>;

// Every position whose owner opted in, with what compounding it would pay `recipient` now, the best first
// Each candidate is simulated on its own, `concurrency` at a time, so one that would fail (fees not worth it, pool price
// outside its owner's tolerance) is simply left out
export async function findCompoundable(
  program: PluribusProgram,
  d: Deployment,
  caller: PublicKey,
  recipient: PublicKey,
  opts: { concurrency?: number; minUsd?: number; builders?: Partial<Record<"raydium" | "meteora", Builder>> } = {},
): Promise<Compoundable[]> {
  const connection = program.provider.connection;
  const [credits, prices] = await Promise.all([fetchAllCredits(program), fetchPrices(program, d)]);
  const candidates: { owner: PublicKey; position: PublicKey; credit: CreditAccount }[] = [];
  for (const { account } of credits) {
    account.positions.forEach((p, slot) => {
      if ((p.kind === KIND_LP || p.kind === KIND_DLMM) && account.compoundSlippageBps[slot] > 0) {
        candidates.push({ owner: account.owner, position: p.mint, credit: account });
      }
    });
  }
  const usdc = key(d.usdcMint);
  const orca: Builder = async (owner, position, credit) => {
    const at = (await locateLps(connection, d, credit)).get(position.toBase58());
    if (!at?.dexProgram.equals(WHIRLPOOL_PROGRAM_ID) || !at.pool.equals(key(d.whirlpool))) return null;
    return { dex: "orca", baseMint: key(d.solMint), ixs: await compoundOrca(program, d, caller, owner, position, recipient) };
  };
  const build = async (c: (typeof candidates)[number]) => {
    const kind = c.credit.positions.find((p) => p.mint.equals(c.position))?.kind;
    const builders = kind === KIND_DLMM ? [opts.builders?.meteora] : [orca, opts.builders?.raydium];
    for (const b of builders) {
      const built = b && (await b(c.owner, c.position, c.credit, recipient).catch(() => null));
      if (built) return built;
    }
    return null;
  };

  const found: Compoundable[] = [];
  const queue = [...candidates];
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      const built = await build(c);
      if (!built) continue;
      const bounty = [ata(built.baseMint, recipient), ata(usdc, recipient)];
      const { blockhash } = await connection.getLatestBlockhash();
      const tx = await buildTransaction(connection, d, caller, [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...built.ixs], blockhash);
      const [before, run] = await Promise.all([
        connection.getMultipleAccountsInfo(bounty),
        connection.simulateTransaction(tx, {
          sigVerify: false,
          replaceRecentBlockhash: true,
          accounts: { encoding: "base64", addresses: bounty.map((b) => b.toBase58()) },
        }),
      ]);
      if (run.value.err) continue;
      // A token account holds its balance as eight bytes at offset 64
      const balance = (data: Buffer | undefined) => (data && data.length >= 72 ? data.readBigUInt64LE(64) : BigInt(0));
      const after = run.value.accounts ?? [];
      const [bountyBase, bountyUsdc] = [0, 1].map((i) => balance(after[i] ? Buffer.from(after[i]!.data[0], "base64") : undefined) - balance(before[i]?.data));
      const decimals = d.assets[built.baseMint.toBase58()]?.decimals ?? 9;
      const usd = (Number(bountyBase) / 10 ** decimals) * (prices[built.baseMint.toBase58()] ?? 0) + Number(bountyUsdc) / 1e6;
      if (usd < (opts.minUsd ?? 0) || (bountyBase === BigInt(0) && bountyUsdc === BigInt(0))) continue;
      found.push({ owner: c.owner, position: c.position, ...built, bountyBase, bountyUsdc, usd, units: run.value.unitsConsumed ?? 1_400_000 });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, worker));
  return found.sort((a, b) => b.usd - a.usd);
}

// Packs compounds into as few transactions as fit: under the compute limit with some room, under the account-lock limit,
// and under the size limit through the deployment's lookup table
export async function packCompounds(
  connection: Connection,
  d: Deployment,
  payer: PublicKey,
  items: Compoundable[],
  opts: { maxUnits?: number; maxAccounts?: number } = {},
): Promise<Packed[]> {
  const maxUnits = opts.maxUnits ?? 1_300_000;
  const maxAccounts = opts.maxAccounts ?? 60;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const make = (group: Compoundable[]) => {
    const units = Math.min(1_400_000, Math.ceil(group.reduce((s, i) => s + i.units, 0) * 1.1));
    return buildTransaction(connection, d, payer, [ComputeBudgetProgram.setComputeUnitLimit({ units }), ...group.flatMap((i) => i.ixs)], blockhash);
  };
  const accounts = (group: Compoundable[]) => new Set(group.flatMap((i) => i.ixs.flatMap((ix) => [ix.programId, ...ix.keys.map((k) => k.pubkey)])).map((k) => k.toBase58())).size;
  const fits = async (group: Compoundable[]) => {
    if (group.reduce((s, i) => s + i.units, 0) * 1.1 > maxUnits || accounts(group) > maxAccounts) return false;
    try {
      return (await make(group)).serialize().length <= 1232;
    } catch {
      return false;
    }
  };
  const out: Packed[] = [];
  let group: Compoundable[] = [];
  for (const item of items) {
    if (group.length && !(await fits([...group, item]))) {
      out.push({ tx: await make(group), items: group, blockhash, lastValidBlockHeight });
      group = [];
    }
    group.push(item);
  }
  if (group.length) out.push({ tx: await make(group), items: group, blockhash, lastValidBlockHeight });
  return out;
}

// One packed transaction, with the blockhash it was built on so its confirmation waits exactly as long as it can land
export type Packed = { tx: VersionedTransaction; items: Compoundable[]; blockhash: string; lastValidBlockHeight: number };

// The recipient's token accounts for the bounty, for every token the compounds pay in, made first when missing
export async function bountyAccountSetup(connection: Connection, d: Deployment, payer: PublicKey, recipient: PublicKey, items: Compoundable[]) {
  const mints = [...new Set([d.usdcMint, ...items.map((i) => i.baseMint.toBase58())])].map(key);
  const infos = await connection.getMultipleAccountsInfo(mints.map((m) => ata(m, recipient)));
  return mints.flatMap((m, i) => (infos[i] ? [] : [createAssociatedTokenAccountIdempotentInstruction(payer, ata(m, recipient), recipient, m, TOKEN_PROGRAM_ID)]));
}

// Signs and sends packed compounds, `concurrency` transactions at a time, with either a key the caller holds
// (a throwaway browser key, the keeper's) or a wallet that signs a whole batch in one prompt
export async function sendCompounds(
  connection: Connection,
  packed: Packed[],
  signer: { keypair: Keypair } | { signAllTransactions: (txs: VersionedTransaction[]) => Promise<VersionedTransaction[]> },
  opts: { concurrency?: number } = {},
): Promise<{ signature: string | null; items: Compoundable[]; error?: string }[]> {
  const txs = packed.map((p) => p.tx);
  const signed = "keypair" in signer ? txs.map((tx) => (tx.sign([signer.keypair]), tx)) : await signer.signAllTransactions(txs);
  const results: { signature: string | null; items: Compoundable[]; error?: string }[] = [];
  const queue = signed.map((tx, i) => ({ ...packed[i], tx }));
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      try {
        const signature = await connection.sendTransaction(job.tx);
        const { blockhash, lastValidBlockHeight } = job;
        const { value } = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
        results.push({ signature, items: job.items, error: value.err ? JSON.stringify(value.err) : undefined });
      } catch (e) {
        results.push({ signature: null, items: job.items, error: (e as Error).message });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, worker));
  return results;
}

// The pool's current bounty in bps
export async function fetchCompoundBounty(program: PluribusProgram) {
  return (await fetchPool(program)).compoundBountyBps;
}
