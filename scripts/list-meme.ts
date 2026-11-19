// Lists a mock memecoin on a deployed demo pool, and brings its risk setup up to date: real Pyth feed ids, per-asset risk premiums,
// the premium tiers, and the switch of assets from their demo prices to their feeds
// Safe to run again: every step looks at the chain first, and an asset whose feed was not fresh enough to go live before is tried again
//   npm run list:meme -- --url https://api.devnet.solana.com
import fs from "node:fs";
import path from "node:path";
import { pda } from "../sdk/index.ts";
import {
  LIVE_SYMBOLS,
  MEME,
  addFeeds,
  demoActivateNow,
  deploymentFile,
  ensureFeedIds,
  ensureLookupTable,
  ensurePremiums,
  ensureShockColumn,
  goLive,
  listMeme,
  loadDeployment,
  program,
} from "./lib.ts";
import { root } from "./orca-common.ts";

const d = loadDeployment();
if (!(await program.account.pool.fetch(pda.pool())).demoMode) throw new Error("Demo mode is off on this pool, so its assets cannot be listed or switched at once");

// The listing's volatility horizon needs a shock column that shocks something, so the column comes first
await ensureShockColumn(d, MEME.group, MEME.initShocks, MEME.maintShocks);
const mint = await listMeme(d);
addFeeds(d);
await ensureFeedIds(d);
await ensurePremiums(d);
// Feed ids, premiums and the new listing wait out the activation delay, 8 days on devnet, which in demo mode protects nobody
await demoActivateNow(d);
await ensureLookupTable(d);

fs.writeFileSync(deploymentFile, JSON.stringify(d, null, 2) + "\n");
console.log(`Wrote ${deploymentFile}`);
// The web app reads its own copy of the deployments, which npm run sdk:sync refreshes along with the SDK
const web = path.join(root, "web/src/lib/pluribus/deployments");
if (fs.existsSync(web)) fs.copyFileSync(deploymentFile, path.join(web, path.basename(deploymentFile)));

// SOL and NVDAx stay on their demo prices, so the crash demo can still move them
// An asset goes live only while its feed is fresh and its price is one the program accepts, so run this again after the keeper
// has been posting the rest
await goLive(d, LIVE_SYMBOLS);
console.log(`${MEME.symbol} mint ${mint.toBase58()}`);
