/**
 * Scheduled reports (owner 2026-11-12, as CAB / Nihilist): daily 22:00, weekly Sunday 10:00, monthly the 1st 11:00
 * (Dubai). Each period is claimed once in btc_reports and goes through the same delivery queue as the signals —
 * to the channel and every subscriber with access — with the report picture. A report missed by a restart goes out
 * late, within 24 h of its time; older ones are skipped. The same text answers /daily, /weekly, /monthly.
 */
import { db, btcReportsTable, btcSignalsTable, btcTelegramDeliveriesTable, pool } from "@workspace/db";
import { and, eq, gte, lt } from "drizzle-orm";
import { formatMorning, formatReport, latestSchedule, morningSchedule, onDemandSchedule, reportEventId, type ReportKind, type ReportRow, type Schedule } from "./reportFormat";
import { scannerStatus } from "../engine/scanner";
import { bilingual } from "../telegram/bilingual";
import { getFearGreed } from "../market/fearGreed";
import { logger } from "../lib/logger";
import { ownerEmail, recipientSql } from "../lib/users";
import { SIGNAL_CHANNEL } from "../telegram/transport";

export const REPORT_MARK = "__BTC_REPORT__\n";
/** Morning market update: sent with the market-update picture. */
export const MARKET_MARK = "__BTC_MARKET_UPDATE__\n";
const LATE_MS = 24 * 3_600_000;

async function rowsFor(s: Schedule): Promise<ReportRow[]> {
  return db.select({
    direction: btcSignalsTable.direction, patternKey: btcSignalsTable.patternKey,
    pnlPricePct: btcSignalsTable.pnlPricePct, mfePct: btcSignalsTable.mfePct,
    closeReason: btcSignalsTable.closeReason, detectedAt: btcSignalsTable.detectedAt, closedAt: btcSignalsTable.closedAt,
  }).from(btcSignalsTable).where(and(
    eq(btcSignalsTable.live, true),
    eq(btcSignalsTable.status, "closed"),
    gte(btcSignalsTable.closedAt, new Date(s.from)),
    lt(btcSignalsTable.closedAt, new Date(s.to)),
  ));
}

/** On demand: today so far / last 7 days / this month so far. */
export async function onDemandReport(kind: ReportKind, label: (key: string) => string, now = Date.now()): Promise<string> {
  const s = onDemandSchedule(kind, now);
  return bilingual(formatReport(s, await rowsFor(s), label));
}

/** Every minute: a due report of each kind is built once and queued to the channel and the subscribers. */
export async function runReports(label: (key: string) => string, now = Date.now()): Promise<void> {
  for (const kind of ["daily", "weekly", "monthly"] as ReportKind[]) {
    const s = latestSchedule(kind, now);
    if (now < s.at || now - s.at > LATE_MS) continue;
    const text = bilingual(formatReport(s, await rowsFor(s), label));
    const claimed = await db.insert(btcReportsTable).values({ periodKey: s.key, text, sentAt: new Date() })
      .onConflictDoNothing().returning({ key: btcReportsTable.periodKey });
    if (!claimed.length) continue; // already queued
    const { rows: subs } = await pool.query<{ chatId: string }>(
      `SELECT u.chat_id AS "chatId" FROM btc_users u WHERE ${recipientSql("$1")}`, [ownerEmail()],
    );
    const eventId = reportEventId(s);
    await db.insert(btcTelegramDeliveriesTable).values([
      { eventId, chatId: SIGNAL_CHANNEL, channel: true, text: `${REPORT_MARK}${text}` },
      ...subs.map((u) => ({ eventId, chatId: u.chatId, channel: false, text: `${REPORT_MARK}${text}` })),
    ]).onConflictDoNothing();
    logger.info({ period: s.key, recipients: subs.length + 1 }, "BTC report queued");
  }
  await runMorning(now);
}

async function queueText(eventId: number, text: string, mark: string): Promise<number> {
  const { rows: subs } = await pool.query<{ chatId: string }>(
    `SELECT u.chat_id AS "chatId" FROM btc_users u WHERE ${recipientSql("$1")}`, [ownerEmail()],
  );
  await db.insert(btcTelegramDeliveriesTable).values([
    { eventId, chatId: SIGNAL_CHANNEL, channel: true, text: `${mark}${text}` },
    ...subs.map((u) => ({ eventId, chatId: u.chatId, channel: false, text: `${mark}${text}` })),
  ]).onConflictDoNothing();
  return subs.length + 1;
}

const MORNING_LATE_MS = 3 * 3_600_000;
const METRICS_FRESH_MS = 15 * 60_000;
const FEAR_GREED_WAIT_MS = 30 * 60_000;

/**
 * Morning Market update (owner 2026-11-12), 09:00 Dubai, with her market-update picture: Fear / Greed, liquidations over 24 h, price and its change
 * over 24 h, from the scanner's last 5m cycle (CoinGlass liquidations of all exchanges, BingX price). Waits for fresh
 * metrics; Fear / Greed is waited for up to 30 minutes, then the report goes with «—». Later than 3 h it is skipped.
 */
async function runMorning(now: number): Promise<void> {
  const s = morningSchedule(now);
  if (now < s.at || now - s.at > MORNING_LATE_MS) return;
  const done = await db.select({ key: btcReportsTable.periodKey }).from(btcReportsTable).where(eq(btcReportsTable.periodKey, s.key)).limit(1);
  if (done.length) return;
  const m = scannerStatus.lastMetrics;
  const closeAt = scannerStatus.lastCandleCloseAt ? Date.parse(scannerStatus.lastCandleCloseAt) : 0;
  if (!m || now - closeAt > METRICS_FRESH_MS) return; // metrics of a successful cycle within 15 min; else next minute
  const fearGreed = await getFearGreed();
  if (!fearGreed && now - s.at < FEAR_GREED_WAIT_MS) return;
  const text = bilingual(formatMorning(s, {
    price: Number.isFinite(m.price) ? m.price : null,
    change24hPct: m.priceChangePct?.["24h"] ?? null,
    liqLongUsd: m.liqLongUsd?.["24h"] ?? null,
    liqShortUsd: m.liqShortUsd?.["24h"] ?? null,
    fearGreed,
  }));
  const claimed = await db.insert(btcReportsTable).values({ periodKey: s.key, text, sentAt: new Date() })
    .onConflictDoNothing().returning({ key: btcReportsTable.periodKey });
  if (!claimed.length) return;
  const recipients = await queueText(s.eventId, text, MARKET_MARK);
  logger.info({ period: s.key, recipients }, "BTC morning report queued");
}
