/**
 * Durable BTC-USDT candle history (AltBullet keeps post-decision 15m
 * trajectories in pattern_backfill_candles; for one symbol a shared store is
 * simpler and exact). 1m candles label decision outcomes; 15m are kept longer.
 */
import { db, btcCandlesTable, btcDecisionsTable } from "@workspace/db";
import { and, asc, desc, eq, gte, lt, sql } from "drizzle-orm";
import { PROFILES, type Direction, type ProfileKey } from "../config/profiles";
import { logger } from "../lib/logger";
import { getCandlesRange, INTERVAL_MS } from "../market/bingx";
import { firstTouch, type OutcomeLabel } from "./outcome";

const BACKFILL_DAYS: Record<"1m" | "15m", number> = { "1m": 14, "15m": 90 };
const RETENTION_DAYS: Record<"1m" | "15m", number> = { "1m": 60, "15m": 730 };
const DAY = 24 * 60 * 60_000;

async function syncInterval(interval: "1m" | "15m"): Promise<number> {
  const step = INTERVAL_MS[interval];
  const [latest] = await db.select({ t: btcCandlesTable.openTime }).from(btcCandlesTable)
    .where(eq(btcCandlesTable.interval, interval)).orderBy(desc(btcCandlesTable.openTime)).limit(1);
  let from = latest ? latest.t.getTime() + step : Date.now() - BACKFILL_DAYS[interval] * DAY;
  let written = 0;
  for (let page = 0; page < 40 && from + step <= Date.now(); page++) {
    const to = Math.min(from + 1400 * step, Date.now());
    const candles = await getCandlesRange(interval, from, to);
    if (candles.length === 0) {
      from = to; // a gap on the exchange side; move on, never fabricate
      continue;
    }
    await db.insert(btcCandlesTable).values(candles.map((c) => ({
      interval, openTime: new Date(c.time), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
    }))).onConflictDoNothing();
    written += candles.length;
    from = candles[candles.length - 1]!.time + step;
  }
  return written;
}

let lastRetentionAt = 0;
export async function syncCandles(): Promise<void> {
  const one = await syncInterval("1m");
  const fifteen = await syncInterval("15m");
  if (one + fifteen > 1000) logger.info({ one, fifteen }, "BTC candles backfilled");
  if (Date.now() - lastRetentionAt > DAY) {
    lastRetentionAt = Date.now();
    for (const interval of ["1m", "15m"] as const) {
      await db.delete(btcCandlesTable).where(and(
        eq(btcCandlesTable.interval, interval),
        lt(btcCandlesTable.openTime, new Date(Date.now() - RETENTION_DAYS[interval] * DAY)),
      ));
    }
  }
}

export type OutcomeGroup = {
  patternKey: string; profile: string; direction: string; decision: string; reason: string;
  total: number; targetFirst: number; stopFirst: number; timeout: number; pending: number;
  /** target_first ÷ (target_first + stop_first), resolved only. */
  targetFirstPct: number | null;
  avgMfePct: number | null; avgMaePct: number | null;
};

/**
 * First-touch outcome (first target vs stop, profile defaults) for every
 * decision in the window — fired and rejected alike, so gates can be judged
 * on what happened after them.
 */
export async function decisionOutcomes(days: number, pattern?: string): Promise<OutcomeGroup[]> {
  const since = new Date(Date.now() - days * DAY);
  const decisions = await db.select().from(btcDecisionsTable).where(and(
    gte(btcDecisionsTable.candleCloseAt, since),
    pattern ? eq(btcDecisionsTable.patternKey, pattern) : undefined,
  )).orderBy(asc(btcDecisionsTable.candleCloseAt)).limit(50_000);
  if (decisions.length === 0) return [];
  const candles = (await db.select({
    openTime: btcCandlesTable.openTime, high: btcCandlesTable.high, low: btcCandlesTable.low,
  }).from(btcCandlesTable).where(and(
    eq(btcCandlesTable.interval, "1m"),
    gte(btcCandlesTable.openTime, decisions[0]!.candleCloseAt),
  )).orderBy(asc(btcCandlesTable.openTime))).map((c) => ({ openTime: c.openTime.getTime(), high: c.high, low: c.low }));

  const groups = new Map<string, OutcomeGroup & { mfeSum: number; maeSum: number; n: number }>();
  const now = Date.now();
  for (const d of decisions) {
    const profile = PROFILES[d.profile as ProfileKey];
    if (!profile || !(d.price && d.price > 0)) continue;
    const decidedAt = d.candleCloseAt.getTime();
    const startIndex = lowerBound(candles, decidedAt);
    const window = candles.slice(startIndex, lowerBound(candles, decidedAt + profile.maxHoldMs));
    const r = firstTouch({
      direction: d.direction as Direction, entry: d.price, stopPct: profile.defaultStopPct,
      target: profile.defaultTargets[0]!, decidedAt, maxHoldMs: profile.maxHoldMs,
      candles: window, intervalMs: 60_000, now,
    });
    const reason = Array.isArray(d.reasons) ? String((d.reasons as unknown[])[0] ?? "") : "";
    const key = [d.patternKey, d.profile, d.direction, d.decision, reason].join("|");
    let g = groups.get(key);
    if (!g) {
      g = { patternKey: d.patternKey, profile: d.profile, direction: d.direction, decision: d.decision, reason,
        total: 0, targetFirst: 0, stopFirst: 0, timeout: 0, pending: 0, targetFirstPct: null,
        avgMfePct: null, avgMaePct: null, mfeSum: 0, maeSum: 0, n: 0 };
      groups.set(key, g);
    }
    g.total++;
    const counter: Record<OutcomeLabel, "targetFirst" | "stopFirst" | "timeout" | "pending"> = {
      target_first: "targetFirst", stop_first: "stopFirst", timeout: "timeout", pending: "pending",
    };
    g[counter[r.label]]++;
    if (r.label !== "pending") { g.mfeSum += r.mfePct; g.maeSum += r.maePct; g.n++; }
  }
  return [...groups.values()].map(({ mfeSum, maeSum, n, ...g }) => ({
    ...g,
    targetFirstPct: g.targetFirst + g.stopFirst > 0
      ? Number(((100 * g.targetFirst) / (g.targetFirst + g.stopFirst)).toFixed(1)) : null,
    avgMfePct: n ? Number((mfeSum / n).toFixed(3)) : null,
    avgMaePct: n ? Number((maeSum / n).toFixed(3)) : null,
  }));
}

function lowerBound(candles: { openTime: number }[], t: number): number {
  let lo = 0, hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid]!.openTime < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

export async function candleCoverage() {
  const result = await db.execute(sql`
    SELECT interval, count(*)::int AS rows, min(open_time) AS first, max(open_time) AS last
      FROM btc_candles GROUP BY interval ORDER BY interval`);
  return result.rows;
}
