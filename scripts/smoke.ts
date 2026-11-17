// Smoke test for a live cluster: one borrower uses every asset type, draws, lends into both tranches and repays
// Safe to rerun, since it reuses its own wallet and ends with no debt
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  KIND_LP,
  MAX_U64,
  fetchCredit,
  fetchHealth,
  fetchJuniorExit,
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
// A staking token, when the deployment lists one
const lst = Object.entries(d.assets).find(([, a]) => a.backing)?.[0];
if (lst && !positions.some((p) => p.mint.toBase58() === lst)) {
  await faucet(d, who, { tokens: { [lst]: 0.5 } });
  await send(await ix.depositToken(program, who, new PublicKey(lst), 500_000_000), [borrower]);
}
if (!positions.some((p) => p.kind === KIND_LP)) {
  await faucet(d, who, { lp: 20, range: [120, 180] });
  const [position] = await listOrcaPositions(connection, d, who);
  if (!position) throw new Error("The faucet's Orca position did not reach the wallet");
  await send(await ix.depositLp(program, d, who, position.positionMint), [borrower]);
}

credit = (await fetchCredit(program, who))!;
const kinds = lst ? "SOL, the stock token, a staking token and an Orca position" : "SOL, the stock token and an Orca position";
check(`The account holds ${kinds}`, credit.positions.filter((p) => p.kind !== 0).length === (lst ? 4 : 3));

const [pool, prices, risks] = await Promise.all([fetchPool(program), fetchPrices(program, d), fetchPositions(program, d, credit)]);
const want = math.limits(risks.map((p) => p.risk), pool.params, prices);
const before = await view();
const gap = Math.abs(before.limit / USDC - want.creditLimit) / want.creditLimit;
check("One credit limit across every asset, matching the SDK's own maths", gap < 1e-6, `$${(before.limit / USDC).toFixed(2)}`);

const amount = Math.floor((before.limit - before.debt) * 0.3);
const wallet = await held(usdc);
await send(await ix.draw(program, d, who, amount), [borrower]);
check("USDC arrives from one draw against every asset", (await held(usdc)) - wallet === amount, `$${(amount / USDC).toFixed(2)}`);

// A dollar into the senior tranche and straight back out
await send(await ix.lendDeposit(program, d, who, USDC), [borrower]);
const shares = await held(pda.shareMint());
await send(await ix.lendWithdraw(program, d, who, shares), [borrower]);
check("Lending into the senior tranche and redeeming works", shares > 0 && (await held(pda.shareMint())) === 0);

// Two dollars of senior money become junior money, which then queues for exit and is taken back out of the queue
// Junior exits wait days on a live cluster, so the smoke run cancels instead of claiming
await send(await ix.lendDeposit(program, d, who, 2 * USDC), [borrower]);
await send(await ix.convertToJunior(program, who, await held(pda.shareMint())), [borrower]);
const junior = await held(pda.juniorMint());
check("Senior shares convert into junior shares", junior > 0 && (await held(pda.shareMint())) === 0, `${junior / USDC} junior shares`);
const refused = await send(await ix.lendWithdraw(program, d, who, junior, { junior: true }), [borrower]).then(
  () => false,
  () => true,
);
check("Junior shares cannot be redeemed directly", refused);
await send(await ix.requestJuniorExit(program, who, junior), [borrower]);
const queued = await fetchJuniorExit(program, who);
check("The exit is queued with its wait", queued !== null && (await held(pda.juniorMint())) === 0, `claimable from ${new Date(queued!.unlockAt.toNumber() * 1000).toISOString()}`);
await send(await ix.cancelJuniorExit(program, who, who), [borrower]);
check("Cancelling hands the shares back", (await held(pda.juniorMint())) === junior && (await fetchJuniorExit(program, who)) === null);

// The mock mint covers whatever the wallet is short, such as the dollars left in the junior tranche, plus a dollar for interest
const short = (await view()).debt - (await held(usdc));
await faucet(d, who, { usdc: Math.max(0, Math.ceil(short / USDC)) + 1 });
await send(await ix.repay(program, d, who, who, MAX_U64), [borrower]);
check("The loan is repaid in full", (await view()).debt === 0);

console.log(`All ${passed} checks passed on ${cluster}`);
console.log(`Borrower ${who.toBase58()}, credit account ${pda.credit(who).toBase58()}`);
