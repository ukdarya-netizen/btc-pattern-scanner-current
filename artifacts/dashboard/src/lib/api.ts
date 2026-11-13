import { getLang } from "./i18n";
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
  fundingBingxPct?: number | null; nextFundingAt?: number | null;
  longShortRatio: number | null; longShortChangePct: ByTf; orderbookBidAskRatio: number | null;
  orderbookImbalancePct: number | null; whaleIndex: number | null; whaleIndexChange4h: number | null;
  whaleIndex4h?: number | null;
  /** RSI, MACD, EMA / SMA, Bollinger, Stochastic RSI, ADX by timeframe (owner 2026-11-12). */
  indicators?: Record<string, Record<string, number | null> | null>;
  /** MFI / Chaikin on aggregated futures and spot volume: fut_15m … spot_4h. */
  moneyFlow?: Record<string, Record<string, number | null> | null>;
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

// ── session (accounts as in CAB / Nihilist, owner 2026-11-12) ──────────────────
const TOKEN_KEY = "btc-session";
export type Session = { token: string; name: string; email: string; role: "owner" | "user" };
export class ApiError extends Error {
  constructor(message: string, public code?: string) { super(message); }
}
/** Signed out, or access ended (pending / blocked / subscription expired). */
export class AuthError extends ApiError {}

function readSession(): Session | null {
  try { const raw = localStorage.getItem(TOKEN_KEY); return raw ? JSON.parse(raw) as Session : null; } catch { return null; }
}
let session = readSession();
export function saveSession(s: Session | null): void {
  session = s;
  try { if (s) localStorage.setItem(TOKEN_KEY, JSON.stringify(s)); else localStorage.removeItem(TOKEN_KEY); } catch { /* private mode: this tab only */ }
}
export const currentSession = () => session;
/** The owner sees everything (shadow, Bot Health, «Подписчики»); users see the channel. */
export const isOwner = () => session?.role === "owner";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (session?.token) headers.Authorization = `Bearer ${session.token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({})) as { error?: string; code?: string };
  if ((res.status === 401 || (res.status === 403 && data.code)) && !path.startsWith("/api/auth/")) throw new AuthError(data.error ?? "Требуется вход", data.code);
  if (!res.ok) throw new ApiError(data.error ?? `HTTP ${res.status}`, data.code ?? String(res.status));
  return data as T;
}
export const getJson = <T>(path: string) => request<T>("GET", path);
/** Owner downloads (a file from an owner-only route, with the session token). */
export async function download(path: string, filename: string): Promise<void> {
  const res = await fetch(path, { headers: session?.token ? { Authorization: `Bearer ${session.token}` } : {} });
  if (!res.ok) { const d = await res.json().catch(() => ({})) as { error?: string }; throw new ApiError(d.error ?? `HTTP ${res.status}`, String(res.status)); }
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
export const post = <T>(path: string, body: unknown) => request<T>("POST", path, body);
export const patch = <T>(path: string, body: unknown) => request<T>("PATCH", path, body);
export const del = <T>(path: string) => request<T>("DELETE", path);

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
export const REASON: Record<string, string> = { take_profit: "Цели", stop: "Стоп", breakeven: "Безубыток", timeout: "Время" };

/** Duration as "3 ч 20 мин" / "2 д 5 ч". */
export function duration(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const m = Math.round(ms / 60_000);
  // Durations sit inside longer texts («2 ч 0 мин – 5 ч 10 мин»), so the language is applied here, not by the dictionary.
  const [mi, hr, dy] = getLang() === "en" ? ["min", "h", "d"] : ["мин", "ч", "д"];
  if (m < 60) return `${m} ${mi}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ${hr} ${m % 60} ${mi}`;
  return `${Math.floor(h / 24)} ${dy} ${h % 24} ${hr}`;
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
