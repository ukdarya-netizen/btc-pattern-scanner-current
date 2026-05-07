import { logger } from "../lib/logger";
import { aggregator } from "./exchanges/aggregator";
import { signalEngine } from "./signal";
import { dbService } from "./dbService";
import { telegramService } from "./telegram";

const VIRTUAL_SIZE_BTC = 0.01;       // ~$800-1000 notional per signal
const SIGNAL_SCORE_THRESHOLD = 0.35; // minimum |score| to open a signal

// Progress milestones towards TP to notify at (fraction 0..1)
const TP_MILESTONES = [0.25, 0.5, 0.75] as const;
// SL proximity warning: fire when this fraction of SL distance has been consumed
const SL_WARNING_AT = 0.75;

interface ActiveSignal {
  id: string;
  side: "long" | "short";
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  leverage: number;
  confidence: number;
  score: number;
  openedAt: Date;
  dataExchanges: string;
  /** TP milestones already notified (0.25, 0.5, 0.75) */
  notifiedMilestones: Set<number>;
  /** Whether the SL proximity warning has been sent */
  slWarningNotified: boolean;
}

class SignalTracker {
  private active: ActiveSignal | null = null;
  private tickInterval: ReturnType<typeof setInterval> | null = null;

  start() {
    if (this.tickInterval) return;
    this.tickInterval = setInterval(() => this.tick(), 5000);
    logger.info("SignalTracker started — tracking signal performance 24/7");
  }

  stop() {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
  }

  getActive(): ActiveSignal | null {
    return this.active;
  }

  private tick() {
    const price = aggregator.getPrimaryPrice();
    if (price === 0) return;

    const signal = signalEngine.compute();

    // --- Manage active signal ---
    if (this.active) {
      const { side, stopLoss, takeProfit, entryPrice } = this.active;

      const hitTp = side === "long" ? price >= takeProfit : price <= takeProfit;
      const hitSl = side === "long" ? price <= stopLoss : price >= stopLoss;

      if (hitTp || hitSl) {
        const exitPrice = hitTp ? takeProfit : stopLoss;
        void this.closeSignal(exitPrice, hitTp ? "tp" : "sl", price);
        return;
      }

      // Close on direction reversal: opposite side exceeds threshold
      const reversed =
        (side === "long" && signal.score < -SIGNAL_SCORE_THRESHOLD) ||
        (side === "short" && signal.score > SIGNAL_SCORE_THRESHOLD);

      if (reversed) {
        void this.closeSignal(price, "signal", price);
        return;
      }

      // --- Progress notifications ---
      this.checkMilestones(price, entryPrice, takeProfit, stopLoss, side);
      return;
    }

    // --- Open new signal ---
    const absScore = Math.abs(signal.score);
    if (absScore < SIGNAL_SCORE_THRESHOLD) return;
    if (signal.direction === "neutral") return;
    if (!signal.suggestedSl || !signal.suggestedTp) return;
    if (signal.suggestedSl === 0 || signal.suggestedTp === 0) return;

    const side = signal.direction as "long" | "short";
    const dataExchanges = aggregator.getActiveExchangeNames().join(" + ");

    this.active = {
      id: `sig-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      side,
      entryPrice: price,
      stopLoss: signal.suggestedSl,
      takeProfit: signal.suggestedTp,
      leverage: signal.suggestedLeverage,
      confidence: signal.confidence,
      score: signal.score,
      openedAt: new Date(),
      dataExchanges,
      notifiedMilestones: new Set(),
      slWarningNotified: false,
    };

    const slPct = (Math.abs(signal.suggestedSl - price) / price * 100).toFixed(2);
    const tpPct = (Math.abs(signal.suggestedTp - price) / price * 100).toFixed(2);
    const strengthLabel = absScore > 0.7 ? "STRONG" : absScore > 0.5 ? "MODERATE" : "WEAK";
    const timeStr = new Date().toLocaleTimeString("ru-RU", { timeZone: "Europe/Moscow", hour12: false }) + " МСК";
    const emoji = side === "long" ? "🟢📈" : "🔴📉";

    logger.info({ side, price, sl: signal.suggestedSl, tp: signal.suggestedTp, score: signal.score }, "SignalTracker: signal opened");

    telegramService.notifyChannel(
      `${emoji} <b>BTC ${side.toUpperCase()} — ${strengthLabel}</b>\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `💰 Цена входа: <b>$${price.toFixed(1)}</b>\n` +
      `💪 Уверенность: <b>${(signal.confidence * 100).toFixed(0)}%</b>\n` +
      `⚡ Плечо: <b>${signal.suggestedLeverage}x</b>\n` +
      `🛑 SL: <b>$${signal.suggestedSl.toFixed(1)}</b> (-${slPct}%)\n` +
      `🎯 TP: <b>$${signal.suggestedTp.toFixed(1)}</b> (+${tpPct}%)\n` +
      `📊 Score: ${signal.score >= 0 ? "+" : ""}${signal.score.toFixed(3)}\n` +
      `📡 Данные: ${dataExchanges}\n` +
      `🕐 ${timeStr}\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `#BTC #bitcoin #scalping`
    );
  }

  /**
   * Fires one-shot milestone notifications while a signal is active:
   * - 25%, 50%, 75% of the way to TP
   * - SL proximity warning when price consumes 75% of the SL distance
   */
  private checkMilestones(
    price: number,
    entryPrice: number,
    takeProfit: number,
    stopLoss: number,
    side: "long" | "short",
  ) {
    if (!this.active) return;

    const tpRange = Math.abs(takeProfit - entryPrice);
    const slRange = Math.abs(stopLoss - entryPrice);
    if (tpRange === 0 || slRange === 0) return;

    // Progress toward TP (0 = entry, 1 = TP)
    const tpProgress =
      side === "long"
        ? (price - entryPrice) / tpRange
        : (entryPrice - price) / tpRange;

    // Progress consumed toward SL (0 = entry, 1 = SL)
    const slProgress =
      side === "long"
        ? (entryPrice - price) / slRange
        : (price - entryPrice) / slRange;

    const timeStr = new Date().toLocaleTimeString("ru-RU", { timeZone: "Europe/Moscow", hour12: false }) + " МСК";
    const priceFmt = `$${price.toFixed(1)}`;
    const tpFmt = `$${takeProfit.toFixed(1)}`;
    const slFmt = `$${stopLoss.toFixed(1)}`;

    // TP milestone notifications
    for (const milestone of TP_MILESTONES) {
      if (!this.active.notifiedMilestones.has(milestone) && tpProgress >= milestone) {
        this.active.notifiedMilestones.add(milestone);
        const pct = Math.round(milestone * 100);
        const bar = "█".repeat(Math.round(milestone * 10)) + "░".repeat(10 - Math.round(milestone * 10));
        const emoji = milestone >= 0.75 ? "🔥" : milestone >= 0.5 ? "📈" : "⚡";
        logger.info({ price, milestone: pct, side }, "SignalTracker: TP milestone reached");
        telegramService.notifyChannel(
          `${emoji} <b>BTC ${side.toUpperCase()} — ${pct}% к TP</b>\n` +
          `━━━━━━━━━━━━━━━━━━━\n` +
          `[${bar}] ${pct}%\n` +
          `💰 Текущая цена: <b>${priceFmt}</b>\n` +
          `🎯 TP: <b>${tpFmt}</b>\n` +
          `🛑 SL: <b>${slFmt}</b>\n` +
          `🕐 ${timeStr}\n` +
          `#BTC #bitcoin #scalping`
        );
      }
    }

    // SL proximity warning (only if not moving toward TP)
    if (!this.active.slWarningNotified && slProgress >= SL_WARNING_AT && tpProgress < 0.1) {
      this.active.slWarningNotified = true;
      logger.info({ price, slProgress, side }, "SignalTracker: SL proximity warning");
      telegramService.notifyChannel(
        `⚠️ <b>BTC ${side.toUpperCase()} — ВНИМАНИЕ: цена близко к SL</b>\n` +
        `━━━━━━━━━━━━━━━━━━━\n` +
        `💰 Текущая цена: <b>${priceFmt}</b>\n` +
        `🛑 SL: <b>${slFmt}</b>\n` +
        `🎯 TP: <b>${tpFmt}</b>\n` +
        `🕐 ${timeStr}\n` +
        `#BTC #bitcoin #scalping`
      );
    }
  }

  private async closeSignal(exitPrice: number, reason: "tp" | "sl" | "signal", currentPrice: number) {
    if (!this.active) return;
    const { id, side, entryPrice, leverage, openedAt, dataExchanges } = this.active;
    this.active = null; // clear before async to prevent double-close

    const dirMult = side === "long" ? 1 : -1;
    const pnlPct = (exitPrice - entryPrice) / entryPrice * dirMult * leverage;
    const notionalUsd = entryPrice * VIRTUAL_SIZE_BTC;
    const pnl = notionalUsd * pnlPct;

    logger.info({ id, side, entryPrice, exitPrice, pnl, reason }, "SignalTracker: signal closed");

    await dbService.saveTrade({
      id,
      symbol: "BTCUSDT",
      side,
      entryPrice,
      exitPrice,
      size: VIRTUAL_SIZE_BTC,
      leverage,
      pnl,
      pnlPct,
      openedAt: openedAt.toISOString(),
      closedAt: new Date().toISOString(),
      closeReason: reason,
    }, "Signal");

    const emoji = pnl >= 0 ? "✅" : "❌";
    const pnlStr = `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`;
    const pnlPctStr = `${pnlPct >= 0 ? "+" : ""}${(pnlPct * 100).toFixed(1)}%`;
    const reasonLabel: Record<string, string> = {
      tp: "Take Profit 🎯",
      sl: "Stop Loss 🛑",
      signal: "Смена направления ↩️",
    };
    const timeStr = new Date().toLocaleTimeString("ru-RU", { timeZone: "Europe/Moscow", hour12: false }) + " МСК";

    telegramService.notifyChannel(
      `${emoji} <b>ЗАКРЫТИЕ ${side.toUpperCase()}</b> — ${reasonLabel[reason]}\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `💰 Цена выхода: <b>$${exitPrice.toFixed(1)}</b>\n` +
      `📊 P&amp;L: <b>${pnlStr}</b> (${pnlPctStr} на плече ${leverage}x)\n` +
      `📡 Данные: ${dataExchanges}\n` +
      `🕐 ${timeStr}\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `#BTC #bitcoin #scalping`
    );
  }
}

export const signalTracker = new SignalTracker();
