import WebSocket from "ws";
import https from "https";
import { logger } from "../../lib/logger";
import { hmacSha256, computeImbalance } from "./utils";
import type {
  IExchangeConnector, ExchangeTicker, ExchangeOrderbook, ExchangeTrade,
  ExchangeBalance, ExchangePosition, PlaceOrderParams, OrderResult, OrderbookLevel,
  ExchangeLiquidation,
} from "./types";

const REST_BASE = "https://api.bybit.com";
const WS_PUBLIC = "wss://stream.bybit.com/v5/public/linear";
const SYMBOL = "BTCUSDT";
const MAX_TRADES = 200;
const BOOK_LEVELS = 25;

function restRequest(
  method: "GET" | "POST",
  path: string,
  params: Record<string, unknown> = {},
  apiKey: string,
  apiSecret: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timestamp = Date.now().toString();
    const recvWindow = "5000";
    let queryString = "";
    let body = "";

    if (method === "GET") {
      const entries = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&");
      queryString = entries;
    } else {
      body = JSON.stringify(params);
    }

    const signPayload = `${timestamp}${apiKey}${recvWindow}${method === "GET" ? queryString : body}`;
    const signature = hmacSha256(apiSecret, signPayload);

    const headers: Record<string, string> = {
      "X-BAPI-API-KEY": apiKey,
      "X-BAPI-TIMESTAMP": timestamp,
      "X-BAPI-RECV-WINDOW": recvWindow,
      "X-BAPI-SIGN": signature,
      "Content-Type": "application/json",
    };

    const url = new URL(`${REST_BASE}${path}${queryString ? "?" + queryString : ""}`);

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers,
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data) as Record<string, unknown>;
          if (parsed["retCode"] !== 0) {
            reject(new Error(`Bybit API error ${parsed["retCode"]}: ${parsed["retMsg"]}`));
          } else {
            resolve((parsed["result"] ?? parsed) as Record<string, unknown>);
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", reject);
    if (method === "POST" && body) req.write(body);
    req.end();
  });
}

export class BybitConnector implements IExchangeConnector {
  readonly name = "Bybit";
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectDelay = 1000;
  private _connected = false;

  private _ticker: ExchangeTicker | null = null;
  private bidsMap = new Map<string, number>();
  private asksMap = new Map<string, number>();
  private _orderbook: ExchangeOrderbook | null = null;
  private _trades: ExchangeTrade[] = [];
  private _liquidationCallbacks: Array<(liq: ExchangeLiquidation) => void> = [];

  onLiquidation(cb: (liq: ExchangeLiquidation) => void) {
    this._liquidationCallbacks.push(cb);
  }

  private apiKey = process.env["BYBIT_API_KEY"] ?? "";
  private apiSecret = process.env["BYBIT_API_SECRET"] ?? "";

  get connected() { return this._connected; }

  connect() {
    if (this.ws) return;
    logger.info("Bybit: connecting to public WebSocket...");
    this.ws = new WebSocket(WS_PUBLIC);

    this.ws.on("open", () => {
      this._connected = true;
      this.reconnectDelay = 1000;
      this.subscribe();
      this.startPing();
      logger.info("Bybit: WebSocket connected");
    });

    this.ws.on("message", (data: Buffer) => {
      try { this.handleMessage(JSON.parse(data.toString())); }
      catch (e) { logger.warn({ err: e }, "Bybit: parse error"); }
    });

    this.ws.on("close", () => {
      this._connected = false;
      this.cleanup();
      this.scheduleReconnect();
      logger.warn("Bybit: WebSocket closed, reconnecting...");
    });

    this.ws.on("error", (err) => {
      logger.error({ err }, "Bybit: WebSocket error");
      this.ws?.terminate();
    });
  }

  private subscribe() {
    this.ws?.send(JSON.stringify({
      op: "subscribe",
      args: [
        `tickers.${SYMBOL}`,
        `orderbook.50.${SYMBOL}`,
        `publicTrade.${SYMBOL}`,
        `allLiquidation.${SYMBOL}`,
      ],
    }));
  }

  private startPing() {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN)
        this.ws.send(JSON.stringify({ op: "ping" }));
    }, 20000);
  }

  private cleanup() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.ws = null;
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
  }

  private handleMessage(msg: Record<string, unknown>) {
    if (msg["op"] === "pong" || msg["op"] === "subscribe") return;
    const topic = msg["topic"] as string | undefined;
    if (!topic) return;

    if (topic === `tickers.${SYMBOL}`) this.handleTicker(msg["data"] as Record<string, string>);
    else if (topic.startsWith("orderbook.")) this.handleOrderbook(msg["data"] as Record<string, unknown>, msg["type"] as string);
    else if (topic === `publicTrade.${SYMBOL}`) this.handleTrades(msg["data"] as Array<Record<string, string>>);
    else if (topic === `allLiquidation.${SYMBOL}`) this.handleLiquidation(msg["data"] as Record<string, unknown>);
  }

  private handleTicker(d: Record<string, string>) {
    const price = parseFloat(d["lastPrice"] ?? "0");
    const prev = parseFloat(d["prevPrice24h"] ?? d["lastPrice"] ?? "0");
    const bid = parseFloat(d["bid1Price"] ?? d["lastPrice"] ?? "0");
    const ask = parseFloat(d["ask1Price"] ?? d["lastPrice"] ?? "0");

    if (price > 0) {
      this._ticker = {
        exchange: "Bybit",
        symbol: SYMBOL,
        price,
        bid: bid || price,
        ask: ask || price,
        spread: ask > 0 && bid > 0 ? ask - bid : 0,
        priceChange24h: price - (prev || price),
        priceChangePct24h: parseFloat(d["price24hPcnt"] ?? "0") * 100,
        volume24h: parseFloat(d["volume24h"] ?? "0"),
        high24h: parseFloat(d["highPrice24h"] ?? "0"),
        low24h: parseFloat(d["lowPrice24h"] ?? "0"),
        openInterest: parseFloat(d["openInterest"] ?? "0"),
        fundingRate: parseFloat(d["fundingRate"] ?? "0"),
        nextFundingTime: parseInt(d["nextFundingTime"] ?? "0"),
        updatedAt: Date.now(),
      };
    }
  }

  private handleOrderbook(data: Record<string, unknown>, type: string) {
    if (type === "snapshot") { this.bidsMap.clear(); this.asksMap.clear(); }

    for (const [p, s] of (data["b"] as Array<[string, string]> ?? [])) {
      const sz = parseFloat(s);
      if (sz === 0) this.bidsMap.delete(p); else this.bidsMap.set(p, sz);
    }
    for (const [p, s] of (data["a"] as Array<[string, string]> ?? [])) {
      const sz = parseFloat(s);
      if (sz === 0) this.asksMap.delete(p); else this.asksMap.set(p, sz);
    }

    const bidsRaw = Array.from(this.bidsMap.entries())
      .map(([p, s]) => ({ price: parseFloat(p), size: s }))
      .sort((a, b) => b.price - a.price).slice(0, BOOK_LEVELS);
    const asksRaw = Array.from(this.asksMap.entries())
      .map(([p, s]) => ({ price: parseFloat(p), size: s }))
      .sort((a, b) => a.price - b.price).slice(0, BOOK_LEVELS);

    let bt = 0, at = 0;
    const bids: OrderbookLevel[] = bidsRaw.map(l => ({ ...l, total: (bt += l.size) }));
    const asks: OrderbookLevel[] = asksRaw.map(l => ({ ...l, total: (at += l.size) }));

    const spread = asks[0] && bids[0] ? asks[0].price - bids[0].price : 0;
    const mid = asks[0] && bids[0] ? (asks[0].price + bids[0].price) / 2 : 1;

    this._orderbook = {
      exchange: "Bybit",
      symbol: SYMBOL,
      bids,
      asks,
      spread,
      spreadPct: mid > 0 ? spread / mid * 100 : 0,
      imbalance: computeImbalance(bids, asks),
      updatedAt: Date.now(),
    };
  }

  private handleTrades(data: Array<Record<string, string>>) {
    for (const t of data) {
      this._trades.unshift({
        id: t["i"] ?? String(Date.now()),
        exchange: "Bybit",
        price: parseFloat(t["p"] ?? "0"),
        size: parseFloat(t["v"] ?? "0"),
        side: t["S"] === "Buy" ? "buy" : "sell",
        timestamp: parseInt(t["T"] ?? "0"),
      });
    }
    if (this._trades.length > MAX_TRADES) this._trades = this._trades.slice(0, MAX_TRADES);
  }

  private handleLiquidation(data: Record<string, unknown>) {
    const side = data["side"] as string;
    const price = parseFloat(String(data["price"] ?? "0"));
    const size = parseFloat(String(data["size"] ?? "0"));
    if (!price || !size) return;

    const liq: ExchangeLiquidation = {
      exchange: "Bybit",
      symbol: SYMBOL,
      side: side === "Buy" ? "short" : "long",
      price,
      size,
      valueUsd: price * size,
      timestamp: Date.now(),
    };

    for (const cb of this._liquidationCallbacks) {
      try { cb(liq); } catch {}
    }
  }

  getTicker() { return this._ticker; }
  getOrderbook() { return this._orderbook; }
  getTrades() { return [...this._trades]; }

  async getBalance(): Promise<ExchangeBalance> {
    if (!this.apiKey) throw new Error("Bybit API key not configured");
    const res = await restRequest("GET", "/v5/account/wallet-balance",
      { accountType: "UNIFIED" }, this.apiKey, this.apiSecret);
    const list = (res["list"] as Array<Record<string, unknown>>)?.[0];
    const totalEq = parseFloat(String(list?.["totalEquity"] ?? "0"));
    const availEq = parseFloat(String(list?.["totalAvailableBalance"] ?? "0"));
    return { total: totalEq, available: availEq, currency: "USDT" };
  }

  async getPositions(): Promise<ExchangePosition[]> {
    if (!this.apiKey) return [];
    const res = await restRequest("GET", "/v5/position/list",
      { category: "linear", symbol: SYMBOL }, this.apiKey, this.apiSecret);
    const list = (res["list"] as Array<Record<string, unknown>>) ?? [];
    return list
      .filter(p => parseFloat(String(p["size"])) > 0)
      .map(p => ({
        exchange: "Bybit",
        symbol: String(p["symbol"]),
        side: (String(p["side"]) === "Buy" ? "long" : "short") as "long" | "short",
        size: parseFloat(String(p["size"])),
        entryPrice: parseFloat(String(p["avgPrice"])),
        markPrice: parseFloat(String(p["markPrice"])),
        unrealizedPnl: parseFloat(String(p["unrealisedPnl"])),
        leverage: parseFloat(String(p["leverage"])),
        liquidationPrice: parseFloat(String(p["liqPrice"])),
      }));
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    if (!this.apiKey) throw new Error("Bybit API key not configured");
    await restRequest("POST", "/v5/position/set-leverage", {
      category: "linear", symbol, buyLeverage: String(leverage), sellLeverage: String(leverage),
    }, this.apiKey, this.apiSecret);
  }

  async placeOrder(params: PlaceOrderParams): Promise<OrderResult> {
    if (!this.apiKey) throw new Error("Bybit API key not configured");

    if (params.leverage) {
      try { await this.setLeverage(params.symbol, params.leverage); }
      catch (e) { logger.warn({ err: e }, "Bybit: failed to set leverage"); }
    }

    const body: Record<string, unknown> = {
      category: "linear",
      symbol: params.symbol,
      side: params.side,
      orderType: params.orderType,
      qty: String(params.qty),
      timeInForce: "GTC",
      reduceOnly: params.reduceOnly ?? false,
    };
    if (params.price) body["price"] = String(params.price);
    if (params.stopLoss) body["stopLoss"] = String(params.stopLoss);
    if (params.takeProfit) body["takeProfit"] = String(params.takeProfit);

    const res = await restRequest("POST", "/v5/order/create", body, this.apiKey, this.apiSecret);
    logger.info({ res }, "Bybit: order placed");

    return {
      orderId: String(res["orderId"]),
      exchange: "Bybit",
      symbol: params.symbol,
      side: params.side,
      qty: params.qty,
      price: params.price ?? 0,
      status: "created",
    };
  }

  async cancelOrder(orderId: string, symbol: string): Promise<void> {
    if (!this.apiKey) throw new Error("Bybit API key not configured");
    await restRequest("POST", "/v5/order/cancel",
      { category: "linear", symbol, orderId }, this.apiKey, this.apiSecret);
  }
}

export const bybitConnector = new BybitConnector();
