/**
 * Slower BTC context sources from AltBullet, each refreshed on its own TTL and
 * cached between scanner cycles (so a 5m cycle never waits on them):
 *  - aggregated liquidation heatmap (CoinGlass model2, 3d) — liquidity
 *    clusters above / below price (AltBullet liq-heatmap-shadow, BTC bands)
 *  - Hyperliquid whale positions and whale alerts for BTC (AltBullet
 *    hyperliquid_whale / whaleTracker)
 *  - BTC balances on exchanges (inflow/outflow, AltBullet Layer 14 analogue)
 *  - BTC dominance (AltBullet coinglass_btc_dominance, CoinGecko fallback)
 * Every field is null when its source failed; nothing is invented.
 */
import { cgGet } from "./coinglass";

const MIN = 60_000;

type Cached<T> = { value: T | null; fetchedAt: number; inFlight: Promise<void> | null };
function cache<T>(): Cached<T> {
  return { value: null, fetchedAt: 0, inFlight: null };
}
async function refresh<T>(slot: Cached<T>, ttlMs: number, load: () => Promise<T | null>): Promise<void> {
  if (Date.now() - slot.fetchedAt < ttlMs) return;
  if (slot.inFlight) return slot.inFlight;
  slot.inFlight = (async () => {
    const value = await load().catch(() => null);
    // A failed refresh keeps the previous value only while it is still within 3 TTLs.
    if (value !== null) slot.value = value;
    else if (Date.now() - slot.fetchedAt > 3 * ttlMs) slot.value = null;
    slot.fetchedAt = Date.now();
  })().finally(() => { slot.inFlight = null; });
  return slot.inFlight;
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// ── Liquidation heatmap ─────────────────────────────────────────────────────
export type HeatCluster = { price: number; distancePct: number; valueUsd: number };
export type HeatmapSummary = {
  fetchedAt: string;
  price: number;
  /** Total liquidation liquidity by distance band from price. */
  below: { "0-1%": number; "1-2%": number; "2-5%": number; "5-10%": number };
  above: { "0-1%": number; "1-2%": number; "2-5%": number; "5-10%": number };
  topBelow: HeatCluster[];
  topAbove: HeatCluster[];
  /** above(0-5%) ÷ below(0-5%): >1 = more liquidity overhead (magnet up). */
  aboveBelowRatio5pct: number | null;
};

/** Pure: prices[i] with summed values[i] around `price`. */
export function summarizeHeatmap(prices: number[], values: number[], price: number, fetchedAt: string): HeatmapSummary | null {
  if (!(price > 0) || prices.length === 0 || prices.length !== values.length) return null;
  const empty = () => ({ "0-1%": 0, "1-2%": 0, "2-5%": 0, "5-10%": 0 });
  const below = empty();
  const above = empty();
  const belowItems: HeatCluster[] = [];
  const aboveItems: HeatCluster[] = [];
  for (let i = 0; i < prices.length; i++) {
    const p = prices[i]!;
    const v = values[i]!;
    if (!(p > 0) || !(v > 0)) continue;
    const d = ((p - price) / price) * 100;
    const a = Math.abs(d);
    if (a < 0.01 || a > 10) continue;
    const band = a < 1 ? "0-1%" : a < 2 ? "1-2%" : a < 5 ? "2-5%" : "5-10%";
    const item = { price: p, distancePct: Number(d.toFixed(3)), valueUsd: Math.round(v) };
    if (d < 0) { below[band] += v; belowItems.push(item); } else { above[band] += v; aboveItems.push(item); }
  }
  const top = (items: HeatCluster[]) => items.sort((x, y) => y.valueUsd - x.valueUsd).slice(0, 3);
  const b5 = below["0-1%"] + below["1-2%"] + below["2-5%"];
  const a5 = above["0-1%"] + above["1-2%"] + above["2-5%"];
  const roundBands = (o: ReturnType<typeof empty>) =>
    Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v)])) as ReturnType<typeof empty>;
  return {
    fetchedAt, price,
    below: roundBands(below), above: roundBands(above),
    topBelow: top(belowItems), topAbove: top(aboveItems),
    aboveBelowRatio5pct: b5 > 0 ? Number((a5 / b5).toFixed(3)) : null,
  };
}

async function loadHeatmap(): Promise<HeatmapSummary | null> {
  const data = await cgGet("/api/futures/liquidation/aggregated-heatmap/model2", { symbol: "BTC", range: "3d" }) as
    { y_axis?: unknown[]; liquidation_leverage_data?: unknown[]; price_candlesticks?: unknown[] } | null;
  if (!data || !Array.isArray(data.y_axis) || !Array.isArray(data.liquidation_leverage_data)) return null;
  const prices = data.y_axis.map((p) => num(p) ?? 0);
  const values = new Array(prices.length).fill(0) as number[];
  for (const cell of data.liquidation_leverage_data) {
    if (!Array.isArray(cell) || cell.length < 3) continue;
    const y = num(cell[1]);
    const v = num(cell[2]);
    if (y === null || v === null || y < 0 || y >= values.length) continue;
    values[y] += v;
  }
  const candles = Array.isArray(data.price_candlesticks) ? data.price_candlesticks : [];
  const last = candles[candles.length - 1];
  const price = Array.isArray(last) ? num(last[4]) : null;
  return price ? summarizeHeatmap(prices, values, price, new Date().toISOString()) : null;
}

// ── Hyperliquid whales (BTC) ────────────────────────────────────────────────
export type HyperliquidWhales = {
  fetchedAt: string;
  longCount: number; shortCount: number;
  longUsd: number; shortUsd: number; netUsd: number;
  avgLeverage: number | null;
  /** Whale-alert opens/closes for BTC in the last hour. */
  opened1hLongUsd: number; opened1hShortUsd: number;
};

async function loadWhales(): Promise<HyperliquidWhales | null> {
  const [positions, alerts] = await Promise.all([
    cgGet("/api/hyperliquid/whale-position", { limit: 1000 }),
    cgGet("/api/hyperliquid/whale-alert", { limit: 200 }),
  ]);
  if (!Array.isArray(positions)) return null;
  let longCount = 0, shortCount = 0, longUsd = 0, shortUsd = 0, levSum = 0, levN = 0;
  for (const p of positions as Array<Record<string, unknown>>) {
    if (String(p.symbol).toUpperCase() !== "BTC") continue;
    const size = num(p.position_size);
    const value = Math.abs(num(p.position_value_usd) ?? 0);
    if (size === null || size === 0) continue;
    if (size > 0) { longCount++; longUsd += value; } else { shortCount++; shortUsd += value; }
    const lev = num(p.leverage);
    if (lev !== null && lev > 0) { levSum += lev; levN++; }
  }
  let opened1hLongUsd = 0, opened1hShortUsd = 0;
  const since = Date.now() - 60 * MIN;
  for (const a of (Array.isArray(alerts) ? alerts : []) as Array<Record<string, unknown>>) {
    if (String(a.symbol).toUpperCase() !== "BTC" || Number(a.position_action) !== 1) continue;
    const at = num(a.create_time);
    if (at === null || at < since) continue;
    const size = num(a.position_size) ?? 0;
    const value = Math.abs(num(a.position_value_usd) ?? 0);
    if (size > 0) opened1hLongUsd += value; else if (size < 0) opened1hShortUsd += value;
  }
  return {
    fetchedAt: new Date().toISOString(),
    longCount, shortCount,
    longUsd: Math.round(longUsd), shortUsd: Math.round(shortUsd), netUsd: Math.round(longUsd - shortUsd),
    avgLeverage: levN ? Number((levSum / levN).toFixed(1)) : null,
    opened1hLongUsd: Math.round(opened1hLongUsd), opened1hShortUsd: Math.round(opened1hShortUsd),
  };
}

// ── BTC on exchanges ────────────────────────────────────────────────────────
export type ExchangeBalance = {
  fetchedAt: string;
  totalBtc: number;
  change1dBtc: number | null; change1dPct: number | null;
  change7dBtc: number | null; change7dPct: number | null;
  exchanges: number;
};

async function loadExchangeBalance(): Promise<ExchangeBalance | null> {
  const rows = await cgGet("/api/exchange/balance/list", { symbol: "BTC" });
  if (!Array.isArray(rows) || rows.length === 0) return null;
  let total = 0, d1 = 0, d7 = 0, has1 = false, has7 = false;
  for (const r of rows as Array<Record<string, unknown>>) {
    const bal = num(r.total_balance ?? r.balance);
    if (bal === null) continue;
    total += bal;
    const c1 = num(r.balance_change_1d);
    const c7 = num(r.balance_change_7d);
    if (c1 !== null) { d1 += c1; has1 = true; }
    if (c7 !== null) { d7 += c7; has7 = true; }
  }
  if (!(total > 0)) return null;
  return {
    fetchedAt: new Date().toISOString(),
    totalBtc: Math.round(total),
    change1dBtc: has1 ? Math.round(d1) : null,
    change1dPct: has1 && total - d1 > 0 ? Number(((d1 / (total - d1)) * 100).toFixed(3)) : null,
    change7dBtc: has7 ? Math.round(d7) : null,
    change7dPct: has7 && total - d7 > 0 ? Number(((d7 / (total - d7)) * 100).toFixed(3)) : null,
    exchanges: rows.length,
  };
}

// ── BTC dominance ───────────────────────────────────────────────────────────
export type Dominance = { fetchedAt: string; source: "coinglass" | "coingecko"; dominancePct: number; change24hPct: number | null };

async function loadDominance(): Promise<Dominance | null> {
  const data = await cgGet("/api/index/bitcoin-dominance", {});
  if (Array.isArray(data) && data.length) {
    const points = (data as Array<Record<string, unknown>>)
      .map((p) => {
        const raw = num(p.timestamp ?? p.time);
        const t = raw === null ? null : raw < 10_000_000_000 ? raw * 1000 : raw;
        return { t, d: num(p.bitcoin_dominance) };
      })
      .filter((p): p is { t: number; d: number } => p.t !== null && p.d !== null && p.d > 0 && p.d <= 100)
      .sort((a, b) => a.t - b.t);
    const last = points[points.length - 1];
    if (last) {
      const dayAgo = [...points].reverse().find((p) => p.t <= last.t - 23 * 60 * MIN);
      return {
        fetchedAt: new Date().toISOString(), source: "coinglass", dominancePct: Number(last.d.toFixed(3)),
        change24hPct: dayAgo ? Number((last.d - dayAgo.d).toFixed(3)) : null,
      };
    }
  }
  // AltBullet falls back to CoinGecko for dominance (not a trading series).
  try {
    const res = await fetch("https://api.coingecko.com/api/v3/global", { signal: AbortSignal.timeout(8_000) });
    const body = (await res.json()) as { data?: { market_cap_percentage?: { btc?: number } } };
    const d = num(body.data?.market_cap_percentage?.btc);
    return d ? { fetchedAt: new Date().toISOString(), source: "coingecko", dominancePct: Number(d.toFixed(3)), change24hPct: null } : null;
  } catch {
    return null;
  }
}

// ── Public ──────────────────────────────────────────────────────────────────
export type MarketContext = {
  heatmap: HeatmapSummary | null;
  hyperliquidWhales: HyperliquidWhales | null;
  exchangeBalance: ExchangeBalance | null;
  dominance: Dominance | null;
};

const heatmap = cache<HeatmapSummary>();
const whales = cache<HyperliquidWhales>();
const balance = cache<ExchangeBalance>();
const dominance = cache<Dominance>();

/** Refreshes whatever is due (in the background) and returns the cached context. */
export function getMarketContext(): MarketContext {
  void refresh(heatmap, 15 * MIN, loadHeatmap);
  void refresh(whales, 5 * MIN, loadWhales);
  void refresh(balance, 60 * MIN, loadExchangeBalance);
  void refresh(dominance, 30 * MIN, loadDominance);
  return {
    heatmap: heatmap.value,
    hyperliquidWhales: whales.value,
    exchangeBalance: balance.value,
    dominance: dominance.value,
  };
}
