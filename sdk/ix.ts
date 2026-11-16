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
  healthAccounts,
  pda,
} from "./core";

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

const moveToken = (owner: PublicKey, mint: PublicKey) => ({
  owner,
  credit: pda.credit(owner),
  pool: pda.pool(),
  asset: pda.asset(mint),
  mint,
  vault: pda.vault(mint),
  ownerToken: ata(mint, owner),
  tokenProgram,
});

const lend = (d: Deployment, lender: PublicKey) => ({
  ...usdcAccounts(d),
  lender,
  shareMint: pda.shareMint(),
  lenderUsdc: ata(key(d.usdcMint), lender),
  lenderShares: ata(pda.shareMint(), lender),
});

export async function openAccount(program: PluribusProgram, owner: PublicKey): Ixs {
  return [
    await program.methods.openAccount().accountsStrict({ owner, credit: pda.credit(owner), systemProgram }).instruction(),
  ];
}

// SOL collateral is wrapped on the way in, and the temporary wSOL account is closed again
export async function depositToken(program: PluribusProgram, owner: PublicKey, mint: PublicKey, amount: Amount): Ixs {
  const sol = mint.equals(NATIVE_MINT);
  const token = ata(mint, owner);
  return [
    createAta(owner, mint),
    ...(sol
      ? [
          SystemProgram.transfer({ fromPubkey: owner, toPubkey: token, lamports: BigInt(amount.toString()) }),
          createSyncNativeInstruction(token),
        ]
      : []),
    await program.methods.depositToken(bn(amount)).accountsStrict(moveToken(owner, mint)).instruction(),
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
    createAta(owner, mint),
    await program.methods
      .withdrawToken(bn(amount))
      .accountsStrict(moveToken(owner, mint))
      .remainingAccounts(healthAccounts(program, d, credit, { skip: emptied ? mint : undefined }))
      .instruction(),
    ...(mint.equals(NATIVE_MINT) ? [unwrap(owner)] : []),
  ];
}

export async function depositLp(program: PluribusProgram, d: Deployment, owner: PublicKey, positionMint: PublicKey): Ixs {
  const nft = await nftProgram(program, positionMint);
  return [
    await program.methods
      .depositLp()
      .accountsStrict({
        owner,
        credit: pda.credit(owner),
        pool: pda.pool(),
        lpMarket: pda.lpMarket(key(d.whirlpool)),
        position: pda.orcaPosition(positionMint),
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
      .remainingAccounts(healthAccounts(program, d, credit, { skip: positionMint }))
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
      .remainingAccounts(healthAccounts(program, d, credit))
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
      .remainingAccounts(healthAccounts(program, d, credit))
      .instruction(),
  ];
}

export async function lendDeposit(program: PluribusProgram, d: Deployment, lender: PublicKey, amount: Amount): Ixs {
  return [
    createAta(lender, pda.shareMint()),
    await program.methods.lendDeposit(bn(amount)).accountsStrict(lend(d, lender)).instruction(),
  ];
}

export async function lendWithdraw(program: PluribusProgram, d: Deployment, lender: PublicKey, shares: Amount): Ixs {
  return [
    createAta(lender, key(d.usdcMint)),
    await program.methods.lendWithdraw(bn(shares)).accountsStrict(lend(d, lender)).instruction(),
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
    createAta(liquidator, mint),
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
        liquidatorCollateral: ata(mint, liquidator),
      })
      .remainingAccounts(healthAccounts(program, d, credit))
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
      .remainingAccounts(healthAccounts(program, d, credit))
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
      .remainingAccounts(healthAccounts(program, d, credit))
      .instruction(),
  ];
}

// Collects a deposited position's Orca fees: the USDC part repays `owner`'s debt and the SOL part becomes collateral
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

export async function initAsset(program: PluribusProgram, admin: PublicKey, mint: PublicKey, params: AssetParams): Ixs {
  return [
    await program.methods
      .initAsset(params)
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
