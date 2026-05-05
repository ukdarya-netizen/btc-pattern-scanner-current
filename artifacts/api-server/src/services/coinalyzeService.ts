import https from "https";
import { logger } from "../lib/logger";

const API_KEY = process.env["COINALYZE_API_KEY"] ?? "";
const BASE = "api.coinalyze.net";
const SYMBOL = "BTCUSDT_PERP.A";

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
  t: number;
  longBtc: number;
  shortBtc: number;
  longUsd: number;
  shortUsd: number;
}

class CoinalyzeService {
  private cache24h: LiqCandle[] | null = null;
  private cache24hAt = 0;
  private cache2h: LiqCandle[] | null = null;
  private cache2hAt = 0;

  private async fetchHistory(from: number, to: number, interval: string): Promise<LiqCandle[]> {
    if (!API_KEY) return [];
    const path = `/v1/liquidation-history?symbols=${SYMBOL}&interval=${interval}&from=${from}&to=${to}`;
    const raw = await caRequest(path) as Array<{ symbol: string; history: Array<{ t: number; l: number; s: number }> }>;
    if (!Array.isArray(raw) || !raw[0]?.history) return [];
    return raw[0].history.map(c => ({
      t: c.t,
      longBtc: c.l ?? 0,
      shortBtc: c.s ?? 0,
      longUsd: (c.l ?? 0) * 100000,
      shortUsd: (c.s ?? 0) * 100000,
    }));
  }

  async get24h(): Promise<LiqCandle[]> {
    const now = Date.now();
    if (this.cache24h && now - this.cache24hAt < 5 * 60 * 1000) return this.cache24h;
    try {
      const to = Math.floor(now / 1000);
      const from = to - 86400;
      this.cache24h = await this.fetchHistory(from, to, "1hour");
      this.cache24hAt = now;
    } catch (e) {
      logger.warn({ err: e }, "Coinalyze 24h fetch failed");
    }
    return this.cache24h ?? [];
  }

  async get2h(): Promise<LiqCandle[]> {
    const now = Date.now();
    if (this.cache2h && now - this.cache2hAt < 60 * 1000) return this.cache2h;
    try {
      const to = Math.floor(now / 1000);
      const from = to - 7200;
      this.cache2h = await this.fetchHistory(from, to, "5min");
      this.cache2hAt = now;
    } catch (e) {
      logger.warn({ err: e }, "Coinalyze 2h fetch failed");
    }
    return this.cache2h ?? [];
  }
}

export const coinalyzeService = new CoinalyzeService();
