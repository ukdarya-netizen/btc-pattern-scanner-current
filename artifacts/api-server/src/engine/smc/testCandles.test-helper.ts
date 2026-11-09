import type { Candle } from "./candles";

/** Candles from a list of closes: open = previous close, wick 0.1% beyond the body. */
export function candlesFromCloses(closes: number[], startTime: number, spanMs: number, wickPct = 0.001): Candle[] {
  const out: Candle[] = [];
  let prev = closes[0];
  closes.forEach((c, i) => {
    const o = prev;
    out.push({ t: startTime + i * spanMs, o, h: Math.max(o, c) * (1 + wickPct), l: Math.min(o, c) * (1 - wickPct), c });
    prev = c;
  });
  return out;
}

/** Linear path through the given points, `steps` bars per segment. */
export function path(points: Array<[number, number]>, start: number): number[] {
  const out: number[] = [start];
  let from = start;
  for (const [to, steps] of points) {
    for (let i = 1; i <= steps; i++) out.push(from + ((to - from) * i) / steps);
    from = to;
  }
  return out;
}
