import { aggregator } from "./exchanges/aggregator";

export interface CvdPoint {
  timestamp: string;
  cvd: number;
  delta: number;
  price: number;
}

export type CvdTrend = "bullish" | "bearish" | "neutral";

export interface CvdAlignment {
  trend: "bullish" | "bearish" | "mixed";
  score: number;
  strong: boolean;
  description: string;
  trends: { "1m": CvdTrend; "5m": CvdTrend; "15m": CvdTrend };
}

const MAX_POINTS_1M  = 60;
const MAX_POINTS_5M  = 48;
const MAX_POINTS_15M = 32;

const INT_1M  = 60_000;
const INT_5M  = 300_000;
const INT_15M = 900_000;

interface BucketEntry { buy: number; sell: number }

class CvdService {
  private buckets1m:  Map<number, BucketEntry> = new Map();
  private buckets5m:  Map<number, BucketEntry> = new Map();
  private buckets15m: Map<number, BucketEntry> = new Map();

  private points: CvdPoint[] = [];
  private processedTradeIds = new Set<string>();
  private lastProcessed = 0;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  start() {
    this.intervalHandle = setInterval(() => this.tick(), 1000);
  }

  stop() {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
    this.intervalHandle = null;
  }

  private bucketKey(ts: number, intervalMs: number): number {
    return Math.floor(ts / intervalMs) * intervalMs;
  }

  private addToBucket(map: Map<number, BucketEntry>, key: number, buy: number, sell: number) {
    const existing = map.get(key) ?? { buy: 0, sell: 0 };
    map.set(key, { buy: existing.buy + buy, sell: existing.sell + sell });
  }

  private pruneMap(map: Map<number, BucketEntry>, intervalMs: number, maxBuckets: number) {
    if (map.size <= maxBuckets) return;
    const cutoff = Date.now() - intervalMs * maxBuckets;
    for (const key of map.keys()) {
      if (key < cutoff) map.delete(key);
    }
  }

  private tick() {
    const now = Date.now();
    const windowStart = this.lastProcessed || now - 2000;

    const trades = aggregator.getPrimaryTrades().filter(
      t => t.timestamp >= windowStart && !this.processedTradeIds.has(t.id)
    );

    if (trades.length > 0) {
      let delta = 0;
      let lastPrice = aggregator.getPrimaryPrice();

      for (const t of trades) {
        const buy  = t.side === "buy"  ? t.size : 0;
        const sell = t.side === "sell" ? t.size : 0;
        delta += buy - sell;

        const ts = t.timestamp;
        this.addToBucket(this.buckets1m,  this.bucketKey(ts, INT_1M),  buy, sell);
        this.addToBucket(this.buckets5m,  this.bucketKey(ts, INT_5M),  buy, sell);
        this.addToBucket(this.buckets15m, this.bucketKey(ts, INT_15M), buy, sell);

        this.processedTradeIds.add(t.id);
        lastPrice = t.price;
      }

      const prevCvd = this.points.length > 0 ? this.points[this.points.length - 1].cvd : 0;
      this.points.push({
        timestamp: new Date(now).toISOString(),
        cvd: prevCvd + delta,
        delta,
        price: lastPrice,
      });

      if (this.points.length > MAX_POINTS_1M) {
        this.points = this.points.slice(-MAX_POINTS_1M);
      }

      if (this.processedTradeIds.size > 10000) this.processedTradeIds.clear();
    }

    this.pruneMap(this.buckets1m,  INT_1M,  MAX_POINTS_1M);
    this.pruneMap(this.buckets5m,  INT_5M,  MAX_POINTS_5M);
    this.pruneMap(this.buckets15m, INT_15M, MAX_POINTS_15M);

    this.lastProcessed = now;
  }

  private sortedDeltas(map: Map<number, BucketEntry>): number[] {
    return [...map.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, v]) => v.buy - v.sell);
  }

  private calcTrendForDeltas(deltas: number[]): CvdTrend {
    if (deltas.length < 10) return "neutral";

    const recent   = deltas.slice(-5);
    const baseline = deltas.slice(-10, -5);
    if (baseline.length < 5) return "neutral";

    const recentSum   = recent.reduce((s, v) => s + v, 0);
    const baselineSum = baseline.reduce((s, v) => s + v, 0);
    const delta = recentSum - baselineSum;

    const last20 = deltas.slice(-20);
    const mean   = last20.reduce((s, v) => s + v, 0) / last20.length;
    const variance = last20.reduce((s, v) => s + (v - mean) ** 2, 0) / last20.length;
    const stddev = Math.sqrt(variance);
    const threshold = stddev * 0.8 + 0.001; // агрессивный CVD: требует более сильного отклонения

    if (delta > threshold)  return "bullish";
    if (delta < -threshold) return "bearish";
    return "neutral";
  }

  getTrend1m(): CvdTrend  { return this.calcTrendForDeltas(this.sortedDeltas(this.buckets1m)); }
  getTrend5m(): CvdTrend  { return this.calcTrendForDeltas(this.sortedDeltas(this.buckets5m)); }
  getTrend15m(): CvdTrend { return this.calcTrendForDeltas(this.sortedDeltas(this.buckets15m)); }

  getAlignment(): CvdAlignment {
    const t1m  = this.getTrend1m();
    const t5m  = this.getTrend5m();
    const t15m = this.getTrend15m();

    const arrow = (t: CvdTrend) => t === "bullish" ? "↑" : t === "bearish" ? "↓" : "→";
    const description = `1m${arrow(t1m)} 5m${arrow(t5m)} 15m${arrow(t15m)}`;

    const bullCount = [t1m, t5m, t15m].filter(t => t === "bullish").length;
    const bearCount = [t1m, t5m, t15m].filter(t => t === "bearish").length;

    if (bullCount === 3) {
      return { trend: "bullish", score:  0.90, strong: true,  description, trends: { "1m": t1m, "5m": t5m, "15m": t15m } };
    }
    if (bearCount === 3) {
      return { trend: "bearish", score: -0.90, strong: true,  description, trends: { "1m": t1m, "5m": t5m, "15m": t15m } };
    }
    if (bullCount === 2) {
      return { trend: "bullish", score:  0.45, strong: false, description, trends: { "1m": t1m, "5m": t5m, "15m": t15m } };
    }
    if (bearCount === 2) {
      return { trend: "bearish", score: -0.45, strong: false, description, trends: { "1m": t1m, "5m": t5m, "15m": t15m } };
    }
    return { trend: "mixed", score: 0, strong: false, description, trends: { "1m": t1m, "5m": t5m, "15m": t15m } };
  }

  getPoints(): CvdPoint[] { return [...this.points]; }
  getCurrentCvd(): number { return this.points.length > 0 ? this.points[this.points.length - 1].cvd : 0; }
  getTrend(): CvdTrend    { return this.getTrend1m(); }
}

export const cvdService = new CvdService();
