/**
 * Crypto Fear & Greed index (owner 2026-11-12: «Сентимент: Fear/Greed» in the morning report). CoinGlass v4
 * /api/index/fear-greed-history (all plans, updated once a day): data_list (index values), time_list (timestamps).
 * The last two points give today and yesterday. Never throws; null when CoinGlass gives nothing usable.
 */
import { cgGet } from "./coinglass";

export type FearGreed = { value: number; prev: number | null; label: string };

/** Classification bands 0–100 (CoinMarketCap's published bands). */
export function fearGreedLabel(v: number): string {
  return v < 20 ? "Extreme Fear" : v < 40 ? "Fear" : v < 60 ? "Neutral" : v < 80 ? "Greed" : "Extreme Greed";
}

export function parseFearGreed(data: unknown): FearGreed | null {
  const obj = (Array.isArray(data) ? data[0] : data) as { data_list?: unknown; time_list?: unknown } | null | undefined;
  const values = Array.isArray(obj?.data_list) ? (obj!.data_list as unknown[]).map(Number) : [];
  const times = Array.isArray(obj?.time_list) ? (obj!.time_list as unknown[]).map(Number) : [];
  if (!values.length) return null;
  const order = values.map((_, i) => i);
  if (times.length === values.length) order.sort((a, b) => times[a]! - times[b]!);
  const ok = order.map((i) => values[i]!).filter((v) => Number.isFinite(v) && v >= 0 && v <= 100);
  const value = ok.at(-1);
  if (value === undefined) return null;
  return { value: Math.round(value), prev: ok.length > 1 ? Math.round(ok.at(-2)!) : null, label: fearGreedLabel(value) };
}

export async function getFearGreed(): Promise<FearGreed | null> {
  return parseFearGreed(await cgGet("/api/index/fear-greed-history", {}));
}
