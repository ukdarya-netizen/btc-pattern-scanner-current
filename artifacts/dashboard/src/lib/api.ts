/** API types, PIN-aware fetch and formatters of the Bitcoin Margin Master dashboard. */

export type Pattern = { key: string; label: string; direction: string; profile: string; live: boolean; tf?: string };

/** Trading style by the pattern's trading timeframe (owner 2026-11-12): 15m scalp, 30m / 1h intraday, 4h / 1d swing. */
export type Style = "scalp" | "intraday" | "swing";
export const STYLE_LABEL: Record<Style, string> = { scalp: "Скальп", intraday: "Интрадей", swing: "Свинг" };
export const styleOfTf = (tf: string | undefined): Style => (tf === "15m" || tf === "5m" ? "scalp" : tf === "30m" || tf === "1h" ? "intraday" : "swing");
export type Profile = {
  key: string; label: string; leverage: number; timeframe: string; defaultStopPct: number;
  defaultTargets: Array<{ pct: number; fraction: number }>; breakevenAfterFirstTarget: boolean; maxHoldMs: number;
};
export type Status = {
  scanner: { lastCycleAt: string | null; lastCandleCloseAt: string | null; lastError: string | null; lastDurationMs: number | null; missingFlow: string[] };
  stream: { connected: boolean; lastTickAt: string | null; lastPrice: number | null };
  openSignals: number;
  patterns: Pattern[];
  profiles?: Record<string, Profile>;
};

export type StatsRow = {
  patternKey: string; profile: string; direction: string; live: boolean;
  total: number; open: number; closed: number; wins: number; losses: number;
  winRatePct: number | null; avgPnlPricePct: number | null; avgPnlMarginPct: number | null;
  sumPnlMarginPct: number | null; avgMfePct: number | null; avgMaePct: number | null;
  takeProfit: number; stop: number; breakeven: number; timeout: number;
};

export type Signal = {
  id: number; patternKey: string; direction: string; profile: string; leverage: number; live: boolean;
  status: string; entryPrice: number; stopPrice: number; initialStopPrice?: number; liquidationPrice: number;
  targets: Array<{ price: number; fraction: number; hitAt: string | null }>;
  detectedAt: string; closedAt: string | null; closeReason: string | null;
  pnlPricePct: number | null; pnlMarginPct: number | null; mfePct: number; maePct: number;
  breakevenMoved?: boolean; exitPrice?: number | null; metrics: Metrics | null;
};

export type ByTf = Record<string, number | null>;
export type Metrics = {
  price: number;
  priceChangePct: ByTf; atrPct: ByTf; bingxVolumeMult: ByTf; futVolumeMult: ByTf; spotVolumeMult: ByTf;
  futVolumeUsd: ByTf; spotVolumeUsd: ByTf; oiUsd: number | null; oiChangePct: ByTf;
  futTakerNetPct: ByTf; spotTakerNetPct: ByTf; futCvdUsd: ByTf; spotCvdUsd: ByTf;
  spotCvdBullish: Record<string, boolean | null>; liqLongUsd: ByTf; liqShortUsd: ByTf;
  liqLongSpike1h: number | null; liqShortSpike1h: number | null; fundingRatePct: number | null;
  longShortRatio: number | null; longShortChangePct: ByTf; orderbookBidAskRatio: number | null;
  orderbookImbalancePct: number | null; whaleIndex: number | null; whaleIndexChange4h: number | null;
  whaleIndex4h?: number | null;
  context?: {
    heatmap: { below: Record<string, number>; above: Record<string, number>; topBelow: Array<{ price: number; distancePct: number; valueUsd: number }>; topAbove: Array<{ price: number; distancePct: number; valueUsd: number }>; aboveBelowRatio5pct: number | null } | null;
    hyperliquidWhales: { longCount: number; shortCount: number; longUsd: number; shortUsd: number; netUsd: number; avgLeverage: number | null; opened1hLongUsd: number; opened1hShortUsd: number } | null;
    exchangeBalance: { totalBtc: number; change1dBtc: number | null; change1dPct: number | null; change7dBtc: number | null; change7dPct: number | null } | null;
    dominance: { dominancePct: number; change24hPct: number | null; source: string } | null;
  } | null;
};

export type DailyRow = { day: string; profile: string; live: boolean; closed: number; wins: number; sumPnlMarginPct: number };
export type OutcomeGroup = {
  patternKey: string; profile: string; direction: string; decision: string; reason: string;
  total: number; targetFirst: number; stopFirst: number; timeout: number; pending: number;
  targetFirstPct: number | null; avgMfePct: number | null; avgMaePct: number | null;
};
export type Decision = { id: number; candleCloseAt: string; patternKey: string; direction: string; profile: string; decision: string; reasons: string[]; price: number | null };
export type PathPoint = { at: string; phase: "before" | "open" | "after_close"; price: number; pctFromEntry: number };

/** A file from public/ under the app's base path. */
export const asset = (p: string) => `${import.meta.env.BASE_URL.replace(/\/$/, "")}/${p}`;

// ── PIN ───────────────────────────────────────────────────────────────────────
const PIN_KEY = "btc-bullet-pin";
function storedPin(): string {
  try { return localStorage.getItem(PIN_KEY) ?? ""; } catch { return ""; }
}
let memoryPin = storedPin();
export function setPin(pin: string): void {
  memoryPin = pin;
  try { localStorage.setItem(PIN_KEY, pin); } catch { /* private mode: PIN kept in memory only */ }
}
export class PinRequired extends Error {}

/** Telegram MiniApp initData (signed by Telegram): the server recognises the owner by it. Empty outside Telegram. */
function initData(): string {
  try { return (window as unknown as { Telegram?: { WebApp?: { initData?: string } } }).Telegram?.WebApp?.initData ?? ""; } catch { return ""; }
}

export async function getJson<T>(path: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (memoryPin) headers["x-dashboard-pin"] = memoryPin;
  const tg = initData();
  if (tg) headers["x-telegram-init-data"] = tg;
  const res = await fetch(path, { headers });
  if (res.status === 401) throw new PinRequired("pin");
  if (res.status === 429) throw new Error("Слишком много неверных PIN — подождите 15 минут");
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

// ── formatters ───────────────────────────────────────────────────────────────
export const num = (v: number | null | undefined, d = 2) => (v == null ? "—" : v.toFixed(d));
export const signed = (v: number | null | undefined, d = 2) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`);
export const tone = (v: number | null | undefined) => (v == null ? "" : v > 0 ? "text-emerald-400" : v < 0 ? "text-rose-400" : "");
export const time = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("ru-RU", { timeZone: "Asia/Dubai", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—");
export const price = (v: number | null | undefined) => (v == null ? "—" : v >= 1000 ? v.toLocaleString("ru-RU", { maximumFractionDigits: 1 }) : v.toPrecision(6));
export const dir = (d: string) => (d === "long" ? "Лонг" : "Шорт");
export const usd = (v: number | null | undefined) => {
  if (v == null) return "—";
  const a = Math.abs(v);
  const t = a >= 1e9 ? `${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : `${(a / 1e3).toFixed(0)}K`;
  return `${v < 0 ? "−" : ""}$${t}`;
};
export const mult = (v: number | null | undefined) => (v == null ? "—" : `${v.toFixed(2)}×`);
export type Subscriber = {
  chatId: string; name: string | null; username: string | null; active: boolean;
  subscribedAt: string; updatedAt: string; sent: number; failed: number; lastSentAt: string | null;
};
export type Subscribers = { rows: Subscriber[]; totals: { all: number; active: number; inactive: number; newToday: number }; namesPending: number };

export const REASON: Record<string, string> = { take_profit: "Цели", stop: "Стоп", breakeven: "Безубыток", timeout: "Время" };

/** Duration as "3 ч 20 мин" / "2 д 5 ч". */
export function duration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч ${m % 60} мин`;
  return `${Math.floor(h / 24)} д ${h % 24} ч`;
}
export const heldMs = (s: Signal, now = Date.now()) => (s.closedAt ? Date.parse(s.closedAt) : now) - Date.parse(s.detectedAt);

/** Live move of an open trade from the entry in the trade's direction — clean: no leverage, no fees (owner 2026-11-12). */
export function liveMove(s: Signal, last: number | null): number | null {
  if (!last) return null;
  const sign = s.direction === "long" ? 1 : -1;
  return (sign * (last - s.entryPrice) / s.entryPrice) * 100;
}
/** Distance from the last price to a level in the trade's favour (+) or against it (−), % of price. */
export function distPct(s: Signal, last: number | null, level: number): number | null {
  if (!last) return null;
  const sign = s.direction === "long" ? 1 : -1;
  return (sign * (level - last) / last) * 100;
}
