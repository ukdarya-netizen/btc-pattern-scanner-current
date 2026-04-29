import { logger } from "../lib/logger";
import { bybitService } from "./bybit";
import { riskManager, type Position } from "./riskManager";
import { signalEngine } from "./signal";
import { telegramService } from "./telegram";

export type BotMode = "paper" | "live" | "stopped";

export interface BotConfig {
  mode: BotMode;
  maxLeverage: number;
  riskPct: number;
}

export interface BotState extends BotConfig {
  running: boolean;
  startedAt: string | null;
  tradesExecuted: number;
  dailyPnl: number;
  circuitBreakerTripped: boolean;
}

const SIGNAL_THRESHOLD = 0.35;
const MIN_TRADE_INTERVAL_MS = 30000;

class BotEngine {
  private running = false;
  private mode: BotMode = "stopped";
  private maxLeverage = 10;
  private riskPct = 1;
  private startedAt: Date | null = null;
  private tradesExecuted = 0;
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private lastTradeAt = 0;
  private priceUpdateInterval: ReturnType<typeof setInterval> | null = null;

  start(config: BotConfig) {
    if (this.running) {
      logger.warn("Bot already running");
      return;
    }
    this.running = true;
    this.mode = config.mode;
    this.maxLeverage = config.maxLeverage;
    this.riskPct = config.riskPct;
    this.startedAt = new Date();
    this.tradesExecuted = 0;

    this.tickInterval = setInterval(() => this.tick(), 5000);
    this.priceUpdateInterval = setInterval(() => {
      const price = bybitService.ticker.lastPrice;
      if (price > 0) riskManager.updatePositionPrices(price);
    }, 1000);

    logger.info({ mode: config.mode, maxLeverage: config.maxLeverage }, "Bot started");
    telegramService.notify(`Bot started in ${config.mode.toUpperCase()} mode. Max leverage: ${config.maxLeverage}x, Risk/trade: ${config.riskPct}%`);
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.mode = "stopped";
    if (this.tickInterval) clearInterval(this.tickInterval);
    if (this.priceUpdateInterval) clearInterval(this.priceUpdateInterval);
    this.tickInterval = null;
    this.priceUpdateInterval = null;

    const stats = riskManager.getStats();
    logger.info({ trades: this.tradesExecuted, dailyPnl: stats.dailyPnl }, "Bot stopped");
    telegramService.notify(`Bot stopped. Trades: ${this.tradesExecuted}, Daily P&L: $${stats.dailyPnl.toFixed(2)}`);
  }

  private async tick() {
    if (!this.running) return;

    if (riskManager.checkCircuitBreaker()) {
      const cooldown = riskManager.getCooldownUntil();
      logger.warn({ cooldown }, "Circuit breaker active, skipping tick");
      return;
    }

    const now = Date.now();
    if (now - this.lastTradeAt < MIN_TRADE_INTERVAL_MS) return;

    const openPositions = riskManager.getPositions();
    const price = bybitService.ticker.lastPrice;
    if (price === 0) return;

    for (const pos of openPositions) {
      const hitSl = pos.side === "long" ? price <= pos.stopLoss : price >= pos.stopLoss;
      const hitTp = pos.side === "long" ? price >= pos.takeProfit : price <= pos.takeProfit;

      if (hitSl || hitTp) {
        const trade = riskManager.closePosition(pos.id, price);
        if (trade) {
          this.tradesExecuted++;
          const reason = hitTp ? "Take Profit" : "Stop Loss";
          telegramService.notify(
            `${reason} hit! ${pos.side.toUpperCase()} closed at $${price.toFixed(2)}. P&L: $${trade.pnl.toFixed(2)} (${(trade.pnlPct * 100).toFixed(2)}%)`
          );
        }
      }
    }

    if (openPositions.length >= 2) return;

    const signal = signalEngine.compute();
    if (Math.abs(signal.score) < SIGNAL_THRESHOLD) return;

    const leverage = Math.min(this.maxLeverage, signal.suggestedLeverage);
    const positionSizeUsd = 10000 * (this.riskPct / 100) * leverage;

    const newPos: Position = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      symbol: "BTCUSDT",
      side: signal.direction as "long" | "short",
      entryPrice: price,
      currentPrice: price,
      size: positionSizeUsd / price,
      leverage,
      pnl: 0,
      pnlPct: 0,
      stopLoss: signal.suggestedSl,
      takeProfit: signal.suggestedTp,
      openedAt: new Date().toISOString(),
    };

    riskManager.openPosition(newPos);
    this.tradesExecuted++;
    this.lastTradeAt = now;

    const slPct = Math.abs((newPos.stopLoss - price) / price * 100).toFixed(2);
    const tpPct = Math.abs((newPos.takeProfit - price) / price * 100).toFixed(2);

    telegramService.notify(
      `${this.mode === "paper" ? "[PAPER] " : ""}Signal: ${signal.direction.toUpperCase()} (score: ${signal.score.toFixed(3)}, conf: ${(signal.confidence * 100).toFixed(0)}%)\n` +
      `Entry: $${price.toFixed(2)} | Lev: ${leverage}x\n` +
      `SL: $${newPos.stopLoss.toFixed(2)} (-${slPct}%) | TP: $${newPos.takeProfit.toFixed(2)} (+${tpPct}%)`
    );
  }

  getState(): BotState {
    const stats = riskManager.getStats();
    return {
      running: this.running,
      mode: this.mode,
      maxLeverage: this.maxLeverage,
      riskPct: this.riskPct,
      startedAt: this.startedAt?.toISOString() ?? null,
      tradesExecuted: this.tradesExecuted,
      dailyPnl: stats.dailyPnl,
      circuitBreakerTripped: stats.circuitBreakerTripped,
    };
  }
}

export const botEngine = new BotEngine();
