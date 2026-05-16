import { logger } from "../lib/logger";
import { aggregator } from "./exchanges/aggregator";
import { signalEngine } from "./signal";
import { dbService } from "./dbService";
import { telegramService } from "./telegram";
import type { MarketSnapshot, EvalResult, SignalType } from "./bufferService";

const VIRTUAL_SIZE_BTC = 0.01;

const TYPE_EMOJI:  Record<SignalType, string> = { scalp: "⚡", intraday: "🔥", swing: "🌊" };
const TYPE_LABEL:  Record<SignalType, string> = { scalp: "СКАЛЬП · 15m", intraday: "ИНТРАДЭЙ · 1H/4H", swing: "СВИНГ · 1D" };

interface ActiveSignal {
  id: string;
  type: SignalType;
  side: "long" | "short";
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  leverage: number;
  openedAt: Date;
  dataExchanges: string;
}

class SignalTracker {
  private active: ActiveSignal | null = null;
  private tickInterval: ReturnType<typeof setInterval> | null = null;

  start() {
    if (this.tickInterval) return;

    // Register callback on signalEngine — fires when a buffer reaches 3/3 agreement
    signalEngine.onFired((type, direction, snap, ev) => {
      void this.handleFire(type, direction, snap, ev);
    });

    // Tick every 5s: monitor SL/TP hits and reversals on active signals
    this.tickInterval = setInterval(() => this.tick(), 5000);
    logger.info("SignalTracker started — listening for buffer fires, monitoring SL/TP");
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

  private async handleFire(type: SignalType, direction: "LONG" | "SHORT", snap: MarketSnapshot, ev: EvalResult) {
    if (this.active) {
      logger.info({ type, direction, active: this.active.type }, "SignalTracker: buffer fired but signal already active — ignoring");
      return;
    }

    if (!snap.slValid || !snap.tpValid) {
      logger.info({ type, direction, slValid: snap.slValid, tpValid: snap.tpValid }, "SignalTracker: SL/TP not valid — skipping signal");
      return;
    }

    const side = direction === "LONG" ? "long" : "short";
    const price = snap.price;
    const slPct = (Math.abs(snap.suggestedSl - price) / price * 100).toFixed(2);
    const tpPct = (Math.abs(snap.suggestedTp - price) / price * 100).toFixed(2);
    const dataExchanges = aggregator.getActiveExchangeNames().join(" + ");
    const timeStr = new Date().toLocaleTimeString("ru-RU", { timeZone: "Europe/Moscow", hour12: false }) + " МСК";
    const emoji   = TYPE_EMOJI[type];
    const label   = TYPE_LABEL[type];
    const dirEmoji = side === "long" ? "🟢" : "🔴";

    this.active = {
      id: `sig-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type,
      side,
      entryPrice: price,
      stopLoss:   snap.suggestedSl,
      takeProfit: snap.suggestedTp,
      leverage:   snap.leverage,
      openedAt:   new Date(),
      dataExchanges,
    };

    logger.info({ type, side, price, sl: snap.suggestedSl, tp: snap.suggestedTp }, "SignalTracker: signal opened");

    const confirmLines = [ev.descLiq, ev.descOb, ev.descCvd].filter(Boolean).map(d => `  • ${d}`).join("\n");

    telegramService.notifyBoth(
      `${emoji} <b>BTC ${direction}</b>  ·  ${label}\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `${dirEmoji} <b>${direction}</b>  @  <b>$${price.toFixed(1)}</b>\n` +
      `\n📋 <b>Подтверждения:</b>\n${confirmLines}\n` +
      `\n🛑 SL: <b>$${snap.suggestedSl.toFixed(1)}</b> (-${slPct}%)\n` +
      `🎯 TP: <b>$${snap.suggestedTp.toFixed(1)}</b> (+${tpPct}%)\n` +
      `⚡ Плечо: <b>${snap.leverage}x</b>\n` +
      `📡 Данные: ${dataExchanges}\n` +
      `🕐 ${timeStr}\n` +
      `━━━━━━━━━━━━━━━━━━━\n` +
      `#BTC #bitcoin #scalping`
    );
  }

  private tick() {
    if (!this.active) return;

    const price = aggregator.getPrimaryPrice();
    if (price === 0) return;

    const { side, stopLoss, takeProfit } = this.active;

    const hitTp = side === "long" ? price >= takeProfit : price <= takeProfit;
    const hitSl = side === "long" ? price <= stopLoss  : price >= stopLoss;

    if (hitTp || hitSl) {
      const exitPrice = hitTp ? takeProfit : stopLoss;
      void this.closeSignal(exitPrice, hitTp ? "tp" : "sl");
    }
  }

  private async closeSignal(exitPrice: number, reason: "tp" | "sl" | "signal") {
    if (!this.active) return;
    const { id, type, side, entryPrice, leverage, openedAt, dataExchanges } = this.active;
    this.active = null;

    const dirMult   = side === "long" ? 1 : -1;
    const pnlPct    = (exitPrice - entryPrice) / entryPrice * dirMult * leverage;
    const notional  = entryPrice * VIRTUAL_SIZE_BTC;
    const pnl       = notional * pnlPct;

    logger.info({ id, type, side, entryPrice, exitPrice, pnl, reason }, "SignalTracker: signal closed");

    await dbService.saveTrade({
      id,
      symbol:    "BTCUSDT",
      side,
      entryPrice,
      exitPrice,
      size:      VIRTUAL_SIZE_BTC,
      leverage,
      pnl,
      pnlPct,
      openedAt:  openedAt.toISOString(),
      closedAt:  new Date().toISOString(),
      closeReason: reason,
    }, "Signal");

    const pnlEmoji   = pnl >= 0 ? "✅" : "❌";
    const pnlStr     = `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`;
    const pnlPctStr  = `${pnlPct >= 0 ? "+" : ""}${(pnlPct * 100).toFixed(1)}%`;
    const reasonLabel: Record<string, string> = {
      tp: "Take Profit 🎯",
      sl: "Stop Loss 🛑",
      signal: "Смена направления ↩️",
    };
    const timeStr = new Date().toLocaleTimeString("ru-RU", { timeZone: "Europe/Moscow", hour12: false }) + " МСК";
    const typeLabel = `${TYPE_EMOJI[type]} ${TYPE_LABEL[type]}`;

    telegramService.notifyBoth(
      `${pnlEmoji} <b>ЗАКРЫТИЕ ${side.toUpperCase()}</b> — ${reasonLabel[reason]}\n` +
      `${typeLabel}\n` +
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
