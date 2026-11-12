/**
 * Lucy's VSA volume for BTC (owner 2026-11-12: ABNeon / Stealth on BTC, volume by the owner's indicator).
 * CoinGlass aggregated taker volume, futures (all exchanges) + spot (all spot exchanges) — the indicator's total —
 * in USD by candle open time, on 15m / 1h / 4h, the last 160 closed bars. Cached per interval and refreshed only
 * when its latest closed bar is missing (15m: every 15 min, 1h: hourly, 4h: every 4 h). Spot missing = futures only
 * (the indicator shows what exists); futures missing = no data. Never throws.
 */
import { cgGet, FUTURES_EXCHANGES, SPOT_EXCHANGES } from "./coinglass";

export type LucyTf = "15m" | "1h" | "4h";
export type LucyVolume = Record<LucyTf, Map<number, number> | null>;
const STEP: Record<LucyTf, number> = { "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000 };
const BARS = 160;
const cache = new Map<LucyTf, Map<number, number>>();

async function taker(spot: boolean, interval: LucyTf): Promise<Map<number, number> | null> {
  const data = await cgGet(spot ? "/api/spot/aggregated-taker-buy-sell-volume/history" : "/api/futures/aggregated-taker-buy-sell-volume/history", {
    symbol: "BTC", interval, limit: BARS, exchange_list: spot ? SPOT_EXCHANGES : FUTURES_EXCHANGES,
  }).catch(() => null);
  if (!Array.isArray(data) || data.length === 0) return null;
  const m = new Map<number, number>();
  for (const row of data as Array<Record<string, unknown>>) {
    const raw = Number(row.time);
    const t = raw < 1e12 ? raw * 1000 : raw;
    const v = Number(row.aggregated_buy_volume_usd) + Number(row.aggregated_sell_volume_usd);
    if (Number.isFinite(t) && Number.isFinite(v)) m.set(t, v);
  }
  return m.size ? m : null;
}

async function series(tf: LucyTf, now: number): Promise<Map<number, number> | null> {
  const lastClosedOpen = Math.floor(now / STEP[tf]) * STEP[tf] - STEP[tf];
  const known = cache.get(tf);
  if (known?.has(lastClosedOpen)) return known;
  const [fut, spot] = await Promise.all([taker(false, tf), taker(true, tf)]);
  if (!fut) return known ?? null;
  const total = new Map<number, number>();
  for (const [t, v] of fut) if (t <= lastClosedOpen) total.set(t, v + (spot?.get(t) ?? 0));
  cache.set(tf, total);
  return total;
}

export async function getLucyVolume(now = Date.now()): Promise<LucyVolume> {
  const [a, b, c] = await Promise.all([series("15m", now), series("1h", now), series("4h", now)]);
  return { "15m": a, "1h": b, "4h": c };
}
