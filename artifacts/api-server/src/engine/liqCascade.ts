/**
 * Liquidation cascade for BTC (owner 2026-11-09: as CAB's Liquidation Cascade, both sides, live at once,
 * parameters not fitted on history — they are recorded with every decision to be tuned on live signals).
 *
 * Long (short is the mirror: short liquidations and a squeeze up):
 *  1. Spike — within the last 12 h an hour (4 closed 15m bars, aggregated CoinGlass liquidations of all
 *     exchanges) with long liquidations ≥ SPIKE_MULT × the average hour of the 24 h before it, at least
 *     SPIKE_MIN_USD, while price fell ≥ SPIKE_PRICE_PCT over that hour.
 *  2. Exhaustion — on the bar just closed long liquidations are ≤ 25% of the biggest 15m bar of the spike
 *     and the last hour holds ≤ 50% of the spike hour (CAB's liqExhausted).
 *  3. Reaction — the bar just closed has a lower wick ≥ WICK_MIN_PCT of the price (CAB's lower-wick gate,
 *     scaled to BTC) and closes in its upper half.
 *  4. Once per spike — the first bar after the spike that meets 2 and 3 (a later bar never re-fires it).
 * Stop: below the cascade low (lowest low since the spike began) − 0.15 × ATR(14) 1H. Targets 1.5R and 3R
 * (50/50), break-even after the first (owner 2026-11-09). Evaluated on every closed 15m bar.
 * No liquidation data → no signal (aggregated only).
 */
import type { Direction } from "../config/profiles";
import type { Candle } from "../market/bingx";
import type { FlowBar } from "../market/coinglass";
import type { Pattern, PatternResult } from "./patterns";
import type { Snapshot } from "./snapshot";

export const LC = {
  SPIKE_MULT: 3,
  SPIKE_MIN_USD: 5_000_000,
  SPIKE_PRICE_PCT: 1,
  WATCH_BARS: 48, // 12 h of 15m bars
  EXHAUST_BAR_SHARE: 0.25,
  EXHAUST_HOUR_SHARE: 0.5,
  WICK_MIN_PCT: 0.4,
  STOP_ATR: 0.15,
  TARGETS_R: [1.5, 3] as const,
};

const M15 = 15 * 60_000;
const r = (x: number | null, d = 4) => (x === null || !Number.isFinite(x) ? null : Number(x.toFixed(d)));

function atr1h(cs: Candle[], n = 14): number | null {
  if (cs.length < n + 1) return null;
  let s = 0;
  for (let i = cs.length - n; i < cs.length; i++) {
    const c = cs[i]!, p = cs[i - 1]!.close;
    s += Math.max(c.high - c.low, Math.abs(c.high - p), Math.abs(c.low - p));
  }
  return s / n;
}

type Bar = { t: number; liq: number; o: number; h: number; l: number; c: number };

/** Pure: the cascade state for one side on aligned 15m bars (oldest first). Exported for tests. */
export function cascadeState(bars: Bar[], dir: 1 | -1) {
  const n = bars.length - 1;
  const hour = (k: number) => (k < 3 ? null : bars[k]!.liq + bars[k - 1]!.liq + bars[k - 2]!.liq + bars[k - 3]!.liq);
  const base = (k: number) => {
    if (k - 99 < 0) return null;
    let s = 0; for (let i = k - 99; i <= k - 4; i++) s += bars[i]!.liq;
    return s / 24;
  };
  const movePct = (k: number) => ((bars[k]!.c - bars[k - 3]!.o) / bars[k - 3]!.o) * 100 * dir;
  const isSpike = (k: number) => {
    const h = hour(k), b = base(k);
    return h !== null && b !== null && b > 0 && h >= LC.SPIKE_MULT * b && h >= LC.SPIKE_MIN_USD && movePct(k) <= -LC.SPIKE_PRICE_PCT;
  };
  // The latest spike that ended before the bar just closed, within the watch window.
  let spike: number | null = null;
  for (let k = n - 1; k >= Math.max(3, n - LC.WATCH_BARS); k--) if (isSpike(k)) { spike = k; break; }
  if (spike === null) return { spike: null as null };
  // The spike's start: walk back over consecutive spike hours (one cascade = one spike).
  let first = spike;
  while (first - 1 >= 3 && isSpike(first - 1)) first--;
  const start = first - 3;
  const spikeHour = Math.max(...Array.from({ length: spike - first + 1 }, (_, i) => hour(first + i) ?? 0));
  const peakBar = Math.max(...bars.slice(start, spike + 1).map((b) => b.liq));
  const qualifies = (m: number) => {
    const b = bars[m]!;
    const lastHour = hour(m);
    const exhausted = b.liq <= LC.EXHAUST_BAR_SHARE * peakBar && lastHour !== null && lastHour <= LC.EXHAUST_HOUR_SHARE * spikeHour;
    const range = b.h - b.l;
    const wick = dir === 1 ? Math.min(b.o, b.c) - b.l : b.h - Math.max(b.o, b.c);
    const wickPct = (wick / b.c) * 100;
    const upperHalf = range > 0 && (dir === 1 ? b.c - b.l : b.h - b.c) / range >= 0.5;
    return { exhausted, wickPct, upperHalf, ok: exhausted && wickPct >= LC.WICK_MIN_PCT && upperHalf };
  };
  let firedBefore = false;
  for (let m = spike + 1; m < n; m++) if (qualifies(m).ok) { firedBefore = true; break; }
  let extreme = dir === 1 ? Infinity : -Infinity;
  for (let i = start; i <= n; i++) extreme = dir === 1 ? Math.min(extreme, bars[i]!.l) : Math.max(extreme, bars[i]!.h);
  const now = qualifies(n);
  return {
    spike, spikeAt: bars[first]!.t, spikeEndAt: bars[spike]!.t + M15, spikeHourUsd: spikeHour, peakBarUsd: peakBar,
    baselineHourUsd: base(first), spikeMovePct: movePct(first), barsSinceSpike: n - spike,
    extreme, now, firedBefore, lastBarUsd: bars[n]!.liq, lastHourUsd: hour(n),
  };
}

export function evaluateLiqCascade(snapshot: Snapshot, direction: Direction): PatternResult {
  const dir = direction === "long" ? 1 : -1;
  const liq = snapshot.flow.liquidations;
  const c15 = snapshot.candles["15m"];
  if (!liq || liq.length < 110) return { fires: false, reasons: ["liquidations:no_data"] };
  const field = direction === "long" ? "long" : "short";
  const byT = new Map<number, FlowBar>(liq.map((b) => [b.time, b]));
  const bars: Bar[] = [];
  for (const c of c15) { const f = byT.get(c.time); if (f && Number.isFinite(f[field])) bars.push({ t: c.time, liq: f[field]!, o: c.open, h: c.high, l: c.low, c: c.close }); }
  const last = c15.at(-1);
  if (!last || bars.at(-1)?.t !== last.time || bars.length < 110) return { fires: false, reasons: ["liquidations:no_data"] };
  const st = cascadeState(bars, dir);
  if (st.spike === null) return { fires: false, reasons: ["no_spike_12h"] };
  const a = atr1h(snapshot.candles["1h"]);
  const detail = {
    method: "liquidation_cascade", spikeAt: new Date(st.spikeAt).toISOString(), spikeEndAt: new Date(st.spikeEndAt).toISOString(),
    spikeHourUsd: Math.round(st.spikeHourUsd), baselineHourUsd: st.baselineHourUsd === null ? null : Math.round(st.baselineHourUsd),
    spikeMult: st.baselineHourUsd ? r(st.spikeHourUsd / st.baselineHourUsd, 2) : null, spikeMovePct: r(st.spikeMovePct, 3),
    peakBarUsd: Math.round(st.peakBarUsd), lastBarUsd: Math.round(st.lastBarUsd), lastHourUsd: st.lastHourUsd === null ? null : Math.round(st.lastHourUsd),
    barsSinceSpike: st.barsSinceSpike, cascadeExtreme: st.extreme, exhausted: st.now.exhausted,
    reactionWickPct: r(st.now.wickPct, 3), closeInReactionHalf: st.now.upperHalf, firedBeforeForSpike: st.firedBefore,
    atr1h: a, params: LC,
  };
  const reasons: string[] = [];
  if (st.firedBefore) reasons.push("already_fired_for_spike");
  if (!st.now.exhausted) reasons.push("liquidations_not_exhausted");
  if (!(st.now.wickPct >= LC.WICK_MIN_PCT)) reasons.push(`reaction_wick<${LC.WICK_MIN_PCT}%`);
  if (!st.now.upperHalf) reasons.push("close_not_in_reaction_half");
  if (a === null) reasons.push("atr1h:no_data");
  if (reasons.length) return { fires: false, reasons, detail };
  const entry = last.close;
  const stop = st.extreme - dir * LC.STOP_ATR * a!;
  const risk = (entry - stop) * dir;
  if (!(risk > 0)) return { fires: false, reasons: ["stop_not_behind_entry"], detail };
  const levels = { stop, targets: LC.TARGETS_R.map((k) => ({ price: entry + dir * k * risk, fraction: 0.5 })) };
  return { fires: true, reasons: ["ok"], levels, detail: { ...detail, entryAtSignal: entry, stop, riskPct: r((risk / entry) * 100, 3), levels } };
}

export const LIQ_CASCADE_PATTERNS: Pattern[] = (["long", "short"] as const).map((direction): Pattern => ({
  key: `lc_${direction}`,
  label: direction === "long" ? "Каскад ликвидаций лонгов → отскок" : "Вынос шортов → откат",
  direction,
  profile: "h4",
  live: true,
  evalTf: "15m",
  evaluate: (snapshot) => evaluateLiqCascade(snapshot, direction),
}));
