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

export interface OiExchangeRow {
  exchange: string;
  oiUsd: number;
  h1ChangePct: number;
  h4ChangePct: number;
  m5ChangePct: number;
  m15ChangePct: number;
  fundingRate: number | null;
  volUsd: number;
}

export interface AggregatedOiData {
  totalOiUsd: number;
  m5ChangePct: number;
  m15ChangePct: number;
  h1ChangePct: number;
  h4ChangePct: number;
  h24ChangePct: number;
  avgFundingRate: number;
  avgFundingRateByVol: number;
  volUsd24h: number;
  oiVolRatio: number;
  exchanges: OiExchangeRow[];
  updatedAt: number;
}

export interface OiDeltaResult {
  delta5m: number;
  delta15m: number;
  delta1h: number;
  delta4h: number;
  priceChange5m: number;
  fundingRate: number;
  interpretation: "trend_strong" | "trend_weak" | "reversal_likely" | "neutral";
  score: number;
}

export interface LongShortExchangeRow {
  exchange: string;
  longRate: number;
  shortRate: number;
  longVolUsd: number;
  shortVolUsd: number;
  totalVolUsd: number;
}

export interface LongShortData {
  longRate: number;
  shortRate: number;
  longVolUsd: number;
  shortVolUsd: number;
  totalVolUsd: number;
  // Sentiment interpretation
  bias: "long_extreme" | "short_extreme" | "long_leaning" | "short_leaning" | "neutral";
  exchanges: LongShortExchangeRow[];
  updatedAt: number;
}

export interface OiHistoryPoint {
  timestamp: number;
  price: number;
  totalOiUsd: number;
  // Per-exchange OI values (USD)
  byExchange: Record<string, number>;
}

// Minimal price ring buffer for priceChange5m derivation
interface PricePoint { timestamp: number; price: number }

class CoinglassService {
  private cachedLiqInfo: LiquidationInfo | null = null;
  private lastLiqInfoFetch = 0;
  private readonly TTL_LIQ_INFO = 60_000;

  private cachedHeatmap: LiqHeatmap | null = null;
  private heatmapFetching = false;
  private heatmapInterval: ReturnType<typeof setInterval> | null = null;

  private cachedAggOi: AggregatedOiData | null = null;
  private oiPolling = false;
  private oiInterval: ReturnType<typeof setInterval> | null = null;
  private priceHistory: PricePoint[] = [];
  private priceInterval: ReturnType<typeof setInterval> | null = null;

  private cachedLongShort: LongShortData | null = null;
  private lsPolling = false;
  private lsInterval: ReturnType<typeof setInterval> | null = null;

  private cachedOiHistory: OiHistoryPoint[] = [];
  private oiHistoryPolling = false;
  private oiHistoryInterval: ReturnType<typeof setInterval> | null = null;

  startPolling() {
    this.fetchHeatmap();
    this.heatmapInterval = setInterval(() => this.fetchHeatmap(), 5 * 60_000);

    void this.fetchAggregatedOi();
    this.oiInterval = setInterval(() => { void this.fetchAggregatedOi(); }, 5 * 60_000);

    void this.fetchLongShort();
    this.lsInterval = setInterval(() => { void this.fetchLongShort(); }, 5 * 60_000);

    void this.fetchOiHistory();
    this.oiHistoryInterval = setInterval(() => { void this.fetchOiHistory(); }, 15 * 60_000);

    // Keep a 10-point price ring buffer (1 per minute) for priceChange5m
    this.recordPrice();
    this.priceInterval = setInterval(() => this.recordPrice(), 60_000);
  }

  stopPolling() {
    if (this.heatmapInterval) clearInterval(this.heatmapInterval);
    if (this.oiInterval) clearInterval(this.oiInterval);
    if (this.lsInterval) clearInterval(this.lsInterval);
    if (this.oiHistoryInterval) clearInterval(this.oiHistoryInterval);
    if (this.priceInterval) clearInterval(this.priceInterval);
    this.heatmapInterval = this.oiInterval = this.lsInterval = this.oiHistoryInterval = this.priceInterval = null;
  }

  private recordPrice() {
    const price = aggregator.getPrimaryPrice();
    if (price === 0) return;
    this.priceHistory.push({ timestamp: Date.now(), price });
    if (this.priceHistory.length > 12) this.priceHistory = this.priceHistory.slice(-12);
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

  private async fetchAggregatedOi() {
    if (!API_KEY || this.oiPolling) return;
    this.oiPolling = true;
    try {
      const raw = await cgRequest("/public/v2/open_interest?symbol=BTC") as Record<string, unknown>[] | null;
      if (!Array.isArray(raw) || raw.length === 0) return;

      const allRow = raw.find(r => r["exchangeName"] === "All");
      if (!allRow) return;

      const exchanges: OiExchangeRow[] = raw
        .filter(r => r["exchangeName"] !== "All")
        .map(r => ({
          exchange:    String(r["exchangeName"] ?? ""),
          oiUsd:       Number(r["openInterest"]     ?? 0),
          h1ChangePct: Number(r["h1OIChangePercent"] ?? 0),
          h4ChangePct: Number(r["h4OIChangePercent"] ?? 0),
          m5ChangePct: Number(r["m5OIChangePercent"] ?? 0),
          m15ChangePct:Number(r["m15OIChangePercent"]?? 0),
          fundingRate: r["avgFundingRate"] != null ? Number(r["avgFundingRate"]) : null,
          volUsd:      Number(r["volUsd"] ?? 0),
        }))
        .sort((a, b) => b.oiUsd - a.oiUsd);

      this.cachedAggOi = {
        totalOiUsd:        Number(allRow["openInterest"]          ?? 0),
        m5ChangePct:       Number(allRow["m5OIChangePercent"]      ?? 0),
        m15ChangePct:      Number(allRow["m15OIChangePercent"]     ?? 0),
        h1ChangePct:       Number(allRow["h1OIChangePercent"]      ?? 0),
        h4ChangePct:       Number(allRow["h4OIChangePercent"]      ?? 0),
        h24ChangePct:      Number(allRow["h24Change"]              ?? 0),
        avgFundingRate:    Number(allRow["avgFundingRate"]         ?? 0),
        avgFundingRateByVol: Number(allRow["avgFundingRateByVol"] ?? 0),
        volUsd24h:         Number(allRow["volUsd"]                 ?? 0),
        oiVolRatio:        Number(allRow["oiVolRatio"]             ?? 0),
        exchanges,
        updatedAt: Date.now(),
      };

      logger.info(
        { totalOiB: (this.cachedAggOi.totalOiUsd / 1e9).toFixed(1), oiΔ1h: this.cachedAggOi.h1ChangePct },
        "CoinGlass aggregated OI updated",
      );
    } catch (e) {
      logger.warn({ err: e }, "CoinGlass OI fetch failed — using cached");
    } finally {
      this.oiPolling = false;
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

  getAggregatedOi(): AggregatedOiData | null {
    return this.cachedAggOi;
  }

  getLongShort(): LongShortData | null {
    return this.cachedLongShort;
  }

  getOiHistory(limit = 24): OiHistoryPoint[] {
    return this.cachedOiHistory.slice(-limit);
  }

  private async fetchLongShort() {
    if (!API_KEY || this.lsPolling) return;
    this.lsPolling = true;
    try {
      const raw = await cgRequest(
        "/public/v2/long_short?symbol=BTC&time_type=h1&currency=USD&limit=1",
      ) as Record<string, unknown>[] | null;
      if (!Array.isArray(raw) || raw.length === 0) return;

      const item = raw[0] as Record<string, unknown>;
      const longRate  = Number(item["longRate"]  ?? 50);
      const shortRate = Number(item["shortRate"] ?? 50);

      let bias: LongShortData["bias"] = "neutral";
      if      (longRate >= 60) bias = "long_extreme";
      else if (longRate <= 35) bias = "short_extreme";
      else if (longRate >= 55) bias = "long_leaning";
      else if (longRate <= 45) bias = "short_leaning";

      const list = (item["list"] as Record<string, unknown>[]) ?? [];
      const exchanges: LongShortExchangeRow[] = list
        .filter(e => Number(e["totalVolUsd"] ?? 0) > 0)
        .map(e => ({
          exchange:    String(e["exchangeName"] ?? ""),
          longRate:    Number(e["longRate"]    ?? 0),
          shortRate:   Number(e["shortRate"]   ?? 0),
          longVolUsd:  Number(e["longVolUsd"]  ?? 0),
          shortVolUsd: Number(e["shortVolUsd"] ?? 0),
          totalVolUsd: Number(e["totalVolUsd"] ?? 0),
        }))
        .sort((a, b) => b.totalVolUsd - a.totalVolUsd);

      this.cachedLongShort = {
        longRate,
        shortRate,
        longVolUsd:  Number(item["longVolUsd"]  ?? 0),
        shortVolUsd: Number(item["shortVolUsd"] ?? 0),
        totalVolUsd: Number(item["totalVolUsd"] ?? 0),
        bias,
        exchanges,
        updatedAt: Date.now(),
      };

      logger.info({ longRate, shortRate, bias }, "CoinGlass long/short updated");
    } catch (e) {
      logger.warn({ err: e }, "CoinGlass long/short fetch failed — using cached");
    } finally {
      this.lsPolling = false;
    }
  }

  private async fetchOiHistory() {
    if (!API_KEY || this.oiHistoryPolling) return;
    this.oiHistoryPolling = true;
    try {
      const raw = await cgRequest(
        "/public/v2/open_interest_history?symbol=BTC&time_type=h1&currency=USD&limit=48",
      ) as Record<string, unknown> | null;
      if (!raw || typeof raw !== "object") return;

      const dateList  = (raw["dateList"]  as number[]) ?? [];
      const priceList = (raw["priceList"] as number[]) ?? [];
      const dataMap   = (raw["dataMap"]   as Record<string, number[]>) ?? {};

      if (dateList.length === 0) return;

      const exchangeNames = Object.keys(dataMap);

      // Build per-point total OI and per-exchange breakdown
      this.cachedOiHistory = dateList.map((ts, i) => {
        const byExchange: Record<string, number> = {};
        let totalOiUsd = 0;
        for (const ex of exchangeNames) {
          const val = dataMap[ex]?.[i] ?? 0;
          byExchange[ex] = val;
          totalOiUsd += val;
        }
        return {
          timestamp: ts,
          price: priceList[i] ?? 0,
          totalOiUsd,
          byExchange,
        };
      });

      logger.info(
        { points: this.cachedOiHistory.length, exchanges: exchangeNames.length },
        "CoinGlass OI history updated",
      );
    } catch (e) {
      logger.warn({ err: e }, "CoinGlass OI history fetch failed — using cached");
    } finally {
      this.oiHistoryPolling = false;
    }
  }

  getOiDelta(): OiDeltaResult {
    const neutral: OiDeltaResult = {
      delta5m: 0, delta15m: 0, delta1h: 0, delta4h: 0,
      priceChange5m: 0, fundingRate: 0,
      interpretation: "neutral", score: 0,
    };

    if (!this.cachedAggOi) return neutral;

    const oi = this.cachedAggOi;
    const delta5m  = oi.m5ChangePct  / 100;
    const delta15m = oi.m15ChangePct / 100;
    const delta1h  = oi.h1ChangePct  / 100;
    const delta4h  = oi.h4ChangePct  / 100;

    // Derive 5m price change from ring buffer
    let priceChange5m = 0;
    if (this.priceHistory.length >= 2) {
      const now = Date.now();
      const snap5m = this.priceHistory.find(p => p.timestamp <= now - 5 * 60_000);
      const latest = this.priceHistory[this.priceHistory.length - 1]!;
      if (snap5m && snap5m.price > 0) {
        priceChange5m = (latest.price - snap5m.price) / snap5m.price;
      }
    }

    const OI_DROP_THRESHOLD = -0.003; // -0.3% in 5m = significant OI drain

    let score = 0;
    let interpretation: OiDeltaResult["interpretation"] = "neutral";

    if (delta5m < OI_DROP_THRESHOLD) {
      interpretation = "reversal_likely";
      score = 0;
    } else if (delta5m > 0 && priceChange5m > 0) {
      interpretation = "trend_strong";
      score = 0.7;
    } else if (delta5m > 0 && priceChange5m < 0) {
      interpretation = "trend_strong";
      score = -0.7;
    } else if (delta5m < 0 && priceChange5m > 0) {
      interpretation = "trend_weak";
      score = 0.3;
    } else if (delta5m < 0 && priceChange5m < 0) {
      interpretation = "trend_weak";
      score = -0.3;
    }

    return {
      delta5m, delta15m, delta1h, delta4h,
      priceChange5m,
      fundingRate: oi.avgFundingRate,
      interpretation,
      score,
    };
  }
}

export const coinglassService = new CoinglassService();
