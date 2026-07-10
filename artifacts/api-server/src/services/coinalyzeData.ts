import { logger } from "../lib/logger";

const BASE = "https://api.coinalyze.net/v1";
const EXCHANGE_CODE = "6"; // Bybit
const HISTORY_INTERVAL = "5min";
const HISTORY_BARS = 289; // ~24h + 1 at 5min resolution

function apiKey(): string {
  const key = process.env.COINALYZE_API_KEY;
  if (!key) throw new Error("COINALYZE_API_KEY is not set");
  return key;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson<T>(url: string, retries = 5): Promise<T | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const res = await fetch(url, { signal: controller.signal, headers: { api_key: apiKey() } });
      clearTimeout(timeout);
      if (res.status === 429) {
        const retryAfterHeader = res.headers.get("retry-after");
        const retryAfterMs = retryAfterHeader ? Math.ceil(parseFloat(retryAfterHeader) * 1000) : 1000 * Math.pow(2, attempt);
        logger.warn({ url, attempt, retryAfterMs }, "Coinalyze rate limited, backing off");
        await sleep(retryAfterMs);
        continue;
      }
      if (!res.ok) {
        logger.warn({ url, status: res.status }, "Coinalyze request failed");
        return null;
      }
      return (await res.json()) as T;
    } catch (e) {
      logger.warn({ url, err: (e as Error).message }, "Coinalyze request errored");
      return null;
    }
  }
  logger.warn({ url }, "Coinalyze request exhausted retries");
  return null;
}

export function toFutureSymbol(symbol: string): string {
  return `${symbol}.${EXCHANGE_CODE}`;
}

export function toSpotSymbol(symbol: string): string {
  return `s${symbol}.${EXCHANGE_CODE}`;
}

function fromFutureSymbol(coinalyzeSymbol: string): string {
  return coinalyzeSymbol.slice(0, -(EXCHANGE_CODE.length + 1));
}

function fromSpotSymbol(coinalyzeSymbol: string): string {
  return coinalyzeSymbol.slice(1, -(EXCHANGE_CODE.length + 1));
}

export interface OiHistBar { t: number; o: number; h: number; l: number; c: number }
export interface OhlcvBar { t: number; o: number; h: number; l: number; c: number; v: number; bv: number }

interface OiHistResponseItem { symbol: string; history: OiHistBar[] }
interface OhlcvResponseItem { symbol: string; history: OhlcvBar[] }
interface FundingResponseItem { symbol: string; value: number }

function historyRange(): { from: number; to: number } {
  const to = Math.floor(Date.now() / 1000);
  const from = to - HISTORY_BARS * 5 * 60;
  return { from, to };
}

export async function fetchOiHistoryBatch(symbols: string[]): Promise<Map<string, OiHistBar[]>> {
  const result = new Map<string, OiHistBar[]>();
  if (symbols.length === 0) return result;
  const coinalyzeSymbols = symbols.map(toFutureSymbol).join(",");
  const { from, to } = historyRange();
  const url = `${BASE}/open-interest-history?symbols=${coinalyzeSymbols}&interval=${HISTORY_INTERVAL}&from=${from}&to=${to}`;
  const data = await getJson<OiHistResponseItem[]>(url);
  if (!Array.isArray(data)) return result;
  for (const item of data) {
    result.set(fromFutureSymbol(item.symbol), item.history ?? []);
  }
  return result;
}

export async function fetchFuturesOhlcvBatch(symbols: string[]): Promise<Map<string, OhlcvBar[]>> {
  const result = new Map<string, OhlcvBar[]>();
  if (symbols.length === 0) return result;
  const coinalyzeSymbols = symbols.map(toFutureSymbol).join(",");
  const { from, to } = historyRange();
  const url = `${BASE}/ohlcv-history?symbols=${coinalyzeSymbols}&interval=${HISTORY_INTERVAL}&from=${from}&to=${to}`;
  const data = await getJson<OhlcvResponseItem[]>(url);
  if (!Array.isArray(data)) return result;
  for (const item of data) {
    result.set(fromFutureSymbol(item.symbol), item.history ?? []);
  }
  return result;
}

export async function fetchSpotOhlcvBatch(symbols: string[]): Promise<Map<string, OhlcvBar[]>> {
  const result = new Map<string, OhlcvBar[]>();
  if (symbols.length === 0) return result;
  const coinalyzeSymbols = symbols.map(toSpotSymbol).join(",");
  const { from, to } = historyRange();
  const url = `${BASE}/ohlcv-history?symbols=${coinalyzeSymbols}&interval=${HISTORY_INTERVAL}&from=${from}&to=${to}`;
  const data = await getJson<OhlcvResponseItem[]>(url);
  if (!Array.isArray(data)) return result;
  for (const item of data) {
    result.set(fromSpotSymbol(item.symbol), item.history ?? []);
  }
  return result;
}

export async function fetchFundingRateBatch(symbols: string[]): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  if (symbols.length === 0) return result;
  const coinalyzeSymbols = symbols.map(toFutureSymbol).join(",");
  const url = `${BASE}/funding-rate?symbols=${coinalyzeSymbols}`;
  const data = await getJson<FundingResponseItem[]>(url);
  if (!Array.isArray(data)) return result;
  for (const item of data) {
    result.set(fromFutureSymbol(item.symbol), item.value);
  }
  return result;
}
