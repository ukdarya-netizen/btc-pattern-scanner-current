import { db, btcDecisionsTable, btcMarketSnapshotsTable, btcSignalEventsTable, btcSignalsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { PROFILES, type ProfileKey, type TargetSpec } from "../config/profiles";
import { logger } from "../lib/logger";
import {
  liquidationPrice,
  maxStopPct,
  stopPriceFor,
  targetPricesFor,
} from "../lib/tradeMath";
import { getClosedCandles, INTERVAL_MS, type Interval } from "../market/bingx";
import { getBtcFlow } from "../market/coinglass";
import { getMarketContext } from "../market/context";
import { trackSignal } from "../tracker/tracker";
import { PATTERNS, type Pattern, type PatternResult } from "./patterns";
import { HISTORY_BARS } from "./rangePatterns";
import { levelsAtEntry } from "./levels";
import { computeMetrics, type Metrics, type Snapshot } from "./snapshot";

export type ScannerStatus = {
  lastCycleAt: string | null;
  lastCandleCloseAt: string | null;
  lastError: string | null;
  lastDurationMs: number | null;
  missingFlow: string[];
  /** Metrics of the last completed cycle (shown on the dashboard). */
  lastMetrics: Metrics | null;
};

export const scannerStatus: ScannerStatus = {
  lastCycleAt: null, lastCandleCloseAt: null, lastError: null, lastDurationMs: null, missingFlow: [],
  lastMetrics: null,
};

let lastClose5m = 0;
let running = false;

function closedBoundary(now: number, interval: Interval): number {
  const step = INTERVAL_MS[interval];
  return Math.floor(now / step) * step;
}

async function buildSnapshot(now: number, longHistory: boolean): Promise<Snapshot> {
  // 4h and 1d patterns replay the range detector over HISTORY_BARS closed
  // bars (ATR 200 + 500-bar calibration); otherwise a short tail suffices.
  const [c5, c15, c1h, c4h, c1d] = await Promise.all([
    getClosedCandles("5m", 300, now),
    getClosedCandles("15m", 300, now),
    getClosedCandles("1h", 300, now),
    getClosedCandles("4h", longHistory ? HISTORY_BARS : 120, now),
    longHistory ? getClosedCandles("1d", HISTORY_BARS, now) : Promise.resolve([]),
  ]);
  const flow = await getBtcFlow(120, now);
  const candles = { "1m": [], "5m": c5, "15m": c15, "1h": c1h, "4h": c4h, "1d": c1d };
  scannerStatus.missingFlow = Object.entries(flow).filter(([, v]) => v === null).map(([k]) => k);
  return { at: now, candles, flow, metrics: computeMetrics(candles, flow, getMarketContext()) };
}

/** Patterns of a profile are evaluated only when that profile's candle closed. */
function due(pattern: Pattern, candleCloseAt: number): boolean {
  const step = INTERVAL_MS[PROFILES[pattern.profile].timeframe];
  return candleCloseAt % step === 0;
}

async function openSignal(pattern: Pattern, snapshot: Snapshot, candleCloseAt: number,
  entry: number, result: PatternResult): Promise<number | string> {
  const profile = PROFILES[pattern.profile as ProfileKey];
  let stopPrice: number;
  let targets: { price: number; fraction: number; hitAt: string | null }[];
  if (result.levels) {
    const resolved = levelsAtEntry(entry, pattern.direction, profile.leverage, result.levels);
    if ("refused" in resolved) {
      logger.warn({ pattern: pattern.key, entry, reason: resolved.refused }, "scanner: signal not opened");
      return resolved.refused;
    }
    stopPrice = resolved.stopPrice;
    targets = resolved.targets;
  } else {
    const stopPct = result.stopPct ?? profile.defaultStopPct;
    if (!(entry > 0) || !(stopPct > 0) || stopPct >= maxStopPct(profile.leverage)) {
      logger.warn({ pattern: pattern.key, stopPct }, "scanner: stop violates liquidation guard — not opened");
      return "liquidation_guard";
    }
    stopPrice = stopPriceFor(entry, stopPct, pattern.direction);
    targets = targetPricesFor(entry, (result.targets as TargetSpec[] | undefined) ?? profile.defaultTargets, pattern.direction);
  }
  const now = new Date();
  const [row] = await db.insert(btcSignalsTable).values({
    patternKey: pattern.key,
    direction: pattern.direction,
    profile: pattern.profile,
    leverage: profile.leverage,
    live: pattern.live,
    entryPrice: entry,
    initialStopPrice: stopPrice,
    stopPrice,
    liquidationPrice: liquidationPrice(entry, profile.leverage, pattern.direction),
    targets,
    detectedAt: now,
    candleCloseAt: new Date(candleCloseAt),
    expiresAt: new Date(now.getTime() + profile.maxHoldMs),
    metrics: { ...snapshot.metrics, ...(result.detail ? { pattern: result.detail } : {}) },
    updatedAt: now,
  }).returning();
  if (!row) return "insert_failed";
  await db.insert(btcSignalEventsTable).values({
    signalId: row.id, eventKey: `${row.id}:opened`, kind: "opened", price: entry, detail: {},
  }).onConflictDoNothing();
  trackSignal(row);
  return row.id;
}

/**
 * One evaluation pass per closed 5m candle. `currentPrice` supplies the entry
 * (live last price at fire time, not the candle close a subscriber can no
 * longer get).
 */
export async function runCycle(currentPrice: () => Promise<number>, now = Date.now()): Promise<void> {
  const candleCloseAt = closedBoundary(now, "5m");
  if (running || candleCloseAt <= lastClose5m) return;
  running = true;
  const started = Date.now();
  try {
    const duePatterns = PATTERNS.filter((pattern) => due(pattern, candleCloseAt));
    const snapshot = await buildSnapshot(now, duePatterns.length > 0);
    const lastCandle = snapshot.candles["5m"].at(-1);
    if (!lastCandle || lastCandle.time + INTERVAL_MS["5m"] !== candleCloseAt) {
      throw new Error("latest closed 5m candle not available yet");
    }
    // A 4h/1d bar that just closed must be in the data before its patterns
    // are evaluated; otherwise retry this boundary on the next tick instead
    // of silently skipping the bar.
    // After 10 minutes give up on that bar (logged per pattern) so a missing
    // or misaligned higher-timeframe candle can never stall the 5m cycle.
    const unavailable = new Set<string>();
    for (const tf of new Set(duePatterns.map((pattern) => PROFILES[pattern.profile].timeframe))) {
      const last = snapshot.candles[tf].at(-1);
      if (!last || last.time + INTERVAL_MS[tf] !== candleCloseAt) {
        if (now - candleCloseAt < 10 * 60_000) throw new Error(`latest closed ${tf} candle not available yet`);
        unavailable.add(tf);
        logger.error({ tf, candleCloseAt, lastOpen: last?.time ?? null }, "scanner: closed candle missing, bar skipped");
      }
    }
    lastClose5m = candleCloseAt;
    scannerStatus.lastMetrics = snapshot.metrics;
    await db.insert(btcMarketSnapshotsTable).values({
      candleCloseAt: new Date(candleCloseAt),
      price: snapshot.metrics.price,
      metrics: snapshot.metrics,
      missing: scannerStatus.missingFlow,
    }).onConflictDoNothing();
    for (const pattern of duePatterns) {
      let decision: "fired" | "rejected" | "suppressed" = "rejected";
      let reasons: string[] = [];
      let signalId: number | null = null;
      try {
        const result = unavailable.has(PROFILES[pattern.profile].timeframe)
          ? { fires: false, reasons: [`${PROFILES[pattern.profile].timeframe}_candle_unavailable`] } as PatternResult
          : pattern.evaluate(snapshot);
        reasons = result.reasons;
        if (result.fires) {
          const existing = await db.select({ id: btcSignalsTable.id }).from(btcSignalsTable).where(and(
            eq(btcSignalsTable.patternKey, pattern.key), eq(btcSignalsTable.status, "open"),
          )).limit(1);
          if (existing.length) {
            decision = "suppressed";
            reasons = ["open_signal_exists"];
          } else {
            const entry = await currentPrice();
            const opened = await openSignal(pattern, snapshot, candleCloseAt, entry, result);
            signalId = typeof opened === "number" ? opened : null;
            decision = signalId ? "fired" : "rejected";
            if (typeof opened === "string") reasons = [opened];
          }
        }
        await db.insert(btcDecisionsTable).values({
          cycleAt: new Date(now),
          candleCloseAt: new Date(candleCloseAt),
          patternKey: pattern.key,
          direction: pattern.direction,
          profile: pattern.profile,
          decision,
          reasons,
          price: snapshot.metrics.price,
          metrics: { ...snapshot.metrics, ...(result.detail ? { pattern: result.detail } : {}) },
          signalId,
        }).onConflictDoNothing();
      } catch (err) {
        logger.error({ err, pattern: pattern.key }, "scanner: pattern evaluation failed");
      }
    }
    scannerStatus.lastError = null;
    scannerStatus.lastCandleCloseAt = new Date(candleCloseAt).toISOString();
  } catch (err) {
    scannerStatus.lastError = err instanceof Error ? err.message : String(err);
    logger.warn({ err }, "scanner: cycle failed, retried on the next tick");
  } finally {
    scannerStatus.lastCycleAt = new Date().toISOString();
    scannerStatus.lastDurationMs = Date.now() - started;
    running = false;
  }
}
