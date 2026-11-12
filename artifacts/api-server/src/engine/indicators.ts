/**
 * Technical indicators (owner 2026-11-12: «RSI, MACD, MA, EMA и т.д.» — values visible and kept for fitting).
 * Computed from the BingX BTC-USDT closed candles the scanner already holds, on 15m / 1h / 4h / 1D, with the
 * TradingView definitions: RSI 14 (Wilder), MACD 12/26/9, EMA 9/21/50/200, SMA 20/50/200, Bollinger 20 / 2σ,
 * Stochastic RSI 14/14/3/3, ADX 14 (+DI / −DI). CoinGlass has the same indicators for Binance pairs, one request per
 * indicator and timeframe; here they cost no request and are on the exchange the signals trade.
 * Distances are % of the price from the line (+ = price above). Null where the history is too short.
 */
import type { Candle } from "../market/bingx";

export type TfIndicators = {
  rsi14: number | null;
  macd: number | null; macdSignal: number | null; macdHist: number | null;
  ema9: number | null; ema21: number | null; ema50: number | null; ema200: number | null;
  sma20: number | null; sma50: number | null; sma200: number | null;
  /** % from the price to each line (+ = price above the line). */
  distEma21Pct: number | null; distEma50Pct: number | null; distEma200Pct: number | null;
  distSma50Pct: number | null; distSma200Pct: number | null;
  bbUpper: number | null; bbLower: number | null; bbPctB: number | null; bbWidthPct: number | null;
  stochRsiK: number | null; stochRsiD: number | null;
  adx14: number | null; plusDi: number | null; minusDi: number | null;
};
export type Indicators = Record<"15m" | "1h" | "4h" | "1d", TfIndicators | null>;

const r = (v: number | null | undefined, d = 4) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(d)));

export function emaSeries(xs: number[], n: number): Array<number | null> {
  const out: Array<number | null> = new Array(xs.length).fill(null);
  if (xs.length < n) return out;
  let e = xs.slice(0, n).reduce((a, b) => a + b, 0) / n;
  out[n - 1] = e;
  const k = 2 / (n + 1);
  for (let i = n; i < xs.length; i++) { e = xs[i]! * k + e * (1 - k); out[i] = e; }
  return out;
}
export function sma(xs: number[], n: number): number | null {
  if (xs.length < n) return null;
  return xs.slice(-n).reduce((a, b) => a + b, 0) / n;
}
/** Wilder RSI, the whole series (null until enough bars). */
export function rsiSeries(xs: number[], n = 14): Array<number | null> {
  const out: Array<number | null> = new Array(xs.length).fill(null);
  if (xs.length <= n) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= n; i++) { const d = xs[i]! - xs[i - 1]!; if (d > 0) gain += d; else loss -= d; }
  gain /= n; loss /= n;
  const val = () => (loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss));
  out[n] = val();
  for (let i = n + 1; i < xs.length; i++) {
    const d = xs[i]! - xs[i - 1]!;
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = val();
  }
  return out;
}
function stochRsi(xs: number[]): { k: number | null; d: number | null } {
  const rs = rsiSeries(xs, 14);
  const raw: Array<number | null> = rs.map((_, i) => {
    const w = rs.slice(Math.max(0, i - 13), i + 1);
    if (w.length < 14 || w.some((v) => v == null)) return null;
    const lo = Math.min(...(w as number[])), hi = Math.max(...(w as number[]));
    return hi === lo ? 0 : ((rs[i]! - lo) / (hi - lo)) * 100;
  });
  const smooth = (s: Array<number | null>, n: number) => s.map((_, i) => {
    const w = s.slice(Math.max(0, i - n + 1), i + 1);
    return w.length < n || w.some((v) => v == null) ? null : (w as number[]).reduce((a, b) => a + b, 0) / n;
  });
  const k = smooth(raw, 3), d = smooth(k, 3);
  return { k: k.at(-1) ?? null, d: d.at(-1) ?? null };
}
function adx(cs: Candle[], n = 14): { adx: number | null; plus: number | null; minus: number | null } {
  if (cs.length < 2 * n + 1) return { adx: null, plus: null, minus: null };
  let tr = 0, pdm = 0, mdm = 0;
  const dx: number[] = [];
  let plus = 0, minus = 0;
  for (let i = 1; i < cs.length; i++) {
    const c = cs[i]!, p = cs[i - 1]!;
    const up = c.high - p.high, down = p.low - c.low;
    const t = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    const pd = up > down && up > 0 ? up : 0, md = down > up && down > 0 ? down : 0;
    if (i <= n) { tr += t; pdm += pd; mdm += md; if (i < n) continue; }
    else { tr = tr - tr / n + t; pdm = pdm - pdm / n + pd; mdm = mdm - mdm / n + md; }
    plus = tr ? (100 * pdm) / tr : 0; minus = tr ? (100 * mdm) / tr : 0;
    dx.push(plus + minus ? (100 * Math.abs(plus - minus)) / (plus + minus) : 0);
  }
  if (dx.length < n) return { adx: null, plus, minus };
  let a = dx.slice(0, n).reduce((x, y) => x + y, 0) / n;
  for (let i = n; i < dx.length; i++) a = (a * (n - 1) + dx[i]!) / n;
  return { adx: a, plus, minus };
}

export function tfIndicators(cs: Candle[]): TfIndicators | null {
  if (cs.length < 30) return null;
  const xs = cs.map((c) => c.close);
  const price = xs.at(-1)!;
  const last = (s: Array<number | null>) => s.at(-1) ?? null;
  const e12 = emaSeries(xs, 12), e26 = emaSeries(xs, 26);
  const macdLine = xs.map((_, i) => (e12[i] != null && e26[i] != null ? e12[i]! - e26[i]! : null));
  const macdVals = macdLine.filter((v): v is number => v != null);
  const sig = last(emaSeries(macdVals, 9));
  const macd = last(macdLine);
  const dist = (line: number | null) => (line == null ? null : ((price - line) / line) * 100);
  const ema = (n: number) => last(emaSeries(xs, n));
  const sd20 = xs.length >= 20 ? Math.sqrt(xs.slice(-20).reduce((a, x) => a + (x - sma(xs, 20)!) ** 2, 0) / 20) : null;
  const mid = sma(xs, 20);
  const up = mid != null && sd20 != null ? mid + 2 * sd20 : null, lo = mid != null && sd20 != null ? mid - 2 * sd20 : null;
  const st = stochRsi(xs), dmi = adx(cs);
  const e21 = ema(21), e50 = ema(50), e200 = ema(200), s50 = sma(xs, 50), s200 = sma(xs, 200);
  return {
    rsi14: r(last(rsiSeries(xs, 14)), 2),
    macd: r(macd, 2), macdSignal: r(sig, 2), macdHist: r(macd != null && sig != null ? macd - sig : null, 2),
    ema9: r(ema(9), 1), ema21: r(e21, 1), ema50: r(e50, 1), ema200: r(e200, 1),
    sma20: r(mid, 1), sma50: r(s50, 1), sma200: r(s200, 1),
    distEma21Pct: r(dist(e21), 3), distEma50Pct: r(dist(e50), 3), distEma200Pct: r(dist(e200), 3),
    distSma50Pct: r(dist(s50), 3), distSma200Pct: r(dist(s200), 3),
    bbUpper: r(up, 1), bbLower: r(lo, 1),
    bbPctB: r(up != null && lo != null && up !== lo ? (price - lo) / (up - lo) : null, 3),
    bbWidthPct: r(up != null && lo != null && mid ? ((up - lo) / mid) * 100 : null, 3),
    stochRsiK: r(st.k, 2), stochRsiD: r(st.d, 2),
    adx14: r(dmi.adx, 2), plusDi: r(dmi.plus, 2), minusDi: r(dmi.minus, 2),
  };
}

export function computeIndicators(candles: Partial<Record<"15m" | "1h" | "4h" | "1d", Candle[]>>): Indicators {
  return {
    "15m": tfIndicators(candles["15m"] ?? []),
    "1h": tfIndicators(candles["1h"] ?? []),
    "4h": tfIndicators(candles["4h"] ?? []),
    "1d": tfIndicators(candles["1d"] ?? []),
  };
}
