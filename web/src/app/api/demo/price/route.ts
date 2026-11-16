import { connection as requestTime } from "next/server";
import { Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { deployment, getConnection } from "@/lib/cluster";
import { fetchPrices, getProgram, ix } from "@/lib/pluribus/sdk";

// A demo crash never needs more, and the cap keeps a typo from wrecking every account
const MAX_MOVE = 20;

function admin() {
  const secret = process.env.DEMO_ADMIN_SECRET;
  return secret ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(secret))) : null;
}
const notFound = () => new Response(null, { status: 404 });
const refuse = (error: string, status = 400) => Response.json({ error }, { status });

/** Tells the client whether the price control can be shown */
export async function GET() {
  // Read the env var per request instead of freezing its build-time value into a static response
  await requestTime();
  return admin() && deployment ? Response.json({ ok: true }) : notFound();
}

/** Sets the demo price of one whitelisted asset, signed by the pool admin */
export async function POST(request: Request) {
  const signer = admin();
  if (!signer || !deployment) return notFound();

  const { mint, price } = await request.json().catch(() => ({}));
  if (typeof mint !== "string" || !deployment.assets[mint]?.priceAccount) return refuse("Unknown asset");
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return refuse("Price must be above zero");

  const connection = getConnection();
  const program = getProgram(connection);
  const current = (await fetchPrices(program, deployment))[mint];
  if (!(current > 0) || price > current * MAX_MOVE || price < current / MAX_MOVE) return refuse(`Price must be within ${MAX_MOVE}x of the current one`);

  try {
    const tx = new Transaction().add(...(await ix.setDemoPrice(program, signer.publicKey, new PublicKey(mint), Math.round(price * 1e6))));
    return Response.json({ signature: await sendAndConfirmTransaction(connection, tx, [signer], { commitment: "confirmed" }) });
  } catch {
    return refuse("The chain rejected the price update", 502);
  }
}
