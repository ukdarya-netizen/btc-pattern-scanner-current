import type { Candle } from "../market/bingx";

const STEP = 4 * 60 * 60_000;
/** Far above the volatile history, so the quiet section forms its own range. */
export const RANGE_MID = 140;

/** Volatile history, then a tight range, then `tail` bars supplied by the test. */
export function rangeScenario(tail: Array<Partial<Candle> & { close: number }>): Candle[] {
  let seed = 11;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const out: Candle[] = [];
  let prev = 100;
  for (let i = 0; i < 400; i++) {
    const close = 100 + 15 * Math.sin(i / 7) + (rnd() - 0.5) * 6;
    out.push({ time: i * STEP, open: prev, high: Math.max(prev, close) + 1 + rnd() * 2,
      low: Math.min(prev, close) - 1 - rnd() * 2, close, volume: 100 });
    prev = close;
  }
  for (let i = 0; i < 120; i++) {
    const close = RANGE_MID + Math.sin(i * Math.PI / 4) * 1;
    out.push({ time: out.length * STEP, open: prev, high: Math.max(prev, close) + 0.2,
      low: Math.min(prev, close) - 0.2, close, volume: 100 });
    prev = close;
  }
  for (const bar of tail) {
    out.push({ time: out.length * STEP, open: prev, high: Math.max(prev, bar.close) + 0.2,
      low: Math.min(prev, bar.close) - 0.2, volume: 100, ...bar });
    prev = bar.close;
  }
  return out;
}
