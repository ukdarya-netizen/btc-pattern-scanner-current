import { logger } from "../lib/logger";
import { aggregator } from "./exchanges/aggregator";
import { riskManager, type Position } from "./riskManager";
import { signalEngine } from "./signal";
import { telegramService } from "./telegram";
import { dbService } from "./dbService";

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
  accountBalance: number;
  slCooldownUntil: string | null;
  consecutiveSl: number;
}

const MIN_TRADE_INTERVAL_MS = 5 * 60 * 1000;
const SNAPSHOT_INTERVAL_MS = 60000;

class BotEngine {
  private running = false;
  private mode: BotMode = "stopped";
  private maxLeverage = 75;
  private riskPct = 1;
  private startedAt: Date | null = null;
  private tradesExecuted = 0;
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private priceInterval: ReturnType<typeof setInterval> | null = null;
  private snapshotInterval: ReturnType<typeof setInterval> | null = null;
  private balanceInterval: ReturnType<typeof setInterval> | null = null;
  private lastTradeAt = 0;

  private lastSlAt = 0;
  private consecutiveSl = 0;
  private slCooldownUntil = 0;
  private lastCooldownLogAt = 0;

  async start(config: BotConfig) {
    if (this.running) { logger.warn("Bot already running"); return; }

    this.running = true;
    this.mode = config.mode;
    this.maxLeverage = config.maxLeverage;
    this.riskPct = config.riskPct;
    this.startedAt = new Date();
    this.tradesExecuted = 0;

    await dbService.startSession(config.mode, config.maxLeverage, config.riskPct);

    riskManager.setTradeCloseCallback(async (trade) => {
      await dbService.saveTrade(trade, aggregator.getBestConnectorForTrading().name);
    });

    await this.refreshBalance();

    this.tickInterval = setInterval(() => this.tick(), 5000);
    this.priceInterval = setInterval(() => {
      const price = aggregator.getPrimaryPrice();
      if (price > 0) riskManager.updatePositionPrices(price);
    }, 1000);

    this.snapshotInterval = setInterval(async () => {
      const stats = riskManager.getStats();
      const positions = riskManager.getPositions();
      await dbService.saveSnapshot(
        riskManager.getAccountBalance(),
        stats.dailyPnl,
        positions.length,
        riskManager.getAccountBalance(),
      );
      await dbService.syncOpenPositions(positions);
    }, SNAPSHOT_INTERVAL_MS);

    this.balanceInterval = setInterval(() => this.refreshBalance(), 5 * 60 * 1000);

    const exchanges = aggregator.getActiveExchanges().join(", ");
    logger.info({ mode: config.mode, maxLeverage: config.maxLeverage, exchanges }, "Bot started");
    const balance = riskManager.getAccountBalance();
    telegramService.notify(
      `Bot started — ${config.mode.toUpperCase()} mode\n` +
      `Balance: $${balance.toFixed(2)} | Leverage: ${config.maxLeverage}x | Risk: ${config.riskPct}%\n` +
      `Exchanges: ${exchanges}`
    );
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    this.mode = "stopped";

    for (const interval of [this.tickInterval, this.priceInterval, this.snapshotInterval, this.balanceInterval]) {
      if (interval) clearInterval(interval);
    }
    this.tickInterval = this.priceInterval = this.snapshotInterval = this.balanceInterval = null;

    const stats = riskManager.getStats();
    await dbService.stopSession(this.tradesExecuted, stats.dailyPnl);
    telegramService.notify(
      `Bot stopped\nTrades: ${this.tradesExecuted} | Daily P&L: $${stats.dailyPnl.toFixed(2)}`
    );
    logger.info({ trades: this.tradesExecuted, dailyPnl: stats.dailyPnl }, "Bot stopped");
  }

  private async refreshBalance() {
    try {
      const balances = await aggregator.getAllBalances();
      const bybit = balances["Bybit"];
      const bingx = balances["BingX"];
      const primary = bybit ?? bingx;
      if (primary?.total > 0) {
        riskManager.setAccountBalance(primary.total);
        logger.info({ balance: primary.total, exchange: bybit ? "Bybit" : "BingX" }, "Balance refreshed");
      }
    } catch (e) {
      logger.warn({ err: e }, "Failed to refresh balance — using previous value");
    }
  }

  private async tick() {
    if (!this.running) return;
    if (riskManager.checkCircuitBreaker()) return;

    const now = Date.now();

    if (now < this.slCooldownUntil) {
      if (now - this.lastCooldownLogAt > 60_000) {
        const remainMin = Math.ceil((this.slCooldownUntil - now) / 60_000);
        logger.info({ remainMin, consecutiveSl: this.consecutiveSl }, "SL cooldown active — skipping tick");
        this.lastCooldownLogAt = now;
      }
      return;
    }

    const price = aggregator.getPrimaryPrice();
    if (price === 0) return;

    const openPositions = riskManager.getPositions();
    const connector = aggregator.getBestConnectorForTrading();

    for (const pos of openPositions) {
      const hitSl = pos.side === "long" ? price <= pos.stopLoss : price >= pos.stopLoss;
      const hitTp = pos.side === "long" ? price >= pos.takeProfit : price <= pos.takeProfit;

      if (hitSl || hitTp) {
        const reason = hitTp ? "tp" : "sl";
        const trade = riskManager.closePosition(pos.id, price, reason);
        if (trade) {
          this.tradesExecuted++;

          telegramService.publishTrade({
            action: "close",
            side: pos.side,
            price,
            size: pos.size,
            leverage: pos.leverage,
            pnl: trade.pnl,
            pnlPct: trade.pnlPct,
            closeReason: reason,
            exchange: connector.name,
            dataExchanges: aggregator.getActiveExchangeNames().join(" + "),
          });
          telegramService.notify(
            `${hitTp ? "✅ TP" : "🔴 SL"} | ${pos.side.toUpperCase()} @ $${price.toFixed(2)}\n` +
            `P&L: $${trade.pnl.toFixed(2)} (${(trade.pnlPct * 100).toFixed(2)}%)`
          );

          if (reason === "sl") {
            this.consecutiveSl++;
            this.lastSlAt = now;

            const cooldownMs = Math.min(
              5 * 60_000 * Math.pow(3, this.consecutiveSl - 1),
              4 * 60 * 60_000
            );
            this.slCooldownUntil = now + cooldownMs;

            const cooldownMin = Math.round(cooldownMs / 60_000);
            logger.warn({ consecutiveSl: this.consecutiveSl, cooldownMin }, "SL cooldown activated");

            telegramService.notify(
              `🔴 SL #${this.consecutiveSl} подряд\n` +
              `⏳ Cooldown: ${cooldownMin} мин\n` +
              `Возобновление: ${new Date(this.slCooldownUntil).toLocaleTimeString("ru-RU")}`
            );
          } else if (reason === "tp") {
            this.consecutiveSl = 0;
            this.slCooldownUntil = 0;
          }

          if (this.mode === "live") {
            try {
              await connector.placeOrder({
                symbol: "BTCUSDT", side: pos.side === "long" ? "Sell" : "Buy",
                orderType: "Market", qty: pos.size, reduceOnly: true,
              });
            } catch (e) { logger.error({ err: e }, "Failed to close live position"); }
          }
        }
      }
    }

    if (now - this.lastTradeAt < MIN_TRADE_INTERVAL_MS) return;
    if (openPositions.length >= 2) return;

    const signal = signalEngine.compute();
    if (!signal.allGatesPassed) return;

    const balance = riskManager.getAccountBalance();
    const leverage = Math.min(this.maxLeverage, signal.suggestedLeverage);
    const riskUsd = balance * (this.riskPct / 100);
    const positionValueUsd = riskUsd * leverage;
    const sizeInBtc = positionValueUsd / price;

    const newPos: Position = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      symbol: "BTCUSDT",
      side: signal.direction as "long" | "short",
      entryPrice: price,
      currentPrice: price,
      size: sizeInBtc,
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

    telegramService.publishTrade({
      action: "open",
      side: signal.direction,
      price,
      size: sizeInBtc,
      leverage,
      exchange: connector.name,
      dataExchanges: aggregator.getActiveExchangeNames().join(" + "),
    });

    const slPct = Math.abs((newPos.stopLoss - price) / price * 100).toFixed(2);
    const tpPct = Math.abs((newPos.takeProfit - price) / price * 100).toFixed(2);
    const prefix = this.mode === "paper" ? "[PAPER]" : "[LIVE]";

    telegramService.notify(
      `${prefix} ${signal.direction.toUpperCase()} signal (${signal.score.toFixed(3)}, ${(signal.confidence * 100).toFixed(0)}%)\n` +
      `Entry: $${price.toFixed(2)} | ${leverage}x | Size: ${sizeInBtc.toFixed(5)} BTC\n` +
      `Exchange: ${connector.name} | Balance: $${balance.toFixed(2)}\n` +
      `SL: $${newPos.stopLoss.toFixed(2)} (-${slPct}%) | TP: $${newPos.takeProfit.toFixed(2)} (+${tpPct}%)`
    );

    if (this.mode === "live") {
      try {
        await connector.placeOrder({
          symbol: "BTCUSDT",
          side: signal.direction === "long" ? "Buy" : "Sell",
          orderType: "Market",
          qty: sizeInBtc,
          leverage,
          stopLoss: signal.suggestedSl,
          takeProfit: signal.suggestedTp,
        });
        logger.info({ exchange: connector.name, side: signal.direction, price, leverage }, "Live order placed");
      } catch (e) {
        logger.error({ err: e }, "Failed to place live order");
        telegramService.notify(`ERROR placing order: ${(e as Error).message}`);
        riskManager.closePosition(newPos.id, price, "order_failed");
        this.tradesExecuted--;
      }
    }
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
      accountBalance: riskManager.getAccountBalance(),
      slCooldownUntil: this.slCooldownUntil > Date.now()
        ? new Date(this.slCooldownUntil).toISOString()
        : null,
      consecutiveSl: this.consecutiveSl,
    };
  }
}

export const botEngine = new BotEngine();
