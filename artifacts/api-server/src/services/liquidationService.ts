import type { ExchangeLiquidation } from "./exchanges/types";

const MAX_EVENTS = 200;
const BUCKET_SIZE_USD = 100;
const WINDOW_MS = 30 * 60 * 1000;

export interface LiqBucket {
  price: number;
  longUsd: number;
  shortUsd: number;
  totalUsd: number;
}

export interface LiqEvent {
  exchange: string;
  side: "long" | "short";
  price: number;
  size: number;
  valueUsd: number;
  timestamp: number;
}

class LiquidationService {
  private events: LiqEvent[] = [];

  addEvent(liq: ExchangeLiquidation) {
    this.events.unshift({
      exchange: liq.exchange,
      side: liq.side,
      price: liq.price,
      size: liq.size,
      valueUsd: liq.valueUsd,
      timestamp: liq.timestamp,
    });
    if (this.events.length > MAX_EVENTS) this.events.length = MAX_EVENTS;
  }

  getRecentEvents(limit = 50): LiqEvent[] {
    return this.events.slice(0, limit);
  }

  getHeatmapBuckets(): LiqBucket[] {
    const cutoff = Date.now() - WINDOW_MS;
    const recent = this.events.filter(e => e.timestamp >= cutoff);
    if (!recent.length) return [];

    const minPrice = Math.min(...recent.map(e => e.price));
    const maxPrice = Math.max(...recent.map(e => e.price));
    const bucketCount = Math.min(60, Math.ceil((maxPrice - minPrice) / BUCKET_SIZE_USD) + 1);
    const actualBucketSize = bucketCount > 1 ? (maxPrice - minPrice) / (bucketCount - 1) : BUCKET_SIZE_USD;
    const basePrice = minPrice;

    const map = new Map<number, LiqBucket>();

    for (const e of recent) {
      const idx = actualBucketSize > 0
        ? Math.round((e.price - basePrice) / actualBucketSize)
        : 0;
      const bucketPrice = Math.round((basePrice + idx * actualBucketSize) / 10) * 10;

      if (!map.has(bucketPrice)) {
        map.set(bucketPrice, { price: bucketPrice, longUsd: 0, shortUsd: 0, totalUsd: 0 });
      }
      const b = map.get(bucketPrice)!;
      if (e.side === "long") b.longUsd += e.valueUsd;
      else b.shortUsd += e.valueUsd;
      b.totalUsd += e.valueUsd;
    }

    return Array.from(map.values()).sort((a, b) => a.price - b.price);
  }

  getSummary() {
    const now = Date.now();
    const inWindow = (ms: number) => this.events.filter(e => e.timestamp >= now - ms);

    const calc = (evts: LiqEvent[]) => ({
      longUsd: evts.filter(e => e.side === "long").reduce((s, e) => s + e.valueUsd, 0),
      shortUsd: evts.filter(e => e.side === "short").reduce((s, e) => s + e.valueUsd, 0),
      count: evts.length,
    });

    return {
      last5m: calc(inWindow(5 * 60 * 1000)),
      last15m: calc(inWindow(15 * 60 * 1000)),
      last30m: calc(inWindow(30 * 60 * 1000)),
      last1h: calc(inWindow(60 * 60 * 1000)),
    };
  }
}

export const liquidationService = new LiquidationService();
