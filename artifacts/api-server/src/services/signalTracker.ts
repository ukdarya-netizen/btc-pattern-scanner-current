import { logger } from "../lib/logger";
import { aggregator } from "./exchanges/aggregator";
import { signalEngine } from "./signal";
import { dbService } from "./dbService";
import { telegramService } from "./telegram";
import { fractalService } from "./fractalService";

const VIRTUAL_SIZE_BTC = 0.01;       // ~$800-1000 notional per signal
const SIGNAL_SCORE_THRESHOLD = 0.35; // minimum |score| to open a signal

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
      const { side, stopLoss, takeProfit } = this.active;

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
      }
      return;
    }

    // --- Open new signal ---
    const absScore = Math.abs(signal.score);
    if (absScore < SIGNAL_SCORE_THRESHOLD) return;
    if (signal.direction === "neutral") return;
    if (!signal.suggestedSl || !signal.suggestedTp) return;
    if (signal.suggestedSl === 0 || signal.suggestedTp === 0) return;

    const engineDirection = signal.direction as "long" | "short";

    // ─── Fractal gate (primary gate) ───────────────────────────────────────
    const fractalGate = fractalService.gateCheck(engineDirection);
    if (!fractalGate.pass) {
      logger.debug({ reason: fractalGate.reason, score: fractalGate.score }, "SignalTracker: fractal gate blocked signal");
      return;
    }

    const side = engineDirection;
    const dataExchanges = aggregator.getActiveExchangeNames().join(" + ");
    const fractalSig = fractalService.getFractalSignal();

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
    };

    const slPct = (Math.abs(signal.suggestedSl - price) / price * 100).toFixed(2);
    const tpPct = (Math.abs(signal.suggestedTp - price) / price * 100).toFixed(2);
    const absScore2 = Math.abs(signal.score);
    const strengthLabel = absScore2 > 0.7 ? "STRONG" : absScore2 > 0.5 ? "MODERATE" : "WEAK";
    const timeStr = new Date().toLocaleTimeString("ru-RU", { timeZone: "Europe/Moscow", hour12: false }) + " МСК";
    const emoji = side === "long" ? "🟢📈" : "🔴📉";
    const fractalLine = fractalSig
      ? `🔮 Фрактал: <b>${(fractalSig.overall_signal_score * 100).toFixed(0)}%</b> (win-rate ${(fractalSig.probability * 100).toFixed(0)}%)\n`
      : "";

    logger.info({
      side, price,
      sl: signal.suggestedSl, tp: signal.suggestedTp, score: signal.score,
      fractalScore: fractalGate.score, fractalReason: fractalGate.reason,
    }, "SignalTracker: signal opened (fractal gate passed)");

    telegramService.notifyChannel(
      `${emoji} <b>BTC ${side.toUpperCase()} — ${strengthLabel}</b>\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `💰 Цена входа: <b>$${price.toFixed(1)}</b>\n` +
      `💪 Уверенность: <b>${(signal.confidence * 100).toFixed(0)}%</b>\n` +
      `⚡ Плечо: <b>${signal.suggestedLeverage}x</b>\n` +
      `🛑 SL: <b>$${signal.suggestedSl.toFixed(1)}</b> (-${slPct}%)\n` +
      `🎯 TP: <b>$${signal.suggestedTp.toFixed(1)}</b> (+${tpPct}%)\n` +
      `📊 Score: ${signal.score >= 0 ? "+" : ""}${signal.score.toFixed(3)}\n` +
      fractalLine +
      `📡 Данные: ${dataExchanges}\n` +
      `🕐 ${timeStr}\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `#BTC #bitcoin #scalping`
    );
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
