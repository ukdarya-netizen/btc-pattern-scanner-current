import WebSocket from "ws";
import https from "https";
import { logger } from "../../lib/logger";
import { hmacSha256, computeImbalance } from "./utils";
import type {
  IExchangeConnector, ExchangeTicker, ExchangeOrderbook, ExchangeTrade,
  ExchangeBalance, ExchangePosition, PlaceOrderParams, OrderResult, OrderbookLevel,
} from "./types";

const REST_BASE = "https://www.okx.com";
const WS_PUBLIC = "wss://ws.okx.com:8443/ws/v5/public";
const INST_ID = "BTC-USDT-SWAP";
const SYMBOL_DISPLAY = "BTCUSDT";
const MAX_TRADES = 200;
const BOOK_LEVELS = 25;

function sign(secret: string, ts: string, method: string, path: string, body = ""): string {
  return Buffer.from(
    hmacSha256(secret, `${ts}${method}${path}${body}`)
  ).toString("base64");
}

function restRequest(
  method: "GET" | "POST",
  path: string,
  params: Record<string, unknown> = {},
  apiKey: string,
  apiSecret: string,
  passphrase: string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ts = new Date().toISOString();
    const queryString = method === "GET" && Object.keys(params).length > 0
      ? "?" + Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&")
      : "";
    const bodyStr = method === "POST" ? JSON.stringify(params) : "";
    const fullPath = path + queryString;
    const sig = sign(apiSecret, ts, method, fullPath, bodyStr);

    const options = {
      hostname: "www.okx.com",
      path: fullPath,
      method,
      headers: {
        "OK-ACCESS-KEY": apiKey,
        "OK-ACCESS-SIGN": sig,
        "OK-ACCESS-TIMESTAMP": ts,
        "OK-ACCESS-PASSPHRASE": passphrase,
        "Content-Type": "application/json",
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data) as Record<string, unknown>;
          if (parsed["code"] !== "0" && parsed["code"] !== undefined) {
            reject(new Error(`OKX error ${parsed["code"]}: ${parsed["msg"]}`));
          } else {
            resolve(parsed["data"] ?? parsed);
          }
        } catch (e) { reject(e); }
      });
    });

    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

export class OKXConnector implements IExchangeConnector {
  readonly name = "OKX";
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

  private apiKey = process.env["OKX_API_KEY"] ?? "";
  private apiSecret = process.env["OKX_API_SECRET"] ?? "";
  private passphrase = process.env["OKX_PASSPHRASE"] ?? "";

  get connected() { return this._connected; }
  get hasCredentials() { return !!this.apiKey && !!this.apiSecret && !!this.passphrase; }

  connect() {
    if (this.ws) return;
    logger.info("OKX: connecting to public WebSocket...");
    this.ws = new WebSocket(WS_PUBLIC);

    this.ws.on("open", () => {
      this._connected = true;
      this.reconnectDelay = 1000;
      this.subscribe();
      this.startPing();
      logger.info("OKX: WebSocket connected");
    });

    this.ws.on("message", (data: Buffer) => {
      const text = data.toString("utf8");
      if (text === "pong") return;
      try { this.handleMessage(JSON.parse(text)); }
      catch (e) { logger.warn({ err: e }, "OKX: parse error"); }
    });

    this.ws.on("close", () => {
      this._connected = false;
      this.cleanup();
      this.scheduleReconnect();
      logger.warn("OKX: WebSocket closed, reconnecting...");
    });

    this.ws.on("error", (err) => {
      logger.error({ err }, "OKX: WebSocket error");
      this.ws?.terminate();
    });
  }

  private subscribe() {
    const args = [
      { channel: "tickers", instId: INST_ID },
      { channel: "books5", instId: INST_ID },
      { channel: "trades", instId: INST_ID },
    ];
    this.ws?.send(JSON.stringify({ op: "subscribe", args }));
  }

  private startPing() {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send("ping");
    }, 25000);
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
    const channel = (msg["arg"] as Record<string, unknown> | undefined)?.["channel"] as string | undefined;
    const data = msg["data"] as unknown[];
    if (!channel || !data?.length) return;

    if (channel === "tickers") this.handleTicker(data[0] as Record<string, string>);
    else if (channel === "books5") this.handleOrderbook(data[0] as Record<string, unknown>);
    else if (channel === "trades") this.handleTrades(data as Array<Record<string, string>>);
  }

  private handleTicker(d: Record<string, string>) {
    const price = parseFloat(d["last"] ?? "0");
    const open24h = parseFloat(d["open24h"] ?? d["last"] ?? "0");
    if (price > 0) {
      const bid = parseFloat(d["bidPx"] ?? d["last"] ?? "0");
      const ask = parseFloat(d["askPx"] ?? d["last"] ?? "0");
      this._ticker = {
        exchange: "OKX",
        symbol: SYMBOL_DISPLAY,
        price,
        bid,
        ask,
        spread: ask - bid,
        priceChange24h: price - open24h,
        priceChangePct24h: open24h > 0 ? (price - open24h) / open24h * 100 : 0,
        volume24h: parseFloat(d["volCcy24h"] ?? d["vol24h"] ?? "0"),
        high24h: parseFloat(d["high24h"] ?? "0"),
        low24h: parseFloat(d["low24h"] ?? "0"),
        openInterest: parseFloat(d["openInterest"] ?? "0"),
        fundingRate: 0,
        nextFundingTime: 0,
        updatedAt: Date.now(),
      };
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
      exchange: "OKX",
      symbol: SYMBOL_DISPLAY,
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
        id: t["tradeId"] ?? String(Date.now()),
        exchange: "OKX",
        price: parseFloat(t["px"] ?? "0"),
        size: parseFloat(t["sz"] ?? "0"),
        side: t["side"] === "buy" ? "buy" : "sell",
        timestamp: parseInt(t["ts"] ?? "0"),
      });
    }
    if (this._trades.length > MAX_TRADES) this._trades = this._trades.slice(0, MAX_TRADES);
  }

  getTicker() { return this._ticker; }
  getOrderbook() { return this._orderbook; }
  getTrades() { return [...this._trades]; }

  async getBalance(): Promise<ExchangeBalance> {
    if (!this.hasCredentials) throw new Error("OKX credentials not configured");
    const res = await restRequest("GET", "/api/v5/account/balance", {}, this.apiKey, this.apiSecret, this.passphrase) as Array<Record<string, unknown>>;
    const details = (res?.[0]?.["details"] as Array<Record<string, unknown>>) ?? [];
    const usdt = details.find(d => d["ccy"] === "USDT");
    return {
      total: parseFloat(String(usdt?.["eq"] ?? "0")),
      available: parseFloat(String(usdt?.["availEq"] ?? "0")),
      currency: "USDT",
    };
  }

  async getPositions(): Promise<ExchangePosition[]> {
    if (!this.hasCredentials) return [];
    const res = await restRequest("GET", "/api/v5/account/positions",
      { instType: "SWAP", instId: INST_ID }, this.apiKey, this.apiSecret, this.passphrase) as Array<Record<string, unknown>>;
    return (res ?? [])
      .filter(p => parseFloat(String(p["pos"])) !== 0)
      .map(p => ({
        exchange: "OKX",
        symbol: SYMBOL_DISPLAY,
        side: (String(p["posSide"]) === "long" ? "long" : "short") as "long" | "short",
        size: Math.abs(parseFloat(String(p["pos"]))),
        entryPrice: parseFloat(String(p["avgPx"])),
        markPrice: parseFloat(String(p["markPx"])),
        unrealizedPnl: parseFloat(String(p["upl"])),
        leverage: parseFloat(String(p["lever"])),
        liquidationPrice: parseFloat(String(p["liqPx"] ?? "0")),
      }));
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    if (!this.hasCredentials) return;
    await restRequest("POST", "/api/v5/account/set-leverage",
      { instId: INST_ID, lever: String(leverage), mgnMode: "cross" },
      this.apiKey, this.apiSecret, this.passphrase);
  }

  async placeOrder(params: PlaceOrderParams): Promise<OrderResult> {
    if (!this.hasCredentials) throw new Error("OKX credentials not configured");

    const body: Record<string, unknown> = {
      instId: INST_ID,
      tdMode: "cross",
      side: params.side === "Buy" ? "buy" : "sell",
      posSide: params.side === "Buy" ? "long" : "short",
      ordType: params.orderType === "Market" ? "market" : "limit",
      sz: String(params.qty),
    };
    if (params.price) body["px"] = String(params.price);
    if (params.stopLoss) body["slTriggerPx"] = String(params.stopLoss);
    if (params.takeProfit) body["tpTriggerPx"] = String(params.takeProfit);

    const res = await restRequest("POST", "/api/v5/trade/order", body, this.apiKey, this.apiSecret, this.passphrase) as Array<Record<string, unknown>>;
    const order = res?.[0] ?? {};
    logger.info({ order }, "OKX: order placed");

    return {
      orderId: String(order["ordId"] ?? Date.now()),
      exchange: "OKX",
      symbol: params.symbol,
      side: params.side,
      qty: params.qty,
      price: params.price ?? 0,
      status: String(order["sCode"] === "0" ? "created" : order["sMsg"]),
    };
  }

  async cancelOrder(orderId: string, _symbol: string): Promise<void> {
    if (!this.hasCredentials) return;
    await restRequest("POST", "/api/v5/trade/cancel-order",
      { instId: INST_ID, ordId: orderId }, this.apiKey, this.apiSecret, this.passphrase);
  }
}

export const okxConnector = new OKXConnector();
