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
  private cache24h: LiqCandle[] = [];
  private cache24hAt = 0;
  private cache2h: LiqCandle[] = [];
  private cache2hAt = 0;
  private fetching2h = false;
  private fetching24h = false;

  constructor() {
    // Warm up cache on start, then refresh on intervals
    void this.refresh2h();
    void this.refresh24h();
    setInterval(() => { void this.refresh2h(); }, 60 * 1000);
    setInterval(() => { void this.refresh24h(); }, 5 * 60 * 1000);
  }

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

  private async refresh2h() {
    if (this.fetching2h) return;
    this.fetching2h = true;
    try {
      const to = Math.floor(Date.now() / 1000);
      const from = to - 7200;
      const data = await this.fetchHistory(from, to, "5min");
      if (data.length > 0) { this.cache2h = data; this.cache2hAt = Date.now(); }
    } catch (e) {
      logger.warn({ err: e }, "Coinalyze 2h refresh failed");
    } finally { this.fetching2h = false; }
  }

  private async refresh24h() {
    if (this.fetching24h) return;
    this.fetching24h = true;
    try {
      const to = Math.floor(Date.now() / 1000);
      const from = to - 86400;
      const data = await this.fetchHistory(from, to, "1hour");
      if (data.length > 0) { this.cache24h = data; this.cache24hAt = Date.now(); }
    } catch (e) {
      logger.warn({ err: e }, "Coinalyze 24h refresh failed");
    } finally { this.fetching24h = false; }
  }

  // Sync getters for signal engine (returns cached data instantly)
  getLatest2hCandles(): LiqCandle[] { return this.cache2h; }
  getLatest24hCandles(): LiqCandle[] { return this.cache24h; }
  isReady(): boolean { return this.cache2hAt > 0 || this.cache24hAt > 0; }

  // Async getters for API routes (refresh if stale)
  async get24h(): Promise<LiqCandle[]> {
    if (Date.now() - this.cache24hAt > 5 * 60 * 1000) await this.refresh24h();
    return this.cache24h;
  }
  async get2h(): Promise<LiqCandle[]> {
    if (Date.now() - this.cache2hAt > 60 * 1000) await this.refresh2h();
    return this.cache2h;
  }
}

export const coinalyzeService = new CoinalyzeService();
