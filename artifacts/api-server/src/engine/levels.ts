import { maxStopPct } from "../lib/tradeMath";
import type { PatternResult } from "./patterns";

/**
 * Converts structure levels to the live entry. Returns a refusal reason when
 * the entry is already beyond the stop or at/after the first target, or when
 * the stop is farther than the liquidation guard allows.
 */
export function levelsAtEntry(
  entry: number, direction: "long" | "short", leverage: number,
  levels: NonNullable<PatternResult["levels"]>,
): { stopPrice: number; stopPct: number; targets: { price: number; fraction: number; hitAt: null }[] } | { refused: string } {
  const s = direction === "long" ? 1 : -1;
  if (!(entry > 0)) return { refused: "entry_unavailable" };
  if ((entry - levels.stop) * s <= 0) return { refused: "entry_beyond_stop" };
  const targets = [...levels.targets].sort((a, b) => (a.price - b.price) * s);
  if (!targets.length || (targets[0]!.price - entry) * s <= 0) return { refused: "entry_past_first_target" };
  const total = targets.reduce((sum, t) => sum + t.fraction, 0);
  if (Math.abs(total - 1) > 1e-9) return { refused: "target_fractions_invalid" };
  const stopPct = Math.abs(entry - levels.stop) / entry * 100;
  if (stopPct >= maxStopPct(leverage)) return { refused: "liquidation_guard" };
  return { stopPrice: levels.stop, stopPct, targets: targets.map((t) => ({ ...t, hitAt: null })) };
}
