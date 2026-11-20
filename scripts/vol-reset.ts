// Demo pools only: sets every listed asset's volatility back to its measured seed in SIGMA_BPS
// For when a jump that was not a real move, such as a demo price giving way to the real one, has inflated the dynamic shocks
//   npm run vol:reset [-- --url http://127.0.0.1:18899]
import { PublicKey } from "@solana/web3.js";
import { ix, pda } from "../sdk/index.ts";
import { SIGMA_BPS, loadDeployment, program, send } from "./lib.ts";
import { me } from "./orca-common.ts";

const d = loadDeployment();
for (const [mint, a] of Object.entries(d.assets)) {
  const sigma = SIGMA_BPS[a.symbol];
  if (sigma === undefined || !(await program.account.asset.fetchNullable(pda.asset(new PublicKey(mint))))) continue;
  await send(await ix.demoResetVol(program, me, new PublicKey(mint), sigma));
  console.log(`${a.symbol}: volatility reset to ${sigma / 100}% a year`);
}
