/**
 * Crypto Fear & Greed index (owner 2026-11-12: «Сентимент: Fear/Greed» in the morning report). CoinGlass v4
 * /api/index/fear-greed-history (all plans, updated once a day): data_list (index values), time_list (timestamps).
 * The last two points give today and yesterday. Never throws; null when CoinGlass gives nothing usable.
 */
import { cgGet } from "./coinglass";

export type FearGreed = { value: number; prev: number | null; label: string };
export type FearGreedPoint = { t: number; v: number };

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

/** Daily history (oldest first), the last `days` points. */
export function parseFearGreedHistory(data: unknown, days = 30): FearGreedPoint[] {
  const obj = (Array.isArray(data) ? data[0] : data) as { data_list?: unknown; time_list?: unknown } | null | undefined;
  const values = Array.isArray(obj?.data_list) ? (obj!.data_list as unknown[]).map(Number) : [];
  const times = Array.isArray(obj?.time_list) ? (obj!.time_list as unknown[]).map(Number) : [];
  if (times.length !== values.length) return [];
  return values.map((v, i) => ({ t: times[i]! < 10_000_000_000 ? times[i]! * 1000 : times[i]!, v }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.v) && p.v >= 0 && p.v <= 100)
    .sort((a, b) => a.t - b.t).slice(-days).map((p) => ({ t: p.t, v: Math.round(p.v) }));
}

// One CoinGlass request per hour at most (the index is updated once a day); the dashboard and the report share it.
let cache: { at: number; latest: FearGreed | null; history: FearGreedPoint[] } | null = null;
const CACHE_MS = 60 * 60_000;

export async function fearGreedCached(now = Date.now()): Promise<{ latest: FearGreed | null; history: FearGreedPoint[] }> {
  // A good reading is kept an hour; after a failed read the next try is in 5 minutes (never on every page load).
  if (cache && now - cache.at < (cache.latest ? CACHE_MS : 5 * 60_000)) return cache;
  const data = await cgGet("/api/index/fear-greed-history", {});
  const latest = parseFearGreed(data);
  cache = latest ? { at: now, latest, history: parseFearGreedHistory(data) } : { at: now, latest: cache?.latest ?? null, history: cache?.history ?? [] };
  return cache;
}

export async function getFearGreed(): Promise<FearGreed | null> {
  return (await fearGreedCached()).latest;
}
