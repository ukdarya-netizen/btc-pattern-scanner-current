import { db, btcSignalEventsTable, btcSignalsTable, btcTelegramDeliveriesTable, pool } from "@workspace/db";
import { and, asc, eq, isNull, lt, lte } from "drizzle-orm";
import { ownerEmail, recipientSql } from "../lib/users";
import { PROFILES, type ProfileKey } from "../config/profiles";
import { PATTERNS } from "../engine/patterns";
import type { Metrics } from "../engine/snapshot";
import { logger } from "../lib/logger";
import { imageFile, sendMessage, sendSignalPhoto, SIGNAL_CHANNEL, splitSignalCaption, TelegramError, type SignalImage } from "./transport";
import { MARKET_MARK, parseReportMark } from "../stats/reports";
import { bilingual } from "./bilingual";

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

/**
 * Owner 2026-11-13: colour marks so the metrics read at a glance, as CAB (mark after the value):
 * 🟢 up / buying · 🔴 down / selling · 🟡 about zero. Thresholds: price and OI ±0.3%, CVD ±$1M, takers ±3%.
 * Volume vs average: 🔥 ≥ 2x · 🟢 ≥ 1.3x · 🟡 below. Liquidations: 🔴 longs washed out, 🟢 shorts, ≥ $1M an hour.
 * For OI green means OI is growing (positions opened), not a bullish reading.
 */
const mark = (v: number | null | undefined, band: number) => (v == null ? "" : v >= band ? "🟢" : v <= -band ? "🔴" : "🟡");
const volMark = (v: number | null | undefined) => (v == null ? "" : v >= 2 ? "🔥" : v >= 1.3 ? "🟢" : "🟡");

/** Funding line as CAB: BingX 8 h rate with the same reading thresholds (typical neutral ≈ ±0.01%). */
export function fundingLine(bingx: number | null | undefined, cgOiWeighted: number | null | undefined): string {
  const cg = cgOiWeighted == null ? "" : ` · CoinGlass OI-взвеш. ${cgOiWeighted >= 0 ? "+" : ""}${cgOiWeighted.toFixed(4)}%`;
  if (bingx == null) return `⚖️ Фандинг (8ч): BingX —${cg}`;
  // Colour as CAB: shorts paying (≤ −0.01%) 🟢, longs paying ≥ 0.02% 🔴, between 🟡 (owner 2026-11-13).
  const v = `${bingx >= 0 ? "+" : ""}${bingx.toFixed(4)}%${bingx <= -0.01 ? "🟢" : bingx >= 0.02 ? "🔴" : "🟡"}`;
  const [icon, note] = bingx <= -0.05 ? ["💰", " — шорты в ловушке, сквиз-давление"]
    : bingx <= -0.01 ? ["💰", " — шорты платят"]
      : bingx >= 0.1 ? ["⚠️", " — лонги перегреты"]
        : bingx >= 0.02 ? ["📈", " — лонги платят"] : ["⚖️", ""];
  return `${icon} Фандинг (8ч): BingX ${v}${note}${cg}`;
}

/** Owner 2026-11-13: position updates show the same block «now» (scanner's last 5m cycle). */
export const NOW_TITLE = "📊 Рынок сейчас (CoinGlass, все биржи)";

/** Owner 2026-11-12: every entry metric as CAB — price, OI, CVD, takers, volume, liquidations, funding, WI, crowd, OB. */
export function metricLines(m: Partial<Metrics> | null, title = "📊 Рынок на входе (CoinGlass, все биржи)"): string[] {
  if (!m || !m.oiChangePct) return [];
  const tf = <K extends string>(o: Partial<Record<K, number | null>> | undefined, keys: K[], f: (v: number | null | undefined) => string, m: (v: number | null | undefined) => string = () => "") =>
    keys.map((k) => `${k} ${f(o?.[k])}${m(o?.[k])}`).join(" · ");
  const pm = (v: number | null | undefined) => mark(v, 0.3), cm = (v: number | null | undefined) => mark(v, 1e6), tm = (v: number | null | undefined) => mark(v, 3);
  const liqL = (v: number | null | undefined) => (v != null && v >= 1e6 ? "🔴" : ""), liqS = (v: number | null | undefined) => (v != null && v >= 1e6 ? "🟢" : "");
  const liq1h = (m.liqLongUsd?.["1h"] ?? 0) + (m.liqShortUsd?.["1h"] ?? 0);
  const liq24h = (m.liqLongUsd?.["24h"] ?? 0) + (m.liqShortUsd?.["24h"] ?? 0);
  const wi = m.whaleIndex;
  const wiPart = wi == null ? null : `WI ${wi >= 0 ? "+" : ""}${wi.toFixed(1)}${wi >= 10 ? "🟢" : wi <= -10 ? "🔴" : "🟡"}${m.whaleIndex4h == null ? "" : ` (4h ${m.whaleIndex4h >= 0 ? "+" : ""}${m.whaleIndex4h.toFixed(1)})`}`;
  const crowd = m.longShortRatio == null ? null : `Толпа ${((m.longShortRatio / (1 + m.longShortRatio)) * 100).toFixed(0)}% лонг (Binance)`;
  const ob = m.orderbookBidAskRatio == null ? null : `OB ${m.orderbookBidAskRatio.toFixed(2)}x${m.orderbookBidAskRatio >= 1.5 ? "🟢" : m.orderbookBidAskRatio <= 0.7 ? "🔴" : "🟡"}`;
  const compact = [wiPart, crowd, ob].filter(Boolean);
  return [
    "",
    title,
    `Цена: ${tf(m.priceChangePct, ["1h", "4h", "24h"], p2, pm)}`,
    `OI: ${tf(m.oiChangePct, ["15m", "30m", "1h", "4h", "24h"], p2, pm)}`,
    `CVD спот: ${tf(m.spotCvdUsd, ["15m", "30m", "1h", "4h"], usd, cm)}`,
    `CVD фьюч: ${tf(m.futCvdUsd, ["15m", "30m", "1h", "4h"], usd, cm)}`,
    `Тейкер фьюч: ${tf(m.futTakerNetPct, ["15m", "1h", "4h"], p2, tm)}`,
    `Тейкер спот: ${tf(m.spotTakerNetPct, ["15m", "1h", "4h"], p2, tm)}`,
    `Объём к среднему: фьюч ${tf(m.futVolumeMult, ["15m", "1h"], x, volMark)} · спот ${tf(m.spotVolumeMult, ["15m", "1h"], x, volMark)}`,
    `Ликвидации 1h: лонги ${usd(m.liqLongUsd?.["1h"])}${liqL(m.liqLongUsd?.["1h"])} · шорты ${usd(m.liqShortUsd?.["1h"])}${liqS(m.liqShortUsd?.["1h"])} · 24h: лонги ${usd(m.liqLongUsd?.["24h"])} · шорты ${usd(m.liqShortUsd?.["24h"])}${liq24h > 0 ? ` · 1h/24h ${((liq1h / liq24h) * 100).toFixed(1)}%` : ""}`,
    fundingLine(m.fundingBingxPct, m.fundingRatePct),
    ...(compact.length ? [`📊 ${compact.join(" · ")}`] : []),
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
// move — no leverage, no fees (owner). Owner 2026-11-12: no leverage or liquidation price in any message.
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

/** Owner 2026-11-12: the signal says which trading system, which pattern and which timeframe it is. */
export function systemLines(signal: Pick<SignalRow, "patternKey" | "detectedAt" | "expiresAt">, patternLabel: string): string[] {
  const key = signal.patternKey;
  const tf = PATTERNS.find((p) => p.key === key)?.evalTf;
  const bare = patternLabel.replace(/ · (4h|1D)$/, "").replace(/ · (скальп|интрадей|свинг)/, "").replace(/ · (лонг|шорт)$/, "");
  let system: string, pattern: string, frame: string;
  const range = /^(h4|d1)_(breakout|deviation)_/.exec(key);
  const smc = /^smc_(4h|1d)_(\w+?)_(long|short)$/.exec(key);
  if (range) {
    system = "Диапазон (рейндж)";
    pattern = bare;
    frame = range[1] === "h4" ? "4h" : "1D";
  } else if (smc) {
    system = "Smart Money";
    pattern = `ордер-блок ${smc[1] === "1d" ? "1D" : "4h"} + слом структуры (CHoCH) ${smc[2]}`;
    frame = `${smc[2]} вход · ${smc[1] === "1d" ? "1D" : "4h"} старший`;
  } else if (key.startsWith("lc_")) {
    system = "Каскад ликвидаций";
    pattern = bare;
    frame = tf ?? "15m";
  } else if (key.startsWith("neon_")) {
    system = "ABNeon уровни";
    pattern = bare;
    frame = tf ?? (key.includes("_1d_") ? "1D" : "4h"); // owner 2026-11-14: ABNeon / Stealth on 1D
  } else {
    system = "—";
    pattern = bare;
    frame = tf ?? "4h";
  }
  const styleTf = smc ? smc[2]! : range ? (range[1] === "h4" ? "4h" : "1d") : frame;
  const hold = signal.expiresAt ? inPosition(signal.detectedAt, signal.expiresAt).replace(/^(\d+д) 0ч$/, "$1") : null;
  return [
    `Система: ${system}`,
    `Паттерн: ${pattern}`,
    `Таймфрейм: ${frame} · ${STYLE_RU[styleOf(styleTf)]}`,
    ...(hold ? [`Макс. удержание: ${hold}`] : []),
  ];
}

export function formatEvent(signal: SignalRow, event: EventRow, patternLabel: string): string {
  const profile = PROFILES[signal.profile as ProfileKey];
  const side = `BTC ${sideRu(signal.direction)}`;
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
      ...systemLines(signal, patternLabel),
      ``,
      `📥 Вход: ${fmt(signal.entryPrice)}`,
      `🛑 Стоп: ${fmt(signal.stopPrice)} (${pct(signed(signal, signal.stopPrice))})`,
      ...targets,
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
      ...metricLines(detail.metrics as Partial<Metrics> | null, NOW_TITLE),
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
      ...metricLines(detail.metrics as Partial<Metrics> | null, NOW_TITLE),
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

/** Select the matching illustration for a persisted signal event. */
export function eventImage(kind: string, detail: Record<string, unknown> | null): SignalImage | null {
  if (kind === "opened") return "new-signal";
  if (kind === "target_hit") return "take-profit";
  if (kind === "position_update") return "position-update";
  if (kind === "closed") {
    if (detail?.reason === "take_profit") return "take-profit";
    if (detail?.reason === "stop") return "stop-loss";
  }
  return null;
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
    // Owner 2026-11-13: Russian and English in one message.
    const body = bilingual(formatEvent(signal, event, patternLabel(signal.patternKey)));
    const eventDetail = event.detail as Record<string, unknown>;
    const selectedImage = eventImage(event.kind, eventDetail);
    const marker = selectedImage === "new-signal" ? NEW_SIGNAL
      : selectedImage === "take-profit" ? TAKE_PROFIT
        : selectedImage === "stop-loss" ? STOP_LOSS
          : selectedImage === "position-update" ? POSITION_UPDATE : null;
    const text = marker ? `${marker}${body}` : body;
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
        let image: SignalImage | null = null;
        if (body.startsWith(MARKET_MARK)) {
          // Market update (owner 2026-11-12): her picture with the text; text only if the picture is not in place.
          body = body.slice(MARKET_MARK.length);
          if (await imageFile("market-update")) image = "market-update";
        } else if (parseReportMark(body)) {
          // Reports (owner 2026-11-13): her picture of that report with the text; text only if the picture is not there.
          const r = parseReportMark(body)!;
          body = r.body;
          if (r.kind && await imageFile(`report-${r.kind}`)) image = `report-${r.kind}`;
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
          image = eventImage(event?.kind ?? "", event?.detail as Record<string, unknown> | null);
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
