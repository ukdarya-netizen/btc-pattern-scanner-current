import { logger } from "../lib/logger";

const FUT_BASE = "https://fapi.binance.com";
const SPOT_BASE = "https://api.binance.com";

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) {
      logger.warn({ url, status: res.status }, "Binance request failed");
      return null;
    }
    return (await res.json()) as T;
  } catch (e) {
    logger.warn({ url, err: (e as Error).message }, "Binance request errored");
    return null;
  }
}

export interface OiHistPoint {
  symbol: string;
  sumOpenInterest: string;
  sumOpenInterestValue: string;
  timestamp: number;
}

export async function fetchOiHist(symbol: string, period: string, limit: number): Promise<OiHistPoint[]> {
  const url = `${FUT_BASE}/futures/data/openInterestHist?symbol=${symbol}&period=${period}&limit=${limit}`;
  const data = await getJson<OiHistPoint[]>(url);
  return Array.isArray(data) ? data : [];
}

// [openTime, open, high, low, close, volume, closeTime, quoteVolume, trades, takerBuyBaseVol, takerBuyQuoteVol, ignore]
export type RawKline = [number, string, string, string, string, string, number, string, number, string, string, string];

export async function fetchFuturesKlines(symbol: string, interval: string, limit: number): Promise<RawKline[]> {
  const url = `${FUT_BASE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const data = await getJson<RawKline[]>(url);
  return Array.isArray(data) ? data : [];
}

export async function fetchSpotKlines(symbol: string, interval: string, limit: number): Promise<RawKline[]> {
  const url = `${SPOT_BASE}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const data = await getJson<RawKline[]>(url);
  return Array.isArray(data) ? data : [];
}

export interface TakerRatioPoint {
  buySellRatio: string;
  buyVol: string;
  sellVol: string;
  timestamp: number;
}

export async function fetchTakerLongShortRatio(symbol: string, period: string, limit: number): Promise<TakerRatioPoint[]> {
  const url = `${FUT_BASE}/futures/data/takerlongshortRatio?symbol=${symbol}&period=${period}&limit=${limit}`;
  const data = await getJson<TakerRatioPoint[]>(url);
  return Array.isArray(data) ? data : [];
}

export interface PremiumIndex {
  symbol: string;
  lastFundingRate: string;
}

export async function fetchFundingRate(symbol: string): Promise<number | null> {
  const url = `${FUT_BASE}/fapi/v1/premiumIndex?symbol=${symbol}`;
  const data = await getJson<PremiumIndex>(url);
  if (!data) return null;
  const v = Number(data.lastFundingRate);
  return Number.isNaN(v) ? null : v;
}
