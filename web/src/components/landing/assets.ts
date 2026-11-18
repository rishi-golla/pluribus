/** The asset classes the landing page draws as blocks, in shades of the brand purple from light to deep */
export const ASSET_CLASSES = [
  { key: "sol", label: "SOL and LSTs", color: "var(--color-brand)" },
  { key: "lp", label: "LP positions", color: "#c8bdff" },
  { key: "stock", label: "Tokenized stocks", color: "#6d58e0" },
  { key: "usdc", label: "USDC", color: "#544c7a" },
] as const;

export type AssetKey = (typeof ASSET_CLASSES)[number]["key"];

/** A small seeded random generator, so the same blocks come out on the server and in the browser */
export function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
