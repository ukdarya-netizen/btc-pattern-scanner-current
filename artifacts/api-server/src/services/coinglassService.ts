import https from "https";
import { logger } from "../lib/logger";
import { aggregator } from "./exchanges/aggregator";

const API_KEY = process.env["COINGLASS_API_KEY"] ?? "";
const BASE = "open-api.coinglass.com";

function cgRequest(path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: BASE,
      path,
      method: "GET",
      headers: {
        "coinglassSecret": API_KEY,
        "Accept": "application/json",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data) as Record<string, unknown>;
          if (parsed["code"] !== "0" && parsed["code"] !== 0) {
            reject(new Error(`CoinGlass error: ${parsed["msg"] ?? parsed["code"]}`));
          } else {
            resolve(parsed["data"]);
          }
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

export interface LiquidationInfo {
  longVolUsd1h: number;
  shortVolUsd1h: number;
  longVolUsd4h: number;
  shortVolUsd4h: number;
  longVolUsd12h: number;
  shortVolUsd12h: number;
  longVolUsd24h: number;
  shortVolUsd24h: number;
  h1TotalVolUsd: number;
  h4TotalVolUsd: number;
  h12TotalVolUsd: number;
  h24TotalVolUsd: number;
  h1Amount: number;
  h4Amount: number;
  h12Amount: number;
  h24Amount: number;
}

export interface LiqHeatmapBucket {
  price: number;
  longLiqUsd: number;
  shortLiqUsd: number;
  totalUsd: number;
}

export interface LiqHeatmap {
  buckets: LiqHeatmapBucket[];
  currentPrice: number;
  updatedAt: number;
}

export interface OiSnapshot {
  timestamp: number;
  oi: number;
  price: number;
}

export interface OiDeltaResult {
  delta5m: number;
  delta15m: number;
  priceChange5m: number;
  interpretation: "trend_strong" | "trend_weak" | "reversal_likely" | "neutral";
  score: number;
}

class CoinglassService {
  private cachedLiqInfo: LiquidationInfo | null = null;
  private lastLiqInfoFetch = 0;
  private readonly TTL_LIQ_INFO = 60_000;

  private cachedHeatmap: LiqHeatmap | null = null;
  private heatmapFetching = false;
  private heatmapInterval: ReturnType<typeof setInterval> | null = null;

  private oiHistory: OiSnapshot[] = [];
  private oiInterval: ReturnType<typeof setInterval> | null = null;

  startPolling() {
    this.fetchHeatmap();
    this.heatmapInterval = setInterval(() => this.fetchHeatmap(), 5 * 60_000);

    this.snapshotOi();
    this.oiInterval = setInterval(() => this.snapshotOi(), 60_000);
  }

  stopPolling() {
    if (this.heatmapInterval) clearInterval(this.heatmapInterval);
    if (this.oiInterval) clearInterval(this.oiInterval);
    this.heatmapInterval = this.oiInterval = null;
  }

  private async fetchHeatmap() {
    if (!API_KEY || this.heatmapFetching) return;
    this.heatmapFetching = true;
    try {
      const raw = await cgRequest("/public/v2/liquidation_heatmap?symbol=BTC&range=12");
      const heatmap = this.parseHeatmap(raw);
      if (heatmap) {
        this.cachedHeatmap = heatmap;
        logger.info({ buckets: heatmap.buckets.length }, "CoinGlass heatmap updated");
      }
    } catch (e) {
      logger.warn({ err: e }, "CoinGlass heatmap fetch failed — using cached");
    } finally {
      this.heatmapFetching = false;
    }
  }

  private parseHeatmap(raw: unknown): LiqHeatmap | null {
    if (!raw || typeof raw !== "object") return null;

    const price = aggregator.getPrimaryPrice() || 0;
    const buckets: LiqHeatmapBucket[] = [];

    if (Array.isArray(raw)) {
      for (const item of raw as Record<string, unknown>[]) {
        const p = Number(item["price"] ?? item["priceLevel"] ?? item["p"] ?? 0);
        if (!p) continue;

        const longLiqUsd  = Number(item["longLiqUsd"]  ?? item["longVolUsd"]  ?? item["long"]  ?? 0);
        const shortLiqUsd = Number(item["shortLiqUsd"] ?? item["shortVolUsd"] ?? item["short"] ?? 0);
        const totalUsd    = Number(item["totalUsd"]    ?? item["total"] ?? 0) || (longLiqUsd + shortLiqUsd);

        if (totalUsd > 0 || longLiqUsd > 0 || shortLiqUsd > 0) {
          buckets.push({ price: p, longLiqUsd, shortLiqUsd, totalUsd: totalUsd || longLiqUsd + shortLiqUsd });
        }
      }
    } else {
      const data = raw as Record<string, unknown>;
      const priceLevels = (data["priceLevels"] ?? data["prices"] ?? data["levels"]) as unknown[];
      const longVols     = (data["longLiqVols"] ?? data["long"]  ?? data["longVolUsd"]) as unknown[];
      const shortVols    = (data["shortLiqVols"] ?? data["short"] ?? data["shortVolUsd"]) as unknown[];

      if (Array.isArray(priceLevels)) {
        for (let i = 0; i < priceLevels.length; i++) {
          const p    = Number(priceLevels[i]);
          const lng  = Array.isArray(longVols)  ? Number(longVols[i]  ?? 0) : 0;
          const sht  = Array.isArray(shortVols) ? Number(shortVols[i] ?? 0) : 0;
          if (p && (lng > 0 || sht > 0)) {
            buckets.push({ price: p, longLiqUsd: lng, shortLiqUsd: sht, totalUsd: lng + sht });
          }
        }
      }
    }

    if (buckets.length === 0) return null;
    return { buckets, currentPrice: price, updatedAt: Date.now() };
  }

  private snapshotOi() {
    const price = aggregator.getPrimaryPrice();
    const oi    = aggregator.getPrimaryOpenInterest();
    if (price === 0 || oi === 0) return;

    this.oiHistory.push({ timestamp: Date.now(), oi, price });
    if (this.oiHistory.length > 30) this.oiHistory = this.oiHistory.slice(-30);
  }

  async getLiquidationInfo(): Promise<LiquidationInfo | null> {
    if (!API_KEY) return null;
    const now = Date.now();
    if (this.cachedLiqInfo && now - this.lastLiqInfoFetch < this.TTL_LIQ_INFO) return this.cachedLiqInfo;

    try {
      const data = await cgRequest("/public/v2/liquidation_info?symbol=BTC&time_type=all") as Record<string, unknown>;
      this.cachedLiqInfo = {
        longVolUsd1h:   Number(data["longVolUsd1h"]   ?? 0),
        shortVolUsd1h:  Number(data["shortVolUsd1h"]  ?? 0),
        longVolUsd4h:   Number(data["longVolUsd4h"]   ?? 0),
        shortVolUsd4h:  Number(data["shortVolUsd4h"]  ?? 0),
        longVolUsd12h:  Number(data["longVolUsd12h"]  ?? 0),
        shortVolUsd12h: Number(data["shortVolUsd12h"] ?? 0),
        longVolUsd24h:  Number(data["longVolUsd24h"]  ?? 0),
        shortVolUsd24h: Number(data["shortVolUsd24h"] ?? 0),
        h1TotalVolUsd:  Number(data["h1TotalVolUsd"]  ?? 0),
        h4TotalVolUsd:  Number(data["h4TotalVolUsd"]  ?? 0),
        h12TotalVolUsd: Number(data["h12TotalVolUsd"] ?? 0),
        h24TotalVolUsd: Number(data["h24TotalVolUsd"] ?? 0),
        h1Amount:       Number(data["h1Amount"]       ?? 0),
        h4Amount:       Number(data["h4Amount"]       ?? 0),
        h12Amount:      Number(data["h12Amount"]      ?? 0),
        h24Amount:      Number(data["h24Amount"]      ?? 0),
      };
      this.lastLiqInfoFetch = now;
      return this.cachedLiqInfo;
    } catch (e) {
      logger.warn({ err: e }, "CoinGlass liquidation_info fetch failed");
      return this.cachedLiqInfo;
    }
  }

  async getLiqHeatmap(range: 12 | 24 = 12): Promise<LiqHeatmap | null> {
    if (!API_KEY) return null;
    await this.fetchHeatmap();
    return this.cachedHeatmap;
  }

  getCachedHeatmap(): LiqHeatmap | null {
    return this.cachedHeatmap;
  }

  getOiDelta(): OiDeltaResult {
    const neutral: OiDeltaResult = {
      delta5m: 0, delta15m: 0, priceChange5m: 0,
      interpretation: "neutral", score: 0,
    };

    if (this.oiHistory.length < 5) return neutral;

    const now = Date.now();
    const snap5m  = this.oiHistory.find(s => s.timestamp <= now - 5 * 60_000);
    const snap15m = this.oiHistory.find(s => s.timestamp <= now - 15 * 60_000);
    const latest  = this.oiHistory[this.oiHistory.length - 1];

    if (!snap5m) return neutral;

    const delta5m        = (latest.oi - snap5m.oi) / snap5m.oi;
    const priceChange5m  = (latest.price - snap5m.price) / snap5m.price;
    const delta15m       = snap15m ? (latest.oi - snap15m.oi) / snap15m.oi : 0;

    const OI_DROP_THRESHOLD = -0.005;

    let score = 0;
    let interpretation: OiDeltaResult["interpretation"] = "neutral";

    if (delta5m < OI_DROP_THRESHOLD) {
      interpretation = "reversal_likely";
      score = 0;
    } else if (delta5m > 0 && priceChange5m > 0) {
      interpretation = "trend_strong";
      score = priceChange5m > 0 ? 0.7 : -0.7;
    } else if (delta5m < 0 && priceChange5m > 0) {
      interpretation = "trend_weak";
      score = 0.3;
    } else if (delta5m > 0 && priceChange5m < 0) {
      interpretation = "trend_strong";
      score = -0.7;
    } else if (delta5m < 0 && priceChange5m < 0) {
      interpretation = "trend_weak";
      score = -0.3;
    }

    return { delta5m, delta15m, priceChange5m, interpretation, score };
  }
}

export const coinglassService = new CoinglassService();
