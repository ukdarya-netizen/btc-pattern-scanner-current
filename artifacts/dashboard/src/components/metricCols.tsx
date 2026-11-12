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

const ind = (x: Partial<Metrics>, tf: string, k: string) => x.indicators?.[tf]?.[k] ?? null;
const numCol = (head: string, title: string, get: (x: Partial<Metrics>) => number | null, d = 1): Col<Signal> => ({
  head, title, cell: (s) => num(get(m(s)), d), sort: (s) => get(m(s)),
});

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
  numCol("RSI 15m", "RSI 14 на 15m (BingX)", (x) => ind(x, "15m", "rsi14")),
  numCol("RSI 1h", "RSI 14 на 1h", (x) => ind(x, "1h", "rsi14")),
  numCol("RSI 4h", "RSI 14 на 4h", (x) => ind(x, "4h", "rsi14")),
  numCol("RSI 1D", "RSI 14 на 1D", (x) => ind(x, "1d", "rsi14")),
  numCol("StochRSI 1h", "Stochastic RSI K на 1h", (x) => ind(x, "1h", "stochRsiK")),
  { head: "MACD 1h", title: "Гистограмма MACD 12/26/9 на 1h", cell: (s) => { const v = ind(m(s), "1h", "macdHist"); return <span className={tone(v)}>{num(v, 1)}</span>; }, sort: (s) => ind(m(s), "1h", "macdHist") },
  { head: "MACD 4h", title: "Гистограмма MACD на 4h", cell: (s) => { const v = ind(m(s), "4h", "macdHist"); return <span className={tone(v)}>{num(v, 1)}</span>; }, sort: (s) => ind(m(s), "4h", "macdHist") },
  numCol("ADX 4h", "ADX 14 на 4h — сила тренда", (x) => ind(x, "4h", "adx14")),
  numCol("BB %B 1h", "Положение цены в Боллинджере 20/2 на 1h (0 — нижняя, 1 — верхняя)", (x) => ind(x, "1h", "bbPctB"), 2),
  pctCol("EMA50 1h", "Цена от EMA 50 на 1h, %", (x) => ind(x, "1h", "distEma50Pct")),
  pctCol("EMA200 4h", "Цена от EMA 200 на 4h, %", (x) => ind(x, "4h", "distEma200Pct")),
  pctCol("MA200 1D", "Цена от MA 200 на 1D, %", (x) => ind(x, "1d", "distSma200Pct")),
  numCol("MFI фьюч 1h", "MFI 14 на агрегированном фьюч объёме, 1h", (x) => x.moneyFlow?.fut_1h?.mfi14 ?? null),
  { head: "LiqR", title: "Ликвидации 1h / 24h, %", cell: (s) => { const v = liqRatio(m(s)); return v == null ? "—" : `${v.toFixed(1)}%`; }, sort: (s) => liqRatio(m(s)) },
];
