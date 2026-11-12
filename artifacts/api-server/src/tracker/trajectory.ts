/**
 * Signal trajectory (owner 2026-11-12, as CAB signal_trajectory_log + exit metrics): for every signal (channel and
 * shadow) the state of the trade and the full market metric set at fixed points after the entry — 15m, 30m, 1h, 2h,
 * 4h, 8h, 12h, 24h, 48h, 72h, then every 24 h while open — and once at the close. For fitting the patterns later.
 * Written by the 5m scanner cycle from its fresh metrics into btc_signals.metrics.trajectory (no schema change).
 * A point is taken only within 15 minutes after its time (a restart gap is left empty, never back-filled with
 * later data); every point keeps the real elapsed time. The market itself is also kept every 5 minutes in
 * btc_market_snapshots (the signal path on the dashboard).
 */
import { pool } from "@workspace/db";
import type { Metrics } from "../engine/snapshot";
import { logger } from "../lib/logger";

const M = 60_000, H = 60 * M, D = 24 * H;
const FIXED: Array<[string, number]> = [
  ["15m", 15 * M], ["30m", 30 * M], ["1h", H], ["2h", 2 * H], ["4h", 4 * H], ["8h", 8 * H], ["12h", 12 * H],
  ["24h", D], ["48h", 2 * D], ["72h", 3 * D],
];
export const POINT_WINDOW_MS = 15 * M;

/** Points due at `elapsed` ms after the entry: the fixed ones, then every 24 h (96h, 120h, …). */
export function duePoint(elapsed: number): string | null {
  for (const [label, at] of FIXED) if (elapsed >= at && elapsed < at + POINT_WINDOW_MS) return label;
  if (elapsed >= 4 * D) {
    const days = Math.floor(elapsed / D);
    if (elapsed - days * D < POINT_WINDOW_MS) return `${days * 24}h`;
  }
  return null;
}

type Row = {
  id: number; direction: string; entryPrice: number; detectedAt: Date; status: string; closedAt: Date | null;
  exitPrice: number | null; stopPrice: number; breakevenMoved: boolean; remainingFraction: number;
  mfePct: number; maePct: number; pnlPricePct: number | null; closeReason: string | null; keys: string[];
};

/** The market set without the bulky heatmap maps (the top clusters stay). */
function marketOf(m: Metrics): Record<string, unknown> {
  const { context, ...rest } = m;
  const heatmap = context?.heatmap ? { topAbove: context.heatmap.topAbove, topBelow: context.heatmap.topBelow, aboveBelowRatio5pct: context.heatmap.aboveBelowRatio5pct } : null;
  return { ...rest, context: context ? { ...context, heatmap } : null };
}

export function trajectoryPoint(r: Row, m: Metrics, now: number, label: string): Record<string, unknown> {
  const dir = r.direction === "long" ? 1 : -1;
  const price = label === "close" && r.exitPrice != null ? r.exitPrice : m.price;
  return {
    label, at: new Date(now).toISOString(), elapsedMs: now - r.detectedAt.getTime(),
    price, pctFromEntry: Number((((price - r.entryPrice) / r.entryPrice) * 100 * dir).toFixed(4)),
    peakPct: r.mfePct, worstPct: r.maePct, status: r.status, stopPrice: r.stopPrice, breakevenMoved: r.breakevenMoved,
    remainingFraction: r.remainingFraction,
    ...(label === "close" ? { closeReason: r.closeReason, pnlPricePct: r.pnlPricePct, closedAt: r.closedAt?.toISOString() ?? null } : {}),
    market: marketOf(m),
  };
}

/** Every 5m cycle, after fresh metrics: due points of open signals and the close point of just-closed ones. */
export async function recordTrajectory(m: Metrics, now = Date.now()): Promise<void> {
  const { rows } = await pool.query<Row>(`
    SELECT id, direction, entry_price AS "entryPrice", detected_at AS "detectedAt", status, closed_at AS "closedAt",
           exit_price AS "exitPrice", stop_price AS "stopPrice", breakeven_moved AS "breakevenMoved",
           remaining_fraction AS "remainingFraction", mfe_pct AS "mfePct", mae_pct AS "maePct",
           pnl_price_pct AS "pnlPricePct", close_reason AS "closeReason",
           coalesce(array(SELECT jsonb_object_keys(coalesce(metrics->'trajectory', '{}'::jsonb))), '{}') AS keys
    FROM btc_signals
    WHERE status = 'open' OR (closed_at > $1 AND NOT coalesce(metrics->'trajectory', '{}'::jsonb) ? 'close')`,
  [new Date(now - POINT_WINDOW_MS)]);
  for (const r of rows) {
    const label = r.status === "open" ? duePoint(now - r.detectedAt.getTime()) : "close";
    if (!label || r.keys.includes(label)) continue;
    try {
      await pool.query(`
        UPDATE btc_signals
        SET metrics = coalesce(metrics, '{}'::jsonb)
          || jsonb_build_object('trajectory', coalesce(metrics->'trajectory', '{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb))
        WHERE id = $1 AND NOT coalesce(metrics->'trajectory', '{}'::jsonb) ? $2`,
      [r.id, label, JSON.stringify(trajectoryPoint(r, m, now, label))]);
    } catch (err) {
      logger.warn({ err, signalId: r.id, label }, "trajectory point not written");
    }
  }
}
