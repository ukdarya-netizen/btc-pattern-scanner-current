/**
 * Market panel (owner 2026-11-12: the morning report and every market metric on the dashboard, for every user).
 * Now: price and 24h change, Fear / Greed (today, yesterday, 30 days), liquidations 24h, funding (BingX 8h and
 * CoinGlass OI-weighted), Whale Index, OI, CVD, takers, crowd, order book, RSI. History: one point per hour over
 * the last 48 h from the 5m market snapshots (each hour's liquidations, flows and takers are that hour's).
 */
import { Router } from "express";
import { pool, db, btcMarketSnapshotsTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import { scannerStatus } from "../engine/scanner";
import { fearGreedCached } from "../market/fearGreed";
import type { Metrics } from "../engine/snapshot";
import { logger } from "../lib/logger";

const router = Router();

export type MarketHourPoint = {
  t: string; price: number; oiUsd: number | null; fundingBingxPct: number | null; fundingCgPct: number | null;
  whaleIndex: number | null; liqLongUsd: number | null; liqShortUsd: number | null;
  futCvdUsd: number | null; spotCvdUsd: number | null; futTakerNetPct: number | null; spotTakerNetPct: number | null;
  rsi1h: number | null;
};

router.get("/btc/market", async (_req, res) => {
  try {
    let m = scannerStatus.lastMetrics as Metrics | null;
    let at = scannerStatus.lastCandleCloseAt;
    if (!m) {
      const [row] = await db.select().from(btcMarketSnapshotsTable).orderBy(desc(btcMarketSnapshotsTable.candleCloseAt)).limit(1);
      m = (row?.metrics as Metrics | undefined) ?? null;
      at = row?.candleCloseAt.toISOString() ?? null;
    }
    const [fg, hours] = await Promise.all([
      fearGreedCached().catch(() => ({ latest: null, history: [] })),
      pool.query<MarketHourPoint>(`
        SELECT candle_close_at AS t, price,
          (metrics->>'oiUsd')::float AS "oiUsd",
          (metrics->>'fundingBingxPct')::float AS "fundingBingxPct",
          (metrics->>'fundingRatePct')::float AS "fundingCgPct",
          (metrics->>'whaleIndex')::float AS "whaleIndex",
          (metrics->'liqLongUsd'->>'1h')::float AS "liqLongUsd",
          (metrics->'liqShortUsd'->>'1h')::float AS "liqShortUsd",
          (metrics->'futCvdUsd'->>'1h')::float AS "futCvdUsd",
          (metrics->'spotCvdUsd'->>'1h')::float AS "spotCvdUsd",
          (metrics->'futTakerNetPct'->>'1h')::float AS "futTakerNetPct",
          (metrics->'spotTakerNetPct'->>'1h')::float AS "spotTakerNetPct",
          (metrics->'indicators'->'1h'->>'rsi14')::float AS "rsi1h"
        FROM btc_market_snapshots
        WHERE candle_close_at > now() - interval '48 hours' AND extract(minute FROM candle_close_at) = 0
        ORDER BY candle_close_at`),
    ]);
    res.json({ candleCloseAt: at, metrics: m, fearGreed: fg.latest, fearGreedHistory: fg.history, hours: hours.rows });
  } catch (err) {
    logger.error({ err }, "market panel failed");
    res.status(500).json({ error: "market_failed" });
  }
});

export default router;
