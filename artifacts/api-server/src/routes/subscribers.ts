/**
 * «Подписчики» (owner 2026-11-12, as in CAB and Nihilist): everyone who pressed /start in the bot — owner only.
 * Names come from Telegram (getChat), cached for 6 h and fetched in the background, so the page never waits
 * on Telegram; the table keeps no names (no schema change).
 */
import { Router } from "express";
import { db, btcTelegramDeliveriesTable, btcTelegramSubscribersTable } from "@workspace/db";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import { isOwnerRequest, requireOwner } from "../lib/ownerAccess";
import { telegramCall } from "../telegram/transport";

type ChatInfo = { name: string | null; username: string | null; at: number };
const NAME_TTL_MS = 6 * 3_600_000;
const names = new Map<string, ChatInfo>();
let fetching = false;

async function fillNames(chatIds: string[]): Promise<void> {
  if (fetching || !process.env.TELEGRAM_BOT_TOKEN) return;
  fetching = true;
  try {
    for (const id of chatIds) {
      const c = names.get(id);
      if (c && Date.now() - c.at < NAME_TTL_MS) continue;
      try {
        const chat = await telegramCall<{ first_name?: string; last_name?: string; title?: string; username?: string }>("getChat", { chat_id: id });
        const name = [chat.first_name, chat.last_name].filter(Boolean).join(" ") || chat.title || null;
        names.set(id, { name, username: chat.username ?? null, at: Date.now() });
      } catch {
        names.set(id, { name: c?.name ?? null, username: c?.username ?? null, at: Date.now() });
      }
      await new Promise((r) => setTimeout(r, 60));
    }
  } finally { fetching = false; }
}

const router = Router();

/** Is this viewer the owner (MiniApp from an admin chat, or the dashboard PIN)? Decides whether the tab is shown. */
router.get("/btc/owner", (req, res) => { res.json({ owner: isOwnerRequest(req) }); });

router.get("/btc/subscribers", requireOwner, async (_req, res) => {
  try {
    const subs = await db.select().from(btcTelegramSubscribersTable);
    const del = await db.select({
      chatId: btcTelegramDeliveriesTable.chatId,
      sent: sql<number>`count(*) filter (where ${btcTelegramDeliveriesTable.status} = 'sent')::int`,
      failed: sql<number>`count(*) filter (where ${btcTelegramDeliveriesTable.status} = 'failed')::int`,
      lastSentAt: sql<string | null>`max(${btcTelegramDeliveriesTable.sentAt})`,
    }).from(btcTelegramDeliveriesTable)
      .where(sql`not ${btcTelegramDeliveriesTable.channel}`)
      .groupBy(btcTelegramDeliveriesTable.chatId);
    const byChat = new Map(del.map((d) => [d.chatId, d]));
    void fillNames(subs.map((s) => s.chatId)).catch((err) => logger.warn({ err }, "subscriber names not fetched"));
    const dayStart = Math.floor((Date.now() + 4 * 3_600_000) / 86_400_000) * 86_400_000 - 4 * 3_600_000; // Dubai day
    const rows = subs.map((s) => {
      const d = byChat.get(s.chatId);
      const n = names.get(s.chatId);
      return {
        chatId: s.chatId, name: n?.name ?? null, username: n?.username ?? null, active: s.active,
        subscribedAt: s.subscribedAt, updatedAt: s.updatedAt,
        sent: d?.sent ?? 0, failed: d?.failed ?? 0, lastSentAt: d?.lastSentAt ?? null,
      };
    });
    res.json({
      rows,
      totals: {
        all: rows.length,
        active: rows.filter((r) => r.active).length,
        inactive: rows.filter((r) => !r.active).length,
        newToday: rows.filter((r) => r.active && new Date(r.subscribedAt).getTime() >= dayStart).length,
      },
      namesPending: rows.filter((r) => !names.has(r.chatId)).length,
    });
  } catch (err) {
    logger.error({ err }, "btc subscribers failed");
    res.status(500).json({ error: "subscribers_failed" });
  }
});

export default router;
