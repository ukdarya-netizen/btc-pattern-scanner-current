/**
 * CoinGlass v4, ported from AltBullet for BTC.
 *
 * Owner rule: aggregated data only, no substitute source; a missing series is
 * `null` and a pattern that needs it does not fire.
 *
 * Governor (as AltBullet's coinglass_governor): requests start at a fixed
 * minimum gap (plan budget), at most MAX_IN_FLIGHT concurrently, a 429 puts
 * every request into a growing cooldown (max 60 s), keys rotate round-robin.
 */
import { recordFailure, recordSuccess } from "../lib/apiHealth";

const BASE = "https://open-api-v4.coinglass.com";
/** STANDARD plan = 300 req/min per key; 250 ms ≈ 240/min = 80% of it. */
const MIN_GAP_MS = Number(process.env.COINGLASS_MIN_GAP_MS ?? 250);
const MAX_IN_FLIGHT = 4;
const MAX_COOLDOWN_MS = 60_000;

export const FUTURES_EXCHANGES =
  "ApeX Omni,Aster,Binance,BingX,Bitfinex,Bitget,Bitunix,Bybit,CME,Coinbase,Crypto.com,Deribit,Drift,EdgeX,Extended,Gate,HTX,Hyperliquid,Kraken,KuCoin,LBank,Lighter,MEXC,OKX,Paradex,WhiteBIT,dYdX,tradeXYZ";
export const SPOT_EXCHANGES = "Binance,Bitfinex,Bitget,Bybit,Coinbase,Crypto.com,Gate,Kraken,OKX,Upbit";

function keys(): string[] {
  return [process.env.COINGLASS_API_KEY, process.env.CoinGlassAPI, process.env.COINGLASS_API_KEY_2]
    .map((k) => k?.trim())
    .filter((k): k is string => Boolean(k))
    .filter((k, i, all) => all.indexOf(k) === i);
}

let keyIndex = 0;
let nextStartAt = 0;
let cooldownUntil = 0;
let consecutive429 = 0;
let inFlight = 0;
const stats = { started: 0, ok: 0, failed: 0, rateLimited: 0 };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function admit(): Promise<void> {
  for (;;) {
    const now = Date.now();
    const wait = Math.max(nextStartAt - now, cooldownUntil - now, 0);
    if (wait === 0 && inFlight < MAX_IN_FLIGHT) {
      nextStartAt = now + MIN_GAP_MS;
      inFlight += 1;
      return;
    }
    await sleep(Math.max(wait, 50));
  }
}

/** One GET; returns `data` (any shape) or null. Never throws. */
export async function cgGet(path: string, params: Record<string, string | number>): Promise<unknown | null> {
  const all = keys();
  if (all.length === 0) {
    recordFailure("coinglass", "COINGLASS_API_KEY не задан");
    return null;
  }
  await admit();
  stats.started += 1;
  const key = all[keyIndex++ % all.length]!;
  try {
    const url = new URL(path, BASE);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    const res = await fetch(url, {
      headers: { "CG-API-KEY": key, Accept: "application/json" },
      signal: AbortSignal.timeout(12_000),
    });
    if (res.status === 429) {
      stats.rateLimited += 1;
      consecutive429 += 1;
      cooldownUntil = Date.now() + Math.min(MAX_COOLDOWN_MS, 2_000 * 2 ** (consecutive429 - 1));
      return null;
    }
    const body = (await res.json()) as { code?: unknown; msg?: unknown; data?: unknown };
    if (!res.ok || String(body.code) !== "0") {
      stats.failed += 1;
      recordFailure("coinglass", `${path}: HTTP ${res.status} code ${String(body.code)} ${String(body.msg ?? "")}`);
      return null;
    }
    consecutive429 = 0;
    stats.ok += 1;
    recordSuccess("coinglass");
    return body.data ?? null;
  } catch (err) {
    stats.failed += 1;
    recordFailure("coinglass", `${path}: ${err instanceof Error ? err.name : "network error"}`);
    return null;
  } finally {
    inFlight -= 1;
  }
}

export function coinglassGovernorStats() {
  return { ...stats, cooldownMs: Math.max(0, cooldownUntil - Date.now()), minGapMs: MIN_GAP_MS };
}

async function cgList(path: string, params: Record<string, string | number>): Promise<Array<Record<string, unknown>> | null> {
  const data = await cgGet(path, params);
  return Array.isArray(data) ? (data as Array<Record<string, unknown>>) : null;
}

export type FlowBar = { time: number; [field: string]: number };

function bars(rows: Array<Record<string, unknown>> | null, fields: Record<string, string>): FlowBar[] | null {
  if (!rows) return null;
  const out: FlowBar[] = [];
  for (const row of rows) {
    const rawTime = Number(row.time ?? row.timestamp);
    const time = rawTime < 10_000_000_000 ? rawTime * 1000 : rawTime;
    if (!Number.isFinite(time)) continue;
    const bar: FlowBar = { time };
    let ok = true;
    for (const [name, source] of Object.entries(fields)) {
      const value = Number(row[source]);
      if (!Number.isFinite(value)) { ok = false; break; }
      bar[name] = value;
    }
    if (ok) out.push(bar);
  }
  return out.sort((a, b) => a.time - b.time);
}

/** Drop the still-forming bar so every metric uses closed intervals only. */
function closedOnly(series: FlowBar[] | null, stepMs: number, now: number): FlowBar[] | null {
  return series ? series.filter((b) => b.time + stepMs <= now) : null;
}

export type FlowSeries = {
  oi: FlowBar[] | null; // close = aggregated OI USD
  liquidations: FlowBar[] | null; // long, short USD
  futuresTaker: FlowBar[] | null; // buy, sell USD
  spotTaker: FlowBar[] | null; // buy, sell USD
  spotCvd: FlowBar[] | null; // cvd (cumulative)
  funding: FlowBar[] | null; // close = OI-weighted funding rate
  longShort: FlowBar[] | null; // ratio (Binance global accounts)
  orderbook: FlowBar[] | null; // bids, asks USD within ±1%
  whaleIndex: FlowBar[] | null; // value (Binance BTCUSDT, 1h)
  whaleIndex4h: FlowBar[] | null; // value (Binance BTCUSDT, 4h — AltBullet context)
};

const M15 = 15 * 60_000;
const H1 = 60 * 60_000;
const H4 = 4 * H1;

/** All flow series, closed bars only. */
export async function getBtcFlow(limit = 120, now = Date.now()): Promise<FlowSeries> {
  const common = { symbol: "BTC", interval: "15m", limit: limit + 1 };
  const [oi, liq, ft, st, cvd, fr, ls, ob, whale, whale4h] = await Promise.all([
    cgList("/api/futures/open-interest/aggregated-history", common),
    cgList("/api/futures/liquidation/aggregated-history", { ...common, exchange_list: FUTURES_EXCHANGES }),
    cgList("/api/futures/aggregated-taker-buy-sell-volume/history", { ...common, exchange_list: FUTURES_EXCHANGES }),
    cgList("/api/spot/aggregated-taker-buy-sell-volume/history", { ...common, exchange_list: SPOT_EXCHANGES }),
    cgList("/api/spot/aggregated-cvd/history", { ...common, exchange_list: SPOT_EXCHANGES }),
    cgList("/api/futures/funding-rate/oi-weight-history", common),
    cgList("/api/futures/global-long-short-account-ratio/history", {
      exchange: "Binance", symbol: "BTCUSDT", interval: "15m", limit: limit + 1,
    }),
    cgList("/api/futures/orderbook/aggregated-ask-bids-history", {
      ...common, exchange_list: FUTURES_EXCHANGES, range: "1",
    }),
    cgList("/api/futures/whale-index/history", { exchange: "Binance", symbol: "BTCUSDT", interval: "1h", limit: 30 }),
    cgList("/api/futures/whale-index/history", { exchange: "Binance", symbol: "BTCUSDT", interval: "4h", limit: 10 }),
  ]);
  return {
    oi: closedOnly(bars(oi, { close: "close" }), M15, now),
    liquidations: closedOnly(bars(liq, {
      long: "aggregated_long_liquidation_usd", short: "aggregated_short_liquidation_usd",
    }), M15, now),
    futuresTaker: closedOnly(bars(ft, {
      buy: "aggregated_buy_volume_usd", sell: "aggregated_sell_volume_usd",
    }), M15, now),
    spotTaker: closedOnly(bars(st, {
      buy: "aggregated_buy_volume_usd", sell: "aggregated_sell_volume_usd",
    }), M15, now),
    spotCvd: closedOnly(bars(cvd, { cvd: "cum_vol_delta" }), M15, now),
    funding: closedOnly(bars(fr, { close: "close" }), M15, now),
    longShort: closedOnly(bars(ls, { ratio: "global_account_long_short_ratio" }), M15, now),
    orderbook: closedOnly(bars(ob, { bids: "aggregated_bids_usd", asks: "aggregated_asks_usd" }), M15, now),
    whaleIndex: closedOnly(bars(whale, { value: "whale_index_value" }), H1, now),
    whaleIndex4h: closedOnly(bars(whale4h, { value: "whale_index_value" }), H4, now),
  };
}
