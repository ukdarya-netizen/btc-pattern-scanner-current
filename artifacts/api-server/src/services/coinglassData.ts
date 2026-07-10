import { logger } from "../lib/logger";
import type { OiHistBar, OhlcvBar } from "./coinalyzeData";

const BASE = "https://open-api-v4.coinglass.com";
const EXCHANGE = "Bybit";
const INTERVAL = "5m";
const HISTORY_LIMIT = 289; // ~24h + 1 at 5min resolution

function apiKey(): string {
  const key = process.env.COINGLASS_API_KEY;
  if (!key) throw new Error("COINGLASS_API_KEY is not set");
  return key;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson<T>(url: string, retries = 3): Promise<T | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "CG-API-KEY": apiKey(), Accept: "application/json" },
      });
      clearTimeout(timeout);
      if (res.status === 429) {
        const retryAfterHeader = res.headers.get("retry-after");
        const retryAfterMs = retryAfterHeader
          ? Math.ceil(parseFloat(retryAfterHeader) * 1000)
          : 1000 * Math.pow(2, attempt);
        logger.warn({ url, attempt, retryAfterMs }, "CoinGlass rate limited, backing off");
        await sleep(retryAfterMs);
        continue;
      }
      if (!res.ok) {
        logger.warn({ url, status: res.status }, "CoinGlass request failed");
        return null;
      }
      const json = (await res.json()) as { code?: string; msg?: string; data?: T };
      if (json.code !== undefined && json.code !== "0") {
        logger.warn({ url, code: json.code, msg: json.msg }, "CoinGlass API error");
        return null;
      }
      return (json.data ?? null) as T | null;
    } catch (e) {
      logger.warn({ url, err: (e as Error).message }, "CoinGlass request errored");
      return null;
    }
  }
  logger.warn({ url }, "CoinGlass request exhausted retries");
  return null;
}

interface PriceHistoryItem {
  time: number;
  open: string | number;
  high: string | number;
  low: string | number;
  close: string | number;
  volume_usd?: string | number;
}

interface OiHistoryItem {
  time: number;
  open: string | number;
  high: string | number;
  low: string | number;
  close: string | number;
}

interface TakerVolumeItem {
  time: number;
  taker_buy_volume_usd: string | number;
  taker_sell_volume_usd: string | number;
}

interface FundingHistoryItem {
  time: number;
  close: string | number;
}

function num(v: string | number | undefined): number {
  if (v === undefined) return 0;
  return typeof v === "number" ? v : parseFloat(v);
}

async function fetchPriceWithTakerVolume(symbol: string, market: "futures" | "spot"): Promise<OhlcvBar[]> {
  const priceUrl = `${BASE}/api/${market}/price/history?exchange=${EXCHANGE}&symbol=${symbol}&interval=${INTERVAL}&limit=${HISTORY_LIMIT}`;
  const takerUrl = `${BASE}/api/${market}/taker-buy-sell-volume/history?exchange=${EXCHANGE}&symbol=${symbol}&interval=${INTERVAL}&limit=${HISTORY_LIMIT}`;
  const [priceData, takerData] = await Promise.all([
    getJson<PriceHistoryItem[]>(priceUrl),
    getJson<TakerVolumeItem[]>(takerUrl),
  ]);
  if (!Array.isArray(priceData)) return [];
  const takerByTime = new Map<number, TakerVolumeItem>();
  if (Array.isArray(takerData)) {
    for (const item of takerData) takerByTime.set(item.time, item);
  }
  return priceData.map((bar) => {
    const taker = takerByTime.get(bar.time);
    const buy = taker ? num(taker.taker_buy_volume_usd) : 0;
    const sell = taker ? num(taker.taker_sell_volume_usd) : 0;
    return {
      t: Math.floor(bar.time / 1000),
      o: num(bar.open),
      h: num(bar.high),
      l: num(bar.low),
      c: num(bar.close),
      v: buy + sell > 0 ? buy + sell : num(bar.volume_usd),
      bv: buy,
    };
  });
}

export async function fetchOiHistoryBatch(symbols: string[]): Promise<Map<string, OiHistBar[]>> {
  const result = new Map<string, OiHistBar[]>();
  for (const symbol of symbols) {
    const url = `${BASE}/api/futures/open-interest/history?exchange=${EXCHANGE}&symbol=${symbol}&interval=${INTERVAL}&limit=${HISTORY_LIMIT}`;
    const data = await getJson<OiHistoryItem[]>(url);
    if (!Array.isArray(data)) continue;
    result.set(
      symbol,
      data.map((bar) => ({
        t: Math.floor(bar.time / 1000),
        o: num(bar.open),
        h: num(bar.high),
        l: num(bar.low),
        c: num(bar.close),
      })),
    );
  }
  return result;
}

export async function fetchFuturesOhlcvBatch(symbols: string[]): Promise<Map<string, OhlcvBar[]>> {
  const result = new Map<string, OhlcvBar[]>();
  for (const symbol of symbols) {
    const bars = await fetchPriceWithTakerVolume(symbol, "futures");
    if (bars.length > 0) result.set(symbol, bars);
  }
  return result;
}

export async function fetchSpotOhlcvBatch(symbols: string[]): Promise<Map<string, OhlcvBar[]>> {
  const result = new Map<string, OhlcvBar[]>();
  for (const symbol of symbols) {
    const bars = await fetchPriceWithTakerVolume(symbol, "spot");
    if (bars.length > 0) result.set(symbol, bars);
  }
  return result;
}

export async function fetchFundingRateBatch(symbols: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  for (const symbol of symbols) {
    const url = `${BASE}/api/futures/funding-rate/history?exchange=${EXCHANGE}&symbol=${symbol}&interval=${INTERVAL}&limit=1`;
    const data = await getJson<FundingHistoryItem[]>(url);
    if (!Array.isArray(data) || data.length === 0) continue;
    result.set(symbol, num(data[data.length - 1]!.close));
  }
  return result;
}

export async function checkCoinglassHealth(): Promise<{ ok: boolean; message: string }> {
  try {
    const url = `${BASE}/api/futures/price/history?exchange=${EXCHANGE}&symbol=BTCUSDT&interval=${INTERVAL}&limit=1`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "CG-API-KEY": apiKey(), Accept: "application/json" },
    });
    clearTimeout(timeout);
    if (!res.ok) return { ok: false, message: `HTTP ${res.status}` };
    const json = (await res.json()) as { code?: string; msg?: string };
    if (json.code !== undefined && json.code !== "0") return { ok: false, message: json.msg ?? `code ${json.code}` };
    return { ok: true, message: "OK" };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
