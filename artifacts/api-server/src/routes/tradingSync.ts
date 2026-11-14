/**
 * Position sync for Lucy's Trading Bot (owner 2026-11-14, as CAB / Nihilist): every Bitcoin MM signal the bot
 * received, with its current state, so the bot can reconcile what to hold and what to close even if a command was
 * missed. Header x-trading-token = BTC_TRADING_TOKEN. Pages by signal id (?afterId=), 200 per page.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { sourceSignalId } from "../trading/messages";
import { tradingToken } from "../trading/relay";

const PAGE = 200;
export function tokenMatches(given: string | undefined, expected: string | null): boolean {
  if (!given || !expected) return false;
  return timingSafeEqual(createHash("sha256").update(given).digest(), createHash("sha256").update(expected).digest());
}

type Row = {
  id: number; direction: string; status: string; close_reason: string | null; detected_at: Date; closed_at: Date | null;
  entry_price: number; initial_stop_price: number; stop_price: number; exit_price: number | null; pnl_price_pct: number | null;
  mfe_pct: number | null; breakeven_moved: boolean; remaining_fraction: number; delivered_at: Date;
};

const router: IRouter = Router();
router.get("/trading/position-sync", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const expected = tradingToken();
  if (!expected) { res.status(503).json({ error: "trading_bot_access_not_configured" }); return; }
  if (!tokenMatches(req.get("x-trading-token"), expected)) { res.status(401).json({ error: "unauthorized" }); return; }
  const raw = req.query.afterId;
  if (raw !== undefined && (typeof raw !== "string" || !/^(0|[1-9]\d{0,9})$/.test(raw))) { res.status(400).json({ error: "invalid_after_id" }); return; }
  try {
    // Only signals whose entry the bot stored (the relay delivered at least the signal message).
    const { rows } = await pool.query<Row>(
      `SELECT s.id, s.direction, s.status, s.close_reason, s.detected_at, s.closed_at, s.entry_price, s.initial_stop_price,
              s.stop_price, s.exit_price, s.pnl_price_pct, s.mfe_pct, s.breakeven_moved, s.remaining_fraction, e.created_at AS delivered_at
         FROM btc_signals s JOIN btc_signal_events e ON e.signal_id = s.id AND e.kind = 'opened'
        WHERE s.live AND COALESCE((e.detail->'trading'->>'sent')::int, 0) >= 1 AND s.id > $1
        ORDER BY s.id LIMIT $2`,
      [raw === undefined ? 0 : Number(raw), PAGE + 1],
    );
    const page = rows.slice(0, PAGE);
    res.json({
      asOf: new Date().toISOString(),
      positions: page.map((r) => ({
        sourceSignalId: sourceSignalId(r.id),
        symbol: "BTCUSDT",
        side: r.direction,
        signalAt: r.detected_at.toISOString(),
        initialStopPrice: r.initial_stop_price,
        sourceStatus: r.status === "open" ? (r.breakeven_moved ? "breakeven" : "active") : r.close_reason ?? "closed",
        sourceAction: r.status === "open" ? "hold" : r.closed_at ? "close" : "review",
        sourceClosedAt: r.closed_at?.toISOString() ?? null,
        sourceEntryPrice: r.entry_price,
        sourceStopLossPrice: r.stop_price,
        sourceRemainingFraction: r.remaining_fraction,
        sourceExitPrice: r.exit_price,
        sourcePnlPercent: r.pnl_price_pct,
        sourcePeakPct: r.mfe_pct,
      })),
      nextAfterId: rows.length > PAGE ? page[page.length - 1]!.id : null,
    });
  } catch {
    res.status(503).json({ error: "position_sync_unavailable" });
  }
});

export default router;
