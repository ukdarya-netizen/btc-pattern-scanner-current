import WebSocket from "ws";
import { logger } from "../lib/logger";

export interface BybitTicker {
  symbol: string;
  lastPrice: number;
  price24hPcnt: number;
  volume24h: number;
  highPrice24h: number;
  lowPrice24h: number;
  prevPrice24h: number;
  openInterest: number;
  fundingRate: number;
  nextFundingTime: number;
}

export interface BybitOrderbookLevel {
  price: number;
  size: number;
}

export interface BybitOrderbook {
  symbol: string;
  bids: BybitOrderbookLevel[];
  asks: BybitOrderbookLevel[];
  updatedAt: number;
}

export interface BybitTrade {
  id: string;
  price: number;
  size: number;
  side: "buy" | "sell";
  timestamp: number;
}

const BYBIT_WS = "wss://stream.bybit.com/v5/public/linear";
const SYMBOL = "BTCUSDT";
const MAX_TRADES = 200;
const MAX_BOOK_LEVELS = 25;

class BybitService {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectDelay = 1000;

  ticker: BybitTicker = {
    symbol: SYMBOL,
    lastPrice: 0,
    price24hPcnt: 0,
    volume24h: 0,
    highPrice24h: 0,
    lowPrice24h: 0,
    prevPrice24h: 0,
    openInterest: 0,
    fundingRate: 0,
    nextFundingTime: 0,
  };

  orderbook: BybitOrderbook = {
    symbol: SYMBOL,
    bids: [],
    asks: [],
    updatedAt: Date.now(),
  };

  trades: BybitTrade[] = [];

  private bidsMap = new Map<string, number>();
  private asksMap = new Map<string, number>();

  connect() {
    if (this.ws) return;
    logger.info("Connecting to Bybit WebSocket...");
    this.ws = new WebSocket(BYBIT_WS);

    this.ws.on("open", () => {
      logger.info("Bybit WebSocket connected");
      this.reconnectDelay = 1000;
      this.subscribe();
      this.startPing();
    });

    this.ws.on("message", (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleMessage(msg);
      } catch (e) {
        logger.warn({ err: e }, "Failed to parse Bybit message");
      }
    });

    this.ws.on("close", () => {
      logger.warn("Bybit WebSocket disconnected, reconnecting...");
      this.cleanup();
      this.scheduleReconnect();
    });

    this.ws.on("error", (err) => {
      logger.error({ err }, "Bybit WebSocket error");
      this.ws?.terminate();
    });
  }

  private subscribe() {
    const topics = [
      `tickers.${SYMBOL}`,
      `orderbook.50.${SYMBOL}`,
      `publicTrade.${SYMBOL}`,
    ];
    this.ws?.send(JSON.stringify({ op: "subscribe", args: topics }));
  }

  private startPing() {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ op: "ping" }));
      }
    }, 20000);
  }

  private cleanup() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.ws = null;
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
  }

  private handleMessage(msg: Record<string, unknown>) {
    if (msg["op"] === "pong" || msg["op"] === "subscribe") return;

    const topic = msg["topic"] as string | undefined;
    if (!topic) return;

    const data = msg["data"];

    if (topic === `tickers.${SYMBOL}`) {
      this.handleTicker(data as Record<string, string>);
    } else if (topic.startsWith("orderbook.")) {
      const type = msg["type"] as string;
      this.handleOrderbook(data as Record<string, unknown>, type);
    } else if (topic === `publicTrade.${SYMBOL}`) {
      this.handleTrades(data as Array<Record<string, string>>);
    }
  }

  private handleTicker(data: Record<string, string>) {
    const price = parseFloat(data["lastPrice"] ?? "0");
    if (price > 0) this.ticker.lastPrice = price;

    const pct = parseFloat(data["price24hPcnt"] ?? "");
    if (!isNaN(pct)) this.ticker.price24hPcnt = pct;

    const vol = parseFloat(data["volume24h"] ?? "");
    if (!isNaN(vol)) this.ticker.volume24h = vol;

    const high = parseFloat(data["highPrice24h"] ?? "");
    if (!isNaN(high)) this.ticker.highPrice24h = high;

    const low = parseFloat(data["lowPrice24h"] ?? "");
    if (!isNaN(low)) this.ticker.lowPrice24h = low;

    const prev = parseFloat(data["prevPrice24h"] ?? "");
    if (!isNaN(prev)) this.ticker.prevPrice24h = prev;

    const oi = parseFloat(data["openInterest"] ?? "");
    if (!isNaN(oi)) this.ticker.openInterest = oi;

    const fr = parseFloat(data["fundingRate"] ?? "");
    if (!isNaN(fr)) this.ticker.fundingRate = fr;

    const nft = parseInt(data["nextFundingTime"] ?? "0");
    if (nft > 0) this.ticker.nextFundingTime = nft;
  }

  private handleOrderbook(data: Record<string, unknown>, type: string) {
    if (type === "snapshot") {
      this.bidsMap.clear();
      this.asksMap.clear();
    }

    const bids = data["b"] as Array<[string, string]> | undefined;
    const asks = data["a"] as Array<[string, string]> | undefined;

    if (bids) {
      for (const [p, s] of bids) {
        const size = parseFloat(s);
        if (size === 0) this.bidsMap.delete(p);
        else this.bidsMap.set(p, size);
      }
    }

    if (asks) {
      for (const [p, s] of asks) {
        const size = parseFloat(s);
        if (size === 0) this.asksMap.delete(p);
        else this.asksMap.set(p, size);
      }
    }

    const bidsArr = Array.from(this.bidsMap.entries())
      .map(([p, s]) => ({ price: parseFloat(p), size: s }))
      .sort((a, b) => b.price - a.price)
      .slice(0, MAX_BOOK_LEVELS);

    const asksArr = Array.from(this.asksMap.entries())
      .map(([p, s]) => ({ price: parseFloat(p), size: s }))
      .sort((a, b) => a.price - b.price)
      .slice(0, MAX_BOOK_LEVELS);

    this.orderbook = {
      symbol: SYMBOL,
      bids: bidsArr,
      asks: asksArr,
      updatedAt: Date.now(),
    };
  }

  private handleTrades(data: Array<Record<string, string>>) {
    for (const t of data) {
      const trade: BybitTrade = {
        id: t["i"] ?? String(Date.now()),
        price: parseFloat(t["p"] ?? "0"),
        size: parseFloat(t["v"] ?? "0"),
        side: t["S"] === "Buy" ? "buy" : "sell",
        timestamp: parseInt(t["T"] ?? "0"),
      };
      this.trades.unshift(trade);
    }
    if (this.trades.length > MAX_TRADES) {
      this.trades = this.trades.slice(0, MAX_TRADES);
    }
  }
}

export const bybitService = new BybitService();
