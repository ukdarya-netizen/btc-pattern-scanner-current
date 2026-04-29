import { Telegraf } from "telegraf";
import { logger } from "../lib/logger";

const ADMIN_CHAT_IDS_ENV = process.env["TELEGRAM_ADMIN_CHAT_IDS"] ?? "";
const adminChatIds: number[] = ADMIN_CHAT_IDS_ENV
  ? ADMIN_CHAT_IDS_ENV.split(",").map((s) => parseInt(s.trim())).filter((n) => !isNaN(n))
  : [];

class TelegramService {
  private bot: Telegraf | null = null;
  private registeredChats = new Set<number>(adminChatIds);

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
        `BTC Scalping Bot connected.\nChat ID: ${chatId}\n\nCommands:\n/status - bot status\n/signal - current signal\n/positions - open positions\n/stop - emergency stop`
      );
      logger.info({ chatId }, "New Telegram chat registered");
    });

    this.bot.command("status", async (ctx) => {
      try {
        const { botEngine } = await import("./botEngine");
        const state = botEngine.getState();
        ctx.reply(
          `Status: ${state.running ? "RUNNING" : "STOPPED"}\nMode: ${state.mode}\nLeverage: ${state.maxLeverage}x\nRisk/trade: ${state.riskPct}%\nTrades today: ${state.tradesExecuted}\nDaily P&L: $${state.dailyPnl.toFixed(2)}\nCircuit breaker: ${state.circuitBreakerTripped ? "TRIPPED" : "OK"}`
        );
      } catch (e) {
        ctx.reply("Error fetching status");
      }
    });

    this.bot.command("signal", async (ctx) => {
      try {
        const { signalEngine } = await import("./signal");
        const s = signalEngine.compute();
        ctx.reply(
          `Signal: ${s.direction.toUpperCase()} (score: ${s.score.toFixed(3)})\nConfidence: ${(s.confidence * 100).toFixed(0)}%\nSuggested leverage: ${s.suggestedLeverage}x\nSL: $${s.suggestedSl.toFixed(2)}\nTP: $${s.suggestedTp.toFixed(2)}`
        );
      } catch (e) {
        ctx.reply("Error fetching signal");
      }
    });

    this.bot.command("positions", async (ctx) => {
      try {
        const { riskManager } = await import("./riskManager");
        const positions = riskManager.getPositions();
        if (positions.length === 0) {
          ctx.reply("No open positions");
          return;
        }
        const text = positions.map((p) =>
          `${p.side.toUpperCase()} ${p.size.toFixed(4)} BTC @ $${p.entryPrice.toFixed(2)} (${p.leverage}x)\nCurrent: $${p.currentPrice.toFixed(2)} | P&L: $${p.pnl.toFixed(2)} (${(p.pnlPct * 100).toFixed(2)}%)\nSL: $${p.stopLoss.toFixed(2)} | TP: $${p.takeProfit.toFixed(2)}`
        ).join("\n\n");
        ctx.reply(text);
      } catch (e) {
        ctx.reply("Error fetching positions");
      }
    });

    this.bot.command("stop", async (ctx) => {
      try {
        const { botEngine } = await import("./botEngine");
        botEngine.stop();
        ctx.reply("Emergency stop executed. Bot stopped.");
        logger.warn({ chatId: ctx.chat.id }, "Emergency stop via Telegram");
      } catch (e) {
        ctx.reply("Error stopping bot");
      }
    });

    this.bot.launch().catch((err) => {
      logger.error({ err }, "Failed to launch Telegram bot");
    });

    process.once("SIGINT", () => this.bot?.stop("SIGINT"));
    process.once("SIGTERM", () => this.bot?.stop("SIGTERM"));

    logger.info("Telegram bot started");
  }

  notify(message: string) {
    if (!this.bot || this.registeredChats.size === 0) {
      logger.info({ message }, "Telegram notification (no recipients)");
      return;
    }
    for (const chatId of this.registeredChats) {
      this.bot.telegram.sendMessage(chatId, message).catch((err) => {
        logger.warn({ err, chatId }, "Failed to send Telegram message");
      });
    }
  }
}

export const telegramService = new TelegramService();
