import { db, btcTelegramStateTable, btcTelegramSubscribersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../lib/logger";
import { sendMessage, subscriptionCommand, telegramCall, TelegramError, type TelegramUpdate } from "./transport";

let running = false;
let adminHandler: ((command: string) => Promise<string>) | null = null;

/** Admin-only commands (/status, /open) from TELEGRAM_ADMIN_CHAT_IDS chats. */
export function setAdminCommandHandler(handler: (command: string) => Promise<string>): void {
  adminHandler = handler;
}

function adminCommand(update: TelegramUpdate): string | null {
  if (update.message?.chat.type !== "private") return null;
  const admins = (process.env.TELEGRAM_ADMIN_CHAT_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  if (!admins.includes(String(update.message.chat.id))) return null;
  const command = update.message.text?.trim().split(/\s+/)[0]?.split("@")[0]?.toLowerCase();
  return command === "/status" || command === "/open" ? command : null;
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function poll(): Promise<void> {
  const [state] = await db.select().from(btcTelegramStateTable)
    .where(eq(btcTelegramStateTable.key, "updates"));
  let offset = state?.nextUpdateId ?? 0;
  logger.info("Telegram subscriptions: polling started");
  while (running) {
    try {
      const updates = await telegramCall<TelegramUpdate[]>("getUpdates", {
        offset, timeout: 25, allowed_updates: ["message"],
      });
      for (const update of updates) {
        if (update.update_id < offset) continue;
        const command = subscriptionCommand(update);
        await db.transaction(async (tx) => {
          if (command && update.message) {
            const values = {
              chatId: String(update.message.chat.id), active: command === "start",
              subscribedAt: new Date(), updatedAt: new Date(),
            };
            await tx.insert(btcTelegramSubscribersTable).values(values)
              .onConflictDoUpdate({ target: btcTelegramSubscribersTable.chatId, set: values });
          }
          await tx.insert(btcTelegramStateTable).values({ key: "updates", nextUpdateId: update.update_id + 1 })
            .onConflictDoUpdate({ target: btcTelegramStateTable.key, set: { nextUpdateId: update.update_id + 1 } });
        });
        offset = update.update_id + 1;
        const admin = adminCommand(update);
        if (admin && adminHandler && update.message) {
          try {
            await sendMessage(String(update.message.chat.id), await adminHandler(admin));
          } catch (err) {
            logger.warn({ err }, "admin command reply failed");
          }
          continue;
        }
        if (command && update.message) {
          try {
            await sendMessage(String(update.message.chat.id), command === "start"
              ? "Вы подписаны на BTC-сигналы. Сигналы будут приходить сюда и в канал @bitcoinmarginmaster. Отписаться: /stop."
              : "Подписка на BTC-сигналы отключена. Подписаться снова: /start.");
          } catch {
            logger.warn("Telegram subscription saved, but confirmation could not be delivered");
          }
        }
      }
    } catch (err) {
      if (err instanceof TelegramError && err.code === 409) {
        logger.error("Telegram polling stopped: another poller or webhook is active; subscriptions cannot update");
        running = false;
        return;
      }
      logger.warn({ err }, "Telegram subscriptions: polling failed, retrying");
      await pause(err instanceof TelegramError ? Math.max(5000, err.retryAfter * 1000) : 5000);
    }
  }
}

export function startTelegramSubscriptions(): void {
  if (running) return;
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    logger.warn("Telegram subscriptions disabled: TELEGRAM_BOT_TOKEN not set");
    return;
  }
  running = true;
  void poll().catch((err) => {
    running = false;
    logger.error({ err }, "Telegram subscriptions stopped");
  });
}
