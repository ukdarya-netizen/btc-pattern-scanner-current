import { db, btcSignalEventsTable, btcSignalsTable, btcTelegramDeliveriesTable, pool } from "@workspace/db";
import { and, asc, eq, isNull, lt, lte } from "drizzle-orm";
import { ownerEmail, recipientSql } from "../lib/users";
import { PROFILES, type ProfileKey } from "../config/profiles";
import { PATTERNS } from "../engine/patterns";
import type { Metrics } from "../engine/snapshot";
import { logger } from "../lib/logger";
import { sendMessage, sendSignalPhoto, SIGNAL_CHANNEL, splitSignalCaption, TelegramError } from "./transport";
import { REPORT_MARK } from "../stats/reports";

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

// ── Message layout (owner 2026-11-12: "формат из других двух ботов") ───────────────────────────────────
// Taken from CAB and Nihilist: a header with what happened and the side (POSITION UPDATE / POSITION CLOSED),
// "entry → price (move) | time in position", the current stop and the next step, the position peak and the
// result on the close, hashtags at the end (ticker, pattern, side, style, event). The result is the clean price
// move — no leverage, no fees (owner). Leverage and liquidation stay in the signal only (BTC-specific).
// Plain text only (no HTML / Markdown): channel posts are copied as-is.

const sideRu = (direction: string) => (direction === "long" ? "ЛОНГ" : "ШОРТ");
const signed = (signal: SignalRow, price: number) =>
  ((price - signal.entryPrice) / signal.entryPrice) * 100 * (signal.direction === "long" ? 1 : -1);
const STYLE_RU: Record<string, string> = { scalp: "скальп", intraday: "интрадей", swing: "свинг" };
/** Style by the timeframe the pattern is evaluated on (as the dashboard). */
export function styleOf(tf: string): "scalp" | "intraday" | "swing" {
  return tf === "15m" || tf === "5m" ? "scalp" : tf === "30m" || tf === "1h" ? "intraday" : "swing";
}
function patternTf(signal: SignalRow): string {
  return PATTERNS.find((p) => p.key === signal.patternKey)?.evalTf ?? PROFILES[signal.profile as ProfileKey]?.timeframe ?? "4h";
}
/** Time in position, e.g. "2д 5ч", "3ч 20м", "45м" (as CAB). */
export function inPosition(from: Date | string, to: Date | string): string {
  const mins = Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60_000));
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  return d > 0 ? `${d}д ${h}ч` : h > 0 ? `${h}ч ${m}м` : `${m}м`;
}
function tags(signal: SignalRow, event: string | null): string {
  const tf = patternTf(signal);
  return [`#BTC`, `#${signal.patternKey}`, `#${signal.direction}`, `#${styleOf(tf)}`, event ? `#${event}` : null].filter(Boolean).join(" ");
}
type Target = { price: number; fraction: number; hitAt: string | null };
const targetsOf = (signal: SignalRow) => (signal.targets as Target[]) ?? [];
function nextTargetLine(signal: SignalRow, afterIndex: number): string | null {
  const ts = targetsOf(signal);
  const i = ts.findIndex((t, k) => k > afterIndex && !t.hitAt);
  return i < 0 ? null : `⏳ Дальше: цель ${i + 1} — ${fmt(ts[i]!.price)} (${pct(signed(signal, ts[i]!.price))})`;
}

export function formatEvent(signal: SignalRow, event: EventRow, patternLabel: string): string {
  const profile = PROFILES[signal.profile as ProfileKey];
  const side = `BTC ${sideRu(signal.direction)}`;
  const tf = patternTf(signal);
  const detail = event.detail as Record<string, unknown>;
  const price = event.price ?? signal.entryPrice;
  const priceLine = `${fmt(signal.entryPrice)} → ${fmt(price)} (${pct(signed(signal, price))}) | ${inPosition(signal.detectedAt, event.createdAt)}`;
  const stopNow = `🛡 ${signal.breakevenMoved && Math.abs(signal.stopPrice - signal.entryPrice) < 1e-9 ? "Стоп в безубытке" : "Стоп"}: ${fmt(signal.stopPrice)} (${pct(signed(signal, signal.stopPrice))} от входа)`;

  if (event.kind === "opened") {
    const ts = targetsOf(signal);
    const targets = ts.map((t, i) => {
      const last = i === ts.length - 1;
      const what = last ? (ts.length > 1 ? "закрыть остаток" : "закрыть позицию")
        : `закрыть ${Math.round(t.fraction * 100)}%${i === 0 && profile?.breakevenAfterFirstTarget ? ", стоп в безубыток" : ""}`;
      return `🎯 Цель ${i + 1}: ${fmt(t.price)} (${pct(signed(signal, t.price))}) — ${what}`;
    });
    return [
      `₿ BITCOIN MARGIN MASTER · ${side}`,
      `${patternLabel} · ${STYLE_RU[styleOf(tf)]} (${tf})`,
      ``,
      `📥 Вход: ${fmt(signal.entryPrice)}`,
      `🛑 Стоп: ${fmt(signal.stopPrice)} (${pct(signed(signal, signal.stopPrice))})`,
      ...targets,
      `⚙️ Плечо x${signal.leverage} · ликвидация ≈ ${fmt(signal.liquidationPrice)}`,
      ...rangeLines((signal.metrics as { pattern?: RangeDetail } | null)?.pattern ?? null),
      ...methodLines((signal.metrics as { pattern?: Record<string, any> } | null)?.pattern ?? null),
      ...metricLines(signal.metrics as Partial<Metrics> | null),
      ``,
      tags(signal, null),
    ].join("\n");
  }
  if (event.kind === "target_hit") {
    const index = Number(detail.index ?? 0);
    const ts = targetsOf(signal);
    const left = Math.max(0, Math.round((1 - ts.slice(0, index + 1).reduce((a, t) => a + t.fraction, 0)) * 100));
    return [
      `📊 ОБНОВЛЕНИЕ ПОЗИЦИИ — ${side}`,
      `🎯 Цель ${index + 1} достигнута`,
      priceLine,
      ``,
      `✂️ Закрыто ${Math.round((ts[index]?.fraction ?? 0) * 100)}% · в позиции ${left}%`,
      detail.breakevenMoved ? `🛡 Стоп в безубыток: ${fmt(signal.entryPrice)}` : stopNow,
      nextTargetLine(signal, index),
      ``,
      tags(signal, `target${index + 1}`),
    ].filter((l) => l !== null).join("\n");
  }
  if (event.kind === "position_update") {
    const move = Number(detail.movePct ?? 0);
    return [
      `📊 ОБНОВЛЕНИЕ ПОЗИЦИИ — ${side}`,
      move >= 0 ? `🚀 ${pct(move)}` : `🔻 ${pct(move)}`,
      priceLine,
      ``,
      stopNow,
      nextTargetLine(signal, -1),
      ``,
      tags(signal, null),
    ].filter((l) => l !== null).join("\n");
  }
  const reason = String(detail.reason);
  const title = reason === "take_profit" ? "🟢 ПРОФИТ: все цели достигнуты"
    : reason === "breakeven" ? "🔵 БЕЗУБЫТОК: стоп в точке входа"
      : reason === "timeout" ? "⏱ ЗАКРЫТО ПО ВРЕМЕНИ УДЕРЖАНИЯ"
        : "🔴 СТОП-ЛОСС";
  const tag = reason === "take_profit" ? "profit" : reason === "breakeven" ? "breakeven" : reason === "timeout" ? "expired" : "stop_loss";
  const ts = targetsOf(signal);
  const hit = ts.filter((t) => t.hitAt).length;
  const result = Number(detail.pnlPricePct ?? 0);
  return [
    `🏁 ПОЗИЦИЯ ЗАКРЫТА — ${side}`,
    title,
    priceLine,
    ``,
    `🎯 Взято целей: ${hit} из ${ts.length}`,
    `📈 Пик позиции: ${pct(signal.mfePct)}`,
    `💰 Итог: ${pct(result)} — чистое движение цены, без плеча и комиссий`,
    ``,
    tags(signal, tag),
  ].join("\n");
}

// ── Delivery age (Nihilist, owner 2026-11-10): a new signal older than 15 minutes is not sent — the entry has
// passed (after a restart or a queue stall); position updates and closes still go up to 6 hours late. ──
export const MAX_SIGNAL_AGE_MS = 15 * 60_000;
export const MAX_UPDATE_AGE_MS = 6 * 3_600_000;
export const isStale = (kind: string, createdAt: Date, now = Date.now()) =>
  now - createdAt.getTime() > (kind === "opened" ? MAX_SIGNAL_AGE_MS : MAX_UPDATE_AGE_MS);

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
    if (isStale(event.kind, event.createdAt)) {
      // Never sent: marked done so it does not block the queue; the dashboard still has it.
      await db.update(btcSignalEventsTable).set({ telegramAttempts: MAX_ATTEMPTS })
        .where(eq(btcSignalEventsTable.id, event.id));
      logger.warn({ eventId: event.id, kind: event.kind }, "Telegram: stale event not sent");
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
        if (body.startsWith(REPORT_MARK)) {
          body = body.slice(REPORT_MARK.length); // reports: text (pictures are the owner's, not changed here)
        } else if (body.startsWith(NEW_SIGNAL)) {
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
        } else if (delivery.eventId > 0) {
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
