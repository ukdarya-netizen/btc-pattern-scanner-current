import type { Direction, ProfileKey, TargetSpec } from "../config/profiles";
import type { Snapshot } from "./snapshot";

export type PatternResult = {
  fires: boolean;
  /** Why it did or did not fire (each failed condition, or "ok"). */
  reasons: string[];
  /** Optional per-signal overrides; validated against the liquidation guard. */
  stopPct?: number;
  targets?: TargetSpec[];
  /**
   * Absolute levels from the market structure (e.g. a range). Converted to
   * the live entry at fire time; a signal whose entry is already past its
   * first target or beyond its stop is not opened.
   */
  levels?: { stop: number; targets: { price: number; fraction: number }[] };
  /** Extra decision metrics specific to this pattern. */
  detail?: Record<string, unknown>;
};

export type Pattern = {
  key: string;
  label: string;
  direction: Direction;
  profile: ProfileKey;
  /** Only patterns explicitly enabled can publish to the channel. */
  live: boolean;
  /**
   * Timeframe whose closed bar triggers the evaluation (owner 2026-11-09: Smart Money on 30m / 1h structure
   * breaks, liquidation cascade on 15m). Default: the profile's timeframe.
   */
  evalTf?: "15m" | "30m" | "1h";
  evaluate: (snapshot: Snapshot) => PatternResult;
};

/** Helper: collect failed conditions; a null input is its own failure. */
export function check(conditions: Array<[string, boolean | null]>): PatternResult {
  const reasons = conditions
    .filter(([, ok]) => ok !== true)
    .map(([name, ok]) => (ok === null ? `${name}:no_data` : name));
  return { fires: reasons.length === 0, reasons: reasons.length ? reasons : ["ok"] };
}

import { RANGE_PATTERNS } from "./rangePatterns";
import { SMC_PATTERNS } from "./smcPatterns";
import { LIQ_CASCADE_PATTERNS } from "./liqCascade";
import { NEON_PATTERNS } from "./neonPatterns";

/**
 * Owner's base (2026-10-25): Auto Range Detector breakouts and deviations on 4h and 1d.
 * Owner 2026-11-09: + Smart Money (Crypto Nihilist method) and liquidation cascade (CAB method), live.
 * Owner 2026-11-12: + ABNeon bounce and Stealth level breakout (CAB), 15m / 1h / 4h, both sides — live since 2026-11-13.
 */
export const PATTERNS: Pattern[] = [...RANGE_PATTERNS, ...SMC_PATTERNS, ...LIQ_CASCADE_PATTERNS, ...NEON_PATTERNS];
