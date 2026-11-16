// Makes a wallet demo-ready: SOL, stock, optional mock USDC and an Orca position
import { PublicKey } from "@solana/web3.js";
import { amount, faucet, loadDeployment } from "./lib.ts";
import { args, cluster } from "./orca-common.ts";

const usage = "Usage: faucet --to <pubkey> [--url ..] [--sol 20] [--stock 50] [--usdc 0] [--lp 10000] [--range 120-180]";
if (!args.to) throw new Error(usage);
let to: PublicKey;
try {
  to = new PublicKey(args.to);
} catch {
  throw new Error(`--to is not a valid address: "${args.to}"`);
}
const span = args.range ?? "120-180";
const range = span.split("-").map((p) => amount("range", p));
if (range.length !== 2 || !(range[0] > 0 && range[0] < range[1])) {
  throw new Error(`--range must look like 120-180, got "${span}"`);
}
const o = {
  sol: amount("sol", args.sol ?? "20"),
  stock: amount("stock", args.stock ?? "50"),
  usdc: amount("usdc", args.usdc ?? "0"),
  lp: amount("lp", args.lp ?? "10000"),
  range: range as [number, number],
};

const position = await faucet(loadDeployment(), to, o);
const sol = cluster === "localnet" ? `${o.sol} SOL, ` : "";
const lp = position ? `, Orca position ${position.toBase58()} worth $${o.lp} over $${span}` : "";
console.log(`Funded ${to.toBase58()}: ${sol}${o.stock} NVDAx, ${o.usdc} USDC${lp}`);
