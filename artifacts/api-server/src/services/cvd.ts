import { aggregator } from "./exchanges/aggregator";

export interface CvdPoint {
  timestamp: string;
  cvd: number;
  delta: number;
  price: number;
}

const MAX_POINTS = 120;

class CvdService {
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

  private tick() {
    const now = Date.now();
    const windowStart = this.lastProcessed || now - 2000;

    const trades = aggregator.getPrimaryTrades().filter(
      t => t.timestamp >= windowStart && !this.processedTradeIds.has(t.id)
    );

    if (trades.length === 0) return;

    let delta = 0;
    let lastPrice = aggregator.getPrimaryPrice();

    for (const t of trades) {
      delta += t.side === "buy" ? t.size : -t.size;
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

    if (this.points.length > MAX_POINTS) {
      this.points = this.points.slice(-MAX_POINTS);
    }

    this.lastProcessed = now;

    if (this.processedTradeIds.size > 10000) {
      this.processedTradeIds.clear();
    }
  }

  getPoints(): CvdPoint[] {
    return [...this.points];
  }

  getCurrentCvd(): number {
    return this.points.length > 0 ? this.points[this.points.length - 1].cvd : 0;
  }

  getTrend(): "bullish" | "bearish" | "neutral" {
    if (this.points.length < 10) return "neutral";
    const recent = this.points.slice(-10);
    const first = recent[0].cvd;
    const last = recent[recent.length - 1].cvd;
    const delta = last - first;
    const threshold = Math.abs(first) * 0.02 + 10;
    if (delta > threshold) return "bullish";
    if (delta < -threshold) return "bearish";
    return "neutral";
  }
}

export const cvdService = new CvdService();
