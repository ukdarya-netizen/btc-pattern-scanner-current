import { db, btcSignalEventsTable, btcSignalsTable, btcTelegramDeliveriesTable, pool } from "@workspace/db";
import { and, asc, eq, isNull, lt, lte } from "drizzle-orm";
import { ownerEmail, recipientSql } from "../lib/users";
import { PROFILES, type ProfileKey } from "../config/profiles";
import type { Metrics } from "../engine/snapshot";
import { logger } from "../lib/logger";
import { sendMessage, sendSignalPhoto, SIGNAL_CHANNEL, splitSignalCaption, TelegramError } from "./transport";

const MAX_ATTEMPTS = 8;
const NEW_SIGNAL = "__BTC_NEW_SIGNAL__\n";
const TAKE_PROFIT = "__BTC_TAKE_PROFIT__\n";
const STOP_LOSS = "__BTC_STOP_LOSS__\n";
const POSITION_UPDATE = "__BTC_POSITION_UPDATE__\n";
const PHOTO_SENT = "__BTC_PHOTO_SENT__\n";

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
    ...(m.context?.heatmap ? [`Кластеры ликвидаций: выше ${m.context.heatmap.topAbove[0] ? `${fmt(m.context.heatmap.topAbove[0].price)} (${pct(m.context.heatmap.topAbove[0].distancePct)})` : "—"} · ниже ${m.context.heatmap.topBelow[0] ? `${fmt(m.context.heatmap.topBelow[0].price)} (${pct(m.context.heatmap.topBelow[0].distancePct)})` : "—"}`] : []),
    ...(m.context?.hyperliquidWhales ? [`Киты Hyperliquid: лонг ${usd(m.context.hyperliquidWhales.longUsd)} · шорт ${usd(m.context.hyperliquidWhales.shortUsd)}`] : []),
  ];
}

type RangeDetail = {
  event?: { kind: string; top: number; bottom: number; heightPct: number; bars: number; sweepPrice: number | null };
  volumeMult?: number | null;
  flowWindow?: string;
  futCvdUsd?: number | null;
  spotCvdUsd?: number | null;
};

/** Range context of a range-detector signal (empty for other patterns). */
export function rangeLines(detail: RangeDetail | null): string[] {
  const e = detail?.event;
  if (!e) return [];
  return [
    "",
    `Диапазон: ${fmt(e.bottom)} – ${fmt(e.top)} (${e.heightPct.toFixed(2)}%, ${e.bars} баров)`,
    ...(e.sweepPrice !== null && e.sweepPrice !== undefined ? [`Ложный пробой до ${fmt(e.sweepPrice)}`] : []),
    `Объём бара: ${detail?.volumeMult == null ? "—" : `${detail.volumeMult.toFixed(2)}x`} к среднему за 20 баров`,
    `CVD ${detail?.flowWindow ?? ""}: фьюч ${usd(detail?.futCvdUsd)} · спот ${usd(detail?.spotCvdUsd)}`,
  ];
}

/** Owner 2026-11-09: what the Smart Money / cascade signal stands on (empty for other methods). */
export function methodLines(detail: Record<string, any> | null): string[] {
  if (!detail) return [];
  if (detail.method === "smart_money" && detail.block) {
    return [
      "",
      `Ордер-блок ${detail.htf === "1d" ? "1D" : "4h"} (${detail.block.scope === "swing" ? "swing" : "internal"}): ${fmt(detail.block.bottom)} – ${fmt(detail.block.top)}`,
      `Слом структуры (CHoCH) ${detail.ltf}: уровень ${fmt(detail.chochLevel)}`,
    ];
  }
  if (detail.method === "liquidation_cascade") {
    return [
      "",
      `Каскад ликвидаций: ${usd(detail.spikeHourUsd)} за час (${detail.spikeMult == null ? "—" : `${Number(detail.spikeMult).toFixed(1)}x`} к среднему часу)`,
      `Экстремум каскада: ${fmt(detail.cascadeExtreme)} · реакция: хвост ${detail.reactionWickPct == null ? "—" : `${Number(detail.reactionWickPct).toFixed(2)}%`}`,
    ];
  }
  return [];
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
      ...rangeLines((signal.metrics as { pattern?: RangeDetail } | null)?.pattern ?? null),
      ...methodLines((signal.metrics as { pattern?: Record<string, any> } | null)?.pattern ?? null),
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
  if (event.kind === "position_update") {
    return [
      head,
      "Обновление позиции",
      `Цена: ${fmt(event.price ?? 0)}`,
      `Движение от входа: ${pct(Number(detail.movePct ?? 0))}`,
    ].join("\n");
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
    // Owner 2026-11-12 (as CAB / Nihilist): signals go to registered, approved users with an active subscription.
    const { rows: subscribers } = await pool.query<{ chatId: string }>(
      `SELECT u.chat_id AS "chatId" FROM btc_users u WHERE ${recipientSql("$2")} AND u.notify_since <= $1`,
      [event.createdAt, ownerEmail()],
    );
    const body = formatEvent(signal, event, patternLabel(signal.patternKey));
    const eventDetail = event.detail as Record<string, unknown>;
    const text = event.kind === "opened" ? `${NEW_SIGNAL}${body}`
      : event.kind === "target_hit" ? `${TAKE_PROFIT}${body}`
      : event.kind === "position_update" ? `${POSITION_UPDATE}${body}`
      : event.kind === "closed" && eventDetail.reason === "stop" ? `${STOP_LOSS}${body}` : body;
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
      const sub = await pool.query(`SELECT 1 FROM btc_users u WHERE u.chat_id = $1 AND ${recipientSql("$2")}`, [delivery.chatId, ownerEmail()]);
      if (!sub.rowCount) {
        await db.update(btcTelegramDeliveriesTable).set({ status: "skipped" })
          .where(eq(btcTelegramDeliveriesTable.id, delivery.id));
        continue;
      }
    }
    try {
      if (delivery.text.startsWith(PHOTO_SENT)) {
        const remainder = delivery.text.slice(PHOTO_SENT.length);
        if (remainder) await sendMessage(delivery.chatId, remainder);
      } else {
        let body = delivery.text;
        let image: "new-signal" | "take-profit" | "stop-loss" | "position-update" | null = null;
        if (body.startsWith(NEW_SIGNAL)) {
          image = "new-signal";
          body = body.slice(NEW_SIGNAL.length);
        } else if (body.startsWith(TAKE_PROFIT)) {
          image = "take-profit";
          body = body.slice(TAKE_PROFIT.length);
        } else if (body.startsWith(STOP_LOSS)) {
          image = "stop-loss";
          body = body.slice(STOP_LOSS.length);
        } else if (body.startsWith(POSITION_UPDATE)) {
          image = "position-update";
          body = body.slice(POSITION_UPDATE.length);
        } else {
          const [event] = await db.select({ kind: btcSignalEventsTable.kind, detail: btcSignalEventsTable.detail })
            .from(btcSignalEventsTable).where(eq(btcSignalEventsTable.id, delivery.eventId));
          if (event?.kind === "opened") image = "new-signal";
          else if (event?.kind === "target_hit") image = "take-profit";
          else if (event?.kind === "position_update") image = "position-update";
          else if (event?.kind === "closed" && (event.detail as Record<string, unknown> | null)?.reason === "stop") image = "stop-loss";
        }
        if (image) {
          const { caption, remainder } = splitSignalCaption(body);
          await sendSignalPhoto(delivery.chatId, caption, image);
          await db.update(btcTelegramDeliveriesTable).set({ text: `${PHOTO_SENT}${remainder}` })
            .where(eq(btcTelegramDeliveriesTable.id, delivery.id));
          if (remainder) await sendMessage(delivery.chatId, remainder);
        } else {
          await sendMessage(delivery.chatId, body);
        }
      }
      await db.update(btcTelegramDeliveriesTable).set({ status: "sent", sentAt: new Date() })
        .where(eq(btcTelegramDeliveriesTable.id, delivery.id));
    } catch (err) {
      const attempts = delivery.attempts + 1;
      const blocked = !delivery.channel && err instanceof TelegramError && err.code === 403;
      if (blocked) {
        // The user blocked the bot: signals off until /start.
        await pool.query("UPDATE btc_users SET notify = false, bot_blocked_at = now() WHERE chat_id = $1", [delivery.chatId]);
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
