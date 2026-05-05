import { logger } from "../lib/logger";
import { aggregator } from "./exchanges/aggregator";

export interface DailyCandle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface PatternMatch {
  startDate: string;
  endDate: string;
  similarity: number;
  forwardPct: number;
  outcome: "bullish" | "bearish" | "neutral";
  currentReturns: number[];
  historicalReturns: number[];
  forwardReturns: number[];
}

export interface PatternResult {
  signal: number;
  confidence: number;
  bullishMatches: number;
  bearishMatches: number;
  topMatches: PatternMatch[];
  currentReturns: number[];
  updatedAt: string;
}

const PATTERN_WINDOW = 7;
const FORWARD_WINDOW = 3;
const BYBIT_KLINE_URL = "https://api.bybit.com/v5/market/kline";
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;
const TOP_N = 10;

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  const meanA = a.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const meanB = b.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let num = 0, devA = 0, devB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    num += da * db;
    devA += da * da;
    devB += db * db;
  }
  const denom = Math.sqrt(devA * devB);
  return denom === 0 ? 0 : num / denom;
}

function toReturns(candles: DailyCandle[]): number[] {
  return candles.map(c => (c.close - c.open) / c.open);
}

function normalize(returns: number[]): number[] {
  const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
  const std = Math.sqrt(returns.reduce((s, v) => s + (v - mean) ** 2, 0) / returns.length);
  if (std === 0) return returns.map(() => 0);
  return returns.map(v => (v - mean) / std);
}

class PatternService {
  private candles: DailyCandle[] = [];
  private lastResult: PatternResult | null = null;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private lastFetch = 0;

  async start() {
    await this.fetchAndCompute();
    this.intervalId = setInterval(() => void this.fetchAndCompute(), REFRESH_INTERVAL_MS);
    logger.info("Pattern service started (7-day historical pattern matching)");
  }

  stop() {
    if (this.intervalId) clearInterval(this.intervalId);
  }

  private async fetchFromCoinGecko(): Promise<DailyCandle[]> {
    const url = "https://api.coingecko.com/api/v3/coins/bitcoin/ohlc?vs_currency=usd&days=180";
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(12000),
      headers: { "Accept": "application/json" },
    });
    if (!resp.ok) throw new Error(`CoinGecko HTTP ${resp.status}`);
    const raw = await resp.json() as [number, number, number, number, number][];
    if (!Array.isArray(raw) || raw.length === 0) throw new Error("CoinGecko returned empty data");

    const dailyMap = new Map<string, DailyCandle>();
    for (const [ts, open, high, low, close] of raw) {
      const day = new Date(ts).toISOString().slice(0, 10);
      const existing = dailyMap.get(day);
      if (!existing) {
        dailyMap.set(day, { ts, open, high, low, close });
      } else {
        dailyMap.set(day, {
          ts: existing.ts,
          open: existing.open,
          high: Math.max(existing.high, high),
          low: Math.min(existing.low, low),
          close,
        });
      }
    }
    return Array.from(dailyMap.values()).sort((a, b) => a.ts - b.ts);
  }

  private async fetchCandles(): Promise<DailyCandle[]> {
    try {
      const candles = await this.fetchFromCoinGecko();
      logger.info({ candles: candles.length }, "Pattern service: fetched daily candles from CoinGecko");
      return candles;
    } catch (e) {
      logger.warn({ err: e }, "Pattern service: CoinGecko fetch failed, trying Bybit connector");
    }
    try {
      const candles = await aggregator.fetchDailyKlines(200);
      logger.info({ candles: candles.length }, "Pattern service: fetched daily candles from Bybit");
      return candles;
    } catch (e2) {
      logger.warn({ err: e2 }, "Pattern service: all kline sources failed");
      return [];
    }
  }

  private async fetchAndCompute() {
    const fresh = await this.fetchCandles();
    if (fresh.length >= PATTERN_WINDOW + FORWARD_WINDOW + 10) {
      this.candles = fresh;
      this.lastFetch = Date.now();
      this.lastResult = this.compute();
      logger.info({ candles: this.candles.length, signal: this.lastResult?.signal.toFixed(3) }, "Pattern matching updated");
    }
  }

  private compute(): PatternResult {
    const candles = this.candles;
    const total = candles.length;

    const completedCandles = candles.slice(0, total - 1);

    const currentSlice = completedCandles.slice(-PATTERN_WINDOW);
    const currentReturns = toReturns(currentSlice);
    const currentNorm = normalize(currentReturns);

    const matches: { similarity: number; forwardPct: number; startIdx: number }[] = [];

    for (let i = 0; i <= completedCandles.length - PATTERN_WINDOW - FORWARD_WINDOW; i++) {
      const window = completedCandles.slice(i, i + PATTERN_WINDOW);
      const winReturns = toReturns(window);
      const winNorm = normalize(winReturns);
      const sim = pearson(currentNorm, winNorm);

      const forwardSlice = completedCandles.slice(i + PATTERN_WINDOW, i + PATTERN_WINDOW + FORWARD_WINDOW);
      const forwardPct = forwardSlice.length > 0
        ? (forwardSlice[forwardSlice.length - 1].close - forwardSlice[0].open) / forwardSlice[0].open * 100
        : 0;

      matches.push({ similarity: sim, forwardPct, startIdx: i });
    }

    matches.sort((a, b) => b.similarity - a.similarity);
    const top = matches.slice(0, TOP_N);

    const topMatches: PatternMatch[] = top.map(m => {
      const window = completedCandles.slice(m.startIdx, m.startIdx + PATTERN_WINDOW);
      const forwardSlice = completedCandles.slice(m.startIdx + PATTERN_WINDOW, m.startIdx + PATTERN_WINDOW + FORWARD_WINDOW);

      const fwdPct = forwardSlice.length > 0
        ? (forwardSlice[forwardSlice.length - 1].close - forwardSlice[0].open) / forwardSlice[0].open * 100
        : 0;

      return {
        startDate: new Date(window[0].ts).toISOString().slice(0, 10),
        endDate: new Date(window[window.length - 1].ts).toISOString().slice(0, 10),
        similarity: parseFloat(m.similarity.toFixed(4)),
        forwardPct: parseFloat(fwdPct.toFixed(4)),
        outcome: fwdPct > 0.5 ? "bullish" : fwdPct < -0.5 ? "bearish" : "neutral",
        currentReturns: currentReturns.map(v => parseFloat(v.toFixed(6))),
        historicalReturns: toReturns(window).map(v => parseFloat(v.toFixed(6))),
        forwardReturns: toReturns(forwardSlice).map(v => parseFloat(v.toFixed(6))),
      };
    });

    const bullishMatches = topMatches.filter(m => m.outcome === "bullish").length;
    const bearishMatches = topMatches.filter(m => m.outcome === "bearish").length;

    const weightedSignal = top.reduce((sum, m) => {
      const direction = m.forwardPct > 0 ? 1 : m.forwardPct < 0 ? -1 : 0;
      return sum + direction * Math.abs(m.similarity);
    }, 0);
    const totalWeight = top.reduce((sum, m) => sum + Math.abs(m.similarity), 0);
    const signal = totalWeight > 0 ? Math.max(-1, Math.min(1, weightedSignal / totalWeight)) : 0;

    const avgSim = top.length > 0 ? top.reduce((s, m) => s + Math.abs(m.similarity), 0) / top.length : 0;
    const agreementRatio = top.length > 0 ? Math.max(bullishMatches, bearishMatches) / top.length : 0;
    const confidence = avgSim * agreementRatio;

    return {
      signal: parseFloat(signal.toFixed(4)),
      confidence: parseFloat(confidence.toFixed(4)),
      bullishMatches,
      bearishMatches,
      topMatches,
      currentReturns: currentReturns.map(v => parseFloat(v.toFixed(6))),
      updatedAt: new Date().toISOString(),
    };
  }

  getResult(): PatternResult | null {
    return this.lastResult;
  }

  getSignal(): number {
    return this.lastResult?.signal ?? 0;
  }

  getConfidence(): number {
    return this.lastResult?.confidence ?? 0;
  }

  isReady(): boolean {
    return this.lastResult !== null;
  }
}

export const patternService = new PatternService();
