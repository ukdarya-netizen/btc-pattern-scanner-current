import type { Direction, ProfileKey, TargetSpec } from "../config/profiles";
import type { Snapshot } from "./snapshot";

export type PatternResult = {
  fires: boolean;
  /** Why it did or did not fire (each failed condition, or "ok"). */
  reasons: string[];
  /** Optional per-signal overrides; validated against the liquidation guard. */
  stopPct?: number;
  targets?: TargetSpec[];
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

/**
 * The pattern set is filled in after the BTC history analysis (owner choice:
 * patterns are proposed from data and approved before going live). Until then
 * the engine runs, records metrics and tracks nothing.
 */
export const PATTERNS: Pattern[] = [];
