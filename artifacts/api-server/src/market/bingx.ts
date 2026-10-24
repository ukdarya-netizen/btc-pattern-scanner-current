import { gunzipSync } from "node:zlib";
import { recordFailure, recordSuccess } from "../lib/apiHealth";

const REST = "https://open-api.bingx.com";
const WS_URL = "wss://open-api-swap.bingx.com/swap-market";
export const BTC_SYMBOL = "BTC-USDT";

export type Candle = {
  time: number; // open time, ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type Interval = "1m" | "5m" | "15m" | "1h" | "4h";
export const INTERVAL_MS: Record<Interval, number> = {
  "1m": 60_000,
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
};

async function get(path: string, params: Record<string, string | number>): Promise<unknown> {
  const url = new URL(path, REST);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  url.searchParams.set("timestamp", String(Date.now()));
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const body = (await res.json()) as { code?: number; msg?: string; data?: unknown };
    if (!res.ok || body.code !== 0) {
      throw new Error(`BingX ${path} failed: HTTP ${res.status} code ${String(body.code)} ${body.msg ?? ""}`);
    }
    recordSuccess("bingx");
    return body.data;
  } catch (err) {
    recordFailure("bingx", err instanceof Error ? err.message : String(err));
    throw err;
  }
}

/** Closed candles only, oldest first. A still-forming candle is dropped. */
export async function getClosedCandles(interval: Interval, limit: number, now = Date.now()): Promise<Candle[]> {
  const data = (await get("/openApi/swap/v3/quote/klines", {
    symbol: BTC_SYMBOL, interval, limit: Math.min(limit + 1, 1440),
  })) as Array<Record<string, unknown>>;
  if (!Array.isArray(data)) throw new Error("BingX klines: invalid payload");
  const step = INTERVAL_MS[interval];
  return data
    .map((k) => ({
      time: Number(k.time),
      open: Number(k.open),
      high: Number(k.high),
      low: Number(k.low),
      close: Number(k.close),
      volume: Number(k.volume),
    }))
    .filter((c) => [c.time, c.open, c.high, c.low, c.close].every(Number.isFinite) && c.time + step <= now)
    .sort((a, b) => a.time - b.time)
    .slice(-limit);
}

/** Closed candles inside [start, end] (used to replay a gap in live ticks). */
export async function getCandlesRange(interval: Interval, start: number, end: number): Promise<Candle[]> {
  const data = (await get("/openApi/swap/v3/quote/klines", {
    symbol: BTC_SYMBOL, interval, startTime: start, endTime: end, limit: 1440,
  })) as Array<Record<string, unknown>>;
  const step = INTERVAL_MS[interval];
  const now = Date.now();
  return (Array.isArray(data) ? data : [])
    .map((k) => ({
      time: Number(k.time), open: Number(k.open), high: Number(k.high),
      low: Number(k.low), close: Number(k.close), volume: Number(k.volume),
    }))
    .filter((c) => c.time >= start && c.time + step <= Math.min(end, now))
    .sort((a, b) => a.time - b.time);
}

export async function getLastPrice(): Promise<number> {
  const data = (await get("/openApi/swap/v2/quote/ticker", { symbol: BTC_SYMBOL })) as Record<string, unknown>;
  const price = Number(data?.lastPrice);
  if (!(price > 0)) throw new Error("BingX ticker: invalid lastPrice");
  return price;
}

export type PriceTick = { price: number; at: number };

function decode(data: unknown): string | null {
  if (typeof data === "string") return data;
  const bytes = data instanceof ArrayBuffer
    ? Buffer.from(data)
    : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength) : null;
  if (!bytes) return null;
  try {
    return (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes).toString("utf8");
  } catch {
    return null;
  }
}

export function parseLastPrice(raw: string, receivedAt: number): PriceTick | null {
  try {
    const message = JSON.parse(raw) as { dataType?: unknown; data?: unknown };
    if (message.dataType !== `${BTC_SYMBOL}@lastPrice`) return null;
    const data = (message.data && typeof message.data === "object" ? message.data : {}) as Record<string, unknown>;
    const price = Number(data.price ?? data.lastPrice ?? data.p ?? data.c);
    return Number.isFinite(price) && price > 0 ? { price, at: receivedAt } : null;
  } catch {
    return null;
  }
}

/**
 * Live BTC-USDT last price. Reconnects with backoff and also when no frame
 * arrives for `silenceMs` (a silently dead socket must not freeze stops).
 */
export function startLastPriceStream(options: {
  onTick: (tick: PriceTick) => void;
  onStatus?: (status: "connected" | "disconnected", detail?: string) => void;
  silenceMs?: number;
}): { stop: () => void; lastTickAt: () => number } {
  let socket: WebSocket | null = null;
  let stopped = false;
  let delay = 1_000;
  let lastFrameAt = 0;
  let lastTickAt = 0;
  const silenceMs = options.silenceMs ?? 30_000;

  const connect = () => {
    if (stopped) return;
    const ws = new WebSocket(WS_URL);
    ws.binaryType = "arraybuffer";
    socket = ws;
    ws.addEventListener("open", () => {
      delay = 1_000;
      lastFrameAt = Date.now();
      ws.send(JSON.stringify({ id: `btc-last-${Date.now()}`, reqType: "sub", dataType: `${BTC_SYMBOL}@lastPrice` }));
      options.onStatus?.("connected");
    });
    ws.addEventListener("message", (event) => {
      const receivedAt = Date.now();
      lastFrameAt = receivedAt;
      const raw = decode(event.data);
      if (!raw) return;
      if (raw === "Ping") {
        if (ws.readyState === WebSocket.OPEN) ws.send("Pong");
        return;
      }
      const tick = parseLastPrice(raw, receivedAt);
      if (tick) {
        lastTickAt = tick.at;
        recordSuccess("bingx_stream", tick.at);
        options.onTick(tick);
      }
    });
    ws.addEventListener("close", (event) => {
      if (socket !== ws) return;
      socket = null;
      options.onStatus?.("disconnected", `${event.code}`);
      if (!stopped) setTimeout(connect, delay);
      delay = Math.min(delay * 2, 30_000);
    });
    ws.addEventListener("error", () => { /* close event reconnects */ });
  };

  const watchdog = setInterval(() => {
    if (socket && socket.readyState === WebSocket.OPEN && Date.now() - lastFrameAt > silenceMs) {
      socket.close();
    }
    if (Date.now() - lastTickAt > silenceMs) recordFailure("bingx_stream", "нет тиков цены");
  }, 5_000);
  connect();

  return {
    stop() {
      stopped = true;
      clearInterval(watchdog);
      socket?.close();
      socket = null;
    },
    lastTickAt: () => lastTickAt,
  };
}
