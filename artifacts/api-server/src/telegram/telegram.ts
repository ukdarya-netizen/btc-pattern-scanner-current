import { db, btcSignalEventsTable, btcSignalsTable, btcTelegramDeliveriesTable, btcTelegramSubscribersTable } from "@workspace/db";
import { and, asc, eq, isNull, lt, lte } from "drizzle-orm";
import { PROFILES, type ProfileKey } from "../config/profiles";
import type { Metrics } from "../engine/snapshot";
import { logger } from "../lib/logger";
import { sendMessage, SIGNAL_CHANNEL, TelegramError } from "./transport";

const MAX_ATTEMPTS = 8;

function fmt(price: number): string {
  return price >= 1000 ? price.toFixed(1) : price.toPrecision(6);
}
function pct(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}
function dirLabel(direction: string): string {
  return direction === "long" ? "ЛОНГ" : "ШОРТ";
}

const CLOSE_TEXT: Record<string, string> = {
  take_profit: "Все цели достигнуты",
  stop: "Стоп-лосс",
  breakeven: "Закрыто в безубыток",
  timeout: "Закрыто по времени удержания",
};

type SignalRow = typeof btcSignalsTable.$inferSelect;
type EventRow = typeof btcSignalEventsTable.$inferSelect;

const usd = (v: number | null | undefined) => {
  if (v == null) return "—";
  const a = Math.abs(v);
  const text = a >= 1e9 ? `${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : `${(a / 1e3).toFixed(0)}K`;
  return `${v < 0 ? "−" : ""}$${text}`;
};
const p2 = (v: number | null | undefined) => (v == null ? "—" : pct(v));
const x = (v: number | null | undefined) => (v == null ? "—" : `${v.toFixed(2)}x`);

/** Decision-time market context (the same metrics the pattern saw). */
export function metricLines(m: Partial<Metrics> | null): string[] {
  if (!m || !m.oiChangePct) return [];
  return [
    "",
    `OI: 15m ${p2(m.oiChangePct["15m"])} · 1h ${p2(m.oiChangePct["1h"])} · 4h ${p2(m.oiChangePct["4h"])} · 24h ${p2(m.oiChangePct["24h"])}`,
    `CVD 1h: фьюч ${usd(m.futCvdUsd?.["1h"])} · спот ${usd(m.spotCvdUsd?.["1h"])}`,
    `Тейкер 1h: фьюч ${p2(m.futTakerNetPct?.["1h"])} · спот ${p2(m.spotTakerNetPct?.["1h"])}`,
    `Объём 1h: фьюч ${x(m.futVolumeMult?.["1h"])} · спот ${x(m.spotVolumeMult?.["1h"])}`,
    `Ликвидации 1h: лонги ${usd(m.liqLongUsd?.["1h"])} · шорты ${usd(m.liqShortUsd?.["1h"])}`,
    `Фандинг ${m.fundingRatePct == null ? "—" : `${m.fundingRatePct.toFixed(4)}%`} · L/S ${m.longShortRatio == null ? "—" : m.longShortRatio.toFixed(2)}`,
  ];
}

/** Plain text only (no HTML/Markdown), as the channel posts are copied as-is. */
export function formatEvent(signal: SignalRow, event: EventRow, patternLabel: string): string {
  const profile = PROFILES[signal.profile as ProfileKey];
  const head = `BTC ${dirLabel(signal.direction)} · ${profile.label} x${signal.leverage}`;
  const detail = event.detail as Record<string, unknown>;
  if (event.kind === "opened") {
    const targets = (signal.targets as Array<{ price: number }>)
      .map((t, i) => `Цель ${i + 1}: ${fmt(t.price)} (${pct(((t.price - signal.entryPrice) / signal.entryPrice) * 100 * (signal.direction === "long" ? 1 : -1))})`);
    const stopMove = ((signal.stopPrice - signal.entryPrice) / signal.entryPrice) * 100 * (signal.direction === "long" ? 1 : -1);
    return [
      head,
      `Паттерн: ${patternLabel}`,
      `Вход: ${fmt(signal.entryPrice)}`,
      `Стоп: ${fmt(signal.stopPrice)} (${pct(stopMove)})`,
      ...targets,
      `Ликвидация ≈ ${fmt(signal.liquidationPrice)}`,
      ...metricLines(signal.metrics as Partial<Metrics> | null),
    ].join("\n");
  }
  if (event.kind === "target_hit") {
    const index = Number(detail.index ?? 0);
    return [
      head,
      `Цель ${index + 1} достигнута: ${fmt(event.price ?? 0)}`,
      detail.breakevenMoved ? "Стоп перенесён в безубыток" : null,
    ].filter(Boolean).join("\n");
  }
  const pnlPrice = Number(detail.pnlPricePct ?? 0);
  const pnlMargin = Number(detail.pnlMarginPct ?? 0);
  return [
    head,
    `${CLOSE_TEXT[String(detail.reason)] ?? "Позиция закрыта"}: ${fmt(event.price ?? 0)}`,
    `Результат: ${pct(pnlPrice)} цены · ${pct(pnlMargin)} к марже с учётом комиссий`,
  ].join("\n");
}

let delivering = false;

async function deliverBatch(patternLabel: (key: string) => string): Promise<void> {
  const rows = await db
    .select({ event: btcSignalEventsTable, signal: btcSignalsTable })
    .from(btcSignalEventsTable)
    .innerJoin(btcSignalsTable, eq(btcSignalsTable.id, btcSignalEventsTable.signalId))
    .where(and(isNull(btcSignalEventsTable.telegramSentAt), lt(btcSignalEventsTable.telegramAttempts, MAX_ATTEMPTS)))
    .orderBy(asc(btcSignalEventsTable.id))
    .limit(20);
  for (const { event, signal } of rows) {
    if (!signal.live) {
      await db.update(btcSignalEventsTable).set({ telegramSentAt: new Date() })
        .where(eq(btcSignalEventsTable.id, event.id));
      continue;
    }
    const subscribers = await db.select().from(btcTelegramSubscribersTable).where(and(
      eq(btcTelegramSubscribersTable.active, true),
      lte(btcTelegramSubscribersTable.subscribedAt, event.createdAt),
    ));
    const text = formatEvent(signal, event, patternLabel(signal.patternKey));
    await db.insert(btcTelegramDeliveriesTable).values([
      { eventId: event.id, chatId: SIGNAL_CHANNEL, channel: true, text },
      ...subscribers.map((s) => ({ eventId: event.id, chatId: s.chatId, channel: false, text })),
    ]).onConflictDoNothing();
  }

  const pending = await db.select().from(btcTelegramDeliveriesTable).where(and(
    eq(btcTelegramDeliveriesTable.status, "pending"),
    lte(btcTelegramDeliveriesTable.nextAttemptAt, new Date()),
  )).orderBy(asc(btcTelegramDeliveriesTable.id)).limit(20);
  for (const delivery of pending) {
    if (!delivery.channel) {
      const [subscriber] = await db.select().from(btcTelegramSubscribersTable)
        .where(eq(btcTelegramSubscribersTable.chatId, delivery.chatId));
      if (!subscriber?.active) {
        await db.update(btcTelegramDeliveriesTable).set({ status: "skipped" })
          .where(eq(btcTelegramDeliveriesTable.id, delivery.id));
        continue;
      }
    }
    try {
      await sendMessage(delivery.chatId, delivery.text);
      await db.update(btcTelegramDeliveriesTable).set({ status: "sent", sentAt: new Date() })
        .where(eq(btcTelegramDeliveriesTable.id, delivery.id));
    } catch (err) {
      const attempts = delivery.attempts + 1;
      const blocked = !delivery.channel && err instanceof TelegramError && err.code === 403;
      if (blocked) {
        await db.update(btcTelegramSubscribersTable).set({ active: false, updatedAt: new Date() })
          .where(eq(btcTelegramSubscribersTable.chatId, delivery.chatId));
      }
      await db.update(btcTelegramDeliveriesTable).set({
        attempts, status: blocked ? "skipped" : attempts >= MAX_ATTEMPTS ? "failed" : "pending",
        nextAttemptAt: new Date(Date.now() + Math.max(
          3000 * 2 ** Math.min(attempts, 8),
          err instanceof TelegramError ? err.retryAfter * 1000 : 0,
        )),
      }).where(eq(btcTelegramDeliveriesTable.id, delivery.id));
      logger.warn({ err, deliveryId: delivery.id, attempts }, "Telegram recipient delivery failed");
    }
    // Stay comfortably below the bot-wide Telegram send limit.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  for (const { event, signal } of rows) {
    if (!signal.live) continue;
    const deliveries = await db.select().from(btcTelegramDeliveriesTable)
      .where(eq(btcTelegramDeliveriesTable.eventId, event.id));
    if (!deliveries.length || deliveries.some((d) => d.status === "pending")) continue;
    await db.update(btcSignalEventsTable).set(
      deliveries.some((d) => d.status === "failed")
        ? { telegramAttempts: MAX_ATTEMPTS }
        : { telegramSentAt: new Date() },
    ).where(eq(btcSignalEventsTable.id, event.id));
  }
}

/** One worker per process; successes persist separately for every recipient. */
export async function deliverNext(patternLabel: (key: string) => string): Promise<void> {
  if (delivering) return;
  delivering = true;
  try { await deliverBatch(patternLabel); }
  finally { delivering = false; }
}
