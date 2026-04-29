import { logger } from "../lib/logger";

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

export interface ClosedTrade {
  id: string;
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  exitPrice: number;
  size: number;
  leverage: number;
  pnl: number;
  pnlPct: number;
  openedAt: string;
  closedAt: string;
  closeReason: string;
}

const DAILY_LOSS_LIMIT = 0.03;
const COOLDOWN_MS = 60 * 60 * 1000;

class RiskManager {
  private positions = new Map<string, Position>();
  private closedToday: ClosedTrade[] = [];
  private accountBalance = 10000;
  private peakEquity = 10000;
  private circuitBreakerTripped = false;
  private cooldownUntil: Date | null = null;
  private pnlHistory: number[] = [];
  private onTradeClose: ((trade: ClosedTrade) => void) | null = null;

  setTradeCloseCallback(cb: (trade: ClosedTrade) => void) {
    this.onTradeClose = cb;
  }

  setAccountBalance(balance: number) {
    if (balance > 0) {
      this.accountBalance = balance;
      if (balance > this.peakEquity) this.peakEquity = balance;
    }
  }

  getAccountBalance(): number { return this.accountBalance; }

  checkCircuitBreaker(): boolean {
    if (this.cooldownUntil && Date.now() >= this.cooldownUntil.getTime()) {
      this.cooldownUntil = null;
      this.circuitBreakerTripped = false;
      logger.info("Circuit breaker reset after cooldown");
    }
    if (this.circuitBreakerTripped) return true;

    const dailyPnlPct = this.getDailyPnl() / this.accountBalance;
    if (dailyPnlPct <= -DAILY_LOSS_LIMIT) {
      this.circuitBreakerTripped = true;
      this.cooldownUntil = new Date(Date.now() + COOLDOWN_MS);
      logger.warn({ dailyPnlPct }, "Circuit breaker TRIPPED — 3% daily loss exceeded");
    }
    return this.circuitBreakerTripped;
  }

  openPosition(pos: Position): void {
    this.positions.set(pos.id, pos);
    logger.info({ id: pos.id, side: pos.side, price: pos.entryPrice }, "Position opened");
  }

  updatePositionPrices(currentPrice: number): void {
    for (const [id, pos] of this.positions) {
      const priceDiff = currentPrice - pos.entryPrice;
      const pnl = (pos.side === "long" ? priceDiff : -priceDiff) * pos.size;
      const pnlPct = pnl / (pos.entryPrice * pos.size / pos.leverage);
      this.positions.set(id, { ...pos, currentPrice, pnl, pnlPct });
    }
  }

  closePosition(id: string, exitPrice: number, reason = "manual"): ClosedTrade | null {
    const pos = this.positions.get(id);
    if (!pos) return null;
    this.positions.delete(id);

    const priceDiff = exitPrice - pos.entryPrice;
    const pnl = (pos.side === "long" ? priceDiff : -priceDiff) * pos.size;
    const pnlPct = pnl / (pos.entryPrice * pos.size / pos.leverage);

    const trade: ClosedTrade = {
      id: pos.id,
      symbol: pos.symbol,
      side: pos.side,
      entryPrice: pos.entryPrice,
      exitPrice,
      size: pos.size,
      leverage: pos.leverage,
      pnl,
      pnlPct,
      openedAt: pos.openedAt,
      closedAt: new Date().toISOString(),
      closeReason: reason,
    };

    this.closedToday.unshift(trade);
    if (this.closedToday.length > 200) this.closedToday = this.closedToday.slice(0, 200);
    this.pnlHistory.push(pnl);
    if (this.pnlHistory.length > 100) this.pnlHistory = this.pnlHistory.slice(-100);

    this.accountBalance += pnl;
    if (this.accountBalance > this.peakEquity) this.peakEquity = this.accountBalance;

    logger.info({ id: pos.id, pnl, reason }, "Position closed");
    if (this.onTradeClose) this.onTradeClose(trade);
    return trade;
  }

  resetDailyTrades(): void {
    this.closedToday = [];
    this.circuitBreakerTripped = false;
    this.cooldownUntil = null;
  }

  getDailyPnl(): number {
    return this.closedToday.reduce((s, t) => s + t.pnl, 0);
  }

  getPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  getClosedTrades(): ClosedTrade[] {
    return [...this.closedToday];
  }

  getStats() {
    const wins = this.closedToday.filter(t => t.pnl > 0);
    const losses = this.closedToday.filter(t => t.pnl < 0);
    const dailyPnl = this.getDailyPnl();
    const maxDrawdown = this.peakEquity > 0
      ? (this.peakEquity - this.accountBalance) / this.peakEquity : 0;

    let sharpe = 0;
    if (this.pnlHistory.length > 2) {
      const avg = this.pnlHistory.reduce((s, v) => s + v, 0) / this.pnlHistory.length;
      const variance = this.pnlHistory.reduce((s, v) => s + (v - avg) ** 2, 0) / this.pnlHistory.length;
      sharpe = Math.sqrt(variance) > 0 ? avg / Math.sqrt(variance) : 0;
    }

    return {
      dailyPnl: parseFloat(dailyPnl.toFixed(4)),
      dailyPnlPct: parseFloat((dailyPnl / this.accountBalance).toFixed(6)),
      maxDrawdown: parseFloat(maxDrawdown.toFixed(6)),
      winRate: this.closedToday.length > 0
        ? parseFloat((wins.length / this.closedToday.length).toFixed(4)) : 0,
      totalTrades: this.closedToday.length,
      winningTrades: wins.length,
      losingTrades: losses.length,
      avgWin: wins.length > 0
        ? parseFloat((wins.reduce((s, t) => s + t.pnl, 0) / wins.length).toFixed(4)) : 0,
      avgLoss: losses.length > 0
        ? parseFloat((losses.reduce((s, t) => s + t.pnl, 0) / losses.length).toFixed(4)) : 0,
      sharpeIntraday: parseFloat(sharpe.toFixed(4)),
      circuitBreakerTripped: this.circuitBreakerTripped,
      cooldownUntil: this.cooldownUntil?.toISOString() ?? null,
    };
  }
}

export const riskManager = new RiskManager();
