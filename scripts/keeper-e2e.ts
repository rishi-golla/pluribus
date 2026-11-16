// Proves the keeper and the indexer on a local chain
// A borrower draws near the limit, the SOL price falls, and the keeper has to clean up alone while the indexer records it
import assert from "node:assert";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Percentage } from "@orca-so/common-sdk";
import { IGNORE_CACHE, swapQuoteByInputToken } from "@orca-so/whirlpools-sdk";
import { NATIVE_MINT, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import type { Row, StoredEvent } from "../indexer/events.ts";
import { sign } from "../indexer/sign.ts";
import { fetchCredit, fetchHealth, fetchPool, fetchPositions, fetchPrices, ix, math, pda } from "../sdk/index.ts";
import { faucet, loadDeployment, program, send } from "./lib.ts";
import { PROGRAM, client, cluster, connection, ctx, me, root, url, whirlpool } from "./orca-common.ts";

if (cluster !== "localnet") {
  throw new Error("keeper:e2e moves the SOL price and the pool settings, so it only runs on a local validator");
}

const d = loadDeployment();
const [usdc, stock] = [new PublicKey(d.usdcMint), new PublicKey(d.stockMint)];
const borrower = Keypair.generate();
const owner = borrower.publicKey;
const token = "keeper-e2e-token";
const INDEX_ONE = new BN(10).pow(new BN(18));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const step = (line: string) => console.log(`\n== ${line}`);
const micro = (amount: number) => Math.round(amount * 1e6);
const whole = (units: BN) => units.toNumber() / 1e6;
const short = (address: PublicKey) => `${address.toBase58().slice(0, 4)}...${address.toBase58().slice(-4)}`;

async function until<T>(what: string, check: () => Promise<T | null | undefined | false>): Promise<T> {
  for (const deadline = Date.now() + 90_000; ; await sleep(500)) {
    const value = await check().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
  }
}

const children: ChildProcess[] = [];
function start(name: string, file: string, args: string[], env: Record<string, string>) {
  const child = spawn(process.execPath, ["--import", "tsx", file, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      output += chunk;
      process.stdout.write(String(chunk).replace(/^(?=.)/gm, `[${name}] `));
    });
  }
  children.push(child);
  return { child, output: () => output };
}

const port = await new Promise<number>((resolve) => {
  const probe = net.createServer().listen(0, () => {
    const { port } = probe.address() as net.AddressInfo;
    probe.close(() => resolve(port));
  });
});
const api = `http://127.0.0.1:${port}`;
const get = async (route: string) => (await fetch(api + route)).json();
const rows = (): Promise<Row[]> => get(`/accounts/${owner.toBase58()}/events`);
const health = async () => (await fetchHealth(program, d, owner))!;

const pool0 = await fetchPool(program);
const solPrice0 = await program.account.demoPrice.fetch(pda.demoPrice(NATIVE_MINT));
const stockPrice0 = await program.account.demoPrice.fetch(pda.demoPrice(stock));
const stockAsset0 = await program.account.asset.fetch(pda.asset(stock));
const setTiers = async (secs: BN[]) => send(await ix.setParams(program, me, { ...pool0.params, tierMinHealthySecs: secs }));
const setStockAge = async (maxPriceAgeSecs: number) =>
  send(await ix.setAsset(program, me, stock, { ...stockAsset0.params, maxPriceAgeSecs }));
const setSol = async (price: BN, conf = new BN(0)) => send(await ix.setDemoPrice(program, me, NATIVE_MINT, price, conf));

try {
  step("Indexer and replay");
  const data = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "keeper-e2e-")), "events.jsonl");
  const indexerEnv = { PORT: String(port), STREAMS_TOKEN: token };
  start("indexer", "indexer/server.ts", [], { ...indexerEnv, INDEXER_DATA: data });
  await until("the indexer to listen", () => get("/health"));
  // A test validator keeps about a minute of history, so the replay follows from the start
  start("replay", "indexer/replay.ts", ["--follow"], { ...indexerEnv, RPC_URL: url });

  step("Fast settings: tier 1 after 5 healthy seconds, stock price stale after 20");
  await setTiers([0, 5, 2_592_000].map((s) => new BN(s)));
  await setStockAge(20);
  await setSol(solPrice0.price, solPrice0.conf);

  step(`Borrower ${owner.toBase58()}: 10 SOL and a $5,000 Orca position, drawn to 97% of the limit`);
  const positionMint = (await faucet(d, owner, { sol: 30, lp: 5000, range: [120, 180] }))!;
  await send(await ix.openAccount(program, owner), [borrower]);
  await send(await ix.depositToken(program, owner, NATIVE_MINT, 10 * LAMPORTS_PER_SOL), [borrower]);
  await send(await ix.depositLp(program, d, owner, positionMint), [borrower]);
  // The pool's books and the slot they were read at, so every later event can be weighed against them
  const { context, value } = await connection.getAccountInfoAndContext(pda.pool());
  const before = program.coder.accounts.decode("pool", value!.data);
  const drawn = (await health()).creditLimit.muln(97).divn(100);
  await send(await ix.draw(program, d, owner, drawn), [borrower]);
  console.log(`Drew ${whole(drawn)} USDC`);

  step("Trading fees for the position: one swap each way");
  await faucet(d, me, { usdc: 20_000 });
  const orcaPool = await client.getPool(whirlpool, IGNORE_CACHE);
  for (const [mint, amount] of [[NATIVE_MINT, 3 * LAMPORTS_PER_SOL], [usdc, 450e6]] as const) {
    await orcaPool.refreshData();
    const slippage = Percentage.fromFraction(1, 100);
    const quote = await swapQuoteByInputToken(orcaPool, mint, new BN(amount), slippage, PROGRAM, ctx.fetcher, IGNORE_CACHE);
    await (await orcaPool.swap(quote)).buildAndExecute();
  }

  step("Keeper");
  const keeper = start("keeper", "keeper/index.ts", [], {
    RPC_URL: url,
    CLUSTER: cluster,
    KEEPER_KEYPAIR: path.join(os.homedir(), ".config/solana/id.json"),
    INTERVAL_MS: "1000",
    AUTOPAY_INTERVAL_MS: "600000",
    DRY_RUN: "",
  });
  await until("the keeper to promote the account to tier 1", async () => (await fetchCredit(program, owner))?.tier === 1);
  await until("the autopay row", async () => (await rows()).some((r) => r.kind === "autopay"));
  const beat = await until("a demo feed heartbeat for the stock", async () => {
    const now = await program.account.demoPrice.fetch(pda.demoPrice(stock));
    return now.publishTime.gt(stockPrice0.publishTime) && now;
  });
  assert(beat.price.eq(stockPrice0.price) && beat.conf.eq(stockPrice0.conf), "The heartbeat changed the stock price");

  step("Dip: under the warning level but not liquidatable, so only the tier goes");
  const risk = (await fetchPositions(program, d, (await fetchCredit(program, owner))!)).map((p) => p.risk);
  const prices = await fetchPrices(program, d);
  const debt = whole((await health()).debt);
  const healthAt = (sol: number) => math.limits(risk, pool0.params, { ...prices, [d.solMint]: sol }).liquidationLimit / debt;
  const dip = [0.98, 0.96, 0.94, 0.92, 0.9, 0.88]
    .map((f) => f * prices[d.solMint])
    .find((p) => healthAt(p) > 1.02 && healthAt(p) < 1.08);
  assert(dip, "No dip price puts the account between liquidation and the warning level");
  await setSol(new BN(micro(dip)));
  await until("the keeper to drop the account to tier 0", async () => (await fetchCredit(program, owner))?.tier === 0);
  const dipped = await health();
  assert(dipped.debt.lte(dipped.liquidationLimit), "The dip made the account liquidatable");
  assert(!(await rows()).some((r) => r.detail.startsWith("Liquidation")), "The keeper liquidated a healthy account");

  step("Crash: SOL at half its starting price");
  await setSol(solPrice0.price.divn(2));
  const after = await until("the keeper to finish liquidating", async () => {
    const h = await health();
    return h.debt.lte(h.liquidationLimit) && h;
  });
  // Stopped before the books are compared, so nothing moves while they are read
  keeper.child.kill("SIGINT");
  const [code] = await once(keeper.child, "exit");
  assert(code === 0 && keeper.output().includes("Keeper stopped"), `The keeper did not exit cleanly on SIGINT, code ${code}`);
  const [poolNow, creditNow] = [await fetchPool(program), (await fetchCredit(program, owner))!];
  // Debt as of the account's last transaction, which is what its last event reports
  const owed = creditNow.debtShares.mul(poolNow.borrowIndex[creditNow.tier]).add(INDEX_ONE.subn(1)).div(INDEX_ONE);
  console.log(`Account ended with ${whole(after.debt)} USDC of debt and a liquidation limit of ${whole(after.liquidationLimit)}`);

  step("Checks");
  const sum = (list: Row[]) => list.reduce((s, r) => s + micro(r.amount), 0);
  const of = (list: Row[], kind: Row["kind"]) => list.filter((r) => r.kind === kind);
  const liquidated = (list: Row[]) => list.filter((r) => r.detail.startsWith("Liquidation"));
  const balance = (list: Row[]) =>
    sum(of(list, "draw")) + sum(of(list, "interest")) - sum(of(list, "repay")) - sum(of(list, "autopay"));
  // What an event of any account moved in or out of the pool's cash
  const flows: Record<string, (e: StoredEvent["data"]) => number> = {
    drawn: (e) => -Number(e.amount),
    protocolFeesCollected: (e) => -Number(e.amount),
    repaid: (e) => Number(e.amount),
    liquidated: (e) => Number(e.repaid),
    lenderMoved: (e) => Number(e.usdc) * (e.deposit ? 1 : -1),
  };
  const cashFlow = (e: StoredEvent) => flows[e.name]?.(e.data) ?? 0;
  const stored = (): StoredEvent[] =>
    fs.readFileSync(data, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((e) => e.slot > context.slot);
  const total = (amount: (e: StoredEvent) => number) => stored().reduce((s, e) => s + amount(e), 0);
  const cashChange = poolNow.cash.sub(before.cash).toNumber();
  const all = await until("the indexer to catch up", async () => {
    const list = await rows();
    return balance(list) === owed.toNumber() && liquidated(list).length > 0 && total(cashFlow) === cashChange && list;
  });
  for (const r of all) console.log(`${r.date} ${r.kind.padEnd(8)} ${r.amount.toFixed(6).padStart(14)}  ${r.detail}`);

  const today = new Date().toISOString().slice(0, 10);
  assert.deepEqual(all, [...all].sort((a, b) => a.time - b.time), "Rows are not oldest first");
  assert.equal(new Set(all.map((r) => r.id)).size, all.length, "Row ids repeat");
  assert(all.every((r) => r.date === today && r.tx.length > 80), "A row has the wrong date or signature");
  assert(all.every((r) => Math.abs(r.time - Date.now() / 1000) < 600), "A row has the wrong time");

  const draws = of(all, "draw");
  const wallet = await connection.getTokenAccountBalance(getAssociatedTokenAddressSync(usdc, owner));
  assert.equal(draws.length, 1, "Expected one draw row");
  assert.equal(micro(draws[0].amount), drawn.toNumber(), "The draw row does not match the amount drawn");
  assert.equal(wallet.value.amount, drawn.toString(), "The borrower's wallet does not hold the amount drawn");

  const autopays = of(all, "autopay");
  assert.equal(autopays.length, 1, `Expected autopay to run once, saw ${autopays.length} rows`);
  assert(autopays[0].amount > 0 && autopays[0].source === "orca", "The autopay row is empty or has no source");
  assert.equal(keeper.output().match(/Autopay for .*, tx /g)?.length, 1, "The keeper did not log exactly one autopay");

  const liquidations = liquidated(all);
  const byKeeper = liquidations.every((r) => r.kind === "repay" && r.detail === `Liquidation by ${short(me)}`);
  assert(liquidations.length > 0 && byKeeper, "Liquidation rows are missing or not the keeper's");
  assert(keeper.output().includes(`Liquidation of ${owner.toBase58()}`), "The keeper did not log a liquidation");
  assert(after.debt.isZero() || after.debt.lte(after.liquidationLimit), "The account is still liquidatable");

  const tiers = of(all, "tier").map((r) => r.detail);
  assert.deepEqual(tiers, ["Tier 1 to Tier 2", "Tier 2 to Tier 1"], "Tier rows are wrong");
  assert.equal(creditNow.tier, 0, "The tier was not reset");

  const badDebt = poolNow.badDebt.sub(before.badDebt).toNumber();
  assert.equal(balance(all), owed.toNumber(), "Rows do not add up to the account's debt");
  assert.equal(total(cashFlow), cashChange, "Indexed events do not add up to the change in pool cash");
  assert.equal(total((e) => (e.name === "badDebt" ? Number(e.data.loss) : 0)), badDebt, "Indexed write-offs are not the pool's bad debt");
  console.log(`Books add up: debt ${whole(owed)}, pool cash change ${cashChange / 1e6}, bad debt ${badDebt / 1e6}`);

  const stats = await get("/stats");
  const day = stats[stats.length - 1];
  assert(stats.length === 90 && day.date === today, "Stats do not cover 90 days ending today");
  assert(micro(day.draws) >= drawn.toNumber() && micro(day.autopay) >= sum(autopays), "Today's stats miss this run");
  assert(day.liquidations >= liquidations.length, "Today's stats miss the liquidations");
  const state = await get("/health");
  assert(state.ok && state.events >= all.length && state.lastSlot > 0, "The health route is wrong");

  // A second, uncompressed delivery of a stored transaction, wrapped the way Streams may wrap a filter's result
  const signature = liquidations[liquidations.length - 1].tx;
  const tx = (await connection.getTransaction(signature, { maxSupportedTransactionVersion: 0 }))!;
  const again = { signature, slot: tx.slot, blockTime: tx.blockTime, err: null, logs: tx.meta!.logMessages };
  const body = JSON.stringify({ data: [again] });
  const post = (nonce: string, signed: string) =>
    fetch(`${api}/webhook`, {
      method: "POST",
      headers: { "x-qn-nonce": nonce, "x-qn-timestamp": "1", "x-qn-signature": signed },
      body,
    });
  const repeat = await post("a", sign(token, "a", "1", body));
  assert.deepEqual([repeat.status, await repeat.json()], [200, { ok: true, stored: 0 }], "A repeated delivery was stored again");
  assert.equal((await post("b", sign(token, "a", "1", body))).status, 401, "A wrong signature was accepted");
  assert.equal((await fetch(`${api}/webhook`, { method: "POST", body })).status, 401, "An unsigned delivery was accepted");

  assert(keeper.output().includes("Demo feed heartbeat: NVDAx"), "The keeper did not log the heartbeat");
  assert(!keeper.output().includes(" failed: "), "The keeper logged a failure");
  console.log("\nKeeper e2e passed");
} finally {
  for (const child of children) child.kill();
  const restore = (what: string, run: Promise<unknown>) => run.catch((e) => console.error(`Could not restore ${what}: ${e.message}`));
  await restore("the pool settings", setTiers(pool0.params.tierMinHealthySecs));
  await restore("the stock settings", setStockAge(stockAsset0.params.maxPriceAgeSecs));
  await restore("the SOL price", setSol(solPrice0.price, solPrice0.conf));
}
