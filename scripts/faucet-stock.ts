// Stocks the wallet behind the web app's Get test tokens button
// It holds mock tokens, a little SOL and ready-made Orca positions, so the web server never needs the admin key
// Safe to rerun, since each run only tops the wallet up to its targets
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";
import { listOrcaPositions } from "../sdk/index.ts";
import { amount, faucet, loadDeployment, send } from "./lib.ts";
import { args, cluster, connection, key, me } from "./orca-common.ts";

const local = cluster === "localnet";
const to = key("faucet").publicKey;
const want = {
  sol: amount("sol", args.sol ?? (local ? "500" : "0.4")),
  positions: amount("positions", args.positions ?? "5"),
  // Dollar value of each position, kept small where its SOL side costs real devnet SOL
  lp: amount("lp", args.lp ?? (local ? "10000" : "20")),
};

const d = loadDeployment();
const sol = Math.max(0, want.sol - (await connection.getBalance(to)) / LAMPORTS_PER_SOL);
// A local chain airdrops the SOL inside faucet, and anywhere else it comes out of the admin wallet
if (!local && sol > 0) {
  await send([SystemProgram.transfer({ fromPubkey: me, toPubkey: to, lamports: Math.round(sol * LAMPORTS_PER_SOL) })]);
}
const stockAccount = getAssociatedTokenAddressSync(new PublicKey(d.stockMint), to);
const stocked = await connection.getTokenAccountBalance(stockAccount).then(
  (b) => Number(b.value.uiAmount) > 0,
  () => false,
);
// Mock tokens cost nothing to mint, so the stash is far more than the SOL will ever let it hand out
await faucet(d, to, { sol, stock: stocked ? 0 : 1_000_000, usdc: stocked ? 0 : 100_000_000, lp: 0 });
const held = (await listOrcaPositions(connection, d, to)).length;
for (let i = held; i < want.positions; i++) await faucet(d, to, { lp: want.lp, range: [120, 180] });

console.log(`Faucet wallet ${to.toBase58()} holds ${want.sol} SOL or more and ${Math.max(held, want.positions)} Orca positions worth $${want.lp} each`);
console.log(`The web app hands tokens out once FAUCET_SECRET holds the contents of scripts/.keys/${cluster}/faucet.json`);
