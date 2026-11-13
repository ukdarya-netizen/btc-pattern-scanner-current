/**
 * S&P 500 daily closes (owner 2026-11-13: «сипка» on one chart with BTC dominance). Not a CoinGlass series —
 * Yahoo Finance chart API (^GSPC, no key), Stooq CSV (^SPX) as the fallback. Context only, never a signal input.
 * Production only (dev makes no external requests); one read per hour, after a failure the next try in 10 minutes.
 */
import { logger } from "../lib/logger";

export type SpxPoint = { t: number; close: number };
const deployed = () => process.env.REPLIT_DEPLOYMENT === "1" || process.env.NODE_ENV === "production";

export function parseYahoo(body: unknown): SpxPoint[] {
  const r = (body as { chart?: { result?: Array<{ timestamp?: number[]; indicators?: { quote?: Array<{ close?: Array<number | null> }> } }> } })?.chart?.result?.[0];
  const ts = r?.timestamp ?? [], cl = r?.indicators?.quote?.[0]?.close ?? [];
  return ts.map((t, i) => ({ t: t * 1000, close: Number(cl[i]) }))
    .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.close) && p.close > 0).sort((a, b) => a.t - b.t);
}

export function parseStooq(csv: string): SpxPoint[] {
  return csv.trim().split("\n").slice(1).map((line) => {
    const [date, , , , close] = line.split(",");
    return { t: Date.parse(`${date}T00:00:00Z`), close: Number(close) };
  }).filter((p) => Number.isFinite(p.t) && Number.isFinite(p.close) && p.close > 0).sort((a, b) => a.t - b.t);
}

let cache: { at: number; points: SpxPoint[] } | null = null;

async function load(): Promise<SpxPoint[]> {
  try {
    const res = await fetch("https://query1.finance.yahoo.com/v8/finance/chart/%5EGSPC?interval=1d&range=6mo", {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" }, signal: AbortSignal.timeout(8_000),
    });
    if (res.ok) { const p = parseYahoo(await res.json()); if (p.length) return p; }
  } catch (err) { logger.warn({ err }, "S&P 500: Yahoo failed"); }
  try {
    const res = await fetch("https://stooq.com/q/d/l/?s=%5Espx&i=d", { signal: AbortSignal.timeout(8_000) });
    if (res.ok) return parseStooq(await res.text()).slice(-130);
  } catch (err) { logger.warn({ err }, "S&P 500: Stooq failed"); }
  return [];
}

export async function spxHistory(days = 120, now = Date.now()): Promise<SpxPoint[]> {
  if (!deployed()) return [];
  const fresh = cache && now - cache.at < (cache.points.length ? 3_600_000 : 10 * 60_000);
  if (!fresh) {
    const points = await load();
    cache = points.length || !cache ? { at: now, points } : { at: now - 3_600_000 + 10 * 60_000, points: cache.points };
  }
  return cache!.points.filter((p) => p.t >= now - days * 86_400_000);
}
