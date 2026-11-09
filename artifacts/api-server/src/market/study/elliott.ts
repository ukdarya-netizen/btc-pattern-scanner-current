/**
 * Objective part of Elliott (owner 2026-11-05): how many waves the decline into the order block had
 * before a long (shorts: the rise, on mirrored candles). A 3-wave move (A-B-C) is a correction —
 * a reversal is expected after it; a 5-wave move is an impulse — the trend tends to go on.
 * Counted on closed 1H candles with a zigzag: a swing is confirmed when price reverses by at least
 * 2 × ATR(14) from the last extreme. Start = the highest high of the 120 bars before the entry;
 * end = the lowest low after it (up to the entry candle). Rules fixed up front, not tuned.
 * Pure. Observation only — no decision reads it.
 */
export type Bar = { time: number; open: number; high: number; low: number; close: number };

const LOOKBACK = 120;
const ATR_N = 14;
const ZZ_ATR = 2;

function atr(bars: Bar[], end: number): number | null {
  if (end < ATR_N) return null;
  let s = 0;
  for (let k = end - ATR_N + 1; k <= end; k++) {
    const b = bars[k]!, p = bars[k - 1]!;
    s += Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
  }
  return s / ATR_N;
}

export function countDeclineWaves(bars: Bar[], entryIdx: number) {
  const empty = { legs: null, structure: "unknown", rulesOk: null, depthPct: null, bars: null, cToA: null } as const;
  const a = atr(bars, entryIdx);
  if (a === null || entryIdx < LOOKBACK) return { ...empty, reason: "short_history" };
  const from = entryIdx - LOOKBACK + 1;
  let hi = from;
  for (let i = from; i <= entryIdx; i++) if (bars[i]!.high > bars[hi]!.high) hi = i;
  let lo = hi;
  for (let i = hi; i <= entryIdx; i++) if (bars[i]!.low < bars[lo]!.low) lo = i;
  if (lo === hi) return { ...empty, reason: "no_decline" };
  const th = ZZ_ATR * a;
  // Zigzag from the high down to the low: alternating pivots (price, index).
  const piv: { p: number; i: number }[] = [{ p: bars[hi]!.high, i: hi }];
  let dir: "down" | "up" = "down";
  let ext = { p: bars[hi]!.low, i: hi };
  for (let i = hi + 1; i <= lo; i++) {
    const b = bars[i]!;
    if (dir === "down") {
      if (b.low < ext.p) ext = { p: b.low, i };
      else if (b.high - ext.p >= th) { piv.push(ext); dir = "up"; ext = { p: b.high, i }; }
    } else {
      if (b.high > ext.p) ext = { p: b.high, i };
      else if (ext.p - b.low >= th) { piv.push(ext); dir = "down"; ext = { p: b.low, i }; }
    }
  }
  // The decline ends at the lowest low.
  if (piv[piv.length - 1]!.i !== lo) {
    if (dir === "up") piv.push(ext); // an unconfirmed bounce before the final low
    piv.push({ p: bars[lo]!.low, i: lo });
  }
  // Keep alternation clean (a down leg must end lower, an up leg higher).
  const legs = piv.length - 1;
  const len = (k: number) => Math.abs(piv[k + 1]!.p - piv[k]!.p);
  let rulesOk: boolean | null = null;
  let cToA: number | null = null;
  if (legs === 3) {
    // A-B-C: B does not retrace beyond the start of A.
    rulesOk = piv[2]!.p < piv[0]!.p;
    cToA = len(2) / len(0);
  } else if (legs === 5) {
    // Impulse down: wave 3 not the shortest of 1/3/5; wave 4 high stays below wave 1 low; wave 2 below start.
    const w1 = len(0), w3 = len(2), w5 = len(4);
    rulesOk = !(w3 < w1 && w3 < w5) && piv[4]!.p < piv[1]!.p && piv[2]!.p < piv[0]!.p;
  }
  const structure =
    legs === 1 ? "single_leg" : legs === 3 ? "abc_correction" : legs === 5 ? "five_wave_impulse" : legs % 2 === 1 ? `complex_${legs}` : `even_${legs}`;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  return {
    legs,
    structure,
    rulesOk,
    depthPct: r2(((bars[hi]!.high - bars[lo]!.low) / bars[hi]!.high) * 100),
    bars: lo - hi,
    barsSinceLow: entryIdx - lo,
    cToA: cToA === null ? null : r2(cToA),
    zigzagAtr: ZZ_ATR,
    reason: null,
  };
}
