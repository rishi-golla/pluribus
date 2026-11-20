// The crash control: the admin sets a demo price
import { PublicKey } from "@solana/web3.js";
import { ix } from "../sdk/index.ts";
import { amount, loadDeployment, program, send } from "./lib.ts";
import { args, me } from "./orca-common.ts";

const d = loadDeployment();
const mints: Record<string, string> = { sol: d.solMint, stock: d.stockMint };
const mint = mints[args.asset ?? ""];
if (!mint || !args.price) throw new Error("Usage: price --asset sol|stock --price <usd> [--url ..]");
const price = amount("price", args.price);
if (price === 0) throw new Error("--price must be above zero");

await send(await ix.setDemoPrice(program, me, new PublicKey(mint), Math.round(price * 1e6)));
console.log(`Set ${d.assets[mint].symbol} to $${price.toFixed(2)}`);
