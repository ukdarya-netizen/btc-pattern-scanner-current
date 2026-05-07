import { Telegraf } from "telegraf";
import { logger } from "../lib/logger";

const ADMIN_CHAT_IDS_ENV = process.env["TELEGRAM_ADMIN_CHAT_IDS"] ?? "";
const adminChatIds: number[] = ADMIN_CHAT_IDS_ENV
  ? ADMIN_CHAT_IDS_ENV.split(",").map((s) => parseInt(s.trim())).filter((n) => !isNaN(n))
  : [];

const CHANNEL_ID = "@bitcoinmarginmaster";

class TelegramService {
  private bot: Telegraf | null = null;
  private registeredChats = new Set<number>(adminChatIds);
  private pollingOffset = 0;
  private pollingTimer: ReturnType<typeof setTimeout> | null = null;

  init() {
    const token = process.env["TELEGRAM_BOT_TOKEN"];
    if (!token) {
      logger.warn("TELEGRAM_BOT_TOKEN not set, Telegram notifications disabled");
      return;
    }

    this.bot = new Telegraf(token);

    this.bot.command("start", (ctx) => {
      const chatId = ctx.chat.id;
      this.registeredChats.add(chatId);
      ctx.reply(
        `✅ BTC Scalping Bot подключён.\nChat ID: ${chatId}\n\nКоманды:\n/status — статус бота\n/signal — текущий сигнал\n/stop — аварийная остановка`
      );
      logger.info({ chatId }, "Telegram chat registered via /start");
    });

    this.bot.command("status", async (ctx) => {
      try {
        const { botEngine } = await import("./botEngine");
        const state = botEngine.getState();
        ctx.reply(
          `Статус: ${state.running ? "🟢 РАБОТАЕТ" : "🔴 ОСТАНОВЛЕН"}\nРежим: ${state.mode.toUpperCase()}\nПлечо: ${state.maxLeverage}x\nРиск/сделка: ${state.riskPct}%\nСделок сегодня: ${state.tradesExecuted}\nP&L сегодня: $${state.dailyPnl.toFixed(2)}\nЦепочный автомат: ${state.circuitBreakerTripped ? "🔴 СРАБОТАЛ" : "🟢 OK"}`
        );
      } catch {
        ctx.reply("Ошибка получения статуса");
      }
    });

    this.bot.command("signal", async (ctx) => {
      try {
        const { signalEngine } = await import("./signal");
        const s = signalEngine.compute();
        ctx.reply(
          `Сигнал: ${s.direction.toUpperCase()} (score: ${s.score.toFixed(3)})\nУверенность: ${(s.confidence * 100).toFixed(0)}%\nПлечо: ${s.suggestedLeverage}x\nSL: $${s.suggestedSl.toFixed(2)}\nTP: $${s.suggestedTp.toFixed(2)}`
        );
      } catch {
        ctx.reply("Ошибка получения сигнала");
      }
    });

    this.bot.command("stop", async (ctx) => {
      try {
        const { botEngine } = await import("./botEngine");
        botEngine.stop();
        ctx.reply("⛔ Аварийная остановка. Бот остановлен.");
        logger.warn({ chatId: ctx.chat.id }, "Emergency stop via Telegram");
      } catch {
        ctx.reply("Ошибка остановки бота");
      }
    });

    // Manual polling — avoids AbortSignal incompatibility in node-fetch@2.x
    // Only poll in production to avoid 409 conflict when dev + deployed run simultaneously
    if (process.env["REPLIT_DEPLOYMENT"] === "1") {
      this.startPolling();
      logger.info("Telegram bot started (manual polling, production)");
    } else {
      logger.info("Telegram bot started (send-only, dev — polling disabled to avoid 409 conflict with production)");
    }
  }

  // Polls Telegram for updates using direct API calls (no AbortSignal)
  private startPolling() {
    const poll = async () => {
      try {
        const updates = await this.bot!.telegram.getUpdates(10, 100, this.pollingOffset, [
          "message",
        ]);

        for (const update of updates) {
          this.pollingOffset = update.update_id + 1;

          // Auto-register any chat that contacts the bot
          const chatId = (update as any).message?.chat?.id as number | undefined;
          if (chatId && !this.registeredChats.has(chatId)) {
            this.registeredChats.add(chatId);
            logger.info({ chatId }, "Auto-registered Telegram chat");
          }

          // Let Telegraf handle commands (/start, /status, etc.)
          void this.bot!.handleUpdate(update).catch(() => {});
        }
      } catch (err) {
        logger.warn({ err }, "Telegram polling error (will retry)");
      }

      this.pollingTimer = setTimeout(() => void poll(), 3000);
    };

    void poll();
  }

  // Send to all registered private chats (bot chat — forwarded to channel by user's Telegram setup)
  // Falls back to direct channel post if no chats are registered yet
  notify(message: string, parseMode: "HTML" | "Markdown" | undefined = undefined) {
    if (!this.bot) return;

    const opts = parseMode ? { parse_mode: parseMode as "HTML" | "Markdown" } : {};

    if (this.registeredChats.size === 0) {
      // Not yet registered — send directly to channel as fallback
      this.bot.telegram
        .sendMessage(CHANNEL_ID, message, { parse_mode: "HTML", ...opts })
        .catch((err) => logger.warn({ err }, "Telegram notify fallback to channel failed"));
      return;
    }

    for (const chatId of this.registeredChats) {
      this.bot.telegram
        .sendMessage(chatId, message, opts)
        .catch((err) => logger.warn({ err, chatId }, "Failed to send Telegram message"));
    }
  }

  // Direct channel post — for reports and announcements (bypasses forwarding by design)
  notifyChannel(message: string) {
    if (!this.bot) return;
    this.bot.telegram
      .sendMessage(CHANNEL_ID, message, { parse_mode: "HTML" })
      .catch((err) => logger.warn({ err, channel: CHANNEL_ID }, "Failed to send channel message"));
  }

  publishTrade(params: {
    action: "open" | "close";
    side: string;
    price: number;
    size: number;
    leverage: number;
    pnl?: number;
    pnlPct?: number;
    closeReason?: string;
    exchange: string;
    dataExchanges?: string;
  }) {
    if (!this.bot) return;

    const timeStr = new Date().toLocaleTimeString("ru-RU", { timeZone: "Europe/Moscow", hour12: false }) + " МСК";
    const dataStr = params.dataExchanges ?? params.exchange;

    if (params.action === "open") {
      const emoji = params.side === "long" ? "🟢" : "🔴";
      const usdValue = (params.price * params.size).toFixed(0);
      const msg =
        `${emoji} <b>ВХОД ${params.side.toUpperCase()}</b>\n` +
        `━━━━━━━━━━━━━━━━━━━\n` +
        `💰 Цена входа: <b>$${params.price.toFixed(1)}</b>\n` +
        `📦 Объём: <b>${params.size.toFixed(5)} BTC</b> (~$${usdValue})\n` +
        `⚡ Плечо: <b>${params.leverage}x</b>\n` +
        `🏦 Ордер: ${params.exchange}\n` +
        `📡 Данные: ${dataStr}\n` +
        `🕐 ${timeStr}\n` +
        `#BTC #bitcoin #scalping`;
      this.notifyChannel(msg);
    } else {
      const pnl = params.pnl ?? 0;
      const pnlPct = params.pnlPct ?? 0;
      const emoji = pnl >= 0 ? "✅" : "❌";
      const reasonLabel: Record<string, string> = {
        tp: "Take Profit 🎯",
        sl: "Stop Loss 🛑",
        signal: "Signal Reversal ↩️",
        circuit_breaker: "Circuit Breaker 🔒",
        manual: "Закрыто вручную",
        order_failed: "Ошибка ордера ⚠️",
      };
      const pnlLevered = pnl * params.leverage;
      const msg =
        `${emoji} <b>ВЫХОД ${params.side.toUpperCase()}</b>\n` +
        `━━━━━━━━━━━━━━━━━━━\n` +
        `💰 Цена выхода: <b>$${params.price.toFixed(1)}</b>\n` +
        `📊 P&amp;L: <b>${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}</b> (${pnl >= 0 ? "+" : ""}${(pnlPct * 100).toFixed(2)}% позиции)\n` +
        `💥 На плече ${params.leverage}x: <b>${pnlLevered >= 0 ? "+" : ""}$${pnlLevered.toFixed(2)}</b>\n` +
        `📋 Причина: ${reasonLabel[params.closeReason ?? "manual"] ?? params.closeReason}\n` +
        `🏦 Ордер: ${params.exchange}\n` +
        `📡 Данные: ${dataStr}\n` +
        `🕐 ${timeStr}\n` +
        `#BTC #bitcoin #scalping`;
      this.notifyChannel(msg);
    }
  }
}

export const telegramService = new TelegramService();
