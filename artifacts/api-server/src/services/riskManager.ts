import { logger } from "../lib/logger";

export interface TradeRecord {
  id: string;
  openedAt: Date;
  closedAt: Date;
  side: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  size: number;
  leverage: number;
  pnl: number;
  pnlPct: number;
}

export interface Position {
  id: string;
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  currentPrice: number;
  size: number;
  leverage: number;
  pnl: number;
  pnlPct: number;
  stopLoss: number;
  takeProfit: number;
  openedAt: string;
}

class RiskManager {
  private trades: TradeRecord[] = [];
  private positions: Position[] = [];
  private balance = 10000;
  private peakBalance = 10000;
  private circuitBreakerTripped = false;
  private cooldownUntil: Date | null = null;
  private maxDailyLossPct = 0.03;
  private cooldownMinutes = 60;

  private getDailyPnl(): number {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return this.trades
      .filter((t) => t.closedAt >= today)
      .reduce((s, t) => s + t.pnl, 0);
  }

  private getDailyPnlPct(): number {
    return this.getDailyPnl() / this.balance;
  }

  checkCircuitBreaker(): boolean {
    if (this.circuitBreakerTripped) {
      if (this.cooldownUntil && new Date() > this.cooldownUntil) {
        this.circuitBreakerTripped = false;
        this.cooldownUntil = null;
        logger.info("Circuit breaker reset after cooldown");
      }
      return this.circuitBreakerTripped;
    }

    const dailyPnlPct = this.getDailyPnlPct();
    if (dailyPnlPct < -this.maxDailyLossPct) {
      this.circuitBreakerTripped = true;
      this.cooldownUntil = new Date(Date.now() + this.cooldownMinutes * 60 * 1000);
      logger.warn({ dailyPnlPct }, "Circuit breaker tripped");
    }

    return this.circuitBreakerTripped;
  }

  recordTrade(trade: TradeRecord) {
    this.trades.push(trade);
    this.balance += trade.pnl;
    if (this.balance > this.peakBalance) this.peakBalance = this.balance;
    this.checkCircuitBreaker();
  }

  openPosition(pos: Position) {
    this.positions.push(pos);
    logger.info({ id: pos.id, side: pos.side, price: pos.entryPrice }, "Position opened");
  }

  closePosition(id: string, exitPrice: number): TradeRecord | null {
    const idx = this.positions.findIndex((p) => p.id === id);
    if (idx === -1) return null;
    const pos = this.positions[idx];
    this.positions.splice(idx, 1);

    const mult = pos.side === "long" ? 1 : -1;
    const pnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * mult * pos.leverage;
    const pnl = pnlPct * pos.size;

    const trade: TradeRecord = {
      id: pos.id,
      openedAt: new Date(pos.openedAt),
      closedAt: new Date(),
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice,
      size: pos.size,
      leverage: pos.leverage,
      pnl,
      pnlPct,
    };

    this.recordTrade(trade);
    logger.info({ id: pos.id, pnl }, "Position closed");
    return trade;
  }

  updatePositionPrices(currentPrice: number) {
    for (const pos of this.positions) {
      pos.currentPrice = currentPrice;
      const mult = pos.side === "long" ? 1 : -1;
      pos.pnlPct = ((currentPrice - pos.entryPrice) / pos.entryPrice) * mult * pos.leverage;
      pos.pnl = pos.pnlPct * pos.size;
    }
  }

  getStats() {
    const dailyTrades = (() => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      return this.trades.filter((t) => t.closedAt >= today);
    })();

    const wins = dailyTrades.filter((t) => t.pnl > 0);
    const losses = dailyTrades.filter((t) => t.pnl < 0);
    const dailyPnl = this.getDailyPnl();
    const maxDrawdown = this.peakBalance > 0 ? (this.peakBalance - this.balance) / this.peakBalance : 0;

    const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;

    const pnlValues = dailyTrades.map((t) => t.pnlPct);
    const mean = pnlValues.length > 0 ? pnlValues.reduce((s, v) => s + v, 0) / pnlValues.length : 0;
    const variance = pnlValues.length > 1
      ? pnlValues.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / pnlValues.length
      : 0;
    const sharpe = variance > 0 ? mean / Math.sqrt(variance) : 0;

    return {
      dailyPnl: parseFloat(dailyPnl.toFixed(2)),
      dailyPnlPct: parseFloat(this.getDailyPnlPct().toFixed(6)),
      maxDrawdown: parseFloat(maxDrawdown.toFixed(6)),
      winRate: dailyTrades.length > 0 ? wins.length / dailyTrades.length : 0,
      totalTrades: dailyTrades.length,
      winningTrades: wins.length,
      losingTrades: losses.length,
      avgWin: parseFloat(avgWin.toFixed(2)),
      avgLoss: parseFloat(avgLoss.toFixed(2)),
      sharpeIntraday: parseFloat(sharpe.toFixed(4)),
      circuitBreakerTripped: this.circuitBreakerTripped,
      cooldownUntil: this.cooldownUntil?.toISOString() ?? null,
    };
  }

  getPositions(): Position[] {
    return [...this.positions];
  }

  isCircuitBreakerTripped(): boolean {
    return this.circuitBreakerTripped;
  }

  getCooldownUntil(): Date | null {
    return this.cooldownUntil;
  }
}

export const riskManager = new RiskManager();
