import { createHmac } from "node:crypto";

// How QuickNode Streams signs a webhook: HMAC-SHA256 over nonce, timestamp and the uncompressed body, as hex
export const sign = (token: string, nonce: string, timestamp: string, body: string) =>
  createHmac("sha256", token).update(nonce + timestamp + body).digest("hex");
