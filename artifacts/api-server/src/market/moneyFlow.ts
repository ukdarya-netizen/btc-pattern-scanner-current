/**
 * MFI and Chaikin for BTC (owner 2026-11-09, recorded in every 5m snapshot and at every signal; observation only):
 * mfi14, cmf20, cho (Chaikin oscillator ÷ 20-bar average volume), cmf_long (15m 96 = 1 day, 1H 72 = 3 days,
 * 4H 42 = 7 days), slopes over 12 bars, bull / bear divergences (last 12 bars vs the 36 before) — same formulas
 * as CAB and Nihilist. Volume = AGGREGATED taker volume of all futures exchanges (fut) and of spot (spot),
 * CoinGlass, ÷ BingX close. 15m from the scanner's flow; 1H / 4H from their own 1H series (cached, 5 min).
 * A reading with a missing volume bar in its window is null (never BingX volume).
 */
import { getClosedCandles, type Candle } from "./bingx";
import { cgGet, FUTURES_EXCHANGES, SPOT_EXCHANGES, type FlowSeries } from "./coinglass";

const H1 = 3_600_000, H4 = 4 * H1, M15 = 15 * 60_000;
type Bar = { t: number; h: number; l: number; c: number; v: number };
const r4 = (x: number | null) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10_000) / 10_000);
const tp = (c: Bar) => (c.h + c.l + c.c) / 3;
const clv = (c: Bar) => (c.h > c.l ? (c.c - c.l - (c.h - c.c)) / (c.h - c.l) : 0);

function mfiAt(cs: Bar[], i: number, n = 14): number | null {
  if (i < n) return null;
  let pos = 0, neg = 0;
  for (let k = i - n + 1; k <= i; k++) {
    const v = cs[k]!.v; if (!Number.isFinite(v)) return null;
    const a = tp(cs[k]!), b = tp(cs[k - 1]!);
    if (a > b) pos += a * v; else if (a < b) neg += a * v;
  }
  return neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
}
function cmfAt(cs: Bar[], i: number, n: number): number | null {
  if (i < n - 1) return null;
  let s = 0, v = 0;
  for (let k = i - n + 1; k <= i; k++) { const x = cs[k]!.v; if (!Number.isFinite(x)) return null; s += clv(cs[k]!) * x; v += x; }
  return v > 0 ? s / v : null;
}
function choAt(cs: Bar[], i: number): number | null {
  const from = Math.max(1, i - 150);
  if (i - from < 60) return null;
  let ad = 0, e3: number | null = null, e10: number | null = null;
  for (let k = from; k <= i; k++) {
    const x = cs[k]!.v; if (!Number.isFinite(x)) return null;
    ad += clv(cs[k]!) * x;
    e3 = e3 === null ? ad : e3 + (2 / 4) * (ad - e3);
    e10 = e10 === null ? ad : e10 + (2 / 11) * (ad - e10);
  }
  let v = 0; for (let k = i - 19; k <= i; k++) v += cs[k]!.v;
  return v > 0 && e3 !== null && e10 !== null ? (e3 - e10) / (v / 20) : null;
}
export function mfReadings(cs: Bar[], i: number, longN: number): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  const mfi = (k: number) => mfiAt(cs, k), cmf = (k: number) => cmfAt(cs, k, 20);
  out.mfi14 = mfi(i); out.cmf20 = cmf(i); out.cho = choAt(cs, i); out.cmf_long = cmfAt(cs, i, longN);
  const m12 = mfi(i - 12), c12 = cmf(i - 12);
  out.mfi_slope12 = out.mfi14 != null && m12 != null ? out.mfi14 - m12 : null;
  out.cmf_slope12 = out.cmf20 != null && c12 != null ? out.cmf20 - c12 : null;
  for (const k of ["mfi_bull_div", "mfi_bear_div", "cmf_bull_div", "cmf_bear_div"]) out[k] = null;
  if (i >= 60) {
    const rng = (a: number, b: number, f: (k: number) => number | null, pick: "min" | "max") => {
      let r: number | null = null;
      for (let k = a; k <= b; k++) { const x = f(k); if (x === null) return null; r = r === null ? x : pick === "min" ? Math.min(r, x) : Math.max(r, x); }
      return r;
    };
    const lowR = rng(i - 11, i, (k) => cs[k]!.l, "min")!, lowP = rng(i - 47, i - 12, (k) => cs[k]!.l, "min")!;
    const hiR = rng(i - 11, i, (k) => cs[k]!.h, "max")!, hiP = rng(i - 47, i - 12, (k) => cs[k]!.h, "max")!;
    for (const [name, f] of [["mfi", mfi], ["cmf", cmf]] as const) {
      const minR = rng(i - 11, i, f, "min"), minP = rng(i - 47, i - 12, f, "min");
      const maxR = rng(i - 11, i, f, "max"), maxP = rng(i - 47, i - 12, f, "max");
      out[`${name}_bull_div`] = minR === null || minP === null ? null : lowR < lowP && minR > minP ? 1 : 0;
      out[`${name}_bear_div`] = maxR === null || maxP === null ? null : hiR > hiP && maxR < maxP ? 1 : 0;
    }
  }
  for (const k of Object.keys(out)) out[k] = r4(out[k]!);
  return out;
}

const withVolume = (cs: Candle[], usd: Map<number, number> | null): Bar[] =>
  cs.map((k) => { const u = usd?.get(k.time); return { t: k.time, h: k.high, l: k.low, c: k.close, v: u !== undefined && u > 0 && k.close > 0 ? u / k.close : NaN }; });
function to4h(b1: Bar[]): Bar[] {
  const g = new Map<number, Bar[]>();
  for (const b of b1) { const k = Math.floor(b.t / H4) * H4; (g.get(k) ?? g.set(k, []).get(k)!).push(b); }
  return [...g.entries()].filter(([, xs]) => xs.length === 4).sort((a, b) => a[0] - b[0])
    .map(([t, xs]) => ({ t, h: Math.max(...xs.map((x) => x.h)), l: Math.min(...xs.map((x) => x.l)), c: xs[3]!.c, v: xs.reduce((s, x) => s + x.v, 0) }));
}
function last(bars: Bar[], span: number, now: number, longN: number) {
  const t = Math.floor(now / span) * span - span;
  const i = bars.findIndex((b) => b.t === t);
  return i < 0 ? null : mfReadings(bars, i, longN);
}
async function hourly(path: string, exchanges: string): Promise<Map<number, number> | null> {
  const rows = await cgGet(path, { symbol: "BTC", interval: "1h", limit: 800, exchange_list: exchanges });
  if (!Array.isArray(rows) || !rows.length) return null;
  const m = new Map<number, number>();
  for (const r of rows as Array<Record<string, unknown>>) {
    const raw = Number(r.time ?? r.timestamp), t = raw < 1e12 ? raw * 1000 : raw;
    const v = Number(r.aggregated_buy_volume_usd) + Number(r.aggregated_sell_volume_usd);
    if (Number.isFinite(t) && Number.isFinite(v)) m.set(t, v);
  }
  return m;
}

type Slow = { at: number; c1h: Candle[]; fut: Map<number, number> | null; spot: Map<number, number> | null };
let slow: Slow | null = null;
let inFlight: Promise<void> | null = null;
function refreshSlow(now: number): void {
  if (inFlight || (slow && now - slow.at < 5 * 60_000)) return;
  inFlight = (async () => {
    const [c1h, fut, spot] = await Promise.all([
      getClosedCandles("1h", 760, now).catch(() => [] as Candle[]),
      hourly("/api/futures/aggregated-taker-buy-sell-volume/history", FUTURES_EXCHANGES).catch(() => null),
      hourly("/api/spot/aggregated-taker-buy-sell-volume/history", SPOT_EXCHANGES).catch(() => null),
    ]);
    if (c1h.length) slow = { at: Date.now(), c1h, fut, spot };
  })().finally(() => { inFlight = null; });
}

export type MoneyFlow = Record<string, Record<string, number | null> | null> & { source?: never };

/** Readings at the last closed 15m / 1H / 4H bar; null where aggregated volume is missing. */
export function moneyFlowMetrics(c15: Candle[], flow: FlowSeries, now: number): Record<string, Record<string, number | null> | null> {
  refreshSlow(now);
  const usd = (s: typeof flow.futuresTaker) => (s ? new Map(s.map((b) => [b.time, (b.buy ?? 0) + (b.sell ?? 0)])) : null);
  const out: Record<string, Record<string, number | null> | null> = {
    fut_15m: flow.futuresTaker ? last(withVolume(c15, usd(flow.futuresTaker)), M15, now, 96) : null,
    spot_15m: flow.spotTaker ? last(withVolume(c15, usd(flow.spotTaker)), M15, now, 96) : null,
    fut_1h: null, fut_4h: null, spot_1h: null, spot_4h: null,
  };
  if (slow) {
    for (const [name, m] of [["fut", slow.fut], ["spot", slow.spot]] as const) {
      if (!m) continue;
      const b1 = withVolume(slow.c1h, m);
      out[`${name}_1h`] = last(b1, H1, now, 72);
      out[`${name}_4h`] = last(to4h(b1), H4, now, 42);
    }
  }
  return out;
}
