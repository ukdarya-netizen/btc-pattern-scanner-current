import type { Direction, TargetSpec } from "../config/profiles";

export type OutcomeCandle = { openTime: number; high: number; low: number };
export type OutcomeLabel =
  | "target_first" // first target touched before the stop
  | "stop_first" // stop touched first (or both inside one candle)
  | "timeout" // neither within the profile's max hold
  | "pending"; // max hold not elapsed yet and nothing touched

/**
 * Order-aware first-touch label (AltBullet lesson: peak and trough without
 * order overstate "missed champions"). Candles strictly after the decision;
 * a candle touching both levels counts as the stop (order unknown).
 */
export function firstTouch(input: {
  direction: Direction;
  entry: number;
  stopPct: number;
  target: TargetSpec;
  decidedAt: number;
  maxHoldMs: number;
  candles: OutcomeCandle[];
  intervalMs: number;
  now: number;
}): { label: OutcomeLabel; at: number | null; mfePct: number; maePct: number } {
  const { direction, entry, stopPct, target } = input;
  const long = direction === "long";
  const stop = long ? entry * (1 - stopPct / 100) : entry * (1 + stopPct / 100);
  const goal = long ? entry * (1 + target.pct / 100) : entry * (1 - target.pct / 100);
  const until = input.decidedAt + input.maxHoldMs;
  let mfe = 0;
  let mae = 0;
  for (const c of input.candles) {
    if (c.openTime < input.decidedAt || c.openTime >= until) continue;
    const fav = long ? ((c.high - entry) / entry) * 100 : ((entry - c.low) / entry) * 100;
    const adv = long ? ((c.low - entry) / entry) * 100 : ((entry - c.high) / entry) * 100;
    mfe = Math.max(mfe, fav);
    mae = Math.min(mae, adv);
    const hitStop = long ? c.low <= stop : c.high >= stop;
    const hitGoal = long ? c.high >= goal : c.low <= goal;
    const at = c.openTime + input.intervalMs;
    if (hitStop) return { label: "stop_first", at, mfePct: mfe, maePct: mae };
    if (hitGoal) return { label: "target_first", at, mfePct: mfe, maePct: mae };
  }
  return { label: input.now >= until ? "timeout" : "pending", at: null, mfePct: mfe, maePct: mae };
}
