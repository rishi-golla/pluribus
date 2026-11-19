import { series } from "./chart";
import { tokenIcon } from "./tokens";

/** Pool-level figures from the ARCHITECTURE.pdf example ($10M pool, 80% utilization). */
export const POOL = { supplied: 10_000_000, borrowed: 8_000_000, senior: 9_000_000, junior: 1_000_000, insurance: 100_000, reserveFactor: 0.1 };

export type AssetClass = "SOL" | "LSTs" | "LP positions" | "Stocks" | "Memes";
export type Market = {
  id: string;
  name: string;
  sub: string;
  cls: AssetClass;
  icon: string;
  /** For LP markets: the protocol badge on the USDC side of the pair. */
  lpBadge?: string;
  /** For LP markets: the exchange whose positions it takes, which is how a deployment lists it. */
  dex?: "orca" | "raydium" | "meteora";
  collateral: number;
  borrowed: number;
  crashLtv: number;
  borrowApr: number;
  volume24h: number;
  change24h: number;
  liquidity: 1 | 2 | 3 | 4 | 5;
};

export const MARKETS: Market[] = [
  { id: "sol", name: "SOL", sub: "Solana", cls: "SOL", icon: "sol.webp", collateral: 5_420_000, borrowed: 2_740_000, crashLtv: 0.665, borrowApr: 0.104, volume24h: 412_000, change24h: 0.024, liquidity: 5 },
  { id: "jitosol", name: "JitoSOL", sub: "Jito liquid staking", cls: "LSTs", icon: "jitosol.webp", collateral: 3_180_000, borrowed: 1_620_000, crashLtv: 0.65, borrowApr: 0.106, volume24h: 188_000, change24h: 0.022, liquidity: 5 },
  { id: "jupsol", name: "JupSOL", sub: "Jupiter liquid staking", cls: "LSTs", icon: "jupsol.webp", collateral: 1_120_000, borrowed: 560_000, crashLtv: 0.64, borrowApr: 0.109, volume24h: 61_000, change24h: 0.021, liquidity: 4 },
  { id: "msol", name: "mSOL", sub: "Marinade liquid staking", cls: "LSTs", icon: "msol.png", collateral: 860_000, borrowed: 420_000, crashLtv: 0.635, borrowApr: 0.11, volume24h: 44_000, change24h: 0.023, liquidity: 4 },
  { id: "orca-lp", name: "SOL-USDC", sub: "Orca Whirlpools", cls: "LP positions", icon: "sol.webp", lpBadge: "orca.png", dex: "orca", collateral: 2_740_000, borrowed: 1_460_000, crashLtv: 0.708, borrowApr: 0.118, volume24h: 236_000, change24h: 0.011, liquidity: 4 },
  { id: "ray-lp", name: "SOL-USDC", sub: "Raydium CLMM", cls: "LP positions", icon: "sol.webp", lpBadge: "ray.webp", dex: "raydium", collateral: 1_310_000, borrowed: 690_000, crashLtv: 0.74, borrowApr: 0.119, volume24h: 97_000, change24h: 0.009, liquidity: 4 },
  { id: "met-lp", name: "SOL-USDC", sub: "Meteora DLMM", cls: "LP positions", icon: "sol.webp", lpBadge: "met.webp", dex: "meteora", collateral: 880_000, borrowed: 450_000, crashLtv: 0.689, borrowApr: 0.118, volume24h: 34_000, change24h: 0.01, liquidity: 4 },
  { id: "nvdax", name: "NVDAx", sub: "NVIDIA xStock", cls: "Stocks", icon: "nvdax.webp", collateral: 940_000, borrowed: 360_000, crashLtv: 0.58, borrowApr: 0.134, volume24h: 52_000, change24h: -0.006, liquidity: 3 },
  { id: "aaplx", name: "AAPLx", sub: "Apple xStock, Token-2022", cls: "Stocks", icon: tokenIcon("AAPLx"), collateral: 410_000, borrowed: 150_000, crashLtv: 0.585, borrowApr: 0.134, volume24h: 21_000, change24h: 0.004, liquidity: 3 },
  { id: "bonk", name: "BONK", sub: "Bonk memecoin", cls: "Memes", icon: "bonk.webp", collateral: 630_000, borrowed: 150_000, crashLtv: 0.35, borrowApr: 0.178, volume24h: 38_000, change24h: -0.041, liquidity: 2 },
];

/** Interest paid by borrowers against each market over 30 days. */
export const fees30d = (m: Market) => (m.borrowed * m.borrowApr) / 12;
/** Share of borrowing power in use: debt against this collateral over its crash-tested credit. */
export const powerUsed = (m: Market) => m.borrowed / (m.collateral * m.crashLtv);

export const TOTALS = (() => {
  const collateral = MARKETS.reduce((s, m) => s + m.collateral, 0);
  const borrowed = MARKETS.reduce((s, m) => s + m.borrowed, 0);
  const fees = MARKETS.reduce((s, m) => s + fees30d(m), 0);
  const volume = MARKETS.reduce((s, m) => s + m.volume24h, 0);
  return { collateral, borrowed, fees, volume, avgApr: (fees * 12) / borrowed };
})();

export const CLASS_COLORS: Record<AssetClass, string> = {
  SOL: "#9e8cff",
  LSTs: "#6aa8ff",
  "LP positions": "#3ddc97",
  Stocks: "#ffa24c",
  Memes: "#ff6166",
};

/** 90 days of protocol activity. The last day matches today's 24h volume. */
const DAYS = 90;
const draws = series(DAYS, 360_000, 520_000, 120_000, 41).map((v) => Math.max(120_000, v));
const repays = series(DAYS, 300_000, 430_000, 110_000, 42).map((v) => Math.max(100_000, v));
const autopay = series(DAYS, 52_000, 78_000, 14_000, 43).map((v) => Math.max(30_000, v));
const scale = TOTALS.volume / (draws[DAYS - 1] + repays[DAYS - 1] + autopay[DAYS - 1]);
export const VOLUME = draws.map((_, i) => ({ draws: draws[i] * scale, repays: repays[i] * scale, autopay: autopay[i] * scale }));

/* Scaled so the last 30 days sum exactly to the per-market 30D fee total. */
const rawFees = series(DAYS, 2050, TOTALS.fees / 30, 210, 44);
const feeScale = TOTALS.fees / rawFees.slice(-30).reduce((s, v) => s + v, 0);
const dailyFees = rawFees.map((f) => f * feeScale);
export const FEES = {
  lenders: dailyFees.map((f) => f * (1 - POOL.reserveFactor)),
  insurance: dailyFees.map((f) => f * POOL.reserveFactor),
};

export const compactUsd = (v: number) =>
  v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${v.toFixed(0)}`;
