import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  // Bundling this one hides its native binding, which makes it warn on every server start
  serverExternalPackages: ["bigint-buffer"],
  turbopack: {
    // Anchor's browser build still requires fs inside a helper that only runs in Node
    resolveAlias: { fs: { browser: "./src/lib/empty.ts" } },
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
