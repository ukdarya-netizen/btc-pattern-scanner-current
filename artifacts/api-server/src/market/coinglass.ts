/**
 * CoinGlass v4 aggregated BTC flow. Owner rule carried over from AltBullet:
 * aggregated data only, no fallback source; a missing series is `null` and a
 * pattern that needs it does not fire.
 */
const BASE = "https://open-api-v4.coinglass.com";
const MIN_GAP_MS = Number(process.env.COINGLASS_MIN_GAP_MS ?? 1_500);

const FUTURES_EXCHANGES =
  "ApeX Omni,Aster,Binance,BingX,Bitfinex,Bitget,Bitunix,Bybit,CME,Coinbase,Crypto.com,Deribit,Drift,EdgeX,Extended,Gate,HTX,Hyperliquid,Kraken,KuCoin,LBank,Lighter,MEXC,OKX,Paradex,WhiteBIT,dYdX,tradeXYZ";
const SPOT_EXCHANGES = "Binance,Bitfinex,Bitget,Bybit,Coinbase,Crypto.com,Gate,Kraken,OKX,Upbit";

let nextSlot = 0;
async function paced<T>(fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + MIN_GAP_MS;
  if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
  return fn();
}

function apiKey(): string | null {
  return (process.env.COINGLASS_API_KEY ?? process.env.CoinGlassAPI ?? "").trim() || null;
}

async function cg(path: string, params: Record<string, string | number>): Promise<Array<Record<string, unknown>> | null> {
  const key = apiKey();
  if (!key) return null;
  return paced(async () => {
    const url = new URL(path, BASE);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
    try {
      const res = await fetch(url, {
        headers: { "CG-API-KEY": key, Accept: "application/json" },
        signal: AbortSignal.timeout(12_000),
      });
      const body = (await res.json()) as { code?: unknown; data?: unknown };
      if (String(body.code) !== "0" || !Array.isArray(body.data)) return null;
      return body.data as Array<Record<string, unknown>>;
    } catch {
      return null;
    }
  });
}

export type FlowBar = { time: number; [field: string]: number };

function bars(rows: Array<Record<string, unknown>> | null, fields: Record<string, string>): FlowBar[] | null {
  if (!rows) return null;
  const out: FlowBar[] = [];
  for (const row of rows) {
    const time = Number(row.time);
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
};

const M15 = 15 * 60_000;

/** All series at 15m, `limit` closed bars each (≈2 calls per minute at the default gap). */
export async function getBtcFlow(limit = 120, now = Date.now()): Promise<FlowSeries> {
  const common = { symbol: "BTC", interval: "15m", limit: limit + 1 };
  const oi = await cg("/api/futures/open-interest/aggregated-history", common);
  const liq = await cg("/api/futures/liquidation/aggregated-history", { ...common, exchange_list: FUTURES_EXCHANGES });
  const ft = await cg("/api/futures/aggregated-taker-buy-sell-volume/history", { ...common, exchange_list: FUTURES_EXCHANGES });
  const st = await cg("/api/spot/aggregated-taker-buy-sell-volume/history", { ...common, exchange_list: SPOT_EXCHANGES });
  const cvd = await cg("/api/spot/aggregated-cvd/history", { ...common, exchange_list: SPOT_EXCHANGES });
  const fr = await cg("/api/futures/funding-rate/oi-weight-history", common);
  const ls = await cg("/api/futures/global-long-short-account-ratio/history", {
    exchange: "Binance", symbol: "BTCUSDT", interval: "15m", limit: limit + 1,
  });
  const ob = await cg("/api/futures/orderbook/aggregated-ask-bids-history", {
    ...common, exchange_list: FUTURES_EXCHANGES, range: "1",
  });
  const whale = await cg("/api/futures/whale-index/history", {
    exchange: "Binance", symbol: "BTCUSDT", interval: "1h", limit: 30,
  });
  return {
    whaleIndex: closedOnly(bars(whale, { value: "whale_index_value" }), 60 * 60_000, now),
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
  };
}
