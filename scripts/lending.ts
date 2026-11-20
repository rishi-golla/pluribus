// Sets the pool's senior and junior lending to the given dollars by moving the admin's own lending, which setup seeded
// Withdraws or exits what is over a target and deposits what is under it; other lenders' money is never touched
//   npm run lending -- --senior 45000 --junior 5000 [--url http://127.0.0.1:18899]
import { getAccount, getAssociatedTokenAddressSync, getMint } from "@solana/spl-token";
import { fetchJuniorExit, fetchPool, ix, math, pda } from "../sdk/index.ts";
import { amount, chainNow, faucet, loadDeployment, program, send } from "./lib.ts";
import { args, connection, me } from "./orca-common.ts";

if (args.senior === undefined || args.junior === undefined) throw new Error("Usage: lending --senior <usd> --junior <usd> [--url ..]");
const target = { senior: amount("senior", args.senior), junior: amount("junior", args.junior) };
const d = loadDeployment();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const held = (mint: ReturnType<typeof pda.shareMint>) =>
  getAccount(connection, getAssociatedTokenAddressSync(mint, me)).then((a) => a.amount, () => 0n);

async function stats() {
  const [pool, senior, junior] = await Promise.all([fetchPool(program), getMint(connection, pda.shareMint()), getMint(connection, pda.juniorMint())]);
  const s = math.poolStats(pool, { senior: senior.supply.toString(), junior: junior.supply.toString() });
  return { ...s, seniorSupply: Number(senior.supply), juniorSupply: Number(junior.supply) };
}
const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;

let s = await stats();
console.log(`Now: senior ${usd(s.seniorAssets)}, junior ${usd(s.juniorAssets)}; target: senior ${usd(target.senior)}, junior ${usd(target.junior)}`);

// Juniors first: an exit pays out of idle cash, which senior withdrawals below would otherwise use up
// The exit fee stays with the juniors who remain, so each round lands a little high and the next one takes that off
for (let round = 0; round < 4 && s.juniorAssets > target.junior + 1; round++) {
  const mine = Number(await held(pda.juniorMint()));
  const shares = Math.min(mine, Math.floor(((s.juniorAssets - target.junior) / s.juniorAssets) * s.juniorSupply));
  if (shares >= mine) {
    console.log(`The admin holds only ${mine / 1e6} junior shares, not enough to bring juniors down to the target`);
    break;
  }
  await send(await ix.requestJuniorExit(program, me, shares));
  const exit = await fetchJuniorExit(program, me);
  // The junior wait, then the claim inside its window
  while ((await chainNow()) < exit!.unlockAt.toNumber()) await sleep(1000);
  await send(await ix.claimJuniorExit(program, d, me));
  console.log(`Exited ${shares / 1e6} junior shares`);
  s = await stats();
}
if (s.juniorAssets < target.junior) {
  const dollars = Math.ceil(target.junior - s.juniorAssets);
  await faucet(d, me, { usdc: dollars });
  await send(await ix.lendDeposit(program, d, me, dollars * 1e6, { junior: true }));
  console.log(`Deposited ${usd(dollars)} junior`);
}

s = await stats();
if (s.seniorAssets > target.senior) {
  const mine = Number(await held(pda.shareMint()));
  const shares = Math.min(mine, Math.floor(((s.seniorAssets - target.senior) / s.seniorAssets) * s.seniorSupply));
  if (shares > 0) {
    await send(await ix.lendWithdraw(program, d, me, shares));
    console.log(`Withdrew ${shares / 1e6} senior shares`);
  }
} else if (s.seniorAssets < target.senior) {
  const dollars = Math.ceil(target.senior - s.seniorAssets);
  await faucet(d, me, { usdc: dollars });
  await send(await ix.lendDeposit(program, d, me, dollars * 1e6));
  console.log(`Deposited ${usd(dollars)} senior`);
}

s = await stats();
console.log(`Done: senior ${usd(s.seniorAssets)}, junior ${usd(s.juniorAssets)}, total ${usd(s.seniorAssets + s.juniorAssets)}`);
