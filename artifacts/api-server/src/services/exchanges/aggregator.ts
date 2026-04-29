import { logger } from "../../lib/logger";
import { bybitConnector } from "./bybitConnector";
import { bingxConnector } from "./bingxConnector";
import { okxConnector } from "./okxConnector";
import { liquidationService } from "../liquidationService";
import type { IExchangeConnector, ExchangeTicker, ExchangeOrderbook, ExchangeTrade, ExchangeBalance, ExchangePosition } from "./types";

export interface AggregatedTicker {
  bestExchange: string;
  prices: Record<string, number>;
  avgPrice: number;
  bestBid: { exchange: string; price: number };
  bestAsk: { exchange: string; price: number };
  spread: number;
  priceChange24h: number;
  priceChangePct24h: number;
  volume24h: number;
  high24h: number;
  low24h: number;
  openInterest: number;
  fundingRate: number;
  nextFundingTime: number;
  updatedAt: string;
}

export interface AggregatedOrderbook {
  byExchange: Record<string, ExchangeOrderbook>;
  mergedBids: { price: number; size: number; total: number; exchange: string }[];
  mergedAsks: { price: number; size: number; total: number; exchange: string }[];
  bestSpread: { exchange: string; spread: number };
  worstSpread: { exchange: string; spread: number };
  avgImbalance: number;
  updatedAt: string;
}

export interface ExchangeStatus {
  name: string;
  connected: boolean;
  hasApiKey: boolean;
  price: number | null;
  latency: number;
}

class ExchangeAggregator {
  private connectors: IExchangeConnector[] = [];
  private activeExchanges: string[] = [];

  init() {
    const candidates: IExchangeConnector[] = [bybitConnector, bingxConnector, okxConnector];

    for (const c of candidates) {
      const hasKey = this.connectorHasKey(c);
      if (hasKey || c.name === "Bybit") {
        this.connectors.push(c);
        this.activeExchanges.push(c.name);
        c.connect();
        logger.info({ exchange: c.name, hasKey }, "Exchange connector started");
      } else {
        logger.info({ exchange: c.name }, "Exchange skipped (no API key)");
      }
    }

    bybitConnector.onLiquidation(liq => liquidationService.addEvent(liq));
  }

  private connectorHasKey(c: IExchangeConnector): boolean {
    const name = c.name.toLowerCase().replace(/\s/g, "");
    const key = process.env[`${name.toUpperCase()}_API_KEY`] ??
      process.env[`${c.name.toUpperCase()}_API_KEY`];
    return !!key;
  }

  getActiveExchanges(): string[] {
    return this.activeExchanges;
  }

  getStatus(): ExchangeStatus[] {
    const all = [bybitConnector, bingxConnector, okxConnector];
    return all.map(c => ({
      name: c.name,
      connected: c.connected,
      hasApiKey: this.connectorHasKey(c),
      price: c.getTicker()?.price ?? null,
      latency: 0,
    }));
  }

  getAggregatedTicker(): AggregatedTicker | null {
    const tickers = this.connectors
      .map(c => c.getTicker())
      .filter((t): t is ExchangeTicker => t !== null && t.price > 0);

    if (tickers.length === 0) return null;

    const prices: Record<string, number> = {};
    for (const t of tickers) prices[t.exchange] = t.price;

    const avgPrice = tickers.reduce((s, t) => s + t.price, 0) / tickers.length;

    const bestBidT = tickers.reduce((best, t) => t.bid > best.bid ? t : best, tickers[0]);
    const bestAskT = tickers.reduce((best, t) => t.ask < best.ask ? t : best, tickers[0]);

    const primary = tickers.find(t => t.exchange === "Bybit") ?? tickers[0];

    return {
      bestExchange: primary.exchange,
      prices,
      avgPrice,
      bestBid: { exchange: bestBidT.exchange, price: bestBidT.bid },
      bestAsk: { exchange: bestAskT.exchange, price: bestAskT.ask },
      spread: bestAskT.ask - bestBidT.bid,
      priceChange24h: primary.priceChange24h,
      priceChangePct24h: primary.priceChangePct24h,
      volume24h: tickers.reduce((s, t) => s + t.volume24h, 0),
      high24h: Math.max(...tickers.map(t => t.high24h)),
      low24h: Math.min(...tickers.map(t => t.low24h)),
      openInterest: primary.openInterest,
      fundingRate: primary.fundingRate,
      nextFundingTime: primary.nextFundingTime,
      updatedAt: new Date().toISOString(),
    };
  }

  getAggregatedOrderbook(): AggregatedOrderbook | null {
    const books = this.connectors
      .map(c => c.getOrderbook())
      .filter((ob): ob is ExchangeOrderbook => ob !== null);

    if (books.length === 0) return null;

    const byExchange: Record<string, ExchangeOrderbook> = {};
    for (const b of books) byExchange[b.exchange] = b;

    const allBids = books.flatMap(ob =>
      ob.bids.slice(0, 10).map(l => ({ ...l, exchange: ob.exchange }))
    ).sort((a, b) => b.price - a.price);

    const allAsks = books.flatMap(ob =>
      ob.asks.slice(0, 10).map(l => ({ ...l, exchange: ob.exchange }))
    ).sort((a, b) => a.price - b.price);

    let bt = 0;
    const mergedBids = allBids.slice(0, 20).map(l => ({ ...l, total: (bt += l.size) }));
    let at = 0;
    const mergedAsks = allAsks.slice(0, 20).map(l => ({ ...l, total: (at += l.size) }));

    const sorted = [...books].sort((a, b) => a.spread - b.spread);
    const bestSpread = { exchange: sorted[0].exchange, spread: sorted[0].spread };
    const worstSpread = { exchange: sorted[sorted.length - 1].exchange, spread: sorted[sorted.length - 1].spread };
    const avgImbalance = books.reduce((s, b) => s + b.imbalance, 0) / books.length;

    return { byExchange, mergedBids, mergedAsks, bestSpread, worstSpread, avgImbalance, updatedAt: new Date().toISOString() };
  }

  getAllTrades(): ExchangeTrade[] {
    const all = this.connectors.flatMap(c => c.getTrades());
    return all.sort((a, b) => b.timestamp - a.timestamp).slice(0, 100);
  }

  getPrimaryPrice(): number {
    return bybitConnector.getTicker()?.price
      ?? bingxConnector.getTicker()?.price
      ?? 0;
  }

  getPrimaryOrderbook(): ExchangeOrderbook | null {
    return bybitConnector.getOrderbook()
      ?? bingxConnector.getOrderbook()
      ?? null;
  }

  getPrimaryTrades(): ExchangeTrade[] {
    return bybitConnector.getTrades().length > 0
      ? bybitConnector.getTrades()
      : bingxConnector.getTrades();
  }

  getPrimaryFundingRate(): number {
    return bybitConnector.getTicker()?.fundingRate ?? 0;
  }

  getPrimaryOpenInterest(): number {
    return bybitConnector.getTicker()?.openInterest ?? 0;
  }

  async getAllBalances(): Promise<Record<string, ExchangeBalance>> {
    const results: Record<string, ExchangeBalance> = {};
    await Promise.allSettled(
      this.connectors.map(async c => {
        if (!this.connectorHasKey(c)) return;
        try { results[c.name] = await c.getBalance(); }
        catch (e) { logger.warn({ err: e, exchange: c.name }, "Failed to fetch balance"); }
      })
    );
    return results;
  }

  async getAllPositions(): Promise<ExchangePosition[]> {
    const all = await Promise.allSettled(
      this.connectors.map(c => c.getPositions())
    );
    return all
      .filter((r): r is PromiseFulfilledResult<ExchangePosition[]> => r.status === "fulfilled")
      .flatMap(r => r.value);
  }

  getBestConnectorForTrading(): IExchangeConnector {
    for (const preferred of ["Bybit", "OKX", "BingX"]) {
      const c = this.connectors.find(c => c.name === preferred && c.connected && this.connectorHasKey(c));
      if (c) return c;
    }
    return bybitConnector;
  }
}

export const aggregator = new ExchangeAggregator();
