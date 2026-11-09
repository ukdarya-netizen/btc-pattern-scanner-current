/**
 * Candle shape of the Smart Money engine (ported 1:1 from Crypto Nihilist, owner 2026-11-09).
 * BTC bot candles ({time, open, high, low, close, volume}) are converted with fromBtc().
 */
import type { Candle as BtcCandle } from "../../market/bingx";

export type Candle = {
  /** Bar open time, ms UTC. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
};

export type Interval = "15m" | "30m" | "1h" | "4h" | "1d";

export const INTERVAL_MS: Record<Interval, number> = {
  "15m": 15 * 60_000,
  "30m": 30 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
};

export const fromBtc = (cs: BtcCandle[]): Candle[] => cs.map((c) => ({ t: c.time, o: c.open, h: c.high, l: c.low, c: c.close }));

/** 30m bars from closed 15m bars (both halves present). */
export function to30m(cs15: BtcCandle[]): BtcCandle[] {
  const out: BtcCandle[] = [];
  for (let i = 0; i + 1 < cs15.length; i++) {
    const a = cs15[i]!, b = cs15[i + 1]!;
    if (a.time % INTERVAL_MS["30m"] !== 0 || b.time !== a.time + INTERVAL_MS["15m"]) continue;
    out.push({ time: a.time, open: a.open, high: Math.max(a.high, b.high), low: Math.min(a.low, b.low), close: b.close, volume: a.volume + b.volume });
    i++;
  }
  return out;
}
