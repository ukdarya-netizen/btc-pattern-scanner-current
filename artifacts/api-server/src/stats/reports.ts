import { db, btcReportsTable, btcSignalsTable } from "@workspace/db";
import { and, eq, gte, isNull, lt } from "drizzle-orm";
import { completedPeriods, formatReport, type Period } from "./reportFormat";
import { logger } from "../lib/logger";
import { sendMessage, SIGNAL_CHANNEL } from "../telegram/transport";

const MAX_ATTEMPTS = 8;

export { completedPeriods, formatReport };

async function prepare(period: Period): Promise<void> {
  const [existing] = await db.select({ key: btcReportsTable.periodKey }).from(btcReportsTable)
    .where(eq(btcReportsTable.periodKey, period.key));
  if (existing) return;
  const rows = await db.select({
    profile: btcSignalsTable.profile, direction: btcSignalsTable.direction,
    patternKey: btcSignalsTable.patternKey, pnlMarginPct: btcSignalsTable.pnlMarginPct,
    pnlPricePct: btcSignalsTable.pnlPricePct, closeReason: btcSignalsTable.closeReason,
  }).from(btcSignalsTable).where(and(
    eq(btcSignalsTable.live, true),
    eq(btcSignalsTable.status, "closed"),
    gte(btcSignalsTable.closedAt, period.start),
    lt(btcSignalsTable.closedAt, period.end),
  ));
  const text = formatReport(period.title, rows);
  // An empty period is recorded as already handled, so nothing is posted.
  await db.insert(btcReportsTable).values({
    periodKey: period.key, text: text ?? "", sentAt: text ? null : new Date(),
  }).onConflictDoNothing();
}

/** Builds due reports once and posts unsent ones to the channel. */
export async function runReports(now = Date.now()): Promise<void> {
  for (const period of completedPeriods(now)) await prepare(period);
  const pending = await db.select().from(btcReportsTable)
    .where(and(isNull(btcReportsTable.sentAt), lt(btcReportsTable.attempts, MAX_ATTEMPTS)));
  for (const report of pending) {
    try {
      await sendMessage(SIGNAL_CHANNEL, report.text);
      await db.update(btcReportsTable).set({ sentAt: new Date() })
        .where(eq(btcReportsTable.periodKey, report.periodKey));
    } catch (err) {
      await db.update(btcReportsTable).set({ attempts: report.attempts + 1 })
        .where(eq(btcReportsTable.periodKey, report.periodKey));
      logger.warn({ err, period: report.periodKey }, "BTC report delivery failed");
    }
  }
}
