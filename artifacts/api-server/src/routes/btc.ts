import { Router } from "express";
import { db, btcDecisionsTable, btcSignalsTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
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

export default router;
