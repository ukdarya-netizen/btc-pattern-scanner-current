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
import { getClosedCandles, getFundingRate, INTERVAL_MS, type Interval } from "../market/bingx";
import { getBtcFlow } from "../market/coinglass";
import { getMarketContext } from "../market/context";
import { trackSignal } from "../tracker/tracker";
import { PATTERNS, type Pattern, type PatternResult } from "./patterns";
import { HISTORY_BARS } from "./rangePatterns";
import { levelsAtEntry } from "./levels";
import { recordTrajectory } from "../tracker/trajectory";
import { computeMetrics, type Metrics, type Snapshot } from "./snapshot";
import { entryStudy } from "./entryStudy";
import { aggVolumeStudy } from "../market/aggVolumeStudy";
import { getLucyVolume } from "../market/lucyVolume";

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

async function buildSnapshot(now: number, longHistory: boolean, neon = false): Promise<Snapshot> {
  // 4h and 1d patterns replay the range detector over HISTORY_BARS closed
  // bars (ATR 200 + 500-bar calibration); otherwise a short tail suffices.
  // Smart Money (owner 2026-11-09) walks 400 bars of 30m (from 15m) / 1h on the same 4h / 1d history.
  const [c5, c15, c1h, c4h, c1d] = await Promise.all([
    getClosedCandles("5m", 300, now),
    getClosedCandles("15m", longHistory ? 840 : 300, now),
    getClosedCandles("1h", longHistory ? 420 : 300, now),
    // Owner 2026-11-12: EMA / SMA 200 on 4h and 1D in every cycle (indicators), so at least 250 bars.
    getClosedCandles("4h", longHistory ? HISTORY_BARS : 250, now),
    getClosedCandles("1d", longHistory ? HISTORY_BARS : 250, now),
  ]);
  // 200 bars of 15m: the liquidation cascade needs a 24 h baseline before a spike up to 12 h old.
  const [flow, funding] = await Promise.all([getBtcFlow(200, now), getFundingRate()]);
  const candles = { "1m": [], "5m": c5, "15m": c15, "1h": c1h, "4h": c4h, "1d": c1d };
  scannerStatus.missingFlow = Object.entries(flow).filter(([, v]) => v === null).map(([k]) => k);
  // Owner 2026-11-12: ABNeon / Stealth need Lucy's VSA volume (futures + spot) on 15m / 1h / 4h; at most 10 s.
  const lucy = neon
    ? await Promise.race([getLucyVolume(now), new Promise<null>((res) => setTimeout(() => res(null), 10_000))]).catch(() => null)
    : null;
  const metrics = {
    ...computeMetrics(candles, flow, getMarketContext(), now),
    fundingBingxPct: funding?.ratePct ?? null, nextFundingAt: funding?.nextFundingAt ?? null,
  };
  return { at: now, candles, flow, metrics, lucy };
}

/** Candle series whose closed bar triggers a pattern (30m bars are built from 15m). */
function triggerSeries(pattern: Pattern): { tf: Interval; step: number } {
  if (pattern.evalTf === "30m") return { tf: "15m", step: 30 * 60_000 };
  const tf = pattern.evalTf ?? PROFILES[pattern.profile].timeframe;
  return { tf, step: INTERVAL_MS[tf] };
}

/** A pattern is evaluated only when its trigger timeframe's candle closed. */
function due(pattern: Pattern, candleCloseAt: number): boolean {
  return candleCloseAt % triggerSeries(pattern).step === 0;
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
  // Owner 2026-11-09: everything at the entry — the volume study (Wyckoff, VSA colours, Elliott, ICT) and which
  // other methods hold an open signal now (confluence / conflict between Range, Smart Money and the cascade).
  const study = entryStudy(snapshot.candles["1h"], snapshot.candles["15m"], pattern.direction, now.getTime(), result.detail);
  // Owner 2026-11-12: aggregated volume at the entry as in CAB — VPVR (30 days), Welkin on 20 / 50 / 120 bars and
  // Lucy's VSA rule, futures / spot / total, 24h volume vs the 30-day average and the 60-day busiest day. At most
  // 8 s; a timeout or an error is recorded, the signal is opened anyway.
  const aggVolume = await Promise.race([
    getClosedCandles("1h", 760, now.getTime()).then((c1h) => aggVolumeStudy(c1h, entry, now.getTime())),
    new Promise<Record<string, unknown>>((res) => setTimeout(() => res({ version: 1, error: "timeout_8s" }), 8_000)),
  ]).catch((err) => ({ version: 1, error: err instanceof Error ? err.message.slice(0, 120) : String(err) }));
  const others = await db.select({ id: btcSignalsTable.id, patternKey: btcSignalsTable.patternKey, direction: btcSignalsTable.direction, detectedAt: btcSignalsTable.detectedAt })
    .from(btcSignalsTable).where(eq(btcSignalsTable.status, "open")).catch(() => []);
  const openOthers = others.map((o) => ({ id: o.id, pattern: o.patternKey, direction: o.direction, sameDirection: o.direction === pattern.direction, openedAt: o.detectedAt }));
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
    metrics: { ...snapshot.metrics, ...(result.detail ? { pattern: result.detail } : {}), entryStudy: study, aggVolume, openSignalsAtEntry: openOthers },
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
    // Range (4h / 1d) and Smart Money need the long 4h / 1d history; the cascade needs only 15m / 1h.
    // ABNeon / Stealth (owner 2026-11-12) build their zones on the long 4h history even on 15m bars.
    const neonDue = duePatterns.some((p) => p.key.startsWith("neon_"));
    const snapshot = await buildSnapshot(now, neonDue || duePatterns.some((p) => p.evalTf !== "15m"), neonDue);
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
    for (const tf of new Set(duePatterns.map((pattern) => triggerSeries(pattern).tf))) {
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
    // Owner 2026-11-12: trajectory points of every signal (15m … 72h, then daily, and the close) from these metrics.
    await recordTrajectory(snapshot.metrics, now).catch((err) => logger.warn({ err }, "trajectory pass failed"));
    for (const pattern of duePatterns) {
      let decision: "fired" | "rejected" | "suppressed" = "rejected";
      let reasons: string[] = [];
      let signalId: number | null = null;
      try {
        const result = unavailable.has(triggerSeries(pattern).tf)
          ? { fires: false, reasons: [`${triggerSeries(pattern).tf}_candle_unavailable`] } as PatternResult
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
