/**
 * BTC history for the market-phase study (owner 2026-11-13: «строка — режим рынка / вероятность», checked on a long
 * history across regimes, not on the bot's own 3 weeks). CoinGlass, BTC, 1h (paged back up to 2 years) and 4h:
 * Binance BTCUSDT price OHLC, aggregated OI, futures and spot taker buy / sell, OI-weighted funding, aggregated
 * liquidations, Binance long / short account ratio. About 35 CoinGlass requests, built on demand by the owner and
 * kept for 6 hours. Production only (cgGet makes no request in dev). Never a signal input.
 */
import { gzipSync } from "node:zlib";
import { cgList, FUTURES_EXCHANGES, SPOT_EXCHANGES } from "../market/coinglass";

const H1 = 3_600_000, H4 = 4 * H1;
const DAYS = 730;
type Row = Record<string, number>;
const n = (v: unknown) => { const x = Number(v); return Number.isFinite(x) ? x : null; };
const ms = (v: unknown) => { const x = Number(v); return x < 1e12 ? x * 1000 : x; };

/** All rows of one series from `start` to now, paging back by end_time (4500 rows a request). */
async function series(path: string, params: Record<string, string | number>, interval: string, span: number, start: number): Promise<Array<Record<string, unknown>>> {
  const out = new Map<number, Record<string, unknown>>();
  let end = Date.now();
  for (let page = 0; page < 6 && end > start; page++) {
    const rows = await cgList(path, { ...params, interval, limit: 4500, end_time: end });
    if (!rows?.length) break;
    for (const r of rows) out.set(ms(r.time), r);
    const oldest = Math.min(...rows.map((r) => ms(r.time)));
    if (oldest >= end) break;
    end = oldest - span;
  }
  return [...out.entries()].filter(([t]) => t >= start).sort((a, b) => a[0] - b[0]).map(([, r]) => r);
}

const COLS = ["tf", "t", "open", "high", "low", "close", "oi", "fut_buy", "fut_sell", "spot_buy", "spot_sell", "funding", "liq_long", "liq_short", "ls_ratio"];

export async function buildHistoryCsv(): Promise<{ csv: Buffer; rows: number }> {
  const lines: string[] = [COLS.join(",")];
  for (const [tf, span] of [["1h", H1], ["4h", H4]] as const) {
    const start = Date.now() - DAYS * 86_400_000;
    const sym = { symbol: "BTC" };
    const [price, oi, ft, st, fr, liq, ls] = [
      await series("/api/futures/price/history", { exchange: "Binance", symbol: "BTCUSDT" }, tf, span, start),
      await series("/api/futures/open-interest/aggregated-history", sym, tf, span, start),
      await series("/api/futures/aggregated-taker-buy-sell-volume/history", { ...sym, exchange_list: FUTURES_EXCHANGES }, tf, span, start),
      await series("/api/spot/aggregated-taker-buy-sell-volume/history", { ...sym, exchange_list: SPOT_EXCHANGES }, tf, span, start),
      await series("/api/futures/funding-rate/oi-weight-history", sym, tf, span, start),
      await series("/api/futures/liquidation/aggregated-history", { ...sym, exchange_list: FUTURES_EXCHANGES }, tf, span, start),
      await series("/api/futures/global-long-short-account-ratio/history", { exchange: "Binance", symbol: "BTCUSDT" }, tf, span, start),
    ];
    const by = (rows: Array<Record<string, unknown>>) => new Map(rows.map((r) => [ms(r.time), r]));
    const [O, F, S, R, L, A] = [by(oi), by(ft), by(st), by(fr), by(liq), by(ls)];
    const cell = (v: number | null) => (v === null ? "" : String(v));
    for (const p of price) {
      const t = ms(p.time);
      const row: Array<number | null> = [
        t, n(p.open), n(p.high), n(p.low), n(p.close), n(O.get(t)?.close),
        n(F.get(t)?.aggregated_buy_volume_usd), n(F.get(t)?.aggregated_sell_volume_usd),
        n(S.get(t)?.aggregated_buy_volume_usd), n(S.get(t)?.aggregated_sell_volume_usd),
        n(R.get(t)?.close), n(L.get(t)?.aggregated_long_liquidation_usd), n(L.get(t)?.aggregated_short_liquidation_usd),
        n(A.get(t)?.global_account_long_short_ratio),
      ];
      lines.push([tf, ...row.map(cell)].join(","));
    }
  }
  return { csv: gzipSync(lines.join("\n") + "\n"), rows: lines.length - 1 };
}

let cached: { at: number; csv: Buffer; rows: number } | null = null;
let building: Promise<{ csv: Buffer; rows: number }> | null = null;
/** The file, rebuilt at most every 6 hours; one build at a time. */
export async function historyCsv(): Promise<{ csv: Buffer; rows: number }> {
  if (cached && Date.now() - cached.at < 6 * H1) return cached;
  building ??= buildHistoryCsv().then((r) => { if (r.rows > 0) cached = { at: Date.now(), ...r }; return r; }).finally(() => { building = null; });
  return building;
}
export type HistoryRow = Row;
