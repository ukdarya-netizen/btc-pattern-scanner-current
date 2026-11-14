import { Router } from "express";
import { db, pool, btcDecisionsTable, btcMarketSnapshotsTable, btcSignalsTable } from "@workspace/db";
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
import { isOwnerReq, ownerOnly } from "../lib/users";
import { historyCsv } from "../analysis/historyStudy";

const router = Router();
const clampLimit = (raw: unknown, max = 500) => Math.min(Math.max(Number(raw) || 100, 1), max);

router.get("/btc/status", (req, res) => {
  const owner = isOwnerReq(req);
  res.json({
    scanner: scannerStatus,
    stream: engineHealth(),
    apis: healthSnapshot(),
    coinglass: coinglassGovernorStats(),
    openSignals: openSignalCount(),
    // Owner 2026-11-12: the trading timeframe (style on the dashboard: 15m scalp, 30m / 1h intraday, 4h / 1d swing).
    // Users see the channel only (as CAB / Nihilist): shadow patterns are the owner's.
    patterns: PATTERNS.filter((p) => owner || p.live).map((p) => ({ key: p.key, label: p.label, direction: p.direction, profile: p.profile, live: p.live, tf: p.evalTf ?? PROFILES[p.profile].timeframe, off: p.off ?? false })),
    profiles: PROFILES,
  });
});

/**
 * Bot Health (owner 2026-11-13: the bot's own health on its own tab, apart from the market metrics):
 * process, price stream, scanner cycle, external APIs, CoinGlass budget, database, Telegram delivery queue, reports.
 */
router.get("/btc/health", ownerOnly, async (_req, res) => {
  const t0 = Date.now();
  let dbPingMs: number | null = null;
  let telegram: Record<string, unknown> = {};
  let reports: Array<Record<string, unknown>> = [];
  try {
    await pool.query("SELECT 1");
    dbPingMs = Date.now() - t0;
    const q = await pool.query(`
      SELECT status, count(*)::int AS n, min(next_attempt_at) AS oldest, max(sent_at) AS last_sent, max(attempts)::int AS max_attempts
      FROM btc_telegram_deliveries WHERE id > (SELECT coalesce(max(id), 0) - 2000 FROM btc_telegram_deliveries)
      GROUP BY status`);
    telegram = Object.fromEntries(q.rows.map((r) => [r.status, { n: r.n, oldest: r.oldest, lastSent: r.last_sent, maxAttempts: r.max_attempts }]));
    reports = (await pool.query(`SELECT period_key AS "periodKey", sent_at AS "sentAt" FROM btc_reports ORDER BY created_at DESC LIMIT 6`)).rows;
  } catch (err) {
    logger.warn({ err }, "health: database check failed");
  }
  const mem = process.memoryUsage();
  const lastCandle = scannerStatus.lastCandleCloseAt ? Date.parse(scannerStatus.lastCandleCloseAt) : null;
  res.json({
    at: new Date().toISOString(),
    process: { uptimeMin: Math.round(process.uptime() / 60), rssMb: Math.round(mem.rss / 1048576), heapMb: Math.round(mem.heapUsed / 1048576) },
    stream: engineHealth(),
    scanner: {
      lastCandleCloseAt: scannerStatus.lastCandleCloseAt, lastCycleAt: scannerStatus.lastCycleAt,
      minutesSinceCandle: lastCandle ? Math.round((Date.now() - lastCandle) / 60_000) : null,
      lastDurationMs: scannerStatus.lastDurationMs, lastError: scannerStatus.lastError, missingFlow: scannerStatus.missingFlow,
    },
    apis: healthSnapshot(),
    coinglass: coinglassGovernorStats(),
    db: { ok: dbPingMs !== null, pingMs: dbPingMs },
    telegram,
    reports,
    openSignals: openSignalCount(),
    patterns: { total: PATTERNS.filter((p) => !p.off).length, live: PATTERNS.filter((p) => p.live && !p.off).length },
  });
});

/** BTC history (CoinGlass, 1h up to 2 years + 4h) for the market-phase study — owner only (owner 2026-11-13). */
router.get("/btc/history-study", ownerOnly, async (_req, res) => {
  try {
    const { csv, rows } = await historyCsv();
    if (!rows) { res.status(503).json({ error: "Нет данных CoinGlass (dev или CoinGlass не ответил)" }); return; }
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader("Content-Disposition", 'attachment; filename="btc-history.csv.gz"');
    res.send(csv);
  } catch (err) {
    logger.error({ err }, "history study failed");
    res.status(500).json({ error: "history_failed" });
  }
});

router.get("/btc/stats", ownerOnly, async (req, res) => {
  try {
    res.json({ rows: await getStats(Number(req.query.days) || undefined) });
  } catch (err) {
    logger.error({ err }, "btc stats failed");
    res.status(500).json({ error: "stats_failed" });
  }
});

router.get("/btc/stats/daily", ownerOnly, async (req, res) => {
  try {
    res.json({ rows: await getDailyStats(Math.min(Math.max(Number(req.query.days) || 30, 1), 365)) });
  } catch (err) {
    logger.error({ err }, "daily stats failed");
    res.status(500).json({ error: "daily_stats_failed" });
  }
});

router.get("/btc/signals", async (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : null;
  const owner = isOwnerReq(req);
  // Users: channel signals only, without the engine's entry metrics (as CAB / Nihilist).
  const where = [status ? eq(btcSignalsTable.status, status) : undefined, owner ? undefined : eq(btcSignalsTable.live, true)].filter(Boolean);
  const rows = await db.select().from(btcSignalsTable)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(btcSignalsTable.id))
    .limit(clampLimit(req.query.limit));
  // The trajectory points stay out of the list (heavy); /btc/signals/:id/path has them.
  const light = (r: typeof rows[number]) => {
    const m = r.metrics as Record<string, unknown> | null;
    if (!m || !("trajectory" in m)) return r;
    const { trajectory: _t, ...rest } = m;
    return { ...r, metrics: rest };
  };
  res.json({ rows: owner ? rows.map(light) : rows.map((r) => ({ ...r, metrics: null })) });
});

router.get("/btc/decisions", ownerOnly, async (req, res) => {
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
router.get("/btc/decisions/outcomes", ownerOnly, async (req, res) => {
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
router.get("/btc/metrics", ownerOnly, async (_req, res) => {
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
router.get("/btc/metrics/history", ownerOnly, async (req, res) => {
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
    const owner = isOwnerReq(req);
    if (!sig || (!owner && !sig.live)) { res.status(404).json({ error: "not_found" }); return; }
    const from = new Date(sig.detectedAt.getTime() - 6 * 3_600_000);
    const to = new Date(Math.min(Date.now(), (sig.closedAt ?? new Date()).getTime() + 72 * 3_600_000));
    const rows = await db.select().from(btcMarketSnapshotsTable)
      .where(and(gte(btcMarketSnapshotsTable.candleCloseAt, from), lte(btcMarketSnapshotsTable.candleCloseAt, to)))
      .orderBy(btcMarketSnapshotsTable.candleCloseAt);
    const dir = sig.direction === "long" ? 1 : -1;
    res.json({
      signal: owner ? sig : { ...sig, metrics: null },
      points: rows.map((r) => ({
        at: r.candleCloseAt,
        phase: r.candleCloseAt < sig.detectedAt ? "before" : sig.closedAt && r.candleCloseAt > sig.closedAt ? "after_close" : "open",
        price: r.price,
        pctFromEntry: Number((((r.price - sig.entryPrice) / sig.entryPrice) * 100 * dir).toFixed(4)),
        ...(owner ? { metrics: r.metrics, missing: r.missing } : {}),
      })),
    });
  } catch (err) {
    logger.error({ err }, "btc signal path failed");
    res.status(500).json({ error: "path_failed" });
  }
});

export default router;
