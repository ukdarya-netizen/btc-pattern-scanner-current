import WebSocket from "ws";
import https from "https";
import { logger } from "../../lib/logger";
import { hmacSha256, buildQueryString, computeImbalance } from "./utils";
import type {
  IExchangeConnector, ExchangeTicker, ExchangeOrderbook, ExchangeTrade,
  ExchangeBalance, ExchangePosition, PlaceOrderParams, OrderResult, OrderbookLevel,
} from "./types";

const REST_BASE = "https://open-api.bingx.com";
const WS_URLS = [
  "wss://open-api.bingx.com/swap-market",
  "wss://open-api.bingx.com/market",
];
const SYMBOL = "BTC-USDT";
const SYMBOL_DISPLAY = "BTCUSDT";
const MAX_TRADES = 200;
const BOOK_LEVELS = 25;

function get(path: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${REST_BASE}${path}`);
    const req = https.request({ hostname: url.hostname, path: url.pathname + url.search, method: "GET" }, (res) => {
      let data = "";
      res.on("data", c => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data) as Record<string, unknown>); }
        catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

function restRequest(
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, unknown> = {},
  apiKey: string,
  apiSecret: string,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timestamp = Date.now().toString();
    const paramStr = buildQueryString({ ...params, timestamp });
    const signature = hmacSha256(apiSecret, paramStr);
    const fullQuery = `${paramStr}&signature=${signature}`;
    const urlPath = method === "GET" || method === "DELETE" ? `${path}?${fullQuery}` : path;
    const body = method === "POST" ? fullQuery : "";

    const options = {
      hostname: "open-api.bingx.com",
      path: urlPath,
      method,
      headers: { "X-BX-APIKEY": apiKey, "Content-Type": "application/x-www-form-urlencoded" },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data) as Record<string, unknown>;
          if (parsed["code"] !== 0 && parsed["code"] !== undefined) {
            reject(new Error(`BingX error ${parsed["code"]}: ${parsed["msg"]}`));
          } else {
            resolve((parsed["data"] ?? parsed) as Record<string, unknown>);
          }
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

export class BingXConnector implements IExchangeConnector {
  readonly name = "BingX";
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectDelay = 2000;
  private _connected = false;
  private wsAttempts = 0;
  private useRest = false;
  private wsUrlIdx = 0;

  private _ticker: ExchangeTicker | null = null;
  private bidsMap = new Map<string, number>();
  private asksMap = new Map<string, number>();
  private _orderbook: ExchangeOrderbook | null = null;
  private _trades: ExchangeTrade[] = [];

  private apiKey = process.env["BINGX_API_KEY"] ?? "";
  private apiSecret = process.env["BINGX_API_SECRET"] ?? "";

  get connected() { return this._connected; }

  connect() {
    if (this.ws && !this.useRest) return;
    if (this.useRest) { this.startRestPolling(); return; }
    this.connectWs();
    setTimeout(() => {
      if (!this._connected) {
        logger.info("BingX: WS not connecting, starting REST fallback in parallel");
        this.startRestPolling();
      }
    }, 8000);
  }

  private connectWs() {
    const url = WS_URLS[this.wsUrlIdx % WS_URLS.length];
    logger.info({ url }, "BingX: connecting to WebSocket...");
    this.ws = new WebSocket(url);

    const failTimeout = setTimeout(() => {
      if (!this._connected) {
        logger.warn("BingX: WebSocket connection timeout, trying next URL...");
        this.ws?.terminate();
      }
    }, 10000);

    this.ws.on("open", () => {
      clearTimeout(failTimeout);
      this._connected = true;
      this.reconnectDelay = 2000;
      this.wsAttempts = 0;
      this.subscribe();
      this.startPing();
      logger.info({ url }, "BingX: WebSocket connected");
    });

    this.ws.on("message", async (data: Buffer) => {
      try {
        let text: string;
        if (data[0] === 0x1f && data[1] === 0x8b) {
          const { gunzipSync } = await import("zlib");
          text = gunzipSync(data).toString("utf8");
        } else {
          text = data.toString("utf8");
        }
        if (text === "Pong" || text === "pong") return;
        this.handleMessage(JSON.parse(text));
      } catch (e) { logger.warn({ err: e }, "BingX: parse error"); }
    });

    this.ws.on("close", () => {
      clearTimeout(failTimeout);
      this._connected = false;
      this.cleanup();
      this.wsAttempts++;
      if (this.wsAttempts >= 4) {
        this.wsUrlIdx++;
        if (this.wsAttempts >= 8) {
          logger.warn("BingX: WebSocket consistently failing, switching to REST polling");
          this.useRest = true;
          this.startRestPolling();
          return;
        }
      }
      this.scheduleReconnect();
      logger.warn({ attempt: this.wsAttempts }, "BingX: WebSocket closed, reconnecting...");
    });

    this.ws.on("error", (err) => {
      clearTimeout(failTimeout);
      logger.warn({ err: (err as NodeJS.ErrnoException).message }, "BingX: WebSocket error");
      this.ws?.terminate();
    });
  }

  private startRestPolling() {
    if (this.pollTimer) return;
    logger.info("BingX: starting REST API polling fallback");
    this._connected = true;
    this.pollOnce();
    this.pollTimer = setInterval(() => this.pollOnce(), 2000);
  }

  private async pollOnce() {
    try {
      const [tickerRes, depthRes] = await Promise.all([
        get(`/openApi/swap/v2/quote/ticker?symbol=${SYMBOL}`),
        get(`/openApi/swap/v2/quote/depth?symbol=${SYMBOL}&limit=20`),
      ]);

      const td = (tickerRes["data"] as Record<string, unknown>) ?? tickerRes;
      const price = parseFloat(String(td["lastPrice"] ?? td["c"] ?? "0"));
      if (price > 0) {
        this._ticker = {
          exchange: "BingX",
          symbol: SYMBOL_DISPLAY,
          price,
          bid: parseFloat(String(td["bidPrice"] ?? td["b"] ?? price)),
          ask: parseFloat(String(td["askPrice"] ?? td["a"] ?? price)),
          spread: 0,
          priceChange24h: parseFloat(String(td["priceChange"] ?? td["p"] ?? "0")),
          priceChangePct24h: parseFloat(String(td["priceChangePercent"] ?? td["P"] ?? "0")),
          volume24h: parseFloat(String(td["volume"] ?? td["v"] ?? "0")),
          high24h: parseFloat(String(td["highPrice"] ?? td["h"] ?? "0")),
          low24h: parseFloat(String(td["lowPrice"] ?? td["l"] ?? "0")),
          openInterest: 0,
          fundingRate: 0,
          nextFundingTime: 0,
          updatedAt: Date.now(),
        };
        if (this._ticker) this._ticker.spread = this._ticker.ask - this._ticker.bid;
        this._connected = true;
      }

      const dd = (depthRes["data"] as Record<string, unknown>) ?? depthRes;
      const bidsRaw = (dd["bids"] as Array<[string, string]> ?? [])
        .map(([p, s]) => ({ price: parseFloat(p), size: parseFloat(s) }))
        .sort((a, b) => b.price - a.price).slice(0, BOOK_LEVELS);
      const asksRaw = (dd["asks"] as Array<[string, string]> ?? [])
        .map(([p, s]) => ({ price: parseFloat(p), size: parseFloat(s) }))
        .sort((a, b) => a.price - b.price).slice(0, BOOK_LEVELS);

      if (bidsRaw.length > 0 && asksRaw.length > 0) {
        let bt = 0, at = 0;
        const bids: OrderbookLevel[] = bidsRaw.map(l => ({ ...l, total: (bt += l.size) }));
        const asks: OrderbookLevel[] = asksRaw.map(l => ({ ...l, total: (at += l.size) }));
        const spread = asks[0].price - bids[0].price;
        const mid = (asks[0].price + bids[0].price) / 2;
        this._orderbook = {
          exchange: "BingX",
          symbol: SYMBOL_DISPLAY,
          bids,
          asks,
          spread,
          spreadPct: mid > 0 ? spread / mid * 100 : 0,
          imbalance: computeImbalance(bids, asks),
          updatedAt: Date.now(),
        };
      }
    } catch (e) {
      logger.warn({ err: (e as Error).message }, "BingX: REST poll failed");
      this._connected = false;
    }
  }

  private subscribe() {
    const subs = [
      { id: "ticker", reqType: "sub", dataType: `${SYMBOL}@ticker` },
      { id: "depth", reqType: "sub", dataType: `${SYMBOL}@depth20` },
      { id: "trades", reqType: "sub", dataType: `${SYMBOL}@trade` },
    ];
    for (const s of subs) this.ws?.send(JSON.stringify(s));
  }

  private startPing() {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send("Ping");
    }, 20000);
  }

  private cleanup() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.ws = null;
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connectWs(); }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
  }

  private handleMessage(msg: Record<string, unknown>) {
    const dataType = msg["dataType"] as string | undefined;
    const data = msg["data"];
    if (!dataType || !data) return;

    if (dataType.endsWith("@ticker")) this.handleTicker(data as Record<string, unknown>);
    else if (dataType.endsWith("@depth20")) this.handleOrderbook(data as Record<string, unknown>);
    else if (dataType.endsWith("@trade")) this.handleTrade(data as Record<string, unknown>);
  }

  private handleTicker(d: Record<string, unknown>) {
    const price = parseFloat(String(d["c"] ?? d["lastPrice"] ?? "0"));
    if (price > 0) {
      this._ticker = {
        exchange: "BingX",
        symbol: SYMBOL_DISPLAY,
        price,
        bid: parseFloat(String(d["b"] ?? d["bidPrice"] ?? price)),
        ask: parseFloat(String(d["a"] ?? d["askPrice"] ?? price)),
        spread: 0,
        priceChange24h: parseFloat(String(d["p"] ?? "0")),
        priceChangePct24h: parseFloat(String(d["P"] ?? "0")),
        volume24h: parseFloat(String(d["v"] ?? d["volume"] ?? "0")),
        high24h: parseFloat(String(d["h"] ?? d["highPrice"] ?? "0")),
        low24h: parseFloat(String(d["l"] ?? d["lowPrice"] ?? "0")),
        openInterest: 0,
        fundingRate: 0,
        nextFundingTime: 0,
        updatedAt: Date.now(),
      };
      if (this._ticker) this._ticker.spread = this._ticker.ask - this._ticker.bid;
    }
  }

  private handleOrderbook(d: Record<string, unknown>) {
    const bidsRaw = (d["bids"] as Array<[string, string]> ?? [])
      .map(([p, s]) => ({ price: parseFloat(p), size: parseFloat(s) }))
      .sort((a, b) => b.price - a.price).slice(0, BOOK_LEVELS);
    const asksRaw = (d["asks"] as Array<[string, string]> ?? [])
      .map(([p, s]) => ({ price: parseFloat(p), size: parseFloat(s) }))
      .sort((a, b) => a.price - b.price).slice(0, BOOK_LEVELS);

    let bt = 0, at = 0;
    const bids: OrderbookLevel[] = bidsRaw.map(l => ({ ...l, total: (bt += l.size) }));
    const asks: OrderbookLevel[] = asksRaw.map(l => ({ ...l, total: (at += l.size) }));
    const spread = asks[0] && bids[0] ? asks[0].price - bids[0].price : 0;
    const mid = asks[0] && bids[0] ? (asks[0].price + bids[0].price) / 2 : 1;

    this._orderbook = {
      exchange: "BingX", symbol: SYMBOL_DISPLAY, bids, asks,
      spread, spreadPct: mid > 0 ? spread / mid * 100 : 0,
      imbalance: computeImbalance(bids, asks), updatedAt: Date.now(),
    };
  }

  private handleTrade(d: Record<string, unknown>) {
    const trade: ExchangeTrade = {
      id: String(d["t"] ?? Date.now()),
      exchange: "BingX",
      price: parseFloat(String(d["p"] ?? "0")),
      size: parseFloat(String(d["q"] ?? "0")),
      side: String(d["m"]) === "true" ? "sell" : "buy",
      timestamp: parseInt(String(d["T"] ?? Date.now())),
    };
    this._trades.unshift(trade);
    if (this._trades.length > MAX_TRADES) this._trades = this._trades.slice(0, MAX_TRADES);
  }

  getTicker() { return this._ticker; }
  getOrderbook() { return this._orderbook; }
  getTrades() { return [...this._trades]; }

  async getBalance(): Promise<ExchangeBalance> {
    if (!this.apiKey) throw new Error("BingX API key not configured");
    const res = await restRequest("GET", "/openApi/swap/v3/user/balance", {}, this.apiKey, this.apiSecret);
    const balance = (res as Record<string, unknown>)["balance"] as Record<string, unknown> | undefined;
    return {
      total: parseFloat(String(balance?.["balance"] ?? "0")),
      available: parseFloat(String(balance?.["availableMargin"] ?? "0")),
      currency: "USDT",
    };
  }

  async getPositions(): Promise<ExchangePosition[]> {
    if (!this.apiKey) return [];
    const res = await restRequest("GET", "/openApi/swap/v2/user/positions",
      { symbol: SYMBOL }, this.apiKey, this.apiSecret) as Record<string, unknown>;
    const list = Array.isArray(res) ? res : ((res["positions"] ?? []) as Array<Record<string, unknown>>);
    return list
      .filter(p => parseFloat(String(p["positionAmt"] ?? p["size"] ?? "0")) !== 0)
      .map(p => {
        const size = Math.abs(parseFloat(String(p["positionAmt"] ?? p["size"] ?? "0")));
        const side = parseFloat(String(p["positionAmt"] ?? "1")) > 0 ? "long" : "short";
        return {
          exchange: "BingX",
          symbol: SYMBOL_DISPLAY,
          side: side as "long" | "short",
          size,
          entryPrice: parseFloat(String(p["avgPrice"] ?? p["entryPrice"] ?? "0")),
          markPrice: parseFloat(String(p["markPrice"] ?? "0")),
          unrealizedPnl: parseFloat(String(p["unrealizedProfit"] ?? p["unrealizedPnl"] ?? "0")),
          leverage: parseFloat(String(p["leverage"] ?? "1")),
          liquidationPrice: parseFloat(String(p["liquidationPrice"] ?? "0")),
        };
      });
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    if (!this.apiKey) return;
    await restRequest("POST", "/openApi/swap/v2/trade/leverage",
      { symbol: symbol.replace("USDT", "-USDT"), side: "LONG", leverage: String(leverage) },
      this.apiKey, this.apiSecret);
    await restRequest("POST", "/openApi/swap/v2/trade/leverage",
      { symbol: symbol.replace("USDT", "-USDT"), side: "SHORT", leverage: String(leverage) },
      this.apiKey, this.apiSecret);
  }

  async placeOrder(params: PlaceOrderParams): Promise<OrderResult> {
    if (!this.apiKey) throw new Error("BingX API key not configured");
    if (params.leverage) {
      try { await this.setLeverage(params.symbol, params.leverage); }
      catch (e) { logger.warn({ err: e }, "BingX: failed to set leverage"); }
    }

    const body: Record<string, unknown> = {
      symbol: params.symbol.replace("USDT", "-USDT"),
      side: params.side === "Buy" ? "BUY" : "SELL",
      positionSide: params.side === "Buy" ? "LONG" : "SHORT",
      type: params.orderType === "Market" ? "MARKET" : "LIMIT",
      quantity: String(params.qty),
      reduceOnly: params.reduceOnly ? "true" : "false",
    };
    if (params.price) body["price"] = String(params.price);
    if (params.stopLoss) body["stopLoss"] = JSON.stringify({ type: "STOP_MARKET", stopPrice: params.stopLoss });
    if (params.takeProfit) body["takeProfit"] = JSON.stringify({ type: "TAKE_PROFIT_MARKET", stopPrice: params.takeProfit });

    const res = await restRequest("POST", "/openApi/swap/v2/trade/order", body, this.apiKey, this.apiSecret);
    const order = (res as Record<string, unknown>)["order"] as Record<string, unknown> ?? res;
    logger.info({ order }, "BingX: order placed");
    return {
      orderId: String(order["orderId"] ?? order["id"] ?? Date.now()),
      exchange: "BingX",
      symbol: params.symbol,
      side: params.side,
      qty: params.qty,
      price: params.price ?? 0,
      status: "created",
    };
  }

  async cancelOrder(orderId: string, symbol: string): Promise<void> {
    if (!this.apiKey) return;
    await restRequest("DELETE", "/openApi/swap/v2/trade/order",
      { symbol: symbol.replace("USDT", "-USDT"), orderId }, this.apiKey, this.apiSecret);
  }
}

export const bingxConnector = new BingXConnector();
