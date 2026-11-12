import { type Metrics, type Signal, mult, num, signed, tone, usd } from "../lib/api";
import type { Col } from "./ui";

/**
 * Owner 2026-11-12: the entry metrics as columns, as CAB's tracker / history (OI 15m–24h, spot CVD 15m–4h, volume ×,
 * takers, price 1h / 24h, funding, Whale Index, order book, liquidations 1h / 24h and their ratio, crowd).
 * Owner only (users get no entry metrics). Every column sorts.
 */
const m = (s: Signal): Partial<Metrics> => s.metrics ?? {};
const pctCol = (head: string, title: string, get: (x: Partial<Metrics>) => number | null | undefined, d = 2): Col<Signal> => ({
  head, title,
  cell: (s) => { const v = get(m(s)); return <span className={tone(v)}>{signed(v, d)}</span>; },
  sort: (s) => get(m(s)) ?? null,
});
const usdCol = (head: string, title: string, get: (x: Partial<Metrics>) => number | null | undefined): Col<Signal> => ({
  head, title,
  cell: (s) => { const v = get(m(s)); return <span className={tone(v)}>{usd(v)}</span>; },
  sort: (s) => get(m(s)) ?? null,
});
const liqRatio = (x: Partial<Metrics>) => {
  const h = (x.liqLongUsd?.["1h"] ?? 0) + (x.liqShortUsd?.["1h"] ?? 0);
  const d = (x.liqLongUsd?.["24h"] ?? 0) + (x.liqShortUsd?.["24h"] ?? 0);
  return x.liqLongUsd && d > 0 ? (h / d) * 100 : null;
};
const crowd = (x: Partial<Metrics>) => (x.longShortRatio == null ? null : (x.longShortRatio / (1 + x.longShortRatio)) * 100);

export const METRIC_COLS: Col<Signal>[] = [
  pctCol("OI 15m", "OI Δ15m % (CoinGlass, все биржи) на входе", (x) => x.oiChangePct?.["15m"]),
  pctCol("OI 30m", "OI Δ30m % на входе", (x) => x.oiChangePct?.["30m"]),
  pctCol("OI 1h", "OI Δ1h % на входе", (x) => x.oiChangePct?.["1h"]),
  pctCol("OI 4h", "OI Δ4h % на входе", (x) => x.oiChangePct?.["4h"]),
  pctCol("OI 24h", "OI Δ24h % на входе", (x) => x.oiChangePct?.["24h"]),
  usdCol("CVD 15m", "Spot CVD 15m, $ (CoinGlass)", (x) => x.spotCvdUsd?.["15m"]),
  usdCol("CVD 30m", "Spot CVD 30m, $", (x) => x.spotCvdUsd?.["30m"]),
  usdCol("CVD 1h", "Spot CVD 1h, $", (x) => x.spotCvdUsd?.["1h"]),
  usdCol("CVD 4h", "Spot CVD 4h, $", (x) => x.spotCvdUsd?.["4h"]),
  usdCol("Фьюч CVD 1h", "Futures CVD 1h, $ (тейкер buy − sell)", (x) => x.futCvdUsd?.["1h"]),
  { head: "Спот×", title: "Спот объём 1h к среднему за 24h", cell: (s) => mult(m(s).spotVolumeMult?.["1h"]), sort: (s) => m(s).spotVolumeMult?.["1h"] ?? null },
  { head: "Фьюч×", title: "Фьюч объём 1h к среднему за 24h", cell: (s) => mult(m(s).futVolumeMult?.["1h"]), sort: (s) => m(s).futVolumeMult?.["1h"] ?? null },
  pctCol("Фьюч тейкер", "Futures taker net buy % 1h — >0 покупатели доминируют", (x) => x.futTakerNetPct?.["1h"]),
  pctCol("Спот тейкер", "Spot taker net buy % 1h", (x) => x.spotTakerNetPct?.["1h"]),
  pctCol("P1h", "Изменение цены за 1h на входе", (x) => x.priceChangePct?.["1h"]),
  pctCol("P24h", "Изменение цены за 24h на входе", (x) => x.priceChangePct?.["24h"]),
  pctCol("Fund% BingX", "Funding rate % (BingX, 8ч) на входе", (x) => x.fundingBingxPct, 4),
  pctCol("Fund% CG", "Funding rate % (CoinGlass, OI-взвешенный) на входе", (x) => x.fundingRatePct, 4),
  { head: "WI", title: "CoinGlass Whale Index (Binance BTCUSDT 1h) на входе", cell: (s) => num(m(s).whaleIndex, 1), sort: (s) => m(s).whaleIndex ?? null },
  { head: "WI 4h", title: "Whale Index на 4h барах", cell: (s) => num(m(s).whaleIndex4h, 1), sort: (s) => m(s).whaleIndex4h ?? null },
  { head: "OB", title: "Стакан ±1% bid/ask (CoinGlass): >1 биды давят, <1 аски", cell: (s) => num(m(s).orderbookBidAskRatio, 2), sort: (s) => m(s).orderbookBidAskRatio ?? null },
  { head: "Толпа", title: "% аккаунтов в лонге (Binance)", cell: (s) => { const v = crowd(m(s)); return v == null ? "—" : `${v.toFixed(0)}%`; }, sort: (s) => crowd(m(s)) },
  usdCol("L.Liq 1h", "Ликвидации лонгов за 1h", (x) => x.liqLongUsd?.["1h"]),
  usdCol("S.Liq 1h", "Ликвидации шортов за 1h", (x) => x.liqShortUsd?.["1h"]),
  usdCol("Liq 24h", "Все ликвидации за 24h", (x) => (x.liqLongUsd ? (x.liqLongUsd["24h"] ?? 0) + (x.liqShortUsd?.["24h"] ?? 0) : null)),
  { head: "LiqR", title: "Ликвидации 1h / 24h, %", cell: (s) => { const v = liqRatio(m(s)); return v == null ? "—" : `${v.toFixed(1)}%`; }, sort: (s) => liqRatio(m(s)) },
];
