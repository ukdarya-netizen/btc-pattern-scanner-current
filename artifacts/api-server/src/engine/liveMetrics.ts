/**
 * Metrics of the scanner's last successful 5m cycle, shared without an import cycle (scanner → tracker).
 * Owner 2026-11-13: every position update carries the market right now (OI, CVD, takers, funding, …) as CAB.
 */
import type { Metrics } from "./snapshot";

let latest: { metrics: Metrics; at: number } | null = null;
/** Older than this the numbers are not «now» any more and the update goes without them. */
export const LIVE_METRICS_FRESH_MS = 15 * 60_000;

export function setLiveMetrics(metrics: Metrics, at: number): void {
  latest = { metrics, at };
}
export function liveMetrics(now = Date.now()): Metrics | null {
  return latest && now - latest.at <= LIVE_METRICS_FRESH_MS ? latest.metrics : null;
}
