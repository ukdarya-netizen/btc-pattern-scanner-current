/**
 * Subscription notices (owner 2026-11-12, from CAB): the subscriber is told about 3 hours before the subscription
 * ends and when it has ended; the owner gets one summary of the subscriptions that ended. Each notice is claimed
 * once in btc_reports (key sub_warn / sub_end + user + end date), so no new table and nothing is sent twice; a
 * renewed subscription (a new end date) gets its own notices. Checked every 10 minutes. Plain text.
 */
import { db, btcReportsTable, pool } from "@workspace/db";
import { logger } from "./logger";
import { isOwnerEmail, ownerChatId } from "./users";
import { sendMessage } from "../telegram/transport";
import { bilingual } from "../telegram/bilingual";

const H = 3_600_000;
const CONTACT = "@The_Lucy_x";
export const WARNING_TEXT = bilingual(["⏳ Ваша подписка заканчивается примерно через 3 часа", "", "Продлите доступ, чтобы не пропустить сигналы.", `Для продления — ${CONTACT}`].join("\n"));
export const ENDED_TEXT = bilingual(["⌛️ Подписка закончилась", "", "Сигналы и Dashboard больше недоступны.", `Для продления — ${CONTACT}`].join("\n"));

/** In the 3-hour warning window: ends in more than 2 h and less than 4 h (as CAB). */
export const inWarningWindow = (until: Date, now: number) => until.getTime() - now > 2 * H && until.getTime() - now < 4 * H;

async function claim(key: string, text: string): Promise<boolean> {
  const r = await db.insert(btcReportsTable).values({ periodKey: key, text, sentAt: new Date() }).onConflictDoNothing()
    .returning({ key: btcReportsTable.periodKey });
  return r.length > 0;
}

export async function runSubscriptionNotices(now = Date.now()): Promise<void> {
  const { rows } = await pool.query<{ id: number; name: string; email: string; chat_id: string | null; subscribed_until: Date }>(
    `SELECT id, name, email, chat_id, subscribed_until FROM btc_users
      WHERE status = 'approved' AND subscribed_until IS NOT NULL
        AND subscribed_until > $1::timestamptz - interval '1 day' AND subscribed_until < $1::timestamptz + interval '4 hours'`,
    [new Date(now)],
  );
  const ended: string[] = [];
  for (const u of rows) {
    if (isOwnerEmail(u.email)) continue;
    const until = new Date(u.subscribed_until);
    const stamp = until.toISOString();
    try {
      if (inWarningWindow(until, now) && u.chat_id && await claim(`sub_warn:${u.id}:${stamp}`, WARNING_TEXT)) {
        await sendMessage(u.chat_id, WARNING_TEXT);
      }
      if (until.getTime() <= now && await claim(`sub_end:${u.id}:${stamp}`, ENDED_TEXT)) {
        if (u.chat_id) await sendMessage(u.chat_id, ENDED_TEXT).catch(() => undefined);
        ended.push(`• ${u.name} (${u.email}${u.chat_id ? ` · ID ${u.chat_id}` : ""})`);
      }
    } catch (err) {
      logger.warn({ err, userId: u.id }, "btc: subscription notice not delivered");
    }
  }
  if (ended.length) {
    const owner = await ownerChatId();
    if (owner) await sendMessage(owner, [`⏰ Закончилось подписок: ${ended.length}`, "", ...ended].join("\n")).catch(() => undefined);
  }
}
