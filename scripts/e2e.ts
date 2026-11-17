// End-to-end proof on a local validator with the real Orca program
// Prints one line per check and exits non-zero on the first failure
import { Percentage } from "@orca-so/common-sdk";
import { IGNORE_CACHE, PoolUtil, PriceMath, WhirlpoolIx, swapQuoteByInputToken, toTx } from "@orca-so/whirlpools-sdk";
import {
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createMintToInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Keypair, PublicKey, type SendTransactionError, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import Decimal from "decimal.js";
import {
  MAX_U64,
  type Pool,
  type PositionInfo,
  decodeError,
  decodeEvents,
  decodeOrcaPosition,
  fetchCredit,
  fetchHealth,
  fetchPool,
  fetchPositions,
  fetchPrices,
  ix,
  listOrcaPositions,
  math,
  pda,
} from "../sdk/index.ts";
import { exists, faucet, loadDeployment, program, send, setParamsNow } from "./lib.ts";
import {
  DEC_A,
  DEC_B,
  PROGRAM,
  ataA,
  ataB,
  client,
  cluster,
  connection,
  ctx,
  me,
  oracle,
  tickArray,
  wallet,
  whirlpool,
} from "./orca-common.ts";

if (cluster !== "localnet") throw new Error("The e2e run moves prices and pool parameters, so it only runs on localnet");

const d = loadDeployment();
const [sol, stock, usdc] = [d.solMint, d.stockMint, d.usdcMint].map((m) => new PublicKey(m));
const USDC = 1e6;
const SOL = 1e9;
const STOCK_PRICE = 180;
// The brief's shock table for the SOL and stock groups, written out by hand to stay independent of the SDK
const SHOCKS = {
  init: [[0.3, 0.15], [0.15, 0.35], [0.25, 0.25]],
  maint: [[0.2, 0.1], [0.1, 0.25], [0.17, 0.17]],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// A local validator's clock can trail the wall clock, so waits for on-chain deadlines are measured on the chain's own clock
async function untilChainTime(at: number) {
  while (((await connection.getBlockTime(await connection.getSlot("confirmed"))) ?? 0) < at) await sleep(1000);
}
const n = (x: { toString(): string }) => Number(x.toString());
const usd = (micro: number) => `$${(micro / USDC).toFixed(2)}`;
const gap = (got: number, want: number) => Math.abs(got - want) / Math.max(Math.abs(want), 1e-9);

let passed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) throw new Error(`Check failed: ${name}${detail && ` (${detail})`}`);
  console.log(`Pass ${String(++passed).padStart(2)}  ${name}${detail && `: ${detail}`}`);
}

async function logsOf(signature: string) {
  for (let i = 0; i < 40; i++) {
    const tx = await connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (tx?.meta?.logMessages) return tx.meta.logMessages;
    await sleep(250);
  }
  throw new Error(`No logs for ${signature}`);
}

// Sends one transaction and checks that exactly the expected events come back out of its logs
let decoded = 0;
async function run(name: string, ixs: Promise<TransactionInstruction[]>, signer: Keypair, expected: string[]) {
  const events = decodeEvents(await logsOf(await send(await ixs, [signer])));
  const names = events.map((e) => e.name);
  check(name, names.join() === expected.join(), `events [${names.join(", ")}]${names.join() === expected.join() ? "" : `, wanted [${expected.join(", ")}]`}`);
  decoded += 1;
  return events.map((e) => e.data);
}

async function fails(name: string, ixs: Promise<TransactionInstruction[]>, signer: Keypair, error: string) {
  const logs = await send(await ixs, [signer]).then(
    () => null,
    (e: SendTransactionError) => e.logs ?? [],
  );
  const got = logs ? (decodeError(logs)?.name ?? "an unknown error") : "nothing";
  check(name, got === error, `fails with ${got}`);
}

async function balance(mint: PublicKey, owner: PublicKey, tokenProgram = TOKEN_PROGRAM_ID) {
  const account = getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
  return (await exists(account)) ? Number((await connection.getTokenAccountBalance(account)).value.amount) : 0;
}

async function view(owner: PublicKey) {
  const h = await fetchHealth(program, d, owner);
  if (!h) throw new Error(`${owner.toBase58()} has no credit account`);
  return h;
}

const slot = async (owner: PublicKey, mint: PublicKey) =>
  n((await fetchCredit(program, owner))?.positions.find((p) => p.mint.equals(mint))?.amount ?? 0);

// The SDK's float maths against the program's own health view
async function matchesMath(name: string, owner: PublicKey) {
  const [h, credit, pool, prices] = await Promise.all([
    view(owner),
    fetchCredit(program, owner),
    fetchPool(program),
    fetchPrices(program, d),
  ]);
  const positions = await fetchPositions(program, d, credit!);
  const m = math.limits(positions.map((p) => p.risk), pool.params, prices);
  const worst = Math.max(
    gap(m.collateralValue * USDC, n(h.collateralValue)),
    gap(m.creditLimit * USDC, n(h.creditLimit)),
    gap(m.liquidationLimit * USDC, n(h.liquidationLimit)),
    ...positions.map((p, i) => gap(m.values[i] * USDC, n(h.positionValue[p.slot]))),
  );
  check(name, worst <= 1e-6, `limit ${usd(n(h.creditLimit))}, liquidation at ${usd(n(h.liquidationLimit))}, largest relative gap ${worst.toExponential(1)}`);
  return { h, positions, pool, prices };
}

// What lender shares are backed by, in exact integers as the program computes it
const INDEX_ONE = new BN(10).pow(new BN(18));
const lenderAssets = (p: Pool) =>
  p.debtShares
    .reduce((sum, shares, t) => sum.add(shares.mul(p.borrowIndex[t]).add(INDEX_ONE.subn(1)).div(INDEX_ONE)), p.cash)
    .sub(p.reserves)
    .sub(p.protocolFees);
// One tranche: what its shares are backed by and how many there are
async function shares(junior = false) {
  const pool = await fetchPool(program);
  const all = lenderAssets(pool);
  const juniorAssets = BN.min(pool.juniorAssets, all);
  const mint = junior ? pda.juniorMint() : pda.shareMint();
  const supply = new BN((await connection.getTokenSupply(mint)).value.amount);
  return { assets: junior ? juniorAssets : all.sub(juniorAssets), supply };
}
const tranches = async () => ({ senior: await shares(), junior: await shares(true) });
type Shares = Awaited<ReturnType<typeof shares>>;
const worthMore = (a: Shares, b: Shares) => a.assets.mul(b.supply).gt(b.assets.mul(a.supply));

// The admin sells SOL into the whirlpool and buys it back, which leaves fees on both sides for positions in range
async function swapRound(dollars: number) {
  const pool = await client.getPool(whirlpool, IGNORE_CACHE);
  for (const sell of [true, false]) {
    const data = await pool.refreshData();
    const price = PriceMath.sqrtPriceX64ToPrice(data.sqrtPrice, DEC_A, DEC_B).toNumber();
    const amount = BigInt(Math.floor(sell ? (dollars / price) * SOL : dollars * USDC));
    await send(
      sell
        ? [SystemProgram.transfer({ fromPubkey: me, toPubkey: ataA, lamports: amount }), createSyncNativeInstruction(ataA)]
        : [createMintToInstruction(usdc, ataB, me, amount)],
    );
    const quote = await swapQuoteByInputToken(
      pool,
      sell ? NATIVE_MINT : usdc,
      new BN(amount.toString()),
      Percentage.fromFraction(1, 100),
      PROGRAM,
      ctx.fetcher,
      IGNORE_CACHE,
    );
    await toTx(
      ctx,
      WhirlpoolIx.swapIx(ctx.program, {
        ...quote,
        whirlpool,
        tokenAuthority: me,
        tokenOwnerAccountA: ataA,
        tokenOwnerAccountB: ataB,
        tokenVaultA: data.tokenVaultA,
        tokenVaultB: data.tokenVaultB,
        oracle,
      }),
    ).buildAndExecute();
  }
}

// Collects a position's Orca fees straight from Orca, signed by whoever holds the NFT
async function collectOrcaFees(holder: Keypair, positionMint: PublicKey, nftProgram: PublicKey) {
  const position = pda.orcaPosition(positionMint);
  const { tickLower, tickUpper } = decodeOrcaPosition((await connection.getAccountInfo(position))!.data);
  const data = (await client.getPool(whirlpool, IGNORE_CACHE)).getData();
  const before = [await balance(sol, holder.publicKey), await balance(usdc, holder.publicKey)];
  await toTx(
    ctx,
    WhirlpoolIx.updateFeesAndRewardsIx(ctx.program, {
      whirlpool,
      position,
      tickArrayLower: tickArray(tickLower),
      tickArrayUpper: tickArray(tickUpper),
    }),
  )
    .addInstruction(
      WhirlpoolIx.collectFeesIx(ctx.program, {
        whirlpool,
        position,
        positionTokenAccount: getAssociatedTokenAddressSync(positionMint, holder.publicKey, false, nftProgram),
        positionAuthority: holder.publicKey,
        tokenOwnerAccountA: getAssociatedTokenAddressSync(sol, holder.publicKey),
        tokenOwnerAccountB: getAssociatedTokenAddressSync(usdc, holder.publicKey),
        tokenVaultA: data.tokenVaultA,
        tokenVaultB: data.tokenVaultB,
      }),
    )
    .addSigner(holder)
    .buildAndExecute();
  return [(await balance(sol, holder.publicKey)) - before[0], (await balance(usdc, holder.publicKey)) - before[1]];
}

const [borrower, control, third, lender, juniorLender, liquidator, keeper] = Array.from({ length: 7 }, () => Keypair.generate());
const [A, C, D, J, Q] = [borrower, control, third, juniorLender, liquidator].map((k) => k.publicKey);
const setPrice = (name: string, mint: PublicKey, dollars: number) =>
  run(name, ix.setDemoPrice(program, me, mint, Math.round(dollars * USDC)), wallet, ["demoPriceSet"]);

const orcaPrice = PriceMath.sqrtPriceX64ToPrice((await client.getPool(whirlpool, IGNORE_CACHE)).getData().sqrtPrice, DEC_A, DEC_B);
const solPrice = Math.round(orcaPrice.toNumber() * 100) / 100;
const params = (await fetchPool(program)).params;

try {
  await setPrice(`Admin sets SOL to the whirlpool price, $${solPrice.toFixed(2)}`, sol, solPrice);
  await setPrice(`Admin sets the stock to $${STOCK_PRICE.toFixed(2)}`, stock, STOCK_PRICE);

  const lpA = (await faucet(d, A, { sol: 20, stock: 40, lp: 10_000, nftProgram: TOKEN_PROGRAM_ID }))!;
  const lpC = (await faucet(d, C, { sol: 20, stock: 120, lp: 10_000 }))!;
  const lpD = (await faucet(d, D, { sol: 20, lp: 2000 }))!;
  await faucet(d, lender.publicKey, { sol: 1, usdc: 50_000 });
  await faucet(d, J, { sol: 1, usdc: 5000 });
  await faucet(d, Q, { sol: 2, usdc: 50_000 });
  await faucet(d, keeper.publicKey, { sol: 1 });
  const listed = await listOrcaPositions(connection, d, A);
  check(
    "Faucet: the borrower's wallet lists one Orca position in the whitelisted pool",
    listed.length === 1 && listed[0].positionMint.equals(lpA) && gap(listed[0].value, 10_000) < 0.01,
    `$${listed[0]?.value.toFixed(2)} over $${listed[0]?.priceLower.toFixed(2)} to $${listed[0]?.priceUpper.toFixed(2)}`,
  );

  check("A wallet with no account reads as null", (await fetchHealth(program, d, A)) === null);

  // 1: one account across SOL, stock and a real Orca position
  await run("Borrower opens an account", ix.openAccount(program, A), borrower, ["accountOpened"]);
  await run("Borrower deposits 10 SOL, wrapped on the way in", ix.depositToken(program, A, sol, 10 * SOL), borrower, ["collateralChanged"]);
  await run("Borrower deposits 20 NVDAx", ix.depositToken(program, A, stock, 20 * 1e6), borrower, ["collateralChanged"]);
  const tokens = await view(A);
  const hand = (table: number[][]) =>
    Math.min(...table.map(([s, e]) => 10 * solPrice * (1 - s) * 0.95 + 20 * STOCK_PRICE * (1 - e) * 0.9)) * USDC;
  check(
    "Token collateral matches the numbers worked out by hand",
    Math.abs(n(tokens.collateralValue) - (10 * solPrice + 20 * STOCK_PRICE) * USDC) <= 2 &&
      Math.abs(n(tokens.creditLimit) - hand(SHOCKS.init)) <= 2 &&
      Math.abs(n(tokens.liquidationLimit) - hand(SHOCKS.maint)) <= 2,
    `value ${usd(n(tokens.collateralValue))}, limit ${usd(n(tokens.creditLimit))}, liquidation at ${usd(n(tokens.liquidationLimit))}`,
  );
  await run("Borrower deposits the Orca position NFT", ix.depositLp(program, d, A, lpA), borrower, ["collateralChanged"]);
  check(
    "The NFT left the wallet and sits in the pool's vault",
    (await listOrcaPositions(connection, d, A)).length === 0 && (await balance(lpA, pda.pool())) === 1,
  );
  const first = await matchesMath("Health view matches sdk math for SOL, stock and LP together", A);

  // 2: draw
  const draw = Math.floor(n(first.h.creditLimit) * 0.4);
  const [drawn] = await run("Borrower draws 40% of the limit", ix.draw(program, d, A, draw), borrower, ["drawn"]);
  check(
    "USDC arrived and the debt equals the draw",
    (await balance(usdc, A)) === draw && n(drawn.debt) - draw >= 0 && n(drawn.debt) - draw <= 1,
    `${usd(draw)} drawn, debt ${usd(n(drawn.debt))}`,
  );

  const [paid] = await run("Borrower repays $100 from the wallet", ix.repay(program, d, A, A, 100 * USDC), borrower, ["repaid"]);
  check(
    "The repayment came off the debt",
    paid.source === 0 && n(paid.amount) === 100 * USDC && (await balance(usdc, A)) === draw - 100 * USDC && n(drawn.debt) - n(paid.debt) >= 100 * USDC - 100,
    `debt ${usd(n(paid.debt))}`,
  );

  // 3: sdk LP maths against the Orca SDK
  const lp = first.positions[2].risk as Extract<PositionInfo["risk"], { liquidity: unknown }>;
  const worstLp = Math.max(
    ...[solPrice, 100, 200].map((price) => {
      const orca = PoolUtil.getTokenAmountsFromLiquidity(
        new BN(lp.liquidity.toString()),
        PriceMath.priceToSqrtPriceX64(new Decimal(price), DEC_A, DEC_B),
        PriceMath.tickIndexToSqrtPriceX64(lp.tickLower),
        PriceMath.tickIndexToSqrtPriceX64(lp.tickUpper),
        false,
      );
      const value = (n(orca.tokenA) / SOL) * price + n(orca.tokenB) / USDC;
      return gap(math.lpValue(lp.liquidity, lp.tickLower, lp.tickUpper, price), value);
    }),
  );
  check("sdk lpValue agrees with the Orca SDK's token amounts below, inside and above the range", worstLp <= 1e-6, `largest relative gap ${worstLp.toExponential(1)}`);

  // 4: withdrawals
  await fails("Withdrawing the LP position would break the limit", ix.withdrawLp(program, d, A, lpA), borrower, "ExceedsCreditLimit");
  const lamports = await connection.getBalance(A);
  await run("Borrower withdraws 1 SOL, unwrapped on the way out", ix.withdrawToken(program, d, A, sol, SOL), borrower, ["collateralChanged"]);
  check(
    "The SOL is back in the wallet and 9 SOL stay as collateral",
    (await connection.getBalance(A)) - lamports > 0.99 * SOL && (await slot(A, sol)) === 9 * SOL,
  );

  // The control borrower: same SOL and LP exposure, three times the stock, and the NFT is a Token-2022 one
  await run("Control borrower opens an account", ix.openAccount(program, C), control, ["accountOpened"]);
  await run("Control borrower deposits 10 SOL", ix.depositToken(program, C, sol, 10 * SOL), control, ["collateralChanged"]);
  await run("Control borrower deposits 120 NVDAx", ix.depositToken(program, C, stock, 120 * 1e6), control, ["collateralChanged"]);
  await run("Control borrower deposits a Token-2022 position NFT", ix.depositLp(program, d, C, lpC), control, ["collateralChanged"]);
  await run("Control borrower withdraws it again", ix.withdrawLp(program, d, C, lpC), control, ["collateralChanged"]);
  check(
    "Token-2022 NFT round trip: back in the wallet and the vault account is closed",
    (await listOrcaPositions(connection, d, C)).some((p) => p.positionMint.equals(lpC)) &&
      !(await exists(getAssociatedTokenAddressSync(lpC, pda.pool(), true, TOKEN_2022_PROGRAM_ID))),
  );
  await run("Control borrower deposits it once more", ix.depositLp(program, d, C, lpC), control, ["collateralChanged"]);

  // The third borrower also empties a slot while in debt, which only works if that slot's accounts are left out
  await run("Third borrower opens an account", ix.openAccount(program, D), third, ["accountOpened"]);
  await run("Third borrower deposits 10 SOL", ix.depositToken(program, D, sol, 10 * SOL), third, ["collateralChanged"]);
  await run("Third borrower deposits a $2000 position NFT", ix.depositLp(program, d, D, lpD), third, ["collateralChanged"]);
  await run("Third borrower draws $100", ix.draw(program, d, D, 100 * USDC), third, ["drawn"]);
  await run("Third borrower withdraws all 10 SOL while in debt", ix.withdrawToken(program, d, D, sol, 10 * SOL), third, ["collateralChanged"]);
  await run("Third borrower deposits the 10 SOL again", ix.depositToken(program, D, sol, 10 * SOL), third, ["collateralChanged"]);

  // Everyone borrows up to 90% of their limit, the control borrower exactly as much as the borrower
  // The borrower first doubles the stock, so that half the debt is worth less than the stock a liquidator can take
  await run("Borrower deposits 20 more NVDAx", ix.depositToken(program, A, stock, 20 * 1e6), borrower, ["collateralChanged"]);
  const top = async (owner: PublicKey) => {
    const h = await view(owner);
    return Math.floor(n(h.creditLimit) * 0.9) - n(h.debt);
  };
  await run("Borrower draws up to 90% of the limit", ix.draw(program, d, A, await top(A)), borrower, ["drawn"]);
  const debtA = n((await view(A)).debt);
  await run("Control borrower draws the same debt", ix.draw(program, d, C, debtA), control, ["drawn"]);
  await run("Third borrower draws up to 90% of the limit", ix.draw(program, d, D, await top(D)), third, ["drawn"]);
  await fails("A draw past the limit is refused", ix.draw(program, d, D, Math.floor(0.2 * n((await view(D)).creditLimit))), third, "ExceedsCreditLimit");

  // Autopay: Orca trading fees pay the debt down
  await swapRound(3000);
  const beforeFees = { debt: n((await view(A)).debt), sol: await slot(A, sol) };
  const [solFee, repaid] = await run(
    "Keeper runs autopay on the borrower's position",
    ix.autopay(program, d, keeper.publicKey, A, lpA),
    keeper,
    ["collateralChanged", "repaid"],
  );
  check(
    "Autopay: the USDC fee repaid debt",
    repaid.source === 1 && n(repaid.amount) > 0 && n(repaid.debt) < beforeFees.debt && n((await view(A)).debt) < beforeFees.debt,
    `${usd(n(repaid.amount))} off a debt of ${usd(beforeFees.debt)}`,
  );
  check(
    "Autopay: the SOL fee became wSOL collateral",
    solFee.mint.equals(sol) && n(solFee.amount) > 0 && (await slot(A, sol)) === beforeFees.sol + n(solFee.amount),
    `${n(solFee.amount) / SOL} SOL`,
  );

  // Loyalty tiers need days on a real clock, so the admin shortens them for a moment
  // A change that is not a pure tightening waits out the activation delay, seconds on localnet
  try {
    const [queued] = await run("Admin shortens the tier periods", ix.setParams(program, me, { ...params, tierMinHealthySecs: [0, 1, 2].map((s) => new BN(s)) }), wallet, ["changeQueued"]);
    await fails("The change cannot apply before its delay", ix.applyParams(program), keeper, "ChangeNotDue");
    await untilChainTime(n(queued.effectiveAt) + 1);
    await run("Anyone applies it once the delay has passed", ix.applyParams(program), keeper, ["changeApplied"]);
    await sleep(3000);
    const [tier] = await run("Keeper refreshes the borrower's tier", ix.refreshTier(program, d, A), keeper, ["tierChanged"]);
    const promoted = await view(A);
    const base = math.poolStats(await fetchPool(program)).borrowRateBps;
    check(
      "The borrower reached the top tier and pays the discounted rate",
      tier.from === 0 && tier.to === 2 && promoted.tier === 2 && Math.abs(promoted.borrowRateBps - (base - params.tierDiscountBps[2])) <= 2,
      `${promoted.borrowRateBps} bps against a base rate of ${base.toFixed(1)} bps`,
    );
  } finally {
    await setParamsNow(params);
    check("Admin restored the tier periods", JSON.stringify((await fetchPool(program)).params) === JSON.stringify(params));
  }

  // 5: lender
  const [moved] = await run("Lender deposits 50,000 USDC", ix.lendDeposit(program, d, lender.publicKey, 50_000 * USDC), lender, ["lenderMoved"]);
  const held = await balance(pda.shareMint(), lender.publicKey);
  check("Senior shares arrived", held > 0 && held === n(moved.shares) && moved.junior === false, `${held / USDC} shares`);
  const [movedJunior] = await run("Junior lender deposits 5,000 USDC", ix.lendDeposit(program, d, J, 5000 * USDC, { junior: true }), juniorLender, ["lenderMoved"]);
  const heldJunior = await balance(pda.juniorMint(), J);
  check("Junior shares arrived", heldJunior > 0 && heldJunior === n(movedJunior.shares) && movedJunior.junior === true, `${heldJunior / USDC} shares`);
  const early = await tranches();
  await sleep(4000);
  await run("Anyone accrues interest", ix.accrue(program), keeper, []);
  const late = await tranches();
  check(
    "A senior share is worth more after interest accrued",
    worthMore(late.senior, early.senior),
    `senior assets rose by ${late.senior.assets.sub(early.senior.assets).toString()} micro-USDC`,
  );
  // Growth is compared instead of level, because a rerun starts with junior shares already marked down by a loss
  const grewMore = late.junior.assets
    .mul(early.junior.supply)
    .mul(early.senior.assets)
    .mul(late.senior.supply)
    .gt(late.senior.assets.mul(early.senior.supply).mul(early.junior.assets).mul(late.junior.supply));
  const stats = math.poolStats(await fetchPool(program), { senior: late.senior.supply, junior: late.junior.supply });
  // What the program pays for a share: the price with its one virtual share counted, capped by the plain price
  const sharePrice = (t: { assets: BN; supply: BN }) => Math.min((n(t.assets) + 1e6) / (n(t.supply) + 1e6), n(t.assets) / n(t.supply));
  check(
    "A junior share gained more per unit than a senior share",
    worthMore(late.junior, early.junior) &&
      grewMore &&
      stats.juniorApyBps > stats.seniorApyBps &&
      gap(stats.seniorShareValue!, sharePrice(late.senior)) < 1e-9 &&
      gap(stats.juniorShareValue!, sharePrice(late.junior)) < 1e-9,
    `junior assets rose by ${late.junior.assets.sub(early.junior.assets).toString()} micro-USDC, a junior share is worth $${stats.juniorShareValue?.toFixed(9)} at ${stats.juniorApyBps.toFixed(1)} bps, a senior share $${stats.seniorShareValue?.toFixed(9)} at ${stats.seniorApyBps.toFixed(1)} bps`,
  );
  const half = Math.floor(held / 2);
  const usdcBefore = await balance(usdc, lender.publicKey);
  const [out] = await run("Lender redeems half the shares", ix.lendWithdraw(program, d, lender.publicKey, half), lender, ["lenderMoved"]);
  const received = (await balance(usdc, lender.publicKey)) - usdcBefore;
  check("Half the shares pay back at least half the deposit", received === n(out.usdc) && received >= 25_000 * USDC - 1, usd(received));
  const [converted] = await run(
    "Lender turns a fifth of the remaining senior shares into junior shares",
    ix.convertToJunior(program, lender.publicKey, Math.floor(held / 10)),
    lender,
    ["trancheConverted"],
  );
  check(
    "Converting moved value into the junior tranche with no USDC changing hands",
    (await balance(pda.juniorMint(), lender.publicKey)) === n(converted.minted) && n(converted.value) >= 5000 * USDC - 1,
    `${usd(n(converted.value))} became ${n(converted.minted) / USDC} junior shares`,
  );
  const [fees] = await run("Admin collects the protocol's share of interest", ix.collectProtocolFees(program, d, me, MAX_U64), wallet, ["protocolFeesCollected"]);
  check("Protocol fees were paid out", n(fees.amount) > 0, `${n(fees.amount)} micro-USDC`);

  // Pause stops new debt
  try {
    await run("Admin pauses the pool", ix.setFlags(program, me, true, true), wallet, []);
    await fails("A draw while paused is refused", ix.draw(program, d, A, 1), borrower, "Paused");
  } finally {
    await run("Admin unpauses the pool", ix.setFlags(program, me, false, true), wallet, []);
  }

  // 6: crash that the extra stock absorbs for the control borrower
  const a = await matchesMath("Borrower before the crash", A);
  const c = await matchesMath("Control borrower before the crash", C);
  const limitAt = (positions: PositionInfo[], price: number) =>
    math.limits(positions.map((p) => p.risk), a.pool.params, { ...a.prices, [d.solMint]: price }).liquidationLimit * USDC;
  // The gap has to be wide enough that one capped token liquidation does not make the account healthy again
  let crash = Math.floor(solPrice);
  while (crash > 1 && !(limitAt(a.positions, crash) < 0.85 * n(a.h.debt) && limitAt(c.positions, crash) > 1.1 * n(c.h.debt))) crash -= 1;
  check("sdk what-if finds a SOL price that sinks the borrower but not the control borrower", crash > 1, `$${crash}`);
  await setPrice(`Admin crashes SOL to $${crash}`, sol, crash);
  const sunk = await matchesMath("Borrower after the crash, with the position out of range", A);
  const safe = await matchesMath("Control borrower after the crash", C);
  check(
    "Same debt: the borrower is liquidatable and the control borrower is not",
    n(sunk.h.debt) > n(sunk.h.liquidationLimit) && n(safe.h.debt) < n(safe.h.liquidationLimit),
    `debts ${usd(n(sunk.h.debt))} and ${usd(n(safe.h.debt))}`,
  );
  await fails("Liquidating the control borrower is refused", ix.liquidate(program, d, Q, C, stock, MAX_U64), liquidator, "NotLiquidatable");

  const [taken, reset] = await run("Liquidator repays debt for the borrower's stock", ix.liquidate(program, d, Q, A, stock, MAX_U64), liquidator, ["liquidated", "tierChanged"]);
  check(
    "The token liquidation is capped at half the debt",
    Math.abs(2 * n(taken.repaid) - (n(taken.repaid) + n(taken.debt))) <= 2,
    `${usd(n(taken.repaid))} repaid, ${usd(n(taken.debt))} left`,
  );
  check(
    "The liquidator received stock worth the repayment plus the 5% bonus",
    (await balance(stock, Q)) === n(taken.seized) && gap((n(taken.seized) / 1e6) * STOCK_PRICE, (n(taken.repaid) / USDC) * 1.05) < 1e-5,
    `${n(taken.seized) / 1e6} NVDAx`,
  );
  check("The borrower fell back to the base tier", reset.from === 2 && reset.to === 0 && (await view(A)).tier === 0);

  const paidBefore = await balance(usdc, Q);
  const [kept, bought] = await run("Liquidator buys the borrower's position NFT", ix.liquidateLp(program, d, Q, A, lpA), liquidator, ["collateralChanged", "liquidated"]);
  const excess = paidBefore - (await balance(usdc, Q)) - n(bought.repaid);
  check(
    "The liquidator holds the NFT and the pool's vault account is closed",
    (await listOrcaPositions(connection, d, Q)).some((p) => p.positionMint.equals(lpA)) &&
      !(await exists(getAssociatedTokenAddressSync(lpA, pda.pool(), true))),
  );
  check(
    "Payment above the repay cap stays in the borrower's account as USDC collateral",
    excess > 0 && (await slot(A, usdc)) === excess && kept.mint.equals(usdc) && n(kept.amount) === excess,
    `${usd(n(bought.repaid))} repaid, ${usd(excess)} kept`,
  );
  const [own] = await run("Borrower pays debt down with that USDC collateral", ix.repayFromCollateral(program, d, A, A, MAX_U64), borrower, ["repaid"]);
  check("The USDC collateral went to the debt", own.source === 2 && n(own.amount) === excess && (await slot(A, usdc)) === 0, usd(n(own.amount)));

  // 7: deeper crash until the third borrower has no collateral left
  const deep = Math.max(1, Math.round(crash * 0.35));
  await setPrice(`Admin crashes SOL further to $${deep}`, sol, deep);
  await run("Liquidator takes the third borrower's SOL", ix.liquidate(program, d, Q, D, sol, MAX_U64), liquidator, ["liquidated"]);
  const poolBefore = await fetchPool(program);
  const before = await tranches();
  const [last, bad] = await run("Liquidator buys the third borrower's Token-2022 position NFT", ix.liquidateLp(program, d, Q, D, lpD), liquidator, ["liquidated", "badDebt"]);
  const poolAfter = await fetchPool(program);
  const left = await fetchCredit(program, D);
  check(
    "The debt nothing backs any more is written off",
    n(bad.loss) === n(last.debt) && n(bad.loss) > 0 && left!.debtShares.isZero() && left!.positions.every((p) => p.kind === 0) &&
      n(poolAfter.badDebt) - n(poolBefore.badDebt) === n(bad.loss),
    usd(n(bad.loss)),
  );
  const after = await tranches();
  const [loss, fromReserves, fromFees, fromJunior] = [bad.loss, bad.coveredByReserves, bad.coveredByProtocolFees, bad.coveredByJunior].map(n);
  check(
    "Reserves take the loss first, then protocol fees, then junior lenders",
    fromReserves >= n(poolBefore.reserves) && fromReserves > 0 && poolAfter.reserves.isZero() &&
      fromFees >= n(poolBefore.protocolFees) && poolAfter.protocolFees.isZero() &&
      fromJunior > 0 && fromJunior === loss - fromReserves - fromFees,
    `${fromReserves} micro-USDC from reserves, ${fromFees} from protocol fees, ${usd(fromJunior)} from junior lenders`,
  );
  // The write-off accrues first, so the tranches also move by the interest of the second or so since the last transaction
  const juniorDrop = n(poolBefore.juniorAssets) - n(poolAfter.juniorAssets);
  const seniorGain = n(after.senior.assets.sub(before.senior.assets));
  check(
    "Junior assets fell by what they covered and the senior tranche lost nothing",
    juniorDrop <= fromJunior && fromJunior - juniorDrop < 1000 && seniorGain >= 0 && seniorGain < 1000 &&
      worthMore(before.junior, after.junior) && !worthMore(before.senior, after.senior),
    `junior assets down ${juniorDrop} micro-USDC against ${fromJunior} covered, senior assets up ${seniorGain} micro-USDC of interest`,
  );
  // Junior money leaves through the exit queue, and queued shares go on carrying losses until claimed
  await fails("A junior lender cannot redeem directly", ix.lendWithdraw(program, d, J, heldJunior, { junior: true }), juniorLender, "JuniorExitQueue");
  const [queuedExit] = await run("Junior lender queues every share for exit", ix.requestJuniorExit(program, J, heldJunior), juniorLender, ["juniorExitRequested"]);
  await fails("The exit cannot be claimed during its wait", ix.claimJuniorExit(program, d, J), juniorLender, "ExitNotReady");
  await untilChainTime(n(queuedExit.unlockAt) + 1);
  const [outJunior] = await run("Junior lender claims the exit in USDC", ix.claimJuniorExit(program, d, J), juniorLender, ["juniorExitClaimed"]);
  const back = await balance(usdc, J);
  check(
    "The junior lender carries a share of the loss and leaves the exit fee behind",
    outJunior.inUsdc === true && back === n(outJunior.paid) && n(outJunior.fee) > 0 && back < 5000 * USDC && back > 4500 * USDC,
    `${usd(back)} back for $5000.00, ${usd(n(outJunior.fee))} fee`,
  );

  // Custody round trip: the liquidator can use both seized NFTs with Orca directly
  await swapRound(3000);
  await send([createAssociatedTokenAccountIdempotentInstruction(Q, getAssociatedTokenAddressSync(sol, Q), Q, sol)], [liquidator]);
  for (const [name, mint, nftProgram] of [
    ["classic", lpA, TOKEN_PROGRAM_ID],
    ["Token-2022", lpD, TOKEN_2022_PROGRAM_ID],
  ] as const) {
    const [solFees, usdcFees] = await collectOrcaFees(liquidator, mint, nftProgram);
    check(`The liquidator collects Orca fees with the seized ${name} NFT`, solFees > 0 && usdcFees > 0, `${solFees / SOL} SOL and ${usd(usdcFees)}`);
  }

  // 8: every transaction above had its events decoded and compared
  check("decodeEvents returned the expected events for every transaction", decoded > 0, `${decoded} transactions`);
  console.log(`All ${passed} checks passed`);
} finally {
  await send([
    ...(await ix.setDemoPrice(program, me, sol, Math.round(solPrice * USDC))),
    ...(await ix.setDemoPrice(program, me, stock, STOCK_PRICE * USDC)),
  ]);
}
