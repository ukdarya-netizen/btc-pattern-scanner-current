import { Router } from "express";
import { db, btcDecisionsTable, btcMarketSnapshotsTable, btcSignalsTable } from "@workspace/db";
import { and, desc, eq, gte } from "drizzle-orm";
import { PROFILES } from "../config/profiles";
import { PATTERNS } from "../engine/patterns";
import { scannerStatus } from "../engine/scanner";
import { getStats } from "../stats/stats";
import { openSignalCount } from "../tracker/tracker";
import { engineHealth } from "../engine/runtime";
import { logger } from "../lib/logger";

const router = Router();
const clampLimit = (raw: unknown, max = 500) => Math.min(Math.max(Number(raw) || 100, 1), max);

router.get("/btc/status", (_req, res) => {
  res.json({
    scanner: scannerStatus,
    stream: engineHealth(),
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

export default router;
