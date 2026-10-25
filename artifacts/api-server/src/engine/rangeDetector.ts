/**
 * Port of "Auto Range Detector [QuantAlgo]" (TradingView, Pine v6) — the
 * owner's chosen base indicator for BTC. Bar-close mode only: one pass per
 * closed candle, so nothing is revised after the fact. Defaults are the
 * indicator's defaults. The engine is a pure replay over closed candles:
 * the same candles always give the same ranges and events.
 */
import type { Candle } from "../market/bingx";

export type RangeParams = {
  baseLength: number;
  scanMultipliers: number[];
  bandPercentile: number;
  atrLength: number;
  compressionPct: number;
  calibrationLength: number;
  minRotation: number;
  minTouches: number;
  touchToleranceAtr: number;
  maxDrift: number;
  minContainment: number;
  anchorLookback: number;
  minRangeBars: number;
  absorbOvershoot: boolean;
  overshootToleranceAtr: number;
  breakoutBufferAtr: number;
  mergeDeviations: boolean;
  deviationWindow: number;
  cooldownBars: number;
};

export const DEFAULT_RANGE_PARAMS: RangeParams = {
  baseLength: 20,
  scanMultipliers: [1, 2, 3], // "Base + 2x + 3x"
  bandPercentile: 90, // "Percentile band"
  atrLength: 200,
  compressionPct: 40,
  calibrationLength: 500,
  minRotation: 0.18,
  minTouches: 2, // "Wick reaches"
  touchToleranceAtr: 0.1,
  maxDrift: 0.45,
  minContainment: 0.7,
  anchorLookback: 300, // "Extend to containment"
  minRangeBars: 10,
  absorbOvershoot: true,
  overshootToleranceAtr: 0.25,
  breakoutBufferAtr: 0.15, // "Close beyond"
  mergeDeviations: true,
  deviationWindow: 10,
  cooldownBars: 3,
};

export type RangeBox = {
  top: number;
  bottom: number;
  /** Index of the left edge / of the bar the range was detected on. */
  leftIndex: number;
  openedIndex: number;
  confirmed: boolean;
};

export type RangeEventKind = "breakout_up" | "breakout_down" | "deviation_bull" | "deviation_bear";

export type RangeEvent = {
  kind: RangeEventKind;
  index: number;
  time: number;
  /** The range that was broken / re-entered (boundaries at that bar). */
  range: { top: number; bottom: number; leftIndex: number; bars: number; heightPct: number };
  /** Deviation only: extreme of the failed excursion (the swept level). */
  sweepPrice: number | null;
  atr: number;
};

export type RangeReplay = {
  events: RangeEvent[];
  /** State after the last closed bar. */
  active: RangeBox | null;
  dormant: { top: number; bottom: number; direction: 1 | -1; since: number; sweepPrice: number } | null;
  atr: number[];
};

// ---------- Pine primitives ----------

/** ta.atr: RMA of true range, seeded with the SMA of the first `length` values. */
export function atrSeries(candles: Candle[], length: number): number[] {
  const out = new Array<number>(candles.length).fill(Number.NaN);
  let sum = 0;
  let prev = Number.NaN;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    const tr = i === 0 ? c.high - c.low
      : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1]!.close), Math.abs(c.low - candles[i - 1]!.close));
    if (i < length) {
      sum += tr;
      if (i === length - 1) prev = sum / length;
    } else {
      prev = (prev * (length - 1) + tr) / length;
    }
    if (i >= length - 1) out[i] = prev;
  }
  return out;
}

/** ta.percentile_linear_interpolation over the last `length` values (inclusive). */
function percentileLinear(values: number[], end: number, length: number, pct: number): number {
  const window = values.slice(end - length + 1, end + 1).sort((a, b) => a - b);
  const rank = (pct / 100) * (window.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return window[lo]! + (window[hi]! - window[lo]!) * (rank - lo);
}

/** Least-squares slope of the last `length` values (x increasing to the newest). */
function regressionSlope(values: number[], end: number, length: number): number {
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let k = 0; k < length; k++) {
    const y = values[end - length + 1 + k]!;
    sx += k; sy += y; sxy += k * y; sxx += k * k;
  }
  return (length * sxy - sx * sy) / (length * sxx - sx * sx);
}

/** ta.percentrank: % of the previous `length` values <= the current value. */
function percentRank(values: number[], end: number, length: number): number | null {
  if (end - length < 0) return null;
  const current = values[end]!;
  let count = 0;
  for (let k = 1; k <= length; k++) if (values[end - k]! <= current) count++;
  return (count / length) * 100;
}

type Scan = { qualified: boolean; top: number; bottom: number; length: number };

function scanWindows(candles: Candle[], atr: number[], p: RangeParams): Scan[][] {
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);
  return p.scanMultipliers.map((multiplier) => {
    const len = p.baseLength * multiplier;
    const compression = new Array<number>(candles.length).fill(99);
    const tops = new Array<number>(candles.length).fill(Number.NaN);
    const bottoms = new Array<number>(candles.length).fill(Number.NaN);
    for (let i = len - 1; i < candles.length; i++) {
      const top = percentileLinear(highs, i, len, p.bandPercentile);
      const bottom = percentileLinear(lows, i, len, 100 - p.bandPercentile);
      tops[i] = top;
      bottoms[i] = bottom;
      const a = atr[i]!;
      const height = top - bottom;
      compression[i] = Number.isFinite(a) && a > 0 && height > 0 ? height / (a * Math.sqrt(len)) : 99;
    }
    return candles.map((_, i): Scan => {
      const a = atr[i]!;
      const top = tops[i]!;
      const bottom = bottoms[i]!;
      const base = { qualified: false, top, bottom, length: len };
      if (!(Number.isFinite(a) && a > 0) || i <= len + 5 || !Number.isFinite(top)) return base;
      const spanCap = Math.max(1, Math.min(p.calibrationLength, i - p.atrLength));
      const rank = percentRank(compression, i, spanCap);
      if (rank === null || rank > p.compressionPct) return base;
      const height = top - bottom;
      const drift = height > 0 ? Math.abs(regressionSlope(closes, i, len)) * len / height : 99;
      if (drift > p.maxDrift) return base;
      const mid = (top + bottom) / 2;
      const tol = p.touchToleranceAtr * a;
      let crossings = 0, hitsTop = 0, hitsBottom = 0, contained = 0;
      for (let k = 0; k < len; k++) {
        const c = candles[i - k]!;
        const prior = candles[i - k - 1];
        if (prior && (c.close > mid) !== (prior.close > mid)) crossings++;
        if (c.high >= top - tol) hitsTop++;
        if (c.low <= bottom + tol) hitsBottom++;
        if (c.close <= top && c.close >= bottom) contained++;
      }
      const qualified = crossings >= Math.max(3, Math.round(p.minRotation * len)) &&
        hitsTop >= p.minTouches && hitsBottom >= p.minTouches &&
        contained / len >= p.minContainment;
      return { ...base, qualified };
    });
  });
}

function anchorSpan(candles: Candle[], i: number, window: number, top: number, bottom: number,
  tolerance: number, p: RangeParams): number {
  let span = window;
  const limit = Math.min(p.anchorLookback, i);
  const allowed = Math.max(2, Math.round((1 - p.minContainment) * window));
  let outside = 0;
  for (let offset = 0; offset < limit && outside <= allowed; offset++) {
    const c = candles[i - offset]!;
    const closedIn = c.close <= top && c.close >= bottom;
    const fullyIn = closedIn && c.high <= top + tolerance && c.low >= bottom - tolerance;
    if (closedIn) {
      outside = Math.max(0, outside - 1);
      if (fullyIn && offset + 1 >= window) span = offset + 1;
    } else {
      outside++;
    }
  }
  return span;
}

/** Replays the indicator over closed candles (oldest first). */
export function replayRanges(candles: Candle[], params: RangeParams = DEFAULT_RANGE_PARAMS): RangeReplay {
  const p = params;
  const atr = atrSeries(candles, p.atrLength);
  const scans = scanWindows(candles, atr, p);
  const events: RangeEvent[] = [];

  let active = false;
  let confirmed = false;
  let dormant = false;
  let top = Number.NaN;
  let bottom = Number.NaN;
  let left = 0;
  let opened = 0;
  let dormantSince = 0;
  let dormantDir: 0 | 1 | -1 = 0;
  let deviationPrice = Number.NaN;
  let cooldown = 0;

  const heightPct = () => (bottom !== 0 ? ((top - bottom) / bottom) * 100 : 0);

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    const a = atr[i]!;
    if (cooldown > 0) cooldown--;

    if (!active && !dormant && cooldown <= 0) {
      // The longest qualifying window defines the range.
      let chosen: Scan | null = null;
      for (const series of scans) if (series[i]!.qualified) chosen = series[i]!;
      if (chosen) {
        const span = anchorSpan(candles, i, chosen.length, chosen.top, chosen.bottom, p.touchToleranceAtr * a, p);
        left = i - span + 1;
        opened = i;
        top = chosen.top;
        bottom = chosen.bottom;
        active = true;
        confirmed = false;
      }
    }

    if (active) {
      const breakOffset = p.breakoutBufferAtr * a;
      const absorbOffset = p.overshootToleranceAtr * a;
      if (p.absorbOvershoot && c.close <= top && c.close >= bottom) {
        if (c.high > top && c.high <= top + absorbOffset) top = c.high;
        if (c.low < bottom && c.low >= bottom - absorbOffset) bottom = c.low;
      }
      const breakUp = c.close > top + breakOffset;
      const breakDown = c.close < bottom - breakOffset;
      if (breakUp || breakDown) {
        const direction: 1 | -1 = breakUp ? 1 : -1;
        if (confirmed) {
          events.push({
            kind: direction === 1 ? "breakout_up" : "breakout_down",
            index: i, time: c.time, sweepPrice: null, atr: a,
            range: { top, bottom, leftIndex: left, bars: i - left, heightPct: heightPct() },
          });
        }
        if (p.mergeDeviations && confirmed) {
          dormant = true;
          dormantSince = i;
          dormantDir = direction;
          deviationPrice = direction === 1 ? c.high : c.low;
        }
        active = false;
        confirmed = false;
        cooldown = p.cooldownBars;
      } else {
        confirmed = i - left + 1 >= p.minRangeBars;
      }
    }

    if (dormant) {
      if (dormantDir === 1 && c.high > deviationPrice) deviationPrice = c.high;
      if (dormantDir === -1 && c.low < deviationPrice) deviationPrice = c.low;
      const reentered = dormantDir === 1 ? c.close <= top : c.close >= bottom;
      const expired = i - dormantSince >= p.deviationWindow;
      if (reentered && i > dormantSince) {
        events.push({
          kind: dormantDir === 1 ? "deviation_bear" : "deviation_bull",
          index: i, time: c.time, sweepPrice: deviationPrice, atr: a,
          range: { top, bottom, leftIndex: left, bars: i - left + 1, heightPct: heightPct() },
        });
        active = true;
        confirmed = true;
        dormant = false;
        dormantDir = 0;
        cooldown = 0;
      } else if (expired) {
        dormant = false;
        dormantDir = 0;
      }
    }
  }

  return {
    events,
    active: active ? { top, bottom, leftIndex: left, openedIndex: opened, confirmed } : null,
    dormant: dormant && dormantDir !== 0
      ? { top, bottom, direction: dormantDir, since: dormantSince, sweepPrice: deviationPrice } : null,
    atr,
  };
}
