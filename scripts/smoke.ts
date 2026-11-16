// Smoke test for a live cluster: one borrower uses every asset type, draws, lends into both tranches and repays
// Safe to rerun, since it reuses its own wallet and ends with no debt
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  KIND_LP,
  MAX_U64,
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
import { faucet, loadDeployment, program, send } from "./lib.ts";
import { cluster, connection, key, me } from "./orca-common.ts";

const d = loadDeployment();
const [sol, stock, usdc] = [d.solMint, d.stockMint, d.usdcMint].map((m) => new PublicKey(m));
const borrower = key("smoke-borrower");
const who = borrower.publicKey;
const USDC = 1e6;

let passed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) throw new Error(`Check failed: ${name}${detail && ` (${detail})`}`);
  console.log(`Pass ${String(++passed).padStart(2)}  ${name}${detail && `: ${detail}`}`);
}

async function held(mint: PublicKey) {
  const account = getAssociatedTokenAddressSync(mint, who);
  return (await connection.getAccountInfo(account)) ? Number((await connection.getTokenAccountBalance(account)).value.amount) : 0;
}

async function view() {
  const health = await fetchHealth(program, d, who);
  if (!health) throw new Error("The smoke borrower has no credit account");
  return { debt: Number(health.debt.toString()), limit: Number(health.creditLimit.toString()) };
}

// Fees and a little SOL collateral come from the admin wallet
if ((await connection.getBalance(who)) < 0.1 * LAMPORTS_PER_SOL) {
  await send([SystemProgram.transfer({ fromPubkey: me, toPubkey: who, lamports: 0.15 * LAMPORTS_PER_SOL })]);
}

let credit = await fetchCredit(program, who);
if (!credit) {
  await send(await ix.openAccount(program, who), [borrower]);
  credit = await fetchCredit(program, who);
}
if (!credit) throw new Error("Opening the credit account did not stick");
const positions = credit.positions.filter((p) => p.kind !== 0);
if (!positions.some((p) => p.mint.equals(sol))) {
  await send(await ix.depositToken(program, who, sol, 50_000_000), [borrower]);
}
if (!positions.some((p) => p.mint.equals(stock))) {
  await faucet(d, who, { stock: 5 });
  await send(await ix.depositToken(program, who, stock, 5_000_000), [borrower]);
}
if (!positions.some((p) => p.kind === KIND_LP)) {
  await faucet(d, who, { lp: 20, range: [120, 180] });
  const [position] = await listOrcaPositions(connection, d, who);
  if (!position) throw new Error("The faucet's Orca position did not reach the wallet");
  await send(await ix.depositLp(program, d, who, position.positionMint), [borrower]);
}

credit = (await fetchCredit(program, who))!;
check("The account holds SOL, the stock token and an Orca position", credit.positions.filter((p) => p.kind !== 0).length === 3);

const [pool, prices, risks] = await Promise.all([fetchPool(program), fetchPrices(program, d), fetchPositions(program, d, credit)]);
const want = math.limits(risks.map((p) => p.risk), pool.params, prices);
const before = await view();
const gap = Math.abs(before.limit / USDC - want.creditLimit) / want.creditLimit;
check("One credit limit across all three, matching the SDK's own maths", gap < 1e-6, `$${(before.limit / USDC).toFixed(2)}`);

const amount = Math.floor((before.limit - before.debt) * 0.3);
const wallet = await held(usdc);
await send(await ix.draw(program, d, who, amount), [borrower]);
check("USDC arrives from one draw against every asset", (await held(usdc)) - wallet === amount, `$${(amount / USDC).toFixed(2)}`);

// A dollar into each tranche and straight back out
for (const junior of [false, true]) {
  const mint = junior ? pda.juniorMint() : pda.shareMint();
  await send(await ix.lendDeposit(program, d, who, USDC, { junior }), [borrower]);
  const shares = await held(mint);
  await send(await ix.lendWithdraw(program, d, who, shares, { junior }), [borrower]);
  check(`Lending into the ${junior ? "junior" : "senior"} tranche and redeeming works`, shares > 0 && (await held(mint)) === 0);
}

// The mock mint covers interest and rounding so the loan can be closed in full
await faucet(d, who, { usdc: 1 });
await send(await ix.repay(program, d, who, who, MAX_U64), [borrower]);
check("The loan is repaid in full", (await view()).debt === 0);

console.log(`All ${passed} checks passed on ${cluster}`);
console.log(`Borrower ${who.toBase58()}, credit account ${pda.credit(who).toBase58()}`);
