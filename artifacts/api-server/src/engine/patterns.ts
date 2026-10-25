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

/** Owner's base (2026-10-25): Auto Range Detector breakouts and deviations on 4h and 1d. */
export const PATTERNS: Pattern[] = [...RANGE_PATTERNS];
