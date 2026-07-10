import { logger } from "../lib/logger";
import type { OiHistBar, OhlcvBar } from "./coinalyzeData";
import * as coinalyze from "./coinalyzeData";
import * as coinglass from "./coinglassData";

// CoinGlass is the primary data source (higher rate limits); Coinalyze is kept as a
// fallback in case CoinGlass errors out or returns no data for a given batch.

async function withFallback<T>(
  label: string,
  primary: () => Promise<Map<string, T>>,
  fallback: () => Promise<Map<string, T>>,
): Promise<Map<string, T>> {
  try {
    const primaryResult = await primary();
    if (primaryResult.size > 0) return primaryResult;
    logger.warn({ label }, "CoinGlass returned no data, falling back to Coinalyze");
  } catch (e) {
    logger.warn({ label, err: (e as Error).message }, "CoinGlass request failed, falling back to Coinalyze");
  }
  try {
    return await fallback();
  } catch (e) {
    logger.warn({ label, err: (e as Error).message }, "Coinalyze fallback also failed");
    return new Map<string, T>();
  }
}

export async function fetchOiHistoryBatch(symbols: string[]): Promise<Map<string, OiHistBar[]>> {
  return withFallback(
    "oiHistory",
    () => coinglass.fetchOiHistoryBatch(symbols),
    () => coinalyze.fetchOiHistoryBatch(symbols),
  );
}

export async function fetchFuturesOhlcvBatch(symbols: string[]): Promise<Map<string, OhlcvBar[]>> {
  return withFallback(
    "futuresOhlcv",
    () => coinglass.fetchFuturesOhlcvBatch(symbols),
    () => coinalyze.fetchFuturesOhlcvBatch(symbols),
  );
}

export async function fetchSpotOhlcvBatch(symbols: string[]): Promise<Map<string, OhlcvBar[]>> {
  return withFallback(
    "spotOhlcv",
    () => coinglass.fetchSpotOhlcvBatch(symbols),
    () => coinalyze.fetchSpotOhlcvBatch(symbols),
  );
}

export async function fetchFundingRateBatch(symbols: string[]): Promise<Map<string, number>> {
  return withFallback(
    "fundingRate",
    () => coinglass.fetchFundingRateBatch(symbols),
    () => coinalyze.fetchFundingRateBatch(symbols),
  );
}
