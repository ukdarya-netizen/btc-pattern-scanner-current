/**
 * Market panel (owner 2026-11-12: the morning report and every market metric on the dashboard, for every user).
 * Now: price and 24h change, Fear / Greed (today, yesterday, 30 days), liquidations 24h, funding (BingX 8h and
 * CoinGlass OI-weighted), Whale Index, OI, CVD, takers, crowd, order book, RSI. History: one point per hour over
 * the last 48 h from the 5m market snapshots (each hour's liquidations, flows and takers are that hour's).
 */
import { Router } from "express";
import { pool, db, btcMarketSnapshotsTable, btcSignalsTable } from "@workspace/db";
import { and, desc, eq, gte } from "drizzle-orm";
import { getClosedCandles, INTERVAL_MS, type Candle } from "../market/bingx";
import { replayRanges, type RangeReplay } from "../engine/rangeDetector";
import { HISTORY_BARS } from "../engine/rangePatterns";
import { computeZones } from "../engine/neonZones";
import { PATTERNS } from "../engine/patterns";
import { tfIndicators } from "../engine/indicators";
import { mfChartSeries } from "../market/moneyFlow";
import { scannerStatus } from "../engine/scanner";
import { fearGreedCached } from "../market/fearGreed";
import { dominanceHistoryReady } from "../market/context";
import { spxHistory } from "../market/spx";
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
    const [fg, hours, spx, dom] = await Promise.all([
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
      spxHistory().catch(() => []),
      dominanceHistoryReady().catch(() => []),
    ]);
    // Owner 2026-11-13: BTC dominance and S&P 500 by day (one chart), last 120 days.
    res.json({ candleCloseAt: at, metrics: m, fearGreed: fg.latest, fearGreedHistory: fg.history, hours: hours.rows,
      dominanceHistory: dom, spxHistory: spx });
  } catch (err) {
    logger.error({ err }, "market panel failed");
    res.status(500).json({ error: "market_failed" });
  }
});

/**
 * Main BTC chart (owner 2026-11-14): BingX candles (15m · 3 days, 1h · 7 days, 4h · 90 days, 1D · 1 year) with the levels the
 * signals are built on — the Auto Range Detector range on 4h and 1D (the one the deviation and breakout signals
 * use: the active range, or the broken one still waiting for a return = deviation, else the last broken one) and
 * the ABNeon 4H zones (the bounce / Stealth levels) — and the channel signals as arrows. The same engine code as
 * the scanner (replayRanges over 1000 bars, computeZones over the last 600 4H bars). Production only: dev makes no
 * exchange requests (owner rule). Cached: candles 5 min, levels 10 min.
 */
type ChartTf = "15m" | "1h" | "4h" | "1d";
const CHART_BARS: Record<ChartTf, number> = { "15m": 288, "1h": 168, "4h": 540, "1d": 365 };
/** Bars before the visible ones so EMA 200 / MA 200 / MACD are formed from the first visible candle (owner 2026-11-14). */
const WARMUP = 300;
const deployed = () => process.env.REPLIT_DEPLOYMENT === "1" || process.env.NODE_ENV === "production";
const candleCache = new Map<ChartTf, { at: number; candles: Candle[] }>();
type RangeLevel = { tf: "4h" | "1d"; state: "active" | "unconfirmed" | "broken_wait" | "last"; top: number; bottom: number; from: number; note: string | null };
let levelCache: { at: number; ranges: RangeLevel[]; zones: Array<{ top: number; bottom: number; count: number }>; zonesFrom: number | null } | null = null;

async function chartCandles(tf: ChartTf): Promise<Candle[]> {
  const hit = candleCache.get(tf);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.candles;
  const candles = await getClosedCandles(tf, CHART_BARS[tf] + WARMUP);
  candleCache.set(tf, { at: Date.now(), candles });
  return candles;
}

function rangeOf(tf: "4h" | "1d", c: Candle[], r: RangeReplay): RangeLevel | null {
  const at = (i: number) => c[Math.max(0, Math.min(c.length - 1, i))]!.time;
  if (r.active) {
    return { tf, state: r.active.confirmed ? "active" : "unconfirmed", top: r.active.top, bottom: r.active.bottom, from: at(r.active.leftIndex), note: null };
  }
  const last = r.events[r.events.length - 1];
  if (r.dormant && last) {
    // Broken and not back yet: a close back inside within the indicator's window = deviation signal.
    return { tf, state: "broken_wait", top: r.dormant.top, bottom: r.dormant.bottom, from: at(last.range.leftIndex),
      note: r.dormant.direction === 1 ? "пробит вверх · возврат внутрь = девиация в шорт" : "пробит вниз · возврат внутрь = девиация в лонг" };
  }
  if (last) return { tf, state: "last", top: last.range.top, bottom: last.range.bottom, from: at(last.range.leftIndex), note: last.kind };
  return null;
}

async function chartLevels() {
  if (levelCache && Date.now() - levelCache.at < 10 * 60_000) return levelCache;
  const [c4h, c1d] = await Promise.all([getClosedCandles("4h", HISTORY_BARS), getClosedCandles("1d", HISTORY_BARS)]);
  const ranges = [rangeOf("4h", c4h, replayRanges(c4h)), rangeOf("1d", c1d, replayRanges(c1d))].filter((x): x is RangeLevel => x !== null);
  // Owner 2026-11-14: exactly the zones the ABNeon / Stealth signals use (neonPatterns.zonesOf: the last 640 4H bars,
  // none under 200 bars), drawn as her TradingView indicator does — from 300 4H bars back to now.
  const h4 = c4h.slice(-640);
  const zones = h4.length >= 200 ? computeZones(h4).map((z) => ({ top: z.top, bottom: z.bottom, count: z.count })) : [];
  const zonesFrom = c4h.length >= 300 ? c4h[c4h.length - 300]!.time : c4h[0]?.time ?? null;
  levelCache = { at: Date.now(), ranges, zones, zonesFrom };
  return levelCache;
}

/**
 * Owner 2026-11-14: every indicator of the table on the chart. For each visible candle the scanner's own function
 * (engine/indicators.tfIndicators) over the 300 closed candles up to it — the scanner computes the table the same
 * way, so the last candle's values match it (tiny differences in EMA 200 / MA 200 where the scanner holds a longer
 * history). MFI / CMF: aggregated CoinGlass volume, 1H and 4H only. Cached with the candles (5 min).
 */
type IndRow = Record<string, number | null>;
const indCache = new Map<ChartTf, { at: number; first: number; rows: Map<number, IndRow> }>();
function chartIndicators(tf: ChartTf, all: Candle[]): Map<number, IndRow> {
  const hit = indCache.get(tf);
  const first = all[0]?.time ?? 0;
  if (hit && hit.first === first && Date.now() - hit.at < 5 * 60_000) return hit.rows;
  const rows = new Map<number, IndRow>();
  const mf = tf === "1h" || tf === "4h" ? mfChartSeries(tf) : null;
  const from = Math.max(0, all.length - CHART_BARS[tf]);
  for (let i = from; i < all.length; i++) {
    const t = tfIndicators(all.slice(Math.max(0, i - WARMUP + 1), i + 1));
    const m = mf?.get(all[i]!.time) ?? null;
    rows.set(all[i]!.time, {
      ema9: t?.ema9 ?? null, ema21: t?.ema21 ?? null, ema50: t?.ema50 ?? null, ema200: t?.ema200 ?? null,
      sma20: t?.sma20 ?? null, sma50: t?.sma50 ?? null, sma200: t?.sma200 ?? null,
      bbUpper: t?.bbUpper ?? null, bbLower: t?.bbLower ?? null,
      rsi14: t?.rsi14 ?? null, stochK: t?.stochRsiK ?? null, stochD: t?.stochRsiD ?? null,
      macd: t?.macd ?? null, macdSignal: t?.macdSignal ?? null, macdHist: t?.macdHist ?? null,
      adx: t?.adx14 ?? null, plusDi: t?.plusDi ?? null, minusDi: t?.minusDi ?? null,
      futMfi: m?.futMfi ?? null, spotMfi: m?.spotMfi ?? null, futCmf: m?.futCmf ?? null, spotCmf: m?.spotCmf ?? null,
    });
  }
  indCache.set(tf, { at: Date.now(), first, rows });
  return rows;
}

router.get("/btc/chart", async (req, res) => {
  const tf: ChartTf = req.query.tf === "15m" || req.query.tf === "1h" || req.query.tf === "1d" ? req.query.tf : "4h";
  if (!deployed()) { res.json({ tf, dev: true, candles: [], ranges: [], zones: [], signals: [] }); return; }
  try {
    const [all, levels] = await Promise.all([chartCandles(tf), chartLevels()]);
    const candles = all.slice(-CHART_BARS[tf]);
    const ind = chartIndicators(tf, all);
    const from = candles[0]?.time ?? Date.now();
    // Channel signals only (live), as the users see them.
    const sigs = await db.select().from(btcSignalsTable)
      .where(and(eq(btcSignalsTable.live, true), gte(btcSignalsTable.detectedAt, new Date(from))))
      .orderBy(btcSignalsTable.detectedAt);
    const label = (key: string) => PATTERNS.find((p) => p.key === key)?.label ?? key;
    res.json({
      tf, dev: false, spanMs: INTERVAL_MS[tf],
      candles: candles.map((c) => ({ t: c.time, o: c.open, h: c.high, l: c.low, c: c.close, ...(ind.get(c.time) ?? {}) })),
      ranges: levels.ranges, zones: levels.zones, zonesFrom: levels.zonesFrom,
      signals: sigs.map((s) => ({
        id: s.id, at: s.detectedAt.getTime(), direction: s.direction, label: label(s.patternKey), entry: s.entryPrice,
        status: s.status, closeReason: s.closeReason, pnlPricePct: s.pnlPricePct, closedAt: s.closedAt ? s.closedAt.getTime() : null,
      })),
    });
  } catch (err) {
    logger.error({ err }, "btc chart failed");
    res.status(500).json({ error: "chart_failed" });
  }
});

export default router;
