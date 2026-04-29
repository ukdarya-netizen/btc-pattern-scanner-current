import https from "https";
import { logger } from "../lib/logger";

const API_KEY = process.env["COINGLASS_API_KEY"] ?? "";
const BASE = "open-api.coinglass.com";

function cgRequest(path: string): Promise<Record<string, unknown>> {
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
            resolve(parsed["data"] as Record<string, unknown>);
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

class CoinglassService {
  private cached: LiquidationInfo | null = null;
  private lastFetch = 0;
  private readonly TTL = 60000;

  async getLiquidationInfo(): Promise<LiquidationInfo | null> {
    if (!API_KEY) return null;
    const now = Date.now();
    if (this.cached && now - this.lastFetch < this.TTL) return this.cached;

    try {
      const data = await cgRequest("/public/v2/liquidation_info?symbol=BTC&time_type=all");
      this.cached = {
        longVolUsd1h: Number(data["longVolUsd1h"] ?? 0),
        shortVolUsd1h: Number(data["shortVolUsd1h"] ?? 0),
        longVolUsd4h: Number(data["longVolUsd4h"] ?? 0),
        shortVolUsd4h: Number(data["shortVolUsd4h"] ?? 0),
        longVolUsd12h: Number(data["longVolUsd12h"] ?? 0),
        shortVolUsd12h: Number(data["shortVolUsd12h"] ?? 0),
        longVolUsd24h: Number(data["longVolUsd24h"] ?? 0),
        shortVolUsd24h: Number(data["shortVolUsd24h"] ?? 0),
        h1TotalVolUsd: Number(data["h1TotalVolUsd"] ?? 0),
        h4TotalVolUsd: Number(data["h4TotalVolUsd"] ?? 0),
        h12TotalVolUsd: Number(data["h12TotalVolUsd"] ?? 0),
        h24TotalVolUsd: Number(data["h24TotalVolUsd"] ?? 0),
        h1Amount: Number(data["h1Amount"] ?? 0),
        h4Amount: Number(data["h4Amount"] ?? 0),
        h12Amount: Number(data["h12Amount"] ?? 0),
        h24Amount: Number(data["h24Amount"] ?? 0),
      };
      this.lastFetch = now;
      return this.cached;
    } catch (e) {
      logger.warn({ err: e }, "CoinGlass liquidation_info fetch failed");
      return this.cached;
    }
  }
}

export const coinglassService = new CoinglassService();
