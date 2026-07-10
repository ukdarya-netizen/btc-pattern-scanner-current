import type { OhlcvBar } from "./coinalyzeData";

// Pure price-action technical analysis: horizontal support/resistance levels and
// descending trendlines, built from hourly candles aggregated out of the 5-minute
// bars the scanner already has in memory. No volume, no extra API calls.

export interface HourlyBar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface BreakoutResult {
  broken: boolean;
  reason: string;
}

const BARS_PER_HOUR = 12; // 5m bars per 1h candle
const SWING_LOOKBACK = 2; // bars on each side to confirm a pivot
const UNCONFIRMED_TAIL = 2; // most recent hourly bars can't be confirmed pivots yet
const LEVEL_TOLERANCE_PCT = 0.6; // cluster tolerance for horizontal levels
const MIN_TOUCHES = 2;
const BREAKOUT_BUFFER_PCT = 0.15; // close must clear the level by this margin
const MIN_TRENDLINE_SPAN = 6; // hourly bars between the two pivots used for a trendline

export function aggregateToHourly(bars: OhlcvBar[]): HourlyBar[] {
  const hourly: HourlyBar[] = [];
  for (let i = 0; i + BARS_PER_HOUR <= bars.length; i += BARS_PER_HOUR) {
    const group = bars.slice(i, i + BARS_PER_HOUR);
    if (group.length === 0) continue;
    hourly.push({
      t: group[0]!.t,
      o: group[0]!.o,
      h: Math.max(...group.map((b) => b.h)),
      l: Math.min(...group.map((b) => b.l)),
      c: group[group.length - 1]!.c,
    });
  }
  return hourly;
}

interface Pivot {
  index: number;
  price: number;
}

function findPivotHighs(bars: HourlyBar[]): Pivot[] {
  const pivots: Pivot[] = [];
  const lastConfirmable = bars.length - 1 - UNCONFIRMED_TAIL;
  for (let i = SWING_LOOKBACK; i <= lastConfirmable; i++) {
    const window = bars.slice(i - SWING_LOOKBACK, i + SWING_LOOKBACK + 1);
    const isHigh = window.every((b, idx) => idx === SWING_LOOKBACK || b.h <= bars[i]!.h);
    if (isHigh) pivots.push({ index: i, price: bars[i]!.h });
  }
  return pivots;
}

function findPivotLows(bars: HourlyBar[]): Pivot[] {
  const pivots: Pivot[] = [];
  const lastConfirmable = bars.length - 1 - UNCONFIRMED_TAIL;
  for (let i = SWING_LOOKBACK; i <= lastConfirmable; i++) {
    const window = bars.slice(i - SWING_LOOKBACK, i + SWING_LOOKBACK + 1);
    const isLow = window.every((b, idx) => idx === SWING_LOOKBACK || b.l >= bars[i]!.l);
    if (isLow) pivots.push({ index: i, price: bars[i]!.l });
  }
  return pivots;
}

interface Level {
  price: number;
  touches: number;
}

function clusterLevels(pivots: Pivot[]): Level[] {
  const sorted = [...pivots].sort((a, b) => a.price - b.price);
  const clusters: { prices: number[] }[] = [];
  for (const p of sorted) {
    const last = clusters[clusters.length - 1];
    if (last) {
      const clusterAvg = last.prices.reduce((a, b) => a + b, 0) / last.prices.length;
      if (Math.abs(p.price - clusterAvg) / clusterAvg <= LEVEL_TOLERANCE_PCT / 100) {
        last.prices.push(p.price);
        continue;
      }
    }
    clusters.push({ prices: [p.price] });
  }
  return clusters
    .map((c) => ({
      price: c.prices.reduce((a, b) => a + b, 0) / c.prices.length,
      touches: c.prices.length,
    }))
    .filter((l) => l.touches >= MIN_TOUCHES);
}

// Bullish breakout of a horizontal resistance zone: the last completed hourly candle
// closes above a level that previously capped price (>= MIN_TOUCHES), while the candle
// before it was still at/below the level (i.e. a fresh cross, not an old, stale break).
export function checkResistanceBreakout(bars: OhlcvBar[]): BreakoutResult {
  const hourly = aggregateToHourly(bars);
  if (hourly.length < SWING_LOOKBACK * 2 + UNCONFIRMED_TAIL + 3) return { broken: false, reason: "" };

  const levels = clusterLevels(findPivotHighs(hourly));
  if (levels.length === 0) return { broken: false, reason: "" };

  const curr = hourly[hourly.length - 1]!;
  const prev = hourly[hourly.length - 2]!;

  for (const level of levels) {
    if (level.price <= prev.c || level.price <= curr.c * (1 - 0.5 / 100)) continue; // level must sit above prev close
    const clearedBy = ((curr.c - level.price) / level.price) * 100;
    if (prev.c <= level.price && curr.c > level.price * (1 + BREAKOUT_BUFFER_PCT / 100)) {
      return {
        broken: true,
        reason: `пробой уровня сопротивления ${level.price.toFixed(6)} (${level.touches} касаний), close=${curr.c.toFixed(6)} (+${clearedBy.toFixed(2)}%)`,
      };
    }
  }
  return { broken: false, reason: "" };
}

// Bullish breakout of a descending resistance trendline drawn through two lower pivot
// highs. Classic "line gets broken to the upside" pattern.
export function checkTrendlineBreakout(bars: OhlcvBar[]): BreakoutResult {
  const hourly = aggregateToHourly(bars);
  if (hourly.length < SWING_LOOKBACK * 2 + UNCONFIRMED_TAIL + MIN_TRENDLINE_SPAN) {
    return { broken: false, reason: "" };
  }

  const pivots = findPivotHighs(hourly);
  if (pivots.length < 2) return { broken: false, reason: "" };

  const curr = hourly[hourly.length - 1]!;
  const prev = hourly[hourly.length - 2]!;
  const currIndex = hourly.length - 1;
  const prevIndex = hourly.length - 2;

  // Try recent pivot pairs (most recent first) that form a descending line (lower highs).
  for (let i = pivots.length - 1; i >= 1; i--) {
    const p2 = pivots[i]!;
    for (let j = i - 1; j >= 0; j--) {
      const p1 = pivots[j]!;
      if (p2.index - p1.index < MIN_TRENDLINE_SPAN) continue;
      if (p2.price >= p1.price) continue; // must be descending (lower high)

      const slope = (p2.price - p1.price) / (p2.index - p1.index);
      const lineAt = (idx: number) => p1.price + slope * (idx - p1.index);

      // The line must not have been meaningfully violated between the two pivots.
      const between = hourly.slice(p1.index, p2.index + 1);
      const violated = between.some((b, k) => b.h > lineAt(p1.index + k) * (1 + 0.5 / 100));
      if (violated) continue;

      const prevLine = lineAt(prevIndex);
      const currLine = lineAt(currIndex);
      if (prev.c <= prevLine && curr.c > currLine * (1 + BREAKOUT_BUFFER_PCT / 100)) {
        const clearedBy = ((curr.c - currLine) / currLine) * 100;
        return {
          broken: true,
          reason: `пробой нисходящей трендлинии (пивоты ${p1.price.toFixed(6)}→${p2.price.toFixed(6)}), close=${curr.c.toFixed(6)} (+${clearedBy.toFixed(2)}%)`,
        };
      }
    }
  }
  return { broken: false, reason: "" };
}
