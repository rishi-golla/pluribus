// Writes LOCAL_TEST_WALLET_PRIV from the repo's .env to the Solana CLI keypair file every script signs with
// Prints only the public key, and never replaces a different key already in that file
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@solana/web3.js";

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(text: string): Uint8Array {
  let n = 0n;
  for (const c of text) {
    const digit = ALPHABET.indexOf(c);
    if (digit < 0) throw new Error("LOCAL_TEST_WALLET_PRIV is not base58");
    n = n * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  for (; n > 0n; n >>= 8n) bytes.unshift(Number(n & 255n));
  // Each leading 1 stands for a zero byte
  for (const c of text) {
    if (c !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const line = fs
  .readFileSync(path.join(root, ".env"), "utf8")
  .split(/\r?\n/)
  .find((l) => /^\s*LOCAL_TEST_WALLET_PRIV\s*=/.test(l));
if (!line) throw new Error("LOCAL_TEST_WALLET_PRIV is not set in .env");
const secret = line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
const wallet = Keypair.fromSecretKey(base58(secret));

const out = process.argv[2] ?? path.join(os.homedir(), ".config/solana/id.json");
if (fs.existsSync(out)) {
  const current = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(out, "utf8"))));
  if (!current.publicKey.equals(wallet.publicKey)) throw new Error(`${out} holds ${current.publicKey.toBase58()}, move it first`);
} else {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify([...wallet.secretKey]), { mode: 0o600 });
}
console.log(`${wallet.publicKey.toBase58()} -> ${out}`);
