import { db, btcTelegramStateTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { handleUpdate, setupBotProfile } from "./bot";
import { telegramCall, TelegramError, type TelegramUpdate } from "./transport";

let running = false;
let adminHandler: ((command: string) => Promise<string>) | null = null;

/** Admin-only commands (/status, /open) from TELEGRAM_ADMIN_CHAT_IDS chats. */
export function setAdminCommandHandler(handler: (command: string) => Promise<string>): void {
  adminHandler = handler;
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Long polling of the bot (owner 2026-11-12: /start did not answer). A 409 (another poller — e.g. the previous
 * deployment still running during a publish — or a webhook) no longer stops polling for good: it waits 30 s and
 * tries again, so the bot answers as soon as the other poller is gone.
 */
async function poll(): Promise<void> {
  const [state] = await db.select().from(btcTelegramStateTable)
    .where(eq(btcTelegramStateTable.key, "updates"));
  let offset = state?.nextUpdateId ?? 0;
  let conflictLoggedAt = 0;
  logger.info("Telegram bot: polling started");
  while (running) {
    try {
      const updates = await telegramCall<TelegramUpdate[]>("getUpdates", {
        offset, timeout: 25, allowed_updates: ["message", "callback_query"],
      });
      for (const update of updates) {
        if (update.update_id < offset) continue;
        offset = update.update_id + 1;
        await db.insert(btcTelegramStateTable).values({ key: "updates", nextUpdateId: offset })
          .onConflictDoUpdate({ target: btcTelegramStateTable.key, set: { nextUpdateId: offset } });
        try {
          await handleUpdate(update, adminHandler);
        } catch (err) {
          logger.warn({ err }, "Telegram bot: update not handled");
        }
      }
    } catch (err) {
      if (err instanceof TelegramError && err.code === 409) {
        if (Date.now() - conflictLoggedAt > 10 * 60_000) {
          logger.error("Telegram bot: 409 — another poller or a webhook is active; retrying every 30 s");
          conflictLoggedAt = Date.now();
        }
        await pause(30_000);
        continue;
      }
      logger.warn({ err }, "Telegram bot: polling failed, retrying");
      await pause(err instanceof TelegramError ? Math.max(5000, err.retryAfter * 1000) : 5000);
    }
  }
}

export function startTelegramSubscriptions(): void {
  if (running) return;
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    logger.warn("Telegram bot disabled: TELEGRAM_BOT_TOKEN not set");
    return;
  }
  running = true;
  void setupBotProfile().catch((err) => logger.warn({ err }, "Telegram bot profile not set"));
  void poll().catch((err) => {
    running = false;
    logger.error({ err }, "Telegram bot stopped");
  });
}
