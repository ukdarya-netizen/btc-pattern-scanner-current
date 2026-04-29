import crypto from "crypto";

export function hmacSha256(secret: string, message: string): string {
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

export function buildQueryString(params: Record<string, string | number | boolean>): string {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function computeImbalance(bids: { size: number }[], asks: { size: number }[], levels = 10): number {
  const bidVol = bids.slice(0, levels).reduce((s, l) => s + l.size, 0);
  const askVol = asks.slice(0, levels).reduce((s, l) => s + l.size, 0);
  const total = bidVol + askVol;
  return total > 0 ? (bidVol - askVol) / total : 0;
}
