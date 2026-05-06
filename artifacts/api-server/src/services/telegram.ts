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
          `Status: ${state.running ? "🟢 RUNNING" : "🔴 STOPPED"}\nMode: ${state.mode.toUpperCase()}\nLeverage: ${state.maxLeverage}x\nRisk/trade: ${state.riskPct}%\nTrades today: ${state.tradesExecuted}\nDaily P&L: $${state.dailyPnl.toFixed(2)}\nCircuit breaker: ${state.circuitBreakerTripped ? "🔴 TRIPPED" : "🟢 OK"}`
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
    if (!this.bot) return;

    if (this.registeredChats.size === 0) {
      // No private chats registered — fall back to channel so nothing is lost
      this.notifyChannel(`⚙️ ${message}`);
      return;
    }

    for (const chatId of this.registeredChats) {
      this.bot.telegram.sendMessage(chatId, message).catch((err) => {
        logger.warn({ err, chatId }, "Failed to send Telegram message");
      });
    }
  }

  notifyChannel(message: string) {
    if (!this.bot) return;
    this.bot.telegram
      .sendMessage(CHANNEL_ID, message, { parse_mode: "HTML" })
      .catch((err) => {
        logger.warn({ err, channel: CHANNEL_ID }, "Failed to send channel message");
      });
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
