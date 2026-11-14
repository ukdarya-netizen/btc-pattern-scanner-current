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
import { FAMILIES, LADDERS, FEE_PCT, familyOf, simulate, type Candle } from "../trading/ladders";
import { PATTERNS } from "../engine/patterns";

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

/**
 * Virtual panel for Lucy's Trading Bot (owner 2026-11-14: «решим в январе»): every Bitcoin MM signal led each way of
 * trading/ladders.ts, by pattern family and side. Price %, fees included; no leverage (Lucy's bot multiplies by
 * the user's). Pending = the way has not finished yet. Cached 5 minutes.
 */
let reportCache: { at: number; body: unknown } | null = null;
async function strategyReport(): Promise<unknown> {
  if (reportCache && Date.now() - reportCache.at < 5 * 60_000) return reportCache.body;
  const { rows: sigs } = await pool.query<{ id: number; pattern_key: string; direction: "long" | "short"; entry_price: number;
    initial_stop_price: number; targets: Array<{ price: number; fraction: number }>; detected_at: Date; expires_at: Date }>(
    "SELECT id, pattern_key, direction, entry_price, initial_stop_price, targets, detected_at, expires_at FROM btc_signals ORDER BY id");
  const now = Date.now();
  const offKeys = new Set(PATTERNS.filter((p) => p.off).map((p) => p.key));
  type Cell = { n: number; pending: number; wins: number; losses: number; breakeven: number; sumPct: number; best: number | null; worst: number | null };
  const groups = new Map<string, { family: string; side: string; signals: number; firstAt: string; lastAt: string; ways: Record<string, Cell> }>();
  for (const s of sigs) {
    const family = familyOf(s.pattern_key);
    if (!family || offKeys.has(s.pattern_key)) continue;
    const { rows } = await pool.query<{ t: Date; h: number; l: number; c: number }>(
      `SELECT open_time AS t, high AS h, low AS l, close AS c FROM btc_candles
        WHERE interval = '15m' AND open_time >= $1 AND open_time <= $2 ORDER BY open_time`,
      [s.detected_at, new Date(s.expires_at.getTime() + 15 * 60_000)]);
    const candles: Candle[] = rows.map((r) => ({ t: r.t.getTime(), h: r.h, l: r.l, c: r.c }));
    const key = `${family}|${s.direction}`;
    const g = groups.get(key) ?? { family, side: s.direction, signals: 0, firstAt: s.detected_at.toISOString(), lastAt: s.detected_at.toISOString(), ways: {} };
    g.signals += 1; g.lastAt = s.detected_at.toISOString();
    for (const way of LADDERS) {
      const r = simulate({ side: s.direction, entry: s.entry_price, stop: s.initial_stop_price, startAt: s.detected_at.getTime(),
        endAt: s.expires_at.getTime(), candles, steps: way.steps(s.targets), now });
      const c = g.ways[way.id] ??= { n: 0, pending: 0, wins: 0, losses: 0, breakeven: 0, sumPct: 0, best: null, worst: null };
      if (!r.done) { c.pending += 1; continue; }
      c.n += 1; c.sumPct += r.pct;
      if (r.exit === "breakeven") c.breakeven += 1; else if (r.pct > 0) c.wins += 1; else c.losses += 1;
      c.best = c.best === null ? r.pct : Math.max(c.best, r.pct); c.worst = c.worst === null ? r.pct : Math.min(c.worst, r.pct);
    }
    groups.set(key, g);
  }
  const body = {
    asOf: new Date(now).toISOString(), feePct: FEE_PCT, candles: "15m",
    ways: LADDERS.map(({ id, label }) => ({ id, label })),
    families: FAMILIES.map(({ id, label }) => ({ id, label, patterns: PATTERNS.filter((p) => !p.off && familyOf(p.key) === id).map((p) => ({ key: p.key, side: p.direction })) })),
    groups: [...groups.values()],
  };
  reportCache = { at: now, body };
  return body;
}
router.get("/trading/strategy-report", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const expected = tradingToken();
  if (!expected) { res.status(503).json({ error: "trading_bot_access_not_configured" }); return; }
  if (!tokenMatches(req.get("x-trading-token"), expected)) { res.status(401).json({ error: "unauthorized" }); return; }
  try { res.json(await strategyReport()); } catch { res.status(503).json({ error: "strategy_report_unavailable" }); }
});

export default router;
