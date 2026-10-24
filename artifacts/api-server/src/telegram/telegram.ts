import { db, btcSignalEventsTable, btcSignalsTable } from "@workspace/db";
import { and, asc, eq, isNull, lt } from "drizzle-orm";
import { PROFILES, type ProfileKey } from "../config/profiles";
import { logger } from "../lib/logger";

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

async function send(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHANNEL_ID;
  if (!token || !chatId) throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHANNEL_ID not set");
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Telegram HTTP ${res.status}`);
}

/**
 * Outbox: one message per pass, oldest first, only for live signals. Shadow
 * signal events are acknowledged silently. Failures are retried a bounded
 * number of times so a broken message can never block later ones forever.
 */
export async function deliverNext(patternLabel: (key: string) => string): Promise<void> {
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
    try {
      await send(formatEvent(signal, event, patternLabel(signal.patternKey)));
      await db.update(btcSignalEventsTable).set({ telegramSentAt: new Date() })
        .where(eq(btcSignalEventsTable.id, event.id));
    } catch (err) {
      await db.update(btcSignalEventsTable)
        .set({ telegramAttempts: event.telegramAttempts + 1 })
        .where(eq(btcSignalEventsTable.id, event.id));
      logger.warn({ err, eventId: event.id }, "telegram: delivery failed, will retry");
    }
    return; // pace: at most one live message per pass
  }
}
