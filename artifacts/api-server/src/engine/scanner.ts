import { db, btcDecisionsTable, btcSignalEventsTable, btcSignalsTable } from "@workspace/db";
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
import { trackSignal } from "../tracker/tracker";
import { PATTERNS, type Pattern } from "./patterns";
import { computeMetrics, type Snapshot } from "./snapshot";

export type ScannerStatus = {
  lastCycleAt: string | null;
  lastCandleCloseAt: string | null;
  lastError: string | null;
  lastDurationMs: number | null;
  missingFlow: string[];
};

export const scannerStatus: ScannerStatus = {
  lastCycleAt: null, lastCandleCloseAt: null, lastError: null, lastDurationMs: null, missingFlow: [],
};

let lastClose5m = 0;
let running = false;

function closedBoundary(now: number, interval: Interval): number {
  const step = INTERVAL_MS[interval];
  return Math.floor(now / step) * step;
}

async function buildSnapshot(now: number): Promise<Snapshot> {
  const [c5, c15, c1h, c4h] = await Promise.all([
    getClosedCandles("5m", 300, now),
    getClosedCandles("15m", 300, now),
    getClosedCandles("1h", 300, now),
    getClosedCandles("4h", 120, now),
  ]);
  const flow = await getBtcFlow(120, now);
  const candles = { "1m": [], "5m": c5, "15m": c15, "1h": c1h, "4h": c4h };
  scannerStatus.missingFlow = Object.entries(flow).filter(([, v]) => v === null).map(([k]) => k);
  return { at: now, candles, flow, metrics: computeMetrics(candles, flow) };
}

/** Patterns of a profile are evaluated only when that profile's candle closed. */
function due(pattern: Pattern, candleCloseAt: number): boolean {
  const step = INTERVAL_MS[PROFILES[pattern.profile].timeframe];
  return candleCloseAt % step === 0;
}

async function openSignal(pattern: Pattern, snapshot: Snapshot, candleCloseAt: number,
  entry: number, stopPctOverride: number | undefined,
  targetsOverride: TargetSpec[] | undefined): Promise<number | null> {
  const profile = PROFILES[pattern.profile as ProfileKey];
  const stopPct = stopPctOverride ?? profile.defaultStopPct;
  if (!(entry > 0) || !(stopPct > 0) || stopPct >= maxStopPct(profile.leverage)) {
    logger.warn({ pattern: pattern.key, stopPct }, "scanner: stop violates liquidation guard — not opened");
    return null;
  }
  const targets = targetPricesFor(entry, targetsOverride ?? profile.defaultTargets, pattern.direction);
  const now = new Date();
  const [row] = await db.insert(btcSignalsTable).values({
    patternKey: pattern.key,
    direction: pattern.direction,
    profile: pattern.profile,
    leverage: profile.leverage,
    live: pattern.live,
    entryPrice: entry,
    initialStopPrice: stopPriceFor(entry, stopPct, pattern.direction),
    stopPrice: stopPriceFor(entry, stopPct, pattern.direction),
    liquidationPrice: liquidationPrice(entry, profile.leverage, pattern.direction),
    targets,
    detectedAt: now,
    candleCloseAt: new Date(candleCloseAt),
    expiresAt: new Date(now.getTime() + profile.maxHoldMs),
    metrics: snapshot.metrics,
    updatedAt: now,
  }).returning();
  if (!row) return null;
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
    const snapshot = await buildSnapshot(now);
    const lastCandle = snapshot.candles["5m"].at(-1);
    if (!lastCandle || lastCandle.time + INTERVAL_MS["5m"] !== candleCloseAt) {
      throw new Error("latest closed 5m candle not available yet");
    }
    lastClose5m = candleCloseAt;
    for (const pattern of PATTERNS) {
      if (!due(pattern, candleCloseAt)) continue;
      let decision: "fired" | "rejected" | "suppressed" = "rejected";
      let reasons: string[] = [];
      let signalId: number | null = null;
      try {
        const result = pattern.evaluate(snapshot);
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
            signalId = await openSignal(pattern, snapshot, candleCloseAt, entry, result.stopPct, result.targets);
            decision = signalId ? "fired" : "rejected";
            if (!signalId) reasons = ["liquidation_guard"];
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
