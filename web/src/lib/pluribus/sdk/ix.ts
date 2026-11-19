// One builder per instruction, each returning everything a wallet has to send for it
import BN from "bn.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { ComputeBudgetProgram, PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import {
  type AssetParams,
  type Deployment,
  type PluribusProgram,
  type PoolParams,
  KIND_TOKEN,
  WHIRLPOOL_PROGRAM_ID,
  decodeOrcaPosition,
  fetchCredit,
  type CreditAccount,
  healthAccounts,
  locateLps,
  pda, fetchPriceSources, priceAccountFor, backingAccountFor } from "./core";

// Token amounts are always base units
export type Amount = BN | bigint | number;
type Ixs = Promise<TransactionInstruction[]>;

const bn = (x: Amount) => {
  if (typeof x === "number" ? !Number.isSafeInteger(x) || x < 0 : BN.isBN(x) ? x.isNeg() : x < BigInt(0)) {
    throw new Error(`Amount ${x} is not a whole, positive number of base units`);
  }
  return new BN(x.toString());
};
const key = (s: string) => new PublicKey(s);
const systemProgram = SystemProgram.programId;
const tokenProgram = TOKEN_PROGRAM_ID;

// A health check over five LP positions costs about 125k units and a liquidation adds to that
const budget = () => ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

const ata = (mint: PublicKey, owner: PublicKey, program = TOKEN_PROGRAM_ID) =>
  getAssociatedTokenAddressSync(mint, owner, true, program);
const createAta = (payer: PublicKey, mint: PublicKey, program = TOKEN_PROGRAM_ID) =>
  createAssociatedTokenAccountIdempotentInstruction(payer, ata(mint, payer, program), payer, mint, program);
// Closing a wSOL account pays its whole balance out as SOL
const unwrap = (owner: PublicKey) => createCloseAccountInstruction(ata(NATIVE_MINT, owner), owner, owner);

async function creditOf(program: PluribusProgram, owner: PublicKey) {
  const credit = await fetchCredit(program, owner);
  if (!credit) throw new Error(`${owner.toBase58()} has no credit account`);
  return credit;
}

// Position NFTs live under classic Token or Token-2022, depending on how Orca opened them
async function nftProgram(program: PluribusProgram, mint: PublicKey) {
  const info = await program.provider.connection.getAccountInfo(mint);
  if (!info) throw new Error(`Mint ${mint.toBase58()} not found`);
  return info.owner;
}

const usdcAccounts = (d: Deployment) => ({
  pool: pda.pool(),
  usdcMint: key(d.usdcMint),
  usdcVault: pda.usdcVault(),
  tokenProgram,
});

// `program` is the asset's token program: classic, or Token-2022 for tokens like xStocks
const moveToken = (owner: PublicKey, mint: PublicKey, program = TOKEN_PROGRAM_ID) => ({
  owner,
  credit: pda.credit(owner),
  pool: pda.pool(),
  asset: pda.asset(mint),
  mint,
  vault: pda.vault(mint),
  ownerToken: ata(mint, owner, program),
  tokenProgram: program,
});

// The token program a deployment lists `mint` under
const programOf = (d: Deployment, mint: PublicKey) => key(d.assets[mint.toBase58()]?.tokenProgram ?? TOKEN_PROGRAM_ID.toBase58());

// The share mint passed in decides the tranche
type Tranche = { junior?: boolean };
const shareMint = (t: Tranche) => (t.junior ? pda.juniorMint() : pda.shareMint());

const lend = (d: Deployment, lender: PublicKey, t: Tranche) => ({
  ...usdcAccounts(d),
  lender,
  shareMint: shareMint(t),
  lenderUsdc: ata(key(d.usdcMint), lender),
  lenderShares: ata(shareMint(t), lender),
});

export async function openAccount(program: PluribusProgram, owner: PublicKey): Ixs {
  return [
    await program.methods.openAccount().accountsStrict({ owner, credit: pda.credit(owner), systemProgram }).instruction(),
  ];
}

// SOL collateral is wrapped on the way in, and the temporary wSOL account is closed again
export async function depositToken(
  program: PluribusProgram,
  owner: PublicKey,
  mint: PublicKey,
  amount: Amount,
  tokenProgram = TOKEN_PROGRAM_ID,
): Ixs {
  const sol = mint.equals(NATIVE_MINT);
  const token = ata(mint, owner, tokenProgram);
  return [
    createAta(owner, mint, tokenProgram),
    ...(sol
      ? [
          SystemProgram.transfer({ fromPubkey: owner, toPubkey: token, lamports: BigInt(amount.toString()) }),
          createSyncNativeInstruction(token),
        ]
      : []),
    await program.methods.depositToken(bn(amount)).accountsStrict(moveToken(owner, mint, tokenProgram)).instruction(),
    ...(sol ? [unwrap(owner)] : []),
  ];
}

export async function withdrawToken(
  program: PluribusProgram,
  d: Deployment,
  owner: PublicKey,
  mint: PublicKey,
  amount: Amount,
): Ixs {
  const credit = await creditOf(program, owner);
  const emptied = credit.positions.some((p) => p.kind === KIND_TOKEN && p.mint.equals(mint) && p.amount.eq(bn(amount)));
  return [
    budget(),
    createAta(owner, mint, programOf(d, mint)),
    await program.methods
      .withdrawToken(bn(amount))
      .accountsStrict(moveToken(owner, mint, programOf(d, mint)))
      .remainingAccounts(await health(program, d, credit, { skip: emptied ? mint : undefined }))
      .instruction(),
    ...(mint.equals(NATIVE_MINT) ? [unwrap(owner)] : []),
  ];
}

// The accounts a health check reads, with each LP position found on its own dex
const health = async (program: PluribusProgram, d: Deployment, credit: CreditAccount, opts: { skip?: PublicKey } = {}) => {
  const [lps, sources] = await Promise.all([locateLps(program.provider.connection, d, credit), fetchPriceSources(program, d)]);
  return healthAccounts(program, d, credit, { ...opts, lps, sources });
};

// A listed LP market's dex and base token: the main whirlpool, or one of the deployment's `lpMarkets`
const lpMarketOf = (d: Deployment, pool: PublicKey) => {
  if (pool.equals(key(d.whirlpool))) return { dexProgram: WHIRLPOOL_PROGRAM_ID, baseMint: key(d.solMint) };
  const m = d.lpMarkets?.find((x) => x.pool === pool.toBase58());
  if (!m) throw new Error(`No LP market for pool ${pool.toBase58()} in the ${d.cluster} deployment`);
  return { dexProgram: key(m.dexProgram), baseMint: key(m.baseMint) };
};

// `pool` is the position's Orca whirlpool or Raydium pool, the main whirlpool unless given
export async function depositLp(
  program: PluribusProgram,
  d: Deployment,
  owner: PublicKey,
  positionMint: PublicKey,
  pool = key(d.whirlpool),
): Ixs {
  const [nft, market] = [await nftProgram(program, positionMint), lpMarketOf(d, pool)];
  return [
    await program.methods
      .depositLp()
      .accountsStrict({
        owner,
        credit: pda.credit(owner),
        pool: pda.pool(),
        lpMarket: pda.lpMarket(pool),
        baseAsset: pda.asset(market.baseMint),
        position: pda.lpPosition(market.dexProgram, positionMint),
        positionMint,
        ownerNft: ata(positionMint, owner, nft),
        vaultNft: ata(positionMint, pda.pool(), nft),
        tokenProgram: nft,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram,
      })
      .instruction(),
  ];
}

export async function withdrawLp(program: PluribusProgram, d: Deployment, owner: PublicKey, positionMint: PublicKey): Ixs {
  const [credit, nft] = await Promise.all([creditOf(program, owner), nftProgram(program, positionMint)]);
  return [
    budget(),
    createAta(owner, positionMint, nft),
    await program.methods
      .withdrawLp()
      .accountsStrict({
        owner,
        credit: pda.credit(owner),
        pool: pda.pool(),
        positionMint,
        vaultNft: ata(positionMint, pda.pool(), nft),
        ownerNft: ata(positionMint, owner, nft),
        tokenProgram: nft,
      })
      .remainingAccounts(await health(program, d, credit, { skip: positionMint }))
      .instruction(),
  ];
}

export async function draw(program: PluribusProgram, d: Deployment, owner: PublicKey, amount: Amount): Ixs {
  const credit = await creditOf(program, owner);
  return [
    budget(),
    createAta(owner, key(d.usdcMint)),
    await program.methods
      .draw(bn(amount))
      .accountsStrict({
        ...usdcAccounts(d),
        owner,
        credit: pda.credit(owner),
        ownerUsdc: ata(key(d.usdcMint), owner),
      })
      .remainingAccounts(await health(program, d, credit))
      .instruction(),
  ];
}

// Pays `owner`'s debt from `payer`'s wallet, and an amount over the debt (such as MAX_U64) repays all of it
export async function repay(
  program: PluribusProgram,
  d: Deployment,
  payer: PublicKey,
  owner: PublicKey,
  amount: Amount,
): Ixs {
  return [
    await program.methods
      .repay(bn(amount))
      .accountsStrict({
        ...usdcAccounts(d),
        payer,
        credit: pda.credit(owner),
        payerUsdc: ata(key(d.usdcMint), payer),
      })
      .instruction(),
  ];
}

// Pays debt with the account's own USDC collateral, which anyone may do once it is liquidatable
export async function repayFromCollateral(
  program: PluribusProgram,
  d: Deployment,
  caller: PublicKey,
  owner: PublicKey,
  amount: Amount,
): Ixs {
  const credit = await creditOf(program, owner);
  const usdc = key(d.usdcMint);
  return [
    budget(),
    await program.methods
      .repayFromCollateral(bn(amount))
      .accountsStrict({
        ...usdcAccounts(d),
        caller,
        credit: pda.credit(owner),
        usdcAsset: pda.asset(usdc),
        usdcCollateralVault: pda.vault(usdc),
      })
      .remainingAccounts(await health(program, d, credit))
      .instruction(),
  ];
}

// Junior lenders earn part of the senior interest and take losses first
export async function lendDeposit(
  program: PluribusProgram,
  d: Deployment,
  lender: PublicKey,
  amount: Amount,
  tranche: Tranche = {},
): Ixs {
  return [
    createAta(lender, shareMint(tranche)),
    await program.methods.lendDeposit(bn(amount)).accountsStrict(lend(d, lender, tranche)).instruction(),
  ];
}

// Senior shares only: junior shares leave through `requestJuniorExit` and `claimJuniorExit`
export async function lendWithdraw(
  program: PluribusProgram,
  d: Deployment,
  lender: PublicKey,
  shares: Amount,
  tranche: Tranche = {},
): Ixs {
  return [
    createAta(lender, key(d.usdcMint)),
    await program.methods.lendWithdraw(bn(shares)).accountsStrict(lend(d, lender, tranche)).instruction(),
  ];
}

// Turns senior shares into junior shares at both share prices, with no USDC moving
export async function convertToJunior(program: PluribusProgram, lender: PublicKey, shares: Amount): Ixs {
  return [
    createAta(lender, pda.juniorMint()),
    await program.methods
      .convertToJunior(bn(shares))
      .accountsStrict({
        lender,
        pool: pda.pool(),
        shareMint: pda.shareMint(),
        juniorMint: pda.juniorMint(),
        lenderShares: ata(pda.shareMint(), lender),
        lenderJunior: ata(pda.juniorMint(), lender),
        tokenProgram,
      })
      .instruction(),
  ];
}

// Puts senior shares at the back of the withdrawal queue, for when the pool's idle cash cannot pay them at once
// The ticket is read from the pool now, so a request racing another for the same ticket fails and can be sent again
export async function requestSeniorExit(program: PluribusProgram, owner: PublicKey, shares: Amount): Ixs {
  const pool = await program.account.pool.fetch(pda.pool());
  return [
    await program.methods
      .requestSeniorExit(bn(shares))
      .accountsStrict({
        owner,
        pool: pda.pool(),
        shareMint: pda.shareMint(),
        ownerShares: ata(pda.shareMint(), owner),
        seniorEscrow: pda.seniorEscrow(),
        exit: pda.seniorExit(pool.seniorNextTicket),
        tokenProgram,
        systemProgram,
      })
      .instruction(),
  ];
}

// Permissionless: pays the head of the senior queue into its owner's USDC account, or skips it when cancelled
// Returns nothing when the queue is empty
export async function settleSeniorExit(program: PluribusProgram, d: Deployment, caller: PublicKey): Ixs {
  const pool = await program.account.pool.fetch(pda.pool());
  if (pool.seniorHead.gte(pool.seniorNextTicket)) return [];
  const exit = pda.seniorExit(pool.seniorHead);
  const { owner } = await program.account.seniorExit.fetch(exit);
  const usdcMint = key(d.usdcMint);
  return [
    await program.methods
      .settleSeniorExit()
      .accountsStrict({
        caller,
        pool: pda.pool(),
        exit,
        owner,
        shareMint: pda.shareMint(),
        seniorEscrow: pda.seniorEscrow(),
        usdcMint,
        usdcVault: pda.usdcVault(),
        ownerUsdc: ata(usdcMint, owner),
        tokenProgram,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram,
      })
      .instruction(),
  ];
}

// Owner only, at any time: shares worth what was queued come back and the cash held for them is freed
export async function cancelSeniorExit(program: PluribusProgram, owner: PublicKey, ticket: BN | number): Ixs {
  return [
    await program.methods
      .cancelSeniorExit()
      .accountsStrict({
        owner,
        pool: pda.pool(),
        exit: pda.seniorExit(ticket),
        shareMint: pda.shareMint(),
        seniorEscrow: pda.seniorEscrow(),
        ownerShares: ata(pda.shareMint(), owner),
        tokenProgram,
      })
      .instruction(),
  ];
}

// Closes a credit account with no debt and no positions, returning its rent to the owner
export async function closeAccount(program: PluribusProgram, owner: PublicKey): Ixs {
  return [await program.methods.closeAccount().accountsStrict({ owner, credit: pda.credit(owner) }).instruction()];
}

// Admin: grows a pool from before the last layout change, right after a program upgrade
export async function migratePool(program: PluribusProgram, admin: PublicKey): Ixs {
  return [await program.methods.migratePool().accountsStrict({ admin, pool: pda.pool(), systemProgram }).instruction()];
}

// Permissionless: grows an asset or credit account created before the last layout change, the payer covering the extra rent
// Every old account needs this once after an upgrade, and one already at size is left alone
export async function migrateAccount(program: PluribusProgram, payer: PublicKey, account: PublicKey): Ixs {
  return [await program.methods.migrateAccount().accountsStrict({ payer, account, systemProgram }).instruction()];
}

// Moves junior shares into the exit queue, one exit per owner at a time
export async function requestJuniorExit(program: PluribusProgram, owner: PublicKey, shares: Amount): Ixs {
  return [
    await program.methods
      .requestJuniorExit(bn(shares))
      .accountsStrict({
        owner,
        pool: pda.pool(),
        juniorMint: pda.juniorMint(),
        ownerJunior: ata(pda.juniorMint(), owner),
        juniorEscrow: pda.juniorEscrow(),
        exit: pda.juniorExit(owner),
        tokenProgram,
        systemProgram,
      })
      .instruction(),
  ];
}

// Pays a queued exit out in USDC, which needs idle cash in the pool, or in senior shares, which never does
export async function claimJuniorExit(
  program: PluribusProgram,
  d: Deployment,
  owner: PublicKey,
  opts: { inUsdc?: boolean } = {},
): Ixs {
  const payoutMint = opts.inUsdc === false ? pda.shareMint() : key(d.usdcMint);
  return [
    createAta(owner, payoutMint),
    await program.methods
      .claimJuniorExit()
      .accountsStrict({
        owner,
        pool: pda.pool(),
        exit: pda.juniorExit(owner),
        juniorMint: pda.juniorMint(),
        juniorEscrow: pda.juniorEscrow(),
        shareMint: pda.shareMint(),
        usdcMint: key(d.usdcMint),
        usdcVault: pda.usdcVault(),
        payout: ata(payoutMint, owner),
        tokenProgram,
      })
      .instruction(),
  ];
}

// The owner can cancel any time, anyone else once the exit has lapsed
// Shares worth what was queued go back to the owner, and the yield earned while queued stays with junior lenders
export async function cancelJuniorExit(program: PluribusProgram, caller: PublicKey, owner: PublicKey): Ixs {
  const junior = pda.juniorMint();
  return [
    // The shares go back to the owner's account, which a stranger cancelling a lapsed exit may have to create
    createAssociatedTokenAccountIdempotentInstruction(caller, ata(junior, owner), owner, junior),
    await program.methods
      .cancelJuniorExit()
      .accountsStrict({
        caller,
        pool: pda.pool(),
        owner,
        exit: pda.juniorExit(owner),
        juniorMint: pda.juniorMint(),
        juniorEscrow: pda.juniorEscrow(),
        ownerJunior: ata(pda.juniorMint(), owner),
        tokenProgram,
      })
      .instruction(),
  ];
}

export async function pauseJuniorExits(program: PluribusProgram, admin: PublicKey, durationSecs: number): Ixs {
  return [await program.methods.pauseJuniorExits(durationSecs).accountsStrict({ admin, pool: pda.pool() }).instruction()];
}

export async function unpauseJuniorExits(program: PluribusProgram, admin: PublicKey): Ixs {
  return [await program.methods.unpauseJuniorExits().accountsStrict({ admin, pool: pda.pool() }).instruction()];
}

// Permissionless once a waiting change is due
export async function applyParams(program: PluribusProgram): Ixs {
  return [await program.methods.applyParams().accountsStrict({ pool: pda.pool() }).instruction()];
}

export async function applyAsset(program: PluribusProgram, mint: PublicKey): Ixs {
  return [await program.methods.applyAsset().accountsStrict({ pool: pda.pool(), asset: pda.asset(mint) }).instruction()];
}

export async function applyLpMarket(program: PluribusProgram, whirlpool: PublicKey): Ixs {
  return [
    await program.methods.applyLpMarket().accountsStrict({ pool: pda.pool(), lpMarket: pda.lpMarket(whirlpool) }).instruction(),
  ];
}

export async function setGuardian(program: PluribusProgram, admin: PublicKey, guardian: PublicKey): Ixs {
  return [await program.methods.setGuardian(guardian).accountsStrict({ admin, pool: pda.pool() }).instruction()];
}

// Guardian or admin: drops waiting pool parameters
export async function cancelPendingParams(program: PluribusProgram, guard: PublicKey): Ixs {
  return [await program.methods.cancelPendingParams().accountsStrict({ guard, pool: pda.pool() }).instruction()];
}

// Guardian or admin: pauses an asset and drops any change waiting on it
export async function guardAsset(program: PluribusProgram, guard: PublicKey, mint: PublicKey): Ixs {
  return [
    await program.methods.guardAsset().accountsStrict({ guard, pool: pda.pool(), asset: pda.asset(mint) }).instruction(),
  ];
}

export async function guardLpMarket(program: PluribusProgram, guard: PublicKey, whirlpool: PublicKey): Ixs {
  return [
    await program.methods
      .guardLpMarket()
      .accountsStrict({ guard, pool: pda.pool(), lpMarket: pda.lpMarket(whirlpool) })
      .instruction(),
  ];
}

// Repays up to `repayAmount` of `owner`'s debt and takes `mint` collateral in return, left as wSOL when it is SOL
export async function liquidate(
  program: PluribusProgram,
  d: Deployment,
  liquidator: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  repayAmount: Amount,
): Ixs {
  const credit = await creditOf(program, owner);
  return [
    budget(),
    createAta(liquidator, mint, programOf(d, mint)),
    await program.methods
      .liquidate(bn(repayAmount))
      .accountsStrict({
        ...usdcAccounts(d),
        liquidator,
        credit: pda.credit(owner),
        liquidatorUsdc: ata(key(d.usdcMint), liquidator),
        asset: pda.asset(mint),
        collateralMint: mint,
        vault: pda.vault(mint),
        liquidatorCollateral: ata(mint, liquidator, programOf(d, mint)),
        collateralTokenProgram: programOf(d, mint),
      })
      .remainingAccounts(await health(program, d, credit))
      .instruction(),
  ];
}

// Buys the whole position NFT at the liquidation discount
export async function liquidateLp(
  program: PluribusProgram,
  d: Deployment,
  liquidator: PublicKey,
  owner: PublicKey,
  positionMint: PublicKey,
): Ixs {
  const [credit, nft] = await Promise.all([creditOf(program, owner), nftProgram(program, positionMint)]);
  const usdc = key(d.usdcMint);
  return [
    budget(),
    createAta(liquidator, positionMint, nft),
    await program.methods
      .liquidateLp()
      .accountsStrict({
        ...usdcAccounts(d),
        liquidator,
        credit: pda.credit(owner),
        liquidatorUsdc: ata(usdc, liquidator),
        usdcAsset: pda.asset(usdc),
        usdcCollateralVault: pda.vault(usdc),
        positionMint,
        vaultNft: ata(positionMint, pda.pool(), nft),
        liquidatorNft: ata(positionMint, liquidator, nft),
        owner,
        nftTokenProgram: nft,
      })
      .remainingAccounts(await health(program, d, credit))
      .instruction(),
  ];
}

export async function refreshTier(program: PluribusProgram, d: Deployment, owner: PublicKey): Ixs {
  const credit = await creditOf(program, owner);
  return [
    budget(),
    await program.methods
      .refreshTier()
      .accountsStrict({ credit: pda.credit(owner), pool: pda.pool() })
      .remainingAccounts(await health(program, d, credit))
      .instruction(),
  ];
}

// Collects a deposited position's Orca fees: the USDC part repays `owner`'s debt and the SOL part becomes collateral
// Only for the main whirlpool: other markets keep their fees in the position
export async function autopay(
  program: PluribusProgram,
  d: Deployment,
  caller: PublicKey,
  owner: PublicKey,
  positionMint: PublicKey,
): Ixs {
  const [whirlpool, usdc, sol, position] = [key(d.whirlpool), key(d.usdcMint), key(d.solMint), pda.orcaPosition(positionMint)];
  const [mint, account] = await program.provider.connection.getMultipleAccountsInfo([positionMint, position]);
  if (!mint || !account) throw new Error(`Orca position for ${positionMint.toBase58()} not found`);
  const { tickLower, tickUpper } = decodeOrcaPosition(account.data);
  return [
    budget(),
    await program.methods
      .autopay()
      .accountsStrict({
        ...usdcAccounts(d),
        caller,
        credit: pda.credit(owner),
        lpMarket: pda.lpMarket(whirlpool),
        whirlpool,
        position,
        positionMint,
        vaultNft: ata(positionMint, pda.pool(), mint.owner),
        tickArrayLower: pda.tickArray(whirlpool, tickLower, d.tickSpacing),
        tickArrayUpper: pda.tickArray(whirlpool, tickUpper, d.tickSpacing),
        baseAsset: pda.asset(sol),
        baseVault: pda.vault(sol),
        whirlpoolVaultA: key(d.whirlpoolVaultA),
        usdcAsset: pda.asset(usdc),
        usdcCollateralVault: pda.vault(usdc),
        whirlpoolVaultB: key(d.whirlpoolVaultB),
        whirlpoolProgram: WHIRLPOOL_PROGRAM_ID,
      })
      .instruction(),
  ];
}

export async function accrue(program: PluribusProgram): Ixs {
  return [await program.methods.accrue().accountsStrict({ pool: pda.pool() }).instruction()];
}

// `price` and `conf` are dollars with 6 decimals
export async function setDemoPrice(
  program: PluribusProgram,
  admin: PublicKey,
  mint: PublicKey,
  price: Amount,
  conf: Amount = 0,
): Ixs {
  return [
    await program.methods
      .setDemoPrice(bn(price), bn(conf))
      .accountsStrict({
        admin,
        pool: pda.pool(),
        asset: pda.asset(mint),
        demoPrice: pda.demoPrice(mint),
        systemProgram,
      })
      .instruction(),
  ];
}

export async function collectProtocolFees(program: PluribusProgram, d: Deployment, admin: PublicKey, amount: Amount): Ixs {
  const usdc = key(d.usdcMint);
  return [
    createAta(admin, usdc),
    await program.methods
      .collectProtocolFees(bn(amount))
      .accountsStrict({ ...usdcAccounts(d), admin, treasuryUsdc: ata(usdc, admin) })
      .instruction(),
  ];
}

// Only the program's upgrade authority may sign this
export async function initialize(
  program: PluribusProgram,
  admin: PublicKey,
  usdcMint: PublicKey,
  params: PoolParams,
  demoMode: boolean,
): Ixs {
  return [
    await program.methods
      .initialize(params, demoMode)
      .accountsStrict({
        admin,
        programData: pda.programData(),
        pool: pda.pool(),
        usdcMint,
        usdcVault: pda.usdcVault(),
        shareMint: pda.shareMint(),
        tokenProgram,
        systemProgram,
      })
      .instruction(),
  ];
}

// `sigmaSeedBps` is the annual volatility the asset's dynamic shock starts from until the crank has prices of its own
// `tokenProgram` is Token-2022 for tokens like xStocks, whose extensions the program checks against its allow-list
export async function initAsset(
  program: PluribusProgram,
  admin: PublicKey,
  mint: PublicKey,
  params: AssetParams,
  sigmaSeedBps = 0,
  tokenProgram = TOKEN_PROGRAM_ID,
): Ixs {
  return [
    await program.methods
      .initAsset(params, sigmaSeedBps)
      .accountsStrict({
        admin,
        pool: pda.pool(),
        mint,
        asset: pda.asset(mint),
        vault: pda.vault(mint),
        tokenProgram,
        systemProgram,
      })
      .instruction(),
  ];
}

// Permissionless: records a Token-2022 asset's new corporate-action multiplier, so a change the issuer applied at once
// is dated as soon as anyone sees it
export async function syncMint(program: PluribusProgram, mint: PublicKey): Ixs {
  return [await program.methods.syncMint().accountsStrict({ asset: pda.asset(mint), mint }).instruction()];
}

// Permissionless: folds the asset's latest price into its volatility, at most once per minimum interval of publish time
// A staking token also passes its SOL price and stake pool, since its price is capped by that backing,
// and a Token-2022 token its mint, whose multiplier scales its price
export async function updateVol(program: PluribusProgram, d: Deployment, mint: PublicKey): Ixs {
  const a = d.assets[mint.toBase58()];
  // The accounts follow the asset's price source on chain: its demo account or its Pyth feed, and the same for its SOL backing
  const sources = await fetchPriceSources(program, d);
  const price = priceAccountFor(d, mint.toBase58(), sources);
  // The same order as a health check: a Token-2022 asset's mint for its multiplier, then a staking token's backing
  const t22 = a.tokenProgram && a.tokenProgram !== TOKEN_PROGRAM_ID.toBase58() ? mint : null;
  const backing = [t22, backingAccountFor(d, mint.toBase58(), sources), a.backing?.stakePool ? key(a.backing.stakePool) : null].filter(
    (k): k is PublicKey => !!k,
  );
  return [
    await program.methods
      .updateVol()
      .accountsStrict({ pool: pda.pool(), asset: pda.asset(mint), price })
      .remainingAccounts(backing.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })))
      .instruction(),
  ];
}

// Demo mode only: prices an asset from its Pyth feed instead of its demo account, or back again
// The feed has to be fresh before this goes live, since every health check reads it from then on
export async function demoSetLivePrice(program: PluribusProgram, admin: PublicKey, mint: PublicKey, live: boolean): Ixs {
  return [
    await program.methods.demoSetLivePrice(live).accountsStrict({ admin, pool: pda.pool(), asset: pda.asset(mint) }).instruction(),
  ];
}

// Demo mode only: puts every waiting change into effect now, for the pool and for each of `accounts`, the assets and LP
// markets that wait on something, and ends their listings' activation delay
export async function demoActivate(program: PluribusProgram, admin: PublicKey, accounts: PublicKey[]): Ixs {
  return [
    await program.methods
      .demoActivate()
      .accountsStrict({ admin, pool: pda.pool() })
      .remainingAccounts(accounts.map((pubkey) => ({ pubkey, isSigner: false, isWritable: true })))
      .instruction(),
  ];
}

// The extra yearly rate in bps charged on debt an asset backs: a cut applies at once, a raise waits out the activation delay
export async function setAssetPremium(program: PluribusProgram, admin: PublicKey, mint: PublicKey, premiumBps: number): Ixs {
  return [
    await program.methods.setAssetPremium(premiumBps).accountsStrict({ admin, pool: pda.pool(), asset: pda.asset(mint) }).instruction(),
  ];
}

// Quotes an asset per 10^exponent whole tokens, for a token worth a fraction of a cent; only before anything is deposited
export async function setPriceExponent(program: PluribusProgram, admin: PublicKey, mint: PublicKey, exponent: number): Ixs {
  return [await program.methods.setPriceExponent(exponent).accountsStrict({ admin, pool: pda.pool(), asset: pda.asset(mint) }).instruction()];
}

// The share of each asset's premium charged per loyalty tier in bps, never rising with loyalty
export async function setPremiumTiers(program: PluribusProgram, admin: PublicKey, tierBps: number[]): Ixs {
  return [await program.methods.setPremiumTiers(tierBps).accountsStrict({ admin, pool: pda.pool() }).instruction()];
}

// Permissionless: puts a waiting premium raise of an asset into effect once its delay has passed
export async function applyAssetPremium(program: PluribusProgram, mint: PublicKey): Ixs {
  return [await program.methods.applyAssetPremium().accountsStrict({ asset: pda.asset(mint) }).instruction()];
}

// Permissionless: puts waiting premium tier shares into effect once their delay has passed
export async function applyPremiumTiers(program: PluribusProgram): Ixs {
  return [await program.methods.applyPremiumTiers().accountsStrict({ pool: pda.pool() }).instruction()];
}

export async function initLpMarket(
  program: PluribusProgram,
  admin: PublicKey,
  whirlpool: PublicKey,
  baseMint: PublicKey,
  liqCostBps: number,
): Ixs {
  return [
    await program.methods
      .initLpMarket(liqCostBps)
      .accountsStrict({
        admin,
        pool: pda.pool(),
        whirlpool,
        baseAsset: pda.asset(baseMint),
        lpMarket: pda.lpMarket(whirlpool),
        systemProgram,
      })
      .instruction(),
  ];
}

export async function setParams(program: PluribusProgram, admin: PublicKey, params: PoolParams): Ixs {
  return [await program.methods.setParams(params).accountsStrict({ admin, pool: pda.pool() }).instruction()];
}

export async function setFlags(program: PluribusProgram, admin: PublicKey, paused: boolean, demoMode: boolean): Ixs {
  return [await program.methods.setFlags(paused, demoMode).accountsStrict({ admin, pool: pda.pool() }).instruction()];
}

export async function setAdmin(program: PluribusProgram, admin: PublicKey, newAdmin: PublicKey): Ixs {
  return [await program.methods.setAdmin(newAdmin).accountsStrict({ admin, pool: pda.pool() }).instruction()];
}

// Opens the junior tranche
export async function initJunior(program: PluribusProgram, admin: PublicKey): Ixs {
  return [
    await program.methods
      .initJunior()
      .accountsStrict({
        admin,
        pool: pda.pool(),
        juniorMint: pda.juniorMint(),
        juniorEscrow: pda.juniorEscrow(),
        tokenProgram,
        systemProgram,
      })
      .instruction(),
  ];
}

export async function setAsset(program: PluribusProgram, admin: PublicKey, mint: PublicKey, params: AssetParams): Ixs {
  return [
    await program.methods
      .setAsset(params)
      .accountsStrict({ admin, pool: pda.pool(), asset: pda.asset(mint) })
      .instruction(),
  ];
}

export async function setLpMarket(
  program: PluribusProgram,
  admin: PublicKey,
  whirlpool: PublicKey,
  liqCostBps: number,
  paused: boolean,
): Ixs {
  return [
    await program.methods
      .setLpMarket(liqCostBps, paused)
      .accountsStrict({ admin, pool: pda.pool(), lpMarket: pda.lpMarket(whirlpool) })
      .instruction(),
  ];
}
