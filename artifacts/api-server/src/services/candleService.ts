import { aggregator } from "./exchanges/aggregator";

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  buyVolume: number;
  sellVolume: number;
}

const MAX_CANDLES = 100;

class CandleService {
  private candles: Candle[] = [];
  private currentCandle: Candle | null = null;
  private processedTradeIds = new Set<string>();
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  private vwapNumerator = 0;
  private vwapDenominator = 0;
  private vwapDayStart = 0;

  start() {
    this.intervalHandle = setInterval(() => this.tick(), 2000);
  }

  stop() {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
  }

  private tick() {
    const trades = aggregator.getAllTrades().filter(t => !this.processedTradeIds.has(t.id));
    for (const t of trades) {
      this.processedTradeIds.add(t.id);
      this.addTick(t.price, t.size, t.side as "buy" | "sell", t.timestamp);
    }
    if (this.processedTradeIds.size > 20000) {
      const arr = Array.from(this.processedTradeIds);
      this.processedTradeIds = new Set(arr.slice(-10000));
    }
  }

  private addTick(price: number, size: number, side: "buy" | "sell", timestamp: number) {
    const dayStartTs = new Date(timestamp).setUTCHours(0, 0, 0, 0);
    if (dayStartTs !== this.vwapDayStart) {
      this.vwapDayStart = dayStartTs;
      this.vwapNumerator = 0;
      this.vwapDenominator = 0;
    }
    this.vwapNumerator += price * size;
    this.vwapDenominator += size;

    const minute = Math.floor(timestamp / 60000) * 60000;
    if (!this.currentCandle || this.currentCandle.time !== minute) {
      if (this.currentCandle) {
        this.candles.push(this.currentCandle);
        if (this.candles.length > MAX_CANDLES) this.candles.shift();
      }
      this.currentCandle = {
        time: minute,
        open: price, high: price, low: price, close: price,
        volume: size,
        buyVolume: side === "buy" ? size : 0,
        sellVolume: side === "sell" ? size : 0,
      };
    } else {
      if (price > this.currentCandle.high) this.currentCandle.high = price;
      if (price < this.currentCandle.low) this.currentCandle.low = price;
      this.currentCandle.close = price;
      this.currentCandle.volume += size;
      if (side === "buy") this.currentCandle.buyVolume += size;
      else this.currentCandle.sellVolume += size;
    }
  }

  getCandles(): Candle[] {
    const all = [...this.candles];
    if (this.currentCandle) all.push({ ...this.currentCandle });
    return all;
  }

  getCandleCount(): number {
    return this.candles.length + (this.currentCandle ? 1 : 0);
  }

  getVwap(): number {
    if (this.vwapDenominator === 0) return 0;
    return this.vwapNumerator / this.vwapDenominator;
  }

  getAtr(period = 14): number {
    const candles = this.getCandles();
    if (candles.length < 2) return 0;
    const trs: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const h = candles[i].high;
      const l = candles[i].low;
      const pc = candles[i - 1].close;
      trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    const lookback = Math.min(period, trs.length);
    return trs.slice(-lookback).reduce((s, v) => s + v, 0) / lookback;
  }

  getEma(period: number): number {
    const candles = this.getCandles();
    if (candles.length === 0) return 0;
    const closes = candles.map(c => c.close);
    if (closes.length < period) {
      return closes.reduce((s, v) => s + v, 0) / closes.length;
    }
    const k = 2 / (period + 1);
    let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
    for (let i = period; i < closes.length; i++) {
      ema = closes[i] * k + ema * (1 - k);
    }
    return ema;
  }
}

export const candleService = new CandleService();
