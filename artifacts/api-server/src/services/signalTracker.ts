import { logger } from "../lib/logger";
import { aggregator } from "./exchanges/aggregator";
import { signalEngine } from "./signal";
import { dbService } from "./dbService";
import { telegramService } from "./telegram";

const VIRTUAL_SIZE_BTC = 0.01;           // ~$800-1000 notional per signal
const MIN_SIGNAL_INTERVAL_MS = 5 * 60 * 1000; // 5 min cooldown between signals
const SIGNAL_SCORE_THRESHOLD = 0.35;     // same threshold as maybePublishSignal in telegram.ts

interface ActiveSignal {
  id: string;
  side: "long" | "short";
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  leverage: number;
  openedAt: Date;
}

class SignalTracker {
  private active: ActiveSignal | null = null;
  private lastSignalAt = 0;
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

    // Check if active signal hit TP or SL
    if (this.active) {
      const { side, entryPrice, stopLoss, takeProfit, leverage } = this.active;
      const hitTp = side === "long" ? price >= takeProfit : price <= takeProfit;
      const hitSl = side === "long" ? price <= stopLoss : price >= stopLoss;

      if (hitTp || hitSl) {
        const exitPrice = hitTp ? takeProfit : stopLoss;
        const reason = hitTp ? "tp" : "sl";
        void this.closeSignal(exitPrice, reason);
        return;
      }
    }

    // Check for new signal
    const now = Date.now();
    if (this.active) return;
    if (now - this.lastSignalAt < MIN_SIGNAL_INTERVAL_MS) return;

    const signal = signalEngine.compute();
    if (Math.abs(signal.score) < SIGNAL_SCORE_THRESHOLD) return;
    if (signal.direction === "neutral") return;
    // Skip if no valid SL/TP from clusters
    if (!signal.suggestedSl || !signal.suggestedTp) return;
    if (signal.suggestedSl === 0 || signal.suggestedTp === 0) return;

    this.active = {
      id: `sig-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      side: signal.direction as "long" | "short",
      entryPrice: price,
      stopLoss: signal.suggestedSl,
      takeProfit: signal.suggestedTp,
      leverage: signal.suggestedLeverage,
      openedAt: new Date(),
    };
    this.lastSignalAt = now;

    const slPct = Math.abs((signal.suggestedSl - price) / price * 100).toFixed(2);
    const tpPct = Math.abs((signal.suggestedTp - price) / price * 100).toFixed(2);

    logger.info({
      side: signal.direction,
      price,
      sl: signal.suggestedSl,
      tp: signal.suggestedTp,
      leverage: signal.suggestedLeverage,
      score: signal.score,
    }, "SignalTracker: signal opened");

    telegramService.notifyChannel(
      `📡 <b>СИГНАЛ ${signal.direction === "long" ? "🟢 LONG" : "🔴 SHORT"}</b>\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `💰 Цена входа: <b>$${price.toFixed(1)}</b>\n` +
      `⚡ Плечо: <b>${signal.suggestedLeverage}x</b>\n` +
      `💪 Уверенность: <b>${(signal.confidence * 100).toFixed(0)}%</b>\n` +
      `🛑 SL: <b>$${signal.suggestedSl.toFixed(1)}</b> (-${slPct}%)\n` +
      `🎯 TP: <b>$${signal.suggestedTp.toFixed(1)}</b> (+${tpPct}%)\n` +
      `📊 Score: ${signal.score >= 0 ? "+" : ""}${signal.score.toFixed(3)}\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `#BTC #bitcoin #scalping`
    );
  }

  private async closeSignal(exitPrice: number, reason: "tp" | "sl") {
    if (!this.active) return;
    const { id, side, entryPrice, leverage, openedAt } = this.active;

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

    const emoji = reason === "tp" ? "✅" : "❌";
    const pnlStr = `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`;
    const pnlPctStr = `${pnlPct >= 0 ? "+" : ""}${(pnlPct * 100).toFixed(1)}%`;

    telegramService.notifyChannel(
      `${emoji} <b>ЗАКРЫТИЕ ${side === "long" ? "LONG" : "SHORT"}</b> — ${reason === "tp" ? "Take Profit 🎯" : "Stop Loss 🛑"}\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `💰 Цена выхода: <b>$${exitPrice.toFixed(1)}</b>\n` +
      `📊 P&amp;L: <b>${pnlStr}</b> (${pnlPctStr} на плече ${leverage}x)\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `#BTC #bitcoin #scalping`
    );

    this.active = null;
  }
}

export const signalTracker = new SignalTracker();
