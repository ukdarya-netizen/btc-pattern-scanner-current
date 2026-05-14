import { logger } from "../lib/logger";

export interface OHLCVCandle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SRLevel {
  price: number;
  strength: number; // 1-5 touches
  type: "support" | "resistance";
}

export interface CandlePattern {
  name: string;
  direction: "bullish" | "bearish" | "neutral";
  strength: number; // 0-1
}

export interface TASnapshot {
  price: number;
  // EMA
  ema21_1h: number; ema50_1h: number; ema200_1h: number;
  ema21_4h: number; ema50_4h: number; ema200_4h: number;
  ema21_1d: number; ema50_1d: number; ema200_1d: number;
  // VWAP (daily)
  vwap_1h: number;
  // S/R levels
  srLevels: SRLevel[];
  nearestSupport: SRLevel | null;
  nearestResistance: SRLevel | null;
  // Candle patterns (last candle on each TF)
  patterns: CandlePattern[];
  // MTF trend
  trend_1h: "bullish" | "bearish" | "neutral";
  trend_4h: "bullish" | "bearish" | "neutral";
  trend_1d: "bullish" | "bearish" | "neutral";
  // Readiness
  ready: boolean;
  readyReason: string;
  updatedAt: number;
}

const BINGX_BASE = "https://open-api.bingx.com";
const REFRESH_1H_MS  = 60  * 60 * 1000;  // every 1h
const REFRESH_4H_MS  = 4   * 60 * 60 * 1000;
const REFRESH_1D_MS  = 6   * 60 * 60 * 1000;

async function fetchBingXKlines(interval: string, limit: number): Promise<OHLCVCandle[]> {
  const url = `${BINGX_BASE}/openApi/swap/v3/quote/klines?symbol=BTC-USDT&interval=${interval}&limit=${limit}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!resp.ok) throw new Error(`BingX klines ${interval} HTTP ${resp.status}`);
  const json = await resp.json() as { data: { time: number; open: string; high: string; low: string; close: string; volume: string }[] };
  if (!json.data?.length) throw new Error(`BingX klines ${interval}: empty`);
  return json.data.map(r => ({
    ts: r.time,
    open: parseFloat(r.open),
    high: parseFloat(r.high),
    low: parseFloat(r.low),
    close: parseFloat(r.close),
    volume: parseFloat(r.volume),
  }));
}

// ── Math helpers ─────────────────────────────────────────────────────────────

function calcEma(closes: number[], period: number): number {
  if (closes.length === 0) return 0;
  if (closes.length < period) {
    return closes.reduce((s, v) => s + v, 0) / closes.length;
  }
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcVwap(candles: OHLCVCandle[]): number {
  let num = 0; let den = 0;
  for (const c of candles) {
    const typ = (c.high + c.low + c.close) / 3;
    num += typ * c.volume;
    den += c.volume;
  }
  return den > 0 ? num / den : 0;
}

function calcTrend(price: number, ema21: number, ema50: number, ema200: number): "bullish" | "bearish" | "neutral" {
  if (ema21 === 0 || ema50 === 0 || ema200 === 0) return "neutral";
  const bullish = price > ema21 && ema21 > ema50 && ema50 > ema200;
  const bearish = price < ema21 && ema21 < ema50 && ema50 < ema200;
  if (bullish) return "bullish";
  if (bearish) return "bearish";
  return "neutral";
}

// ── Support / Resistance from swing highs/lows ──────────────────────────────

function calcSRLevels(candles: OHLCVCandle[], price: number, lookback = 3): SRLevel[] {
  const levels: { price: number; type: "support" | "resistance" }[] = [];

  for (let i = lookback; i < candles.length - lookback; i++) {
    const window = candles.slice(i - lookback, i + lookback + 1);
    const c = candles[i];

    // Swing high
    if (window.every(w => c.high >= w.high)) {
      levels.push({ price: c.high, type: "resistance" });
    }
    // Swing low
    if (window.every(w => c.low <= w.low)) {
      levels.push({ price: c.low, type: "support" });
    }
  }

  // Cluster close levels (within 0.3%)
  const clustered: SRLevel[] = [];
  const used = new Set<number>();

  for (let i = 0; i < levels.length; i++) {
    if (used.has(i)) continue;
    const group = [levels[i]];
    for (let j = i + 1; j < levels.length; j++) {
      if (!used.has(j) && Math.abs(levels[j].price - levels[i].price) / levels[i].price < 0.003) {
        group.push(levels[j]);
        used.add(j);
      }
    }
    used.add(i);
    const avgPrice = group.reduce((s, l) => s + l.price, 0) / group.length;
    // type from majority
    const resistCount = group.filter(l => l.type === "resistance").length;
    const type = resistCount >= group.length / 2 ? "resistance" : "support";
    clustered.push({ price: parseFloat(avgPrice.toFixed(2)), strength: Math.min(group.length, 5), type });
  }

  // Keep within ±5% of current price, sorted by proximity
  return clustered
    .filter(l => Math.abs(l.price - price) / price <= 0.05)
    .sort((a, b) => Math.abs(a.price - price) - Math.abs(b.price - price))
    .slice(0, 10);
}

// ── Candlestick patterns ─────────────────────────────────────────────────────

function detectPatterns(candles: OHLCVCandle[]): CandlePattern[] {
  if (candles.length < 3) return [];
  const patterns: CandlePattern[] = [];

  const c  = candles[candles.length - 1]; // last candle
  const c1 = candles[candles.length - 2]; // prev
  const c2 = candles[candles.length - 3]; // prev-prev

  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;

  // Pin Bar (Hammer / Shooting Star)
  if (range > 0 && body / range < 0.35) {
    if (lowerWick > body * 2 && lowerWick > upperWick * 2) {
      patterns.push({ name: "Hammer (Pin Bar)", direction: "bullish", strength: 0.75 });
    } else if (upperWick > body * 2 && upperWick > lowerWick * 2) {
      patterns.push({ name: "Shooting Star (Pin Bar)", direction: "bearish", strength: 0.75 });
    }
  }

  // Doji
  if (range > 0 && body / range < 0.1) {
    patterns.push({ name: "Doji", direction: "neutral", strength: 0.4 });
  }

  // Bullish Engulfing
  if (c1.close < c1.open && c.close > c.open &&
      c.open < c1.close && c.close > c1.open) {
    patterns.push({ name: "Bullish Engulfing", direction: "bullish", strength: 0.85 });
  }

  // Bearish Engulfing
  if (c1.close > c1.open && c.close < c.open &&
      c.open > c1.close && c.close < c1.open) {
    patterns.push({ name: "Bearish Engulfing", direction: "bearish", strength: 0.85 });
  }

  // Bullish Morning Star (3-candle)
  const body2 = Math.abs(c2.close - c2.open);
  const body1 = Math.abs(c1.close - c1.open);
  const bodyC = Math.abs(c.close - c.open);
  if (c2.close < c2.open && body1 < body2 * 0.4 &&
      c.close > c.open && c.close > (c2.open + c2.close) / 2) {
    patterns.push({ name: "Morning Star", direction: "bullish", strength: 0.90 });
  }

  // Bearish Evening Star
  if (c2.close > c2.open && body1 < body2 * 0.4 &&
      c.close < c.open && c.close < (c2.open + c2.close) / 2) {
    patterns.push({ name: "Evening Star", direction: "bearish", strength: 0.90 });
  }

  return patterns;
}

// ── Service class ─────────────────────────────────────────────────────────────

class TAService {
  private candles1h: OHLCVCandle[] = [];
  private candles4h: OHLCVCandle[] = [];
  private candles1d: OHLCVCandle[] = [];

  private lastRefresh1h = 0;
  private lastRefresh4h = 0;
  private lastRefresh1d = 0;

  private snapshot: TASnapshot | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  start() {
    this.refresh().catch(e => logger.warn({ err: e }, "TA: initial refresh failed"));
    this.timer = setInterval(() => {
      this.refresh().catch(e => logger.warn({ err: e }, "TA: refresh error"));
    }, 5 * 60 * 1000); // try every 5 min, internal cache guards actual fetches
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  private async refresh() {
    const now = Date.now();

    const fetches: Promise<void>[] = [];

    if (now - this.lastRefresh1h > REFRESH_1H_MS) {
      fetches.push(
        fetchBingXKlines("1h", 250)
          .then(d => { this.candles1h = d; this.lastRefresh1h = Date.now(); })
          .catch(e => logger.warn({ err: e }, "TA: 1h fetch failed"))
      );
    }

    if (now - this.lastRefresh4h > REFRESH_4H_MS) {
      fetches.push(
        fetchBingXKlines("4h", 200)
          .then(d => { this.candles4h = d; this.lastRefresh4h = Date.now(); })
          .catch(e => logger.warn({ err: e }, "TA: 4h fetch failed"))
      );
    }

    if (now - this.lastRefresh1d > REFRESH_1D_MS) {
      fetches.push(
        fetchBingXKlines("1d", 250)
          .then(d => { this.candles1d = d; this.lastRefresh1d = Date.now(); })
          .catch(e => logger.warn({ err: e }, "TA: 1d fetch failed"))
      );
    }

    if (fetches.length > 0) {
      await Promise.all(fetches);
      this.buildSnapshot();
    }
  }

  private buildSnapshot() {
    const c1h = this.candles1h;
    const c4h = this.candles4h;
    const c1d = this.candles1d;

    const ready1h = c1h.length >= 210;
    const ready4h = c4h.length >= 55;
    const ready1d = c1d.length >= 55;

    const price = c1h.length > 0 ? c1h[c1h.length - 1].close : 0;

    if (!ready1h || !ready4h || !ready1d || price === 0) {
      this.snapshot = {
        price,
        ema21_1h: 0, ema50_1h: 0, ema200_1h: 0,
        ema21_4h: 0, ema50_4h: 0, ema200_4h: 0,
        ema21_1d: 0, ema50_1d: 0, ema200_1d: 0,
        vwap_1h: 0,
        srLevels: [], nearestSupport: null, nearestResistance: null,
        patterns: [],
        trend_1h: "neutral", trend_4h: "neutral", trend_1d: "neutral",
        ready: false,
        readyReason: `Данные: 1H ${c1h.length}/210, 4H ${c4h.length}/55, 1D ${c1d.length}/55`,
        updatedAt: Date.now(),
      };
      return;
    }

    const closes1h = c1h.map(c => c.close);
    const closes4h = c4h.map(c => c.close);
    const closes1d = c1d.map(c => c.close);

    const ema21_1h  = calcEma(closes1h, 21);
    const ema50_1h  = calcEma(closes1h, 50);
    const ema200_1h = calcEma(closes1h, 200);

    const ema21_4h  = calcEma(closes4h, 21);
    const ema50_4h  = calcEma(closes4h, 50);
    const ema200_4h = calcEma(closes4h, 200);

    const ema21_1d  = calcEma(closes1d, 21);
    const ema50_1d  = calcEma(closes1d, 50);
    const ema200_1d = calcEma(closes1d, 200);

    // VWAP from today's 1h candles
    const dayStart = new Date(); dayStart.setUTCHours(0, 0, 0, 0);
    const todayCandles = c1h.filter(c => c.ts >= dayStart.getTime());
    const vwap_1h = todayCandles.length > 0 ? calcVwap(todayCandles) : calcEma(closes1h.slice(-24), 1);

    const trend_1h = calcTrend(price, ema21_1h, ema50_1h, ema200_1h);
    const trend_4h = calcTrend(price, ema21_4h, ema50_4h, ema200_4h);
    const trend_1d = calcTrend(price, ema21_1d, ema50_1d, ema200_1d);

    // S/R from 4H candles (best balance: enough history, not too noisy)
    const srLevels  = calcSRLevels(c4h, price);
    const nearestSupport    = srLevels.find(l => l.type === "support"    && l.price < price) ?? null;
    const nearestResistance = srLevels.find(l => l.type === "resistance" && l.price > price) ?? null;

    // Patterns from last 3 candles on each TF
    const patterns: CandlePattern[] = [
      ...detectPatterns(c1h.slice(-3)).map(p => ({ ...p, name: `${p.name} (1H)` })),
      ...detectPatterns(c4h.slice(-3)).map(p => ({ ...p, name: `${p.name} (4H)` })),
      ...detectPatterns(c1d.slice(-3)).map(p => ({ ...p, name: `${p.name} (1D)` })),
    ];

    this.snapshot = {
      price,
      ema21_1h, ema50_1h, ema200_1h,
      ema21_4h, ema50_4h, ema200_4h,
      ema21_1d, ema50_1d, ema200_1d,
      vwap_1h,
      srLevels, nearestSupport, nearestResistance,
      patterns,
      trend_1h, trend_4h, trend_1d,
      ready: true,
      readyReason: "OK",
      updatedAt: Date.now(),
    };

    logger.info({ trend_1h, trend_4h, trend_1d, patterns: patterns.length }, "TA: snapshot updated");
  }

  getSnapshot(): TASnapshot | null {
    return this.snapshot;
  }

  isReady(): boolean {
    return this.snapshot?.ready === true;
  }

  // Force immediate refresh (e.g. on startup)
  async forceRefresh() {
    this.lastRefresh1h = 0;
    this.lastRefresh4h = 0;
    this.lastRefresh1d = 0;
    await this.refresh();
  }
}

export const taService = new TAService();
