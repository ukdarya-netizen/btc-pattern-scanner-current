/**
 * Scheduled reports (owner 2026-11-12, as CAB / Nihilist): daily 22:00, weekly Sunday 10:00, monthly the 1st 11:00
 * (Dubai). Each period is claimed once in btc_reports and goes through the same delivery queue as the signals —
 * to the channel and every subscriber with access — with the report picture. A report missed by a restart goes out
 * late, within 24 h of its time; older ones are skipped. The same text answers /daily, /weekly, /monthly.
 */
import { db, btcReportsTable, btcSignalsTable, btcTelegramDeliveriesTable, pool } from "@workspace/db";
import { and, eq, gte, lt } from "drizzle-orm";
import { formatReport, latestSchedule, onDemandSchedule, reportEventId, type ReportKind, type ReportRow, type Schedule } from "./reportFormat";
import { logger } from "../lib/logger";
import { ownerEmail, recipientSql } from "../lib/users";
import { SIGNAL_CHANNEL } from "../telegram/transport";

export const REPORT_MARK = "__BTC_REPORT__\n";
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
  return formatReport(s, await rowsFor(s), label);
}

/** Every minute: a due report of each kind is built once and queued to the channel and the subscribers. */
export async function runReports(label: (key: string) => string, now = Date.now()): Promise<void> {
  for (const kind of ["daily", "weekly", "monthly"] as ReportKind[]) {
    const s = latestSchedule(kind, now);
    if (now < s.at || now - s.at > LATE_MS) continue;
    const text = formatReport(s, await rowsFor(s), label);
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
}
