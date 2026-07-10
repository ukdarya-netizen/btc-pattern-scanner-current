import { Telegraf } from "telegraf";
import { logger } from "../lib/logger";
import type { PatternHit } from "./altScanner";

const ADMIN_CHAT_IDS_ENV = process.env["TELEGRAM_ADMIN_CHAT_IDS"] ?? "";
const adminChatIds: number[] = ADMIN_CHAT_IDS_ENV
  ? ADMIN_CHAT_IDS_ENV.split(",").map((s) => parseInt(s.trim())).filter((n) => !isNaN(n))
  : [];

const CHANNEL_ID = "@bitcoinmarginmaster";

const PATTERN_LABELS: Record<string, string> = {
  oi_spike_accumulation: "OI Spike Accumulation",
  volume_taker: "Volume + Taker Push",
  spot_absorption: "Spot Absorption",
  oi_divergence_reversal: "OI Divergence Reversal",
  oi1h_breakout: "OI 1h Breakout",
  spot_momentum_reversal: "Spot Momentum Reversal",
  spot_oi4h_build: "Spot + OI 4h Build",
  liquidation_cascade: "Liquidation Cascade",
};

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
        `✅ Alt Pattern Scanner подключён.\nChat ID: ${chatId}\n\nСигналы публикуются в канал ${CHANNEL_ID}.`
      );
      logger.info({ chatId }, "Telegram chat registered via /start");
    });

    this.bot.command("status", async (ctx) => {
      try {
        const { altScanner } = await import("./altScanner");
        const metrics = altScanner.getLatestMetrics();
        const hits = altScanner.getRecentHits();
        ctx.reply(
          `Статус: 🟢 РАБОТАЕТ\nОтслеживается символов: ${metrics.length}\nСигналов за сессию: ${hits.length}`
        );
      } catch {
        ctx.reply("Ошибка получения статуса");
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

  // Direct channel post — for pattern signals and reports
  notifyChannel(message: string) {
    if (!this.bot) return;
    this.bot.telegram
      .sendMessage(CHANNEL_ID, message, { parse_mode: "HTML" })
      .catch((err) => logger.warn({ err, channel: CHANNEL_ID }, "Failed to send channel message"));
  }

  // Send ONLY to registered private admin chats — for debug/diagnostic messages
  notifyAdmin(message: string) {
    if (!this.bot) return;
    if (this.registeredChats.size === 0) {
      logger.info("notifyAdmin: no registered chats, skipping");
      return;
    }
    for (const chatId of this.registeredChats) {
      this.bot.telegram
        .sendMessage(chatId, message, { parse_mode: "HTML" })
        .catch((err) => logger.warn({ err, chatId }, "notifyAdmin: send failed"));
    }
  }

  publishPatternSignal(hit: PatternHit) {
    if (!this.bot) return;
    const timeStr = new Date().toLocaleTimeString("ru-RU", { timeZone: "Europe/Moscow", hour12: false }) + " МСК";
    const label = PATTERN_LABELS[hit.pattern] ?? hit.pattern;
    const m = hit.metrics;
    const msg =
      `🚨 <b>${label}</b>\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `💎 Символ: <b>${hit.symbol}</b>\n` +
      `📈 Направление: <b>${hit.direction}</b>\n` +
      `💰 Цена: <b>$${m.price.toFixed(4)}</b>\n` +
      `📊 Δ цена: ${m.priceChange.current.toFixed(2)}%\n` +
      `📦 OI Δ30m/1h/4h: ${m.oiChange.m30.toFixed(2)}% / ${m.oiChange.h1.toFixed(2)}% / ${m.oiChange.h4.toFixed(2)}%\n` +
      `📢 Объём (фьючерсы/спот): ${m.volMult.toFixed(2)}x / ${m.spotVolMult.toFixed(2)}x\n` +
      `⚔️ Taker net buy: ${m.takerNetBuyPct.toFixed(1)}%\n` +
      `💵 Funding: ${(m.fundingRate * 100).toFixed(4)}%\n` +
      `🔁 Циклов подряд: ${hit.cycleCount}\n` +
      `📝 ${hit.reason}\n` +
      `🕐 ${timeStr}\n` +
      `#${hit.symbol} #pattern_scanner`;
    this.notifyChannel(msg);
  }
}

export const telegramService = new TelegramService();
