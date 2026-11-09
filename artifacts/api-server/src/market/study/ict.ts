/**
 * ICT reading at an entry (owner 2026-11-05: «делай всё, кропотливо и для всего»). One pure module,
 * the same file in CAB and in Nihilist, so the numbers are comparable. Long side; shorts are read on
 * mirrored candles (and mirrored levels) by the caller. Observation only — no decision reads it.
 *
 * Parameters are the defaults of the owner's TradingView indicators, fixed up front, not tuned:
 *  - major swings: pivots 14 bars each side («Sweep + MSS») and 21 («SFP Sweep Liquidity»);
 *  - MSS level: the last minor swing high, pivot 2 left / 1 right («2022 Model»);
 *  - equal highs / lows: two major swings within 0.2 × ATR(14);
 *  - ATR(14) for normalising.
 *
 * What is measured on the bars up to and including the entry bar `e` (the last closed bar before the
 * signal), in the window [w0, e]:
 *  1. Sell-side sweep (SFP): a bar in the window took a major swing low that had not been taken
 *     before (low below it) and CLOSED back above it. The latest such bar; if several lows were taken
 *     at once, the lowest. Depth (% and ATR), age of the level, sweep bar volume vs 20 and its close
 *     position, where the level sat vs the pattern level (if given).
 *     Also: a bar in the window CLOSED below an untaken swing low (liquidity taken and accepted).
 *  2. MSS after the sweep: the first close above the last minor swing high formed up to the sweep
 *     bar; bars sweep→MSS and MSS→entry; MSS on the entry bar itself.
 *  3. FVG: bullish gaps (low[i] > high[i−2]) formed from the sweep (or the window start) to the entry,
 *     still unfilled at the entry; whether the entry bar retested one. Bearish gaps above the entry
 *     (high[i] < low[i−2]) in the last 100 bars still unfilled: count and nearest distance.
 *  4. Pools: equal lows below the entry (nearest, swept in the window) and equal highs above
 *     (nearest = the next buy-side target); nearest major swing high above / low below.
 *  5. Entry bar vs swing highs: took an untaken swing high and closed back below it (a high sweep /
 *     fake breakout, TBO) or closed above it (a true break).
 *  6. Premium / discount: the entry close inside the last major swing range (0 = low, 1 = high).
 *  7. Structure: last two major swing highs and lows — HH+HL bullish, LH+LL bearish, else mixed.
 *
 * Version 2 (owner 2026-11-05, two more TradingFinder indicators):
 *  8. «Smart Money Liquidity Structure» — liquidity in front of the level (inducement): pivot lows
 *     (3 bars each side, the indicator's default) ABOVE the pattern level top, formed in the 100 bars
 *     before the entry: how many the price took on its way to the level (low below) and how many were
 *     still untouched at the entry. Only with a pattern level.
 *  9. «ICT Setup 05 — Liquidity Sweep & OB Retest» — New York session: opening range 08:00–09:30 NY,
 *     trading session 09:30–17:00 NY (DST handled). For the latest session that started at/before the
 *     entry: was the entry inside the session, which side of the opening range was taken first (low =
 *     sell-side sweep, high = buy-side), and after a low sweep the CISD — first close at/above the higher
 *     open of the two bars after the last bullish candle before the sweep, within 120 bars (Balanced).
 *     Entry bar as the retest confirmation: bullish, closed above the level top, close in the top 43% of
 *     its range (close location ≥ 0.57, Balanced).
 */
export type IctBar = { time: number; open: number; high: number; low: number; close: number; volume: number };

const MAJOR = [14, 21] as const;
const EQUAL_ATR = 0.2;

const r2 = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const pct = (a: number, b: number) => ((a - b) / Math.abs(b)) * 100;

function atrAt(b: IctBar[], e: number, n = 14): number | null {
  if (e < n) return null;
  let s = 0;
  for (let k = e - n + 1; k <= e; k++) {
    const x = b[k]!, p = b[k - 1]!;
    s += Math.max(x.high - x.low, Math.abs(x.high - p.close), Math.abs(x.low - p.close));
  }
  return s / n;
}

type Pivot = { i: number; p: number; confirmedAt: number };
/** Pivots with `left` bars on the left (strictly beyond) and `right` on the right (not beyond). */
function pivots(b: IctBar[], left: number, right: number, kind: "high" | "low", upTo: number): Pivot[] {
  const out: Pivot[] = [];
  for (let i = left; i + right <= upTo; i++) {
    const v = kind === "high" ? b[i]!.high : b[i]!.low;
    let ok = true;
    for (let k = i - left; k <= i + right && ok; k++) {
      if (k === i) continue;
      const w = kind === "high" ? b[k]!.high : b[k]!.low;
      if (kind === "high" ? (k < i ? w >= v : w > v) : (k < i ? w <= v : w < v)) ok = false;
    }
    if (ok) out.push({ i, p: v, confirmedAt: i + right });
  }
  return out;
}

function volRel(b: IctBar[], j: number) {
  const prior = b.slice(Math.max(0, j - 20), j);
  const av = prior.length ? prior.reduce((s, x) => s + x.volume, 0) / prior.length : 0;
  return av > 0 ? r2(b[j]!.volume / av) : null;
}

function where(level: number, top: number | null, bottom: number | null) {
  if (top === null) return null;
  if (bottom !== null && level < bottom) return "below_level";
  if (level <= top) return bottom !== null ? "inside_level" : "below_level_top";
  return "above_level";
}

function pools(piv: Pivot[], atr: number) {
  const out: number[] = [];
  for (let x = 0; x < piv.length; x++)
    for (let y = x + 1; y < piv.length; y++)
      if (Math.abs(piv[x]!.p - piv[y]!.p) <= EQUAL_ATR * atr) out.push((piv[x]!.p + piv[y]!.p) / 2);
  return out;
}

export function ictReading(
  b: IctBar[],
  e: number,
  opts: { w0: number; levelTop?: number | null; levelBottom?: number | null },
) {
  if (e < 30 || e >= b.length) return { reason: "мало свечей" };
  const w0 = Math.max(1, Math.min(opts.w0, e));
  const atr = atrAt(b, e);
  if (!atr) return { reason: "нет ATR" };
  const top = opts.levelTop ?? null, bottom = opts.levelBottom ?? null;
  const close = b[e]!.close;
  const minorHighs = pivots(b, 2, 1, "high", e);

  const sweepFor = (len: number) => {
    const lows = pivots(b, len, len, "low", e);
    let sweep: { j: number; piv: Pivot } | null = null;
    let closedBelow = false;
    for (let j = w0; j <= e; j++) {
      const bar = b[j]!;
      const live = lows.filter((pv) => pv.confirmedAt < j && !b.slice(pv.confirmedAt + 1, j).some((x) => x.low < pv.p));
      const taken = live.filter((pv) => bar.low < pv.p);
      if (taken.some((pv) => bar.close < pv.p)) closedBelow = true;
      const reclaimed = taken.filter((pv) => bar.close > pv.p).sort((x, y) => x.p - y.p)[0];
      if (reclaimed) sweep = { j, piv: reclaimed };
    }
    if (!sweep) return { swept: false, closedBelowSwingLow: closedBelow };
    const s = b[sweep.j]!;
    // MSS: first close above the last minor swing high formed (confirmed) up to the sweep bar.
    const mssLevel = minorHighs.filter((m) => m.confirmedAt <= sweep!.j).sort((x, y) => y.i - x.i)[0];
    let mss: number | null = null;
    if (mssLevel) for (let k = sweep.j; k <= e; k++) if (b[k]!.close > mssLevel.p) { mss = k; break; }
    // Bullish FVGs from the sweep to the entry, unfilled at the entry.
    const fvgs: { lo: number; hi: number }[] = [];
    for (let i = Math.max(sweep.j, 2); i <= e; i++) {
      const lo = b[i - 2]!.high, hi = b[i]!.low;
      if (hi > lo && !b.slice(i + 1, e + 1).some((x) => x.low <= lo)) fvgs.push({ lo, hi });
    }
    return {
      swept: true,
      barsAgo: e - sweep.j,
      levelAgeBars: sweep.j - sweep.piv.i,
      depthPct: r2(pct(sweep.piv.p, s.low)),
      depthAtr: r2((sweep.piv.p - s.low) / atr),
      sweepVolRel: volRel(b, sweep.j),
      sweepClosePos: s.high > s.low ? r2((s.close - s.low) / (s.high - s.low)) : null,
      levelWhere: where(sweep.piv.p, top, bottom),
      closedBelowSwingLow: closedBelow,
      mss: mss !== null,
      barsSweepToMss: mss === null ? null : mss - sweep.j,
      barsMssToEntry: mss === null ? null : e - mss,
      mssOnEntryBar: mss === e,
      mssLevelAbovePct: mssLevel ? r2(pct(mssLevel.p, close)) : null,
      fvgUnfilled: fvgs.length,
      fvgRetestedOnEntry: fvgs.some((f) => b[e]!.low <= f.hi && b[e]!.close >= f.lo),
    };
  };

  const highs14 = pivots(b, 14, 14, "high", e).filter((p) => p.i >= e - 300);
  const lows14 = pivots(b, 14, 14, "low", e).filter((p) => p.i >= e - 300);
  // Bearish FVGs above the entry, last 100 bars, not filled up to the entry.
  const bearGaps: number[] = [];
  for (let i = Math.max(2, e - 100); i <= e; i++) {
    const gapBottom = b[i]!.high, gapTop = b[i - 2]!.low;
    if (gapTop > gapBottom && gapBottom > close && !b.slice(i + 1, e + 1).some((x) => x.high >= gapTop)) bearGaps.push(gapBottom);
  }
  const eqLows = pools(lows14, atr).filter((p) => p < close).sort((x, y) => y - x);
  const eqHighs = pools(highs14, atr).filter((p) => p > close).sort((x, y) => x - y);
  const swingHighAbove = highs14.filter((p) => p.p > close).sort((x, y) => x.p - y.p)[0];
  const swingLowBelow = lows14.filter((p) => p.p < close).sort((x, y) => y.p - x.p)[0];
  // Entry bar against untaken major swing highs.
  const liveHighs = highs14.filter((pv) => pv.confirmedAt < e && !b.slice(pv.confirmedAt + 1, e).some((x) => x.high > pv.p));
  const tookHigh = liveHighs.filter((pv) => b[e]!.high > pv.p);
  const lastH = highs14.filter((p) => p.confirmedAt <= e).slice(-2), lastL = lows14.filter((p) => p.confirmedAt <= e).slice(-2);
  const structure =
    lastH.length === 2 && lastL.length === 2
      ? lastH[1]!.p > lastH[0]!.p && lastL[1]!.p > lastL[0]!.p ? "bullish" : lastH[1]!.p < lastH[0]!.p && lastL[1]!.p < lastL[0]!.p ? "bearish" : "mixed"
      : null;
  const rangeHi = lastH.at(-1)?.p ?? null, rangeLo = lastL.at(-1)?.p ?? null;

  return {
    windowBars: e - w0 + 1,
    atrPct: r2((atr / Math.abs(close)) * 100),
    sweep14: sweepFor(14),
    sweep21: sweepFor(21),
    fvgBearAboveCount: bearGaps.length,
    fvgBearAboveNearestPct: bearGaps.length ? r2(pct(Math.min(...bearGaps), close)) : null,
    eqLowsBelowNearestPct: eqLows.length ? r2(pct(close, eqLows[0]!)) : null,
    eqLowsBelowSweptInWindow: eqLows.length ? b.slice(w0, e + 1).some((x) => x.low < eqLows[0]! && x.close > eqLows[0]!) : null,
    eqHighsAboveNearestPct: eqHighs.length ? r2(pct(eqHighs[0]!, close)) : null,
    swingHighAbovePct: swingHighAbove ? r2(pct(swingHighAbove.p, close)) : null,
    swingLowBelowPct: swingLowBelow ? r2(pct(close, swingLowBelow.p)) : null,
    entryBarSweptHigh: tookHigh.some((pv) => b[e]!.close < pv.p),
    entryBarBrokeHigh: tookHigh.some((pv) => b[e]!.close > pv.p),
    premiumDiscount: rangeHi !== null && rangeLo !== null && rangeHi > rangeLo ? r2((close - rangeLo) / (rangeHi - rangeLo)) : null,
    structure,
    levelTop: top,
    levelBottom: bottom,
    reason: null,
  };
}

const NY = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
function nyClock(t: number) {
  const p: Record<string, string> = {};
  for (const x of NY.formatToParts(new Date(t))) p[x.type] = x.value;
  return { day: `${p.year}-${p.month}-${p.day}`, min: Number(p.hour) * 60 + Number(p.minute) };
}

/** Owner 2026-11-05: SMLS inducement + ICT Setup 05 New York session reading (see header, 8–9). */
export function ictSessionReading(b: IctBar[], e: number, opts: { levelTop?: number | null; barMs: number }) {
  const top = opts.levelTop ?? null;
  const entry = b[e]!;
  // 8. Inducement: pivot lows (3/3) above the level top in the 100 bars before the entry.
  let inducementTaken: number | null = null, inducementLeft: number | null = null;
  if (top !== null) {
    inducementTaken = 0; inducementLeft = 0;
    for (const pv of pivots(b, 3, 3, "low", e)) {
      if (pv.i < e - 100 || pv.confirmedAt >= e || pv.p <= top) continue;
      if (b.slice(pv.confirmedAt + 1, e + 1).some((x) => x.low < pv.p)) inducementTaken++;
      else inducementLeft++;
    }
  }
  // 9. New York session. Bars are labelled by their open time.
  const clock = b.map((x) => nyClock(x.time));
  const inOR = (k: number) => clock[k]!.min >= 480 && clock[k]!.min < 570;
  const inTrade = (k: number) => clock[k]!.min >= 570 && clock[k]!.min < 1020;
  let start = -1; // first bar of the latest trading session up to the entry
  for (let k = e; k >= 1 && k > e - 2000; k--) if (inTrade(k) && !(inTrade(k - 1) && clock[k - 1]!.day === clock[k]!.day)) { start = k; break; }
  const out: Record<string, unknown> = { inducementTaken, inducementLeft, nyInSession: inTrade(e) };
  const confirm = top !== null ? entry.close > entry.open && entry.close > top && (entry.close - entry.low) / Math.max(entry.high - entry.low, 1e-12) >= 0.57 : null;
  out.retestConfirmCandle = confirm;
  if (start < 0) return { ...out, nyReason: "нет сессии" };
  const day = clock[start]!.day;
  const orBars = b.map((_, k) => k).filter((k) => k < start && k > start - 40 && clock[k]!.day === day && inOR(k));
  if (!orBars.length) return { ...out, nyReason: "нет диапазона 8:00–9:30 (таймфрейм крупнее)" };
  const orHigh = Math.max(...orBars.map((k) => b[k]!.high)), orLow = Math.min(...orBars.map((k) => b[k]!.low));
  let lowAt = -1, highAt = -1;
  for (let k = start; k <= e && clock[k]!.day === day && inTrade(k); k++) {
    if (lowAt < 0 && b[k]!.low < orLow) lowAt = k;
    if (highAt < 0 && b[k]!.high > orHigh) highAt = k;
  }
  const first = lowAt < 0 && highAt < 0 ? null : highAt < 0 || (lowAt >= 0 && lowAt < highAt) ? "low" : lowAt < 0 || highAt < lowAt ? "high" : "both_same_bar";
  let cisd: boolean | null = null, barsCisdToEntry: number | null = null;
  if (first === "low") {
    cisd = false;
    let level: number | null = null;
    for (let i = 1; i <= 120 && lowAt - i >= 0; i++) {
      const x = b[lowAt - i]!;
      if (x.close > x.open) { level = i > 1 ? Math.max(b[lowAt - i + 1]!.open, b[lowAt - i + 2]!.open) : b[lowAt]!.open; break; }
    }
    if (level !== null) for (let k = lowAt; k <= e && k - lowAt <= 120; k++) if (b[k]!.close >= level) { cisd = true; barsCisdToEntry = e - k; break; }
  }
  return {
    ...out,
    nyReason: null,
    nySessionHoursBeforeEntry: r2(((entry.time - b[start]!.time) / 3_600_000)),
    nyOrLowSwept: lowAt >= 0,
    nyOrHighSwept: highAt >= 0,
    nyFirstSwept: first,
    nyEntryVsOrLowPct: r2(pct(entry.close, orLow)),
    nyCisdAfterLowSweep: cisd,
    nyBarsCisdToEntry: barsCisdToEntry,
  };
}

/** Mirrors candles for a short (prices negated, high ↔ low). */
export const mirrorIct = (b: IctBar[]): IctBar[] =>
  b.map((x) => ({ time: x.time, open: -x.open, high: -x.low, low: -x.high, close: -x.close, volume: x.volume }));
