/**
 * Aggregated volume at the entry of every BTC signal (owner 2026-11-12: "everything we track for the other two
 * bots — VSA, VPVR and so on"). CoinGlass aggregated taker volume, futures (all exchanges) and spot (all spot
 * exchanges) separately, 1H and 4H history. Observation only, never decides a signal. Never throws.
 *
 *   VPVR (CAB entry-money-flow v2, 1:1): 30 days of 1H bars, BingX BTC-USDT high/low with aggregated USD volume
 *     (futures + spot), 120 price bins: POC distance, in value area, VAH / VAL distance, volume share
 *     within ±5 / ±10% of the entry.
 *   Welkin VSA of the last closed 1H and 4H bar — futures, spot, total — on 20 / 50 / 120 bars, and by the
 *     Lucy's VSA rule (20 bars, grey under the 120-bar average).
 *   Volume of the last 24h vs the 30-day daily average and vs the busiest day of 60 days (futures, spot,
 *     total); spot share of the last 24h, %.
 */
import type { Candle } from "./bingx";
import { cgGet, FUTURES_EXCHANGES, SPOT_EXCHANGES } from "./coinglass";

const H1 = 3_600_000, H4 = 4 * H1;
const r2 = (x: number) => Math.round(x * 100) / 100;

type Usd = Map<number, number>;

async function takerUsd(spot: boolean, interval: "1h" | "4h", limit: number): Promise<Usd | null> {
  const data = await cgGet(spot ? "/api/spot/aggregated-taker-buy-sell-volume/history" : "/api/futures/aggregated-taker-buy-sell-volume/history", {
    symbol: "BTC", interval, limit, exchange_list: spot ? SPOT_EXCHANGES : FUTURES_EXCHANGES,
  });
  if (!Array.isArray(data) || data.length === 0) return null;
  const m: Usd = new Map();
  for (const row of data as Array<Record<string, unknown>>) {
    const raw = Number(row.time);
    const t = raw < 1e12 ? raw * 1000 : raw;
    const v = Number(row.aggregated_buy_volume_usd) + Number(row.aggregated_sell_volume_usd);
    if (Number.isFinite(t) && Number.isFinite(v)) m.set(t, v);
  }
  return m.size ? m : null;
}

/** Owner's Welkin VSA on n bars ending at `t` (step), population σ; longN > 0: grey under the longN average. */
export function welkinAt(vol: Usd, t: number, step: number, n: number, longN = 0): string | null {
  const span = Math.max(n, longN);
  const vs: number[] = [];
  for (let k = span - 1; k >= 0; k--) { const v = vol.get(t - k * step); if (v === undefined) return null; vs.push(v); }
  const win = vs.slice(span - n);
  const avg = win.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(win.reduce((a, v) => a + (v - avg) ** 2, 0) / n);
  const v = vs[span - 1]!, prev = vs[span - 2]!;
  if (longN > 0 && v < vs.reduce((a, b) => a + b, 0) / longN) return "N";
  if (v > avg + 4 * sd) return "W";
  if (v > avg + 3 * sd) return "M";
  if (v > avg + 2 * sd) return "O";
  if (v > avg) return "A";
  if (prev > 0 && v / prev >= 1.25) return "Y";
  return "N";
}

/** CAB's VPVR (entry-money-flow v2): 30 days of 1H, 120 bins. */
export function vpvrReadings(bars1h: { time: number; high: number; low: number }[], usd1h: Usd, entry: number, endOpen: number): Record<string, number> | null {
  const BINS = 120;
  const from = endOpen - 30 * 24 * H1 + H1;
  const bars: { lo: number; hi: number; usd: number }[] = [];
  let total = 0, missing = 0;
  for (const c of bars1h) {
    if (c.time < from || c.time > endOpen) continue;
    total++;
    const v = usd1h.get(c.time);
    if (v === undefined) { missing++; continue; }
    if (v > 0 && c.high >= c.low && c.low > 0) bars.push({ lo: c.low, hi: c.high, usd: v });
  }
  if (!(entry > 0) || total < 24 * 20 || missing > 0.1 * total || bars.length === 0) return null;
  const lo = Math.min(...bars.map((b) => b.lo)), hi = Math.max(...bars.map((b) => b.hi));
  if (!(hi > lo)) return null;
  const w = (hi - lo) / BINS;
  const vol = new Array<number>(BINS).fill(0);
  const binOf = (p: number) => Math.min(BINS - 1, Math.max(0, Math.floor((p - lo) / w)));
  for (const b of bars) { const a = binOf(b.lo), z = binOf(b.hi); for (let k = a; k <= z; k++) vol[k]! += b.usd / (z - a + 1); }
  const sum = vol.reduce((x, y) => x + y, 0);
  let poc = 0;
  for (let k = 1; k < BINS; k++) if (vol[k]! > vol[poc]!) poc = k;
  let a = poc, z = poc, acc = vol[poc]!;
  while (acc < 0.7 * sum && (a > 0 || z < BINS - 1)) {
    const left = a > 0 ? vol[a - 1]! : -1, right = z < BINS - 1 ? vol[z + 1]! : -1;
    if (right >= left) { z++; acc += vol[z]!; } else { a--; acc += vol[a]!; }
  }
  const mid = (k: number) => lo + (k + 0.5) * w;
  const val = lo + a * w, vah = lo + (z + 1) * w;
  const share = (p1: number, p2: number) => { let t = 0; for (let k = 0; k < BINS; k++) { const m = mid(k); if (m >= p1 && m <= p2) t += vol[k]!; } return (100 * t) / sum; };
  return {
    poc_dist_pct: r2((mid(poc) / entry - 1) * 100),
    in_value_area: entry >= val && entry <= vah ? 1 : 0,
    vah_dist_pct: r2((vah / entry - 1) * 100),
    val_dist_pct: r2((val / entry - 1) * 100),
    above5: r2(share(entry, entry * 1.05)),
    above10: r2(share(entry, entry * 1.1)),
    below5: r2(share(entry * 0.95, entry)),
    below10: r2(share(entry * 0.9, entry)),
  };
}

const sumRange = (m: Usd, from: number, to: number, step: number) => {
  let s = 0, n = 0;
  for (let t = from; t <= to; t += step) { const v = m.get(t); if (v !== undefined) { s += v; n++; } }
  return n ? s : null;
};
const merge = (a: Usd | null, b: Usd | null): Usd | null => {
  if (!a || !b) return null;
  const m: Usd = new Map();
  for (const [t, v] of a) { const w = b.get(t); if (w !== undefined) m.set(t, v + w); }
  return m;
};

export async function aggVolumeStudy(c1h: Candle[], entry: number, at: number): Promise<Record<string, unknown>> {
  try {
    const [f1, s1, f4, s4] = await Promise.all([
      takerUsd(false, "1h", 760), takerUsd(true, "1h", 760), takerUsd(false, "4h", 400), takerUsd(true, "4h", 400),
    ]);
    const out: Record<string, unknown> = { version: 1, source: "coinglass_aggregated_taker_volume" };
    const last1h = Math.floor(at / H1) * H1 - H1, last4h = Math.floor(at / H4) * H4 - H4;
    const t1 = merge(f1, s1), t4 = merge(f4, s4);
    out.vpvr = t1 ? vpvrReadings(c1h, t1, entry, last1h) : null;
    const welkin: Record<string, unknown> = {};
    for (const [name, m1, m4] of [["fut", f1, f4], ["spot", s1, s4], ["total", t1, t4]] as const) {
      welkin[name] = {
        h1: m1 ? { w20: welkinAt(m1, last1h, H1, 20), w50: welkinAt(m1, last1h, H1, 50), w120: welkinAt(m1, last1h, H1, 120), lucy: welkinAt(m1, last1h, H1, 20, 120) } : null,
        h4: m4 ? { w20: welkinAt(m4, last4h, H4, 20), w50: welkinAt(m4, last4h, H4, 50), w120: welkinAt(m4, last4h, H4, 120), lucy: welkinAt(m4, last4h, H4, 20, 120) } : null,
      };
    }
    out.welkin = welkin;
    const ctx: Record<string, unknown> = {};
    for (const [name, m1, m4] of [["fut", f1, f4], ["spot", s1, s4], ["total", t1, t4]] as const) {
      if (!m1 || !m4) { ctx[name] = null; continue; }
      const last24 = sumRange(m1, last1h - 23 * H1, last1h, H1);
      const days: number[] = [];
      for (let d = 1; d <= 60; d++) { const v = sumRange(m4, last4h - (6 * d + 5) * H4, last4h - 6 * d * H4, H4); if (v !== null) days.push(v); }
      const d30 = days.slice(0, 30);
      ctx[name] = {
        vol24hUsd: last24 === null ? null : Math.round(last24),
        vol24hVs30dAvg: last24 !== null && d30.length >= 20 ? r2(last24 / (d30.reduce((a, b) => a + b, 0) / d30.length)) : null,
        vol24hVs60dMaxDay: last24 !== null && days.length >= 40 ? r2(last24 / Math.max(...days)) : null,
      };
    }
    out.volumeContext = ctx;
    const f24 = f1 ? sumRange(f1, last1h - 23 * H1, last1h, H1) : null, sp24 = s1 ? sumRange(s1, last1h - 23 * H1, last1h, H1) : null;
    out.spotShare24hPct = f24 !== null && sp24 !== null && f24 + sp24 > 0 ? r2((100 * sp24) / (f24 + sp24)) : null;
    out.missing = [!f1 && "fut1h", !s1 && "spot1h", !f4 && "fut4h", !s4 && "spot4h"].filter(Boolean);
    return out;
  } catch (err) {
    return { version: 1, error: err instanceof Error ? err.message.slice(0, 120) : String(err) };
  }
}
