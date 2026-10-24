import { db, btcSignalsTable, btcSignalEventsTable, type BtcSignal } from "@workspace/db";
import { eq } from "drizzle-orm";
import { PROFILES, type Direction, type ProfileKey } from "../config/profiles";
import { marginPnlPct } from "../lib/tradeMath";
import { logger } from "../lib/logger";
import { getCandlesRange, type PriceTick } from "../market/bingx";
import {
  applyCandle,
  applyTick,
  type PositionEvent,
  type PositionState,
  type TargetState,
} from "./positionEngine";

type Tracked = {
  id: number;
  profile: ProfileKey;
  leverage: number;
  state: PositionState;
  lastProcessedAt: number;
  dirty: boolean; // mfe/mae changed since last flush
  /** Ticks are held until missed time is replayed from 1m candles, in order. */
  needsCatchUp: boolean;
  queue: Promise<void>;
};

// Backstop only: the runtime marks positions for replay after 20 s without ticks.
const MAX_TICK_GAP_MS = 120_000;

const open = new Map<number, Tracked>();
const MFE_FLUSH_MS = 60_000;

function toState(row: BtcSignal): PositionState {
  return {
    direction: row.direction as Direction,
    entryPrice: row.entryPrice,
    stopPrice: row.stopPrice,
    targets: (row.targets as TargetState[]).map((t) => ({ ...t })),
    remainingFraction: row.remainingFraction,
    realizedPricePct: row.realizedPricePct,
    realizedExitNotional: row.realizedExitNotional,
    breakevenMoved: row.breakevenMoved,
    breakevenAfterFirstTarget: PROFILES[row.profile as ProfileKey].breakevenAfterFirstTarget,
    mfePct: row.mfePct,
    maePct: row.maePct,
    expiresAt: row.expiresAt.getTime(),
    closed: row.status === "closed",
    closeReason: null,
    exitPrice: null,
  };
}

export function trackSignal(row: BtcSignal): void {
  open.set(row.id, {
    id: row.id,
    profile: row.profile as ProfileKey,
    leverage: row.leverage,
    state: toState(row),
    lastProcessedAt: Math.max(row.detectedAt.getTime(), row.updatedAt.getTime()),
    dirty: false,
    needsCatchUp: false,
    queue: Promise.resolve(),
  });
}

export async function loadOpenSignals(): Promise<number> {
  const rows = await db.select().from(btcSignalsTable).where(eq(btcSignalsTable.status, "open"));
  for (const row of rows) {
    trackSignal(row);
    open.get(row.id)!.needsCatchUp = true; // time passed while the process was down
  }
  return rows.length;
}

export function openSignalCount(): number {
  return open.size;
}

export function hasOpenSignal(patternKey: string, rows: BtcSignal[]): boolean {
  return rows.some((r) => r.patternKey === patternKey && r.status === "open");
}

async function persist(t: Tracked, events: PositionEvent[]): Promise<void> {
  const s = t.state;
  const now = new Date();
  const closed = s.closed;
  await db.transaction(async (tx) => {
    await tx.update(btcSignalsTable).set({
      stopPrice: s.stopPrice,
      targets: s.targets,
      remainingFraction: s.remainingFraction,
      realizedPricePct: s.realizedPricePct,
      realizedExitNotional: s.realizedExitNotional,
      breakevenMoved: s.breakevenMoved,
      mfePct: s.mfePct,
      maePct: s.maePct,
      updatedAt: now,
      ...(closed ? {
        status: "closed",
        closedAt: now,
        closeReason: s.closeReason,
        exitPrice: s.exitPrice,
        pnlPricePct: s.realizedPricePct,
        pnlMarginPct: marginPnlPct(s.realizedPricePct, s.realizedExitNotional, t.leverage),
      } : {}),
    }).where(eq(btcSignalsTable.id, t.id));
    for (const event of events) {
      if (event.kind === "breakeven_moved") continue; // reported with the target
      const key = event.kind === "target_hit"
        ? `${t.id}:target:${event.index}`
        : `${t.id}:closed`;
      await tx.insert(btcSignalEventsTable).values({
        signalId: t.id,
        eventKey: key,
        kind: event.kind,
        price: event.price,
        detail: event.kind === "target_hit"
          ? { index: event.index, breakevenMoved: s.breakevenMoved, at: event.at }
          : {
            reason: event.reason, at: event.at,
            pnlPricePct: s.realizedPricePct,
            pnlMarginPct: marginPnlPct(s.realizedPricePct, s.realizedExitNotional, t.leverage),
            leverage: t.leverage,
          },
      }).onConflictDoNothing();
    }
  });
  t.dirty = false;
  if (closed) open.delete(t.id);
}

function enqueue(t: Tracked, job: () => Promise<void>): void {
  t.queue = t.queue.then(job).catch((err) => {
    logger.error({ err, signalId: t.id }, "tracker: persist failed");
  });
}

/** Live tick path: every open position sees every tick, in order. */
export function onTick(tick: PriceTick): void {
  for (const t of open.values()) {
    if (t.needsCatchUp || tick.at < t.lastProcessedAt) continue;
    if (tick.at - t.lastProcessedAt > MAX_TICK_GAP_MS && !t.state.closed) {
      t.needsCatchUp = true; // replay the gap first, never skip it
      continue;
    }
    const before = { mfe: t.state.mfePct, mae: t.state.maePct };
    const events = applyTick(t.state, tick.price, tick.at);
    t.lastProcessedAt = tick.at;
    if (t.state.mfePct !== before.mfe || t.state.maePct !== before.mae) t.dirty = true;
    if (events.length) enqueue(t, () => persist(t, events));
  }
}

/** Marks every position for replay (the live stream went silent). */
export function markAllForCatchUp(): void {
  for (const t of open.values()) t.needsCatchUp = true;
}

export function catchUpPending(): boolean {
  return [...open.values()].some((t) => t.needsCatchUp);
}

/**
 * Replays closed 1m candles from each position's last processed moment, then
 * releases it back to live ticks. Candles touching both stop and target count
 * the stop first (see applyCandle).
 */
export async function catchUpFromCandles(): Promise<void> {
  const pending = [...open.values()].filter((t) => t.needsCatchUp);
  if (pending.length === 0) return;
  const from = Math.min(...pending.map((t) => t.lastProcessedAt));
  const candles = await getCandlesRange("1m", from - 60_000, Date.now());
  for (const t of pending) {
    for (const c of candles) {
      const closeTime = c.time + 60_000;
      if (closeTime <= t.lastProcessedAt) continue;
      const before = { mfe: t.state.mfePct, mae: t.state.maePct };
      const events = applyCandle(t.state, { high: c.high, low: c.low, close: c.close, closeTime });
      t.lastProcessedAt = closeTime;
      if (t.state.mfePct !== before.mfe || t.state.maePct !== before.mae) t.dirty = true;
      if (events.length) enqueue(t, () => persist(t, events));
      if (t.state.closed) break;
    }
    t.needsCatchUp = false;
  }
}

/** Periodic MFE/MAE flush so the dashboard stays current without a write per tick. */
export function startMfeFlush(): NodeJS.Timeout {
  return setInterval(() => {
    for (const t of open.values()) {
      if (!t.dirty) continue;
      enqueue(t, async () => {
        await db.update(btcSignalsTable).set({
          mfePct: t.state.mfePct, maePct: t.state.maePct, updatedAt: new Date(),
        }).where(eq(btcSignalsTable.id, t.id));
        t.dirty = false;
      });
    }
  }, MFE_FLUSH_MS);
}
