import { Router } from "express";
import { db, btcDecisionsTable, btcMarketSnapshotsTable, btcSignalsTable } from "@workspace/db";
import { and, desc, eq, gte, lte } from "drizzle-orm";
import { PROFILES } from "../config/profiles";
import { PATTERNS } from "../engine/patterns";
import { scannerStatus } from "../engine/scanner";
import { getDailyStats, getStats } from "../stats/stats";
import { openSignalCount } from "../tracker/tracker";
import { engineHealth } from "../engine/runtime";
import { logger } from "../lib/logger";
import { healthSnapshot } from "../lib/apiHealth";
import { candleCoverage, decisionOutcomes } from "../analysis/candleStore";
import { coinglassGovernorStats } from "../market/coinglass";

const router = Router();
const clampLimit = (raw: unknown, max = 500) => Math.min(Math.max(Number(raw) || 100, 1), max);

router.get("/btc/status", (_req, res) => {
  res.json({
    scanner: scannerStatus,
    stream: engineHealth(),
    apis: healthSnapshot(),
    coinglass: coinglassGovernorStats(),
    openSignals: openSignalCount(),
    patterns: PATTERNS.map((p) => ({ key: p.key, label: p.label, direction: p.direction, profile: p.profile, live: p.live })),
    profiles: PROFILES,
  });
});

router.get("/btc/stats", async (req, res) => {
  try {
    res.json({ rows: await getStats(Number(req.query.days) || undefined) });
  } catch (err) {
    logger.error({ err }, "btc stats failed");
    res.status(500).json({ error: "stats_failed" });
  }
});

router.get("/btc/stats/daily", async (req, res) => {
  try {
    res.json({ rows: await getDailyStats(Math.min(Math.max(Number(req.query.days) || 30, 1), 365)) });
  } catch (err) {
    logger.error({ err }, "daily stats failed");
    res.status(500).json({ error: "daily_stats_failed" });
  }
});

router.get("/btc/signals", async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : null;
  const rows = await db.select().from(btcSignalsTable)
    .where(status ? eq(btcSignalsTable.status, status) : undefined)
    .orderBy(desc(btcSignalsTable.id))
    .limit(clampLimit(req.query.limit));
  res.json({ rows });
});

router.get("/btc/decisions", async (req, res) => {
  const pattern = typeof req.query.pattern === "string" ? req.query.pattern : null;
  const decision = typeof req.query.decision === "string" ? req.query.decision : null;
  const rows = await db.select().from(btcDecisionsTable)
    .where(and(
      pattern ? eq(btcDecisionsTable.patternKey, pattern) : undefined,
      decision ? eq(btcDecisionsTable.decision, decision) : undefined,
    ))
    .orderBy(desc(btcDecisionsTable.id))
    .limit(clampLimit(req.query.limit, 2000));
  res.json({ rows });
});

/** First-touch outcome (first target vs stop) of every decision, grouped. */
router.get("/btc/decisions/outcomes", async (req, res) => {
  try {
    const days = Math.min(Math.max(Number(req.query.days) || 7, 1), 60);
    const pattern = typeof req.query.pattern === "string" ? req.query.pattern : undefined;
    res.json({ days, groups: await decisionOutcomes(days, pattern), candles: await candleCoverage() });
  } catch (err) {
    logger.error({ err }, "decision outcomes failed");
    res.status(500).json({ error: "outcomes_failed" });
  }
});

/** Latest market metrics (same set the patterns see). */
router.get("/btc/metrics", async (_req, res) => {
  if (scannerStatus.lastMetrics) {
    res.json({
      candleCloseAt: scannerStatus.lastCandleCloseAt,
      missing: scannerStatus.missingFlow,
      metrics: scannerStatus.lastMetrics,
    });
    return;
  }
  // Right after a restart: the last stored cycle until the first new one.
  const [row] = await db.select().from(btcMarketSnapshotsTable)
    .orderBy(desc(btcMarketSnapshotsTable.candleCloseAt)).limit(1);
  res.json({
    candleCloseAt: row?.candleCloseAt.toISOString() ?? null,
    missing: row?.missing ?? [],
    metrics: row?.metrics ?? null,
  });
});

/** Metric history, one row per 5m cycle (default 24h, max 7 days). */
router.get("/btc/metrics/history", async (req, res) => {
  const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 168);
  const rows = await db.select().from(btcMarketSnapshotsTable)
    .where(gte(btcMarketSnapshotsTable.candleCloseAt, new Date(Date.now() - hours * 3_600_000)))
    .orderBy(desc(btcMarketSnapshotsTable.candleCloseAt))
    .limit(2016);
  res.json({ rows });
});

/**
 * Owner 2026-11-09: the whole path of one signal for analysis — every 5m market snapshot (price and the full
 * metric set: flow, OI, liquidations, MFI / Chaikin, context) from 6 h before the entry to 72 h after the close
 * (or until now while open), with the price move from the entry in the trade's direction.
 */
router.get("/btc/signals/:id/path", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id)) { res.status(400).json({ error: "invalid_id" }); return; }
    const [sig] = await db.select().from(btcSignalsTable).where(eq(btcSignalsTable.id, id)).limit(1);
    if (!sig) { res.status(404).json({ error: "not_found" }); return; }
    const from = new Date(sig.detectedAt.getTime() - 6 * 3_600_000);
    const to = new Date(Math.min(Date.now(), (sig.closedAt ?? new Date()).getTime() + 72 * 3_600_000));
    const rows = await db.select().from(btcMarketSnapshotsTable)
      .where(and(gte(btcMarketSnapshotsTable.candleCloseAt, from), lte(btcMarketSnapshotsTable.candleCloseAt, to)))
      .orderBy(btcMarketSnapshotsTable.candleCloseAt);
    const dir = sig.direction === "long" ? 1 : -1;
    res.json({
      signal: sig,
      points: rows.map((r) => ({
        at: r.candleCloseAt,
        phase: r.candleCloseAt < sig.detectedAt ? "before" : sig.closedAt && r.candleCloseAt > sig.closedAt ? "after_close" : "open",
        price: r.price,
        pctFromEntry: Number((((r.price - sig.entryPrice) / sig.entryPrice) * 100 * dir).toFixed(4)),
        metrics: r.metrics,
        missing: r.missing,
      })),
    });
  } catch (err) {
    logger.error({ err }, "btc signal path failed");
    res.status(500).json({ error: "path_failed" });
  }
});

export default router;
