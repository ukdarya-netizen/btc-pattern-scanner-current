import https from "https";
import { logger } from "../lib/logger";

const API_KEY = process.env["COINALYZE_API_KEY"] ?? "";
const BASE = "api.coinalyze.net";
const SYMBOL = "BTCUSDT_PERP.A";

// Leverage tier distribution (typical BTC perp retail)
const LEVERAGE_TIERS = [
  { lev: 5,   weight: 0.05 },
  { lev: 10,  weight: 0.15 },
  { lev: 20,  weight: 0.20 },
  { lev: 25,  weight: 0.15 },
  { lev: 50,  weight: 0.20 },
  { lev: 75,  weight: 0.10 },
  { lev: 100, weight: 0.15 },
];

function caRequest(path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: BASE,
      path,
      method: "GET",
      headers: { "api_key": API_KEY, "Accept": "application/json" },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

export interface LiqCandle {
  t: number; longBtc: number; shortBtc: number; longUsd: number; shortUsd: number;
}

interface OhlcvCandle {
  t: number; o: number; h: number; l: number; c: number; v: number; bv: number;
}

interface OiCandle {
  t: number; o: number; h: number; l: number; c: number;
}

export interface LiqMapBucket {
  price: number;
  longLiqUsd: number;
  shortLiqUsd: number;
  totalUsd: number;
}

export interface LiquidationMap {
  buckets: LiqMapBucket[];
  currentPrice: number;
  priceRange: { min: number; max: number };
  updatedAt: number;
}

class CoinalyzeService {
  // Liquidation history caches
  private cache24h: LiqCandle[] = [];
  private cache24hAt = 0;
  private cache2h: LiqCandle[] = [];
  private cache2hAt = 0;
  private fetching2h = false;
  private fetching24h = false;

  // OHLCV + OI caches for map
  private cacheOhlcv: OhlcvCandle[] = [];
  private cacheOi: OiCandle[] = [];
  private cacheMapAt = 0;
  private fetchingMap = false;
  private cachedMap: LiquidationMap | null = null;

  constructor() {
    void this.refresh2h();
    void this.refresh24h();
    void this.refreshMap();
    setInterval(() => { void this.refresh2h(); }, 60 * 1000);
    setInterval(() => { void this.refresh24h(); }, 5 * 60 * 1000);
    setInterval(() => { void this.refreshMap(); }, 5 * 60 * 1000);
  }

  // ── Liquidation history ──────────────────────────────────────

  private async fetchLiqHistory(from: number, to: number, interval: string): Promise<LiqCandle[]> {
    if (!API_KEY) return [];
    const path = `/v1/liquidation-history?symbols=${SYMBOL}&interval=${interval}&from=${from}&to=${to}`;
    const raw = await caRequest(path) as Array<{ symbol: string; history: Array<{ t: number; l: number; s: number }> }>;
    if (!Array.isArray(raw) || !raw[0]?.history) return [];
    return raw[0].history.map(c => ({
      t: c.t, longBtc: c.l ?? 0, shortBtc: c.s ?? 0,
      longUsd: (c.l ?? 0) * 100000, shortUsd: (c.s ?? 0) * 100000,
    }));
  }

  private async refresh2h() {
    if (this.fetching2h) return;
    this.fetching2h = true;
    try {
      const to = Math.floor(Date.now() / 1000);
      const data = await this.fetchLiqHistory(to - 7200, to, "5min");
      if (data.length > 0) { this.cache2h = data; this.cache2hAt = Date.now(); }
    } catch (e) { logger.warn({ err: e }, "Coinalyze 2h refresh failed"); }
    finally { this.fetching2h = false; }
  }

  private async refresh24h() {
    if (this.fetching24h) return;
    this.fetching24h = true;
    try {
      const to = Math.floor(Date.now() / 1000);
      const data = await this.fetchLiqHistory(to - 86400, to, "1hour");
      if (data.length > 0) { this.cache24h = data; this.cache24hAt = Date.now(); }
    } catch (e) { logger.warn({ err: e }, "Coinalyze 24h refresh failed"); }
    finally { this.fetching24h = false; }
  }

  getLatest2hCandles(): LiqCandle[] { return this.cache2h; }
  getLatest24hCandles(): LiqCandle[] { return this.cache24h; }
  isReady(): boolean { return this.cache2hAt > 0 || this.cache24hAt > 0; }

  async get24h(): Promise<LiqCandle[]> {
    if (Date.now() - this.cache24hAt > 5 * 60 * 1000) await this.refresh24h();
    return this.cache24h;
  }
  async get2h(): Promise<LiqCandle[]> {
    if (Date.now() - this.cache2hAt > 60 * 1000) await this.refresh2h();
    return this.cache2h;
  }

  // ── Liquidation MAP ──────────────────────────────────────────

  private async refreshMap() {
    if (this.fetchingMap) return;
    this.fetchingMap = true;
    try {
      const to = Math.floor(Date.now() / 1000);
      const from = to - 7 * 86400; // 7 days of hourly data

      const [ohlcvRaw, oiRaw] = await Promise.all([
        caRequest(`/v1/ohlcv-history?symbols=${SYMBOL}&interval=1hour&from=${from}&to=${to}`),
        caRequest(`/v1/open-interest-history?symbols=${SYMBOL}&interval=1hour&from=${from}&to=${to}`),
      ]) as [
        Array<{ symbol: string; history: OhlcvCandle[] }>,
        Array<{ symbol: string; history: OiCandle[] }>
      ];

      if (ohlcvRaw[0]?.history?.length) this.cacheOhlcv = ohlcvRaw[0].history;
      if (oiRaw[0]?.history?.length) this.cacheOi = oiRaw[0].history;
      this.cacheMapAt = Date.now();
      this.cachedMap = this.computeMap();
    } catch (e) { logger.warn({ err: e }, "Coinalyze map refresh failed"); }
    finally { this.fetchingMap = false; }
  }

  private computeMap(): LiquidationMap | null {
    if (!this.cacheOhlcv.length) return null;

    const oiByTime = new Map<number, number>();
    this.cacheOi.forEach(c => oiByTime.set(c.t, c.c));

    // Determine price range for buckets
    const allPrices = this.cacheOhlcv.flatMap(c => [c.h, c.l]);
    const globalMin = Math.min(...allPrices) * 0.97;
    const globalMax = Math.max(...allPrices) * 1.03;
    const BUCKET_SIZE = 200; // $200 buckets
    const bucketCount = Math.ceil((globalMax - globalMin) / BUCKET_SIZE);

    const longBuckets = new Float64Array(bucketCount);
    const shortBuckets = new Float64Array(bucketCount);

    // Get current price (last close)
    const lastCandle = this.cacheOhlcv[this.cacheOhlcv.length - 1];
    const currentPrice = lastCandle?.c ?? 80000;

    // Build OI deltas: positive delta = new net positions opened
    for (let i = 1; i < this.cacheOhlcv.length; i++) {
      const c = this.cacheOhlcv[i]!;
      const prev = this.cacheOhlcv[i - 1]!;

      // Entry price approximation: VWAP of candle
      const entryPrice = (c.o + c.h + c.l + c.c) / 4;

      // Volume-based weight (more volume = more positions at this price)
      const volumeWeight = c.v;

      // OI at this candle — use as weight multiplier
      const oi = oiByTime.get(c.t) ?? oiByTime.get(prev.t) ?? 1;

      // Buy volume fraction → estimate long bias
      const buyFrac = c.v > 0 ? c.bv / c.v : 0.5;
      const sellFrac = 1 - buyFrac;

      // Position weight in USD
      const posWeight = volumeWeight * entryPrice * 0.01; // scale factor

      for (const tier of LEVERAGE_TIERS) {
        const tierWeight = tier.weight * posWeight * (oi / 100000);

        // Long liquidation price: price drops 0.9/lev from entry
        const longLiqPrice = entryPrice * (1 - 0.9 / tier.lev);
        // Short liquidation price: price rises 0.9/lev from entry
        const shortLiqPrice = entryPrice * (1 + 0.9 / tier.lev);

        // Only add if within range
        const addToBucket = (price: number, value: number, arr: Float64Array) => {
          if (price < globalMin || price > globalMax) return;
          const idx = Math.floor((price - globalMin) / BUCKET_SIZE);
          if (idx >= 0 && idx < bucketCount) arr[idx] += value;
        };

        addToBucket(longLiqPrice, tierWeight * buyFrac, longBuckets);
        addToBucket(shortLiqPrice, tierWeight * sellFrac, shortBuckets);
      }
    }

    // Convert to array, normalize to USD millions for readability
    const buckets: LiqMapBucket[] = [];
    for (let i = 0; i < bucketCount; i++) {
      const price = globalMin + i * BUCKET_SIZE + BUCKET_SIZE / 2;
      const longLiqUsd = longBuckets[i]!;
      const shortLiqUsd = shortBuckets[i]!;
      const totalUsd = longLiqUsd + shortLiqUsd;
      if (totalUsd > 0) {
        buckets.push({ price, longLiqUsd, shortLiqUsd, totalUsd });
      }
    }

    return { buckets, currentPrice, priceRange: { min: globalMin, max: globalMax }, updatedAt: Date.now() };
  }

  getCachedMap(): LiquidationMap | null { return this.cachedMap; }

  async getLiquidationMap(): Promise<LiquidationMap | null> {
    if (!this.cachedMap || Date.now() - this.cacheMapAt > 5 * 60 * 1000) {
      await this.refreshMap();
    }
    return this.cachedMap;
  }
}

export const coinalyzeService = new CoinalyzeService();
