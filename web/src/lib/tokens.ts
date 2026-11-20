// The repo ignores image files, so a token with no icon in public/tokens gets a plain lettered mark drawn here
const mark = (letter: string, bg: string, edge: string) =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" fill="${bg}"/><path d="M83 0h90l-45 45zM83 256h90l-45-45zM0 83v90l45-45zM256 83v90l-45-45z" fill="${edge}"/><text x="128" y="164" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="112" font-weight="700" fill="#fff">${letter}</text></svg>`,
  )}`;

/** Icon, as a file in public/tokens or a data URL, and a one-line description for each token a deployment lists, by symbol */
export const TOKEN_INFO: Record<string, { icon: string; sub: string }> = {
  SOL: { icon: "sol.webp", sub: "Solana" },
  JitoSOL: { icon: "jitosol.webp", sub: "Jito liquid staking" },
  JupSOL: { icon: "jupsol.webp", sub: "Jupiter liquid staking" },
  NVDAx: { icon: "nvdax.webp", sub: "NVIDIA xStock" },
  AAPLx: { icon: mark("A", "#8e9399", "#4a4e53"), sub: "Apple xStock, Token-2022" },
  BONK: { icon: "bonk.webp", sub: "Bonk memecoin" },
  USDC: { icon: "usdc.webp", sub: "USD Coin" },
};

// the tokens the app offers, in the order it lists them. the rest stay listed on-chain, and an account that already holds one still sees it
export const OFFERED = ["SOL", "NVDAx", "AAPLx", "USDC"];

export const tokenIcon = (symbol: string) => TOKEN_INFO[symbol]?.icon ?? "usdc.webp";
/** The src for an icon from TOKEN_INFO or a file name in public/tokens */
export const iconSrc = (icon: string) => (icon.startsWith("data:") ? icon : `/tokens/${icon}`);
