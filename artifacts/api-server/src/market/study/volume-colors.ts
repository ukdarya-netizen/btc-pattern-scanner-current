/**
 * Ported from CAB (lib/entry-volume-colors.ts, owner 2026-11-05): the owner's TradingView indicators
 * one to one — «VSA Wyckoff Volume» (Wilder MA 20; P ≥2.2, R ≥1.8, O ≥1.2, G ≥0.8, B ≥0.4, S) and
 * «Welkin VSA» (SMA20 ± σ; W >4σ, M >3σ, O >2σ, A > avg, Y ≥1.25× previous, N grey) — on the 48 hourly
 * bars before the entry, with each bar's candle (U/D) and close position. Pure.
 */
const H1 = 3_600_000;
const WINDOW = 48;
export const COLOR_RATIOS = { ultra: 2.2, veryHigh: 1.8, high: 1.2, normal: 0.8, low: 0.4 } as const;

export function colorOf(ratio: number): string {
  const r = COLOR_RATIOS;
  return ratio >= r.ultra ? "P" : ratio >= r.veryHigh ? "R" : ratio >= r.high ? "O" : ratio >= r.normal ? "G" : ratio >= r.low ? "B" : "S";
}

/**
 * Pure: colours of the window. `bars` = consecutive 1H bars (ascending) from the start of the
 * available history up to and including the entry candle; `vol(t)` = volume of the bar or null.
 */
type Bar = { open: number; high: number; low: number; close: number };
/** Candle letter: U green (close > open), D red, F flat. */
const dirOf = (b: Bar | undefined) => (!b ? "-" : b.close > b.open ? "U" : b.close < b.open ? "D" : "F");
/** Close position in the bar: 0 = at the low, 1 = at the high. */
const closePos = (b: Bar | undefined) => (b && b.high > b.low ? (b.close - b.low) / (b.high - b.low) : null);

/**
 * Owner's «Welkin VSA» (TradingView, Pine v5), one to one: SMA(20) and population stdev(20) of the
 * volume INCLUDING the current bar; colour of a bar:
 *   > avg+4σ white (W) · > avg+3σ magenta (M) · > avg+2σ orange (O) · > avg blue (A)
 *   · else volume ≥ 1.25 × previous bar yellow (Y) · else below average grey (N)
 *   · else (volume exactly at the average) plain candle (=).
 * Grey = «пустой» bar; anything else is not empty.
 */
export function welkinColor(vols: number[], i: number): string | null {
  if (i < 19) return null;
  const w = vols.slice(i - 19, i + 1);
  const avg = w.reduce((a, b) => a + b, 0) / 20;
  const sd = Math.sqrt(w.reduce((a, b) => a + (b - avg) ** 2, 0) / 20);
  const v = vols[i]!;
  if (v > avg + 4 * sd) return "W";
  if (v > avg + 3 * sd) return "M";
  if (v > avg + 2 * sd) return "O";
  if (v > avg) return "A";
  const prev = i > 0 ? vols[i - 1]! : 0;
  if (prev > 0 && v / prev >= 1.25) return "Y";
  if (v < avg) return "N";
  return "=";
}

export function colorWindow(barTimes: number[], vol: (t: number) => number | null, entry: number, candle: (t: number) => Bar | undefined = () => undefined) {
  let ma = 0;
  const ratio = new Map<number, number>();
  for (const t of barTimes) {
    const v = vol(t);
    if (v === null) return null; // a hole in the volume history — the MA would differ from the chart
    ma = ma + (v - ma) / 20;
    ratio.set(t, ma > 0 ? v / ma : 0);
  }
  const entryRatio = ratio.get(entry);
  if (entryRatio === undefined) return null;
  const before: string[] = [];
  for (let k = WINDOW; k >= 1; k--) {
    const r = ratio.get(entry - k * H1);
    before.push(r === undefined ? "-" : colorOf(r));
  }
  // Owner 2026-11-04 (VSA proper): which candle carried the volume. Same 48 bars, BingX price.
  const bars = Array.from({ length: WINDOW }, (_, i) => candle(entry - (WINDOW - i) * H1));
  const dirs = bars.map(dirOf);
  // Welkin colours of the same 48 bars and of the entry candle.
  const vols = barTimes.map((t) => vol(t)!);
  const idx = new Map(barTimes.map((t, i) => [t, i]));
  const welkinAt = (t: number) => { const i = idx.get(t); return i === undefined ? "-" : (welkinColor(vols, i) ?? "-"); };
  const welkin = Array.from({ length: WINDOW }, (_, i) => welkinAt(entry - (WINDOW - i) * H1));
  const notGrey = (n: number) => welkin.slice(-n).filter((c) => c !== "N" && c !== "-").length;
  const welkinCounts = (n: number) => {
    const w = welkin.slice(-n);
    const c = (x: string) => w.filter((y) => y === x).length;
    return { W: c("W"), M: c("M"), O: c("O"), A: c("A"), Y: c("Y"), N: c("N"), notGrey: notGrey(n) };
  };
  const last = (n: number) => before.slice(-n);
  const colored = (c: string) => c === "P" || c === "R" || c === "O";
  /** Counts over the last n bars of coloured (P/R/O) bars by candle type. */
  const vsaCounts = (n: number) => {
    let up = 0, down = 0, downStopping = 0, closeNearLow = 0, upCloseNearHigh = 0;
    for (let i = WINDOW - n; i < WINDOW; i++) {
      if (!colored(before[i]!)) continue;
      const d = dirs[i], p = closePos(bars[i]);
      if (d === "U") up++;
      if (d === "D") down++;
      // stopping volume: red bar on high volume that closed in the upper half (buyers absorbed the selling)
      if (d === "D" && p !== null && p >= 0.5) downStopping++;
      // weakness: high volume bar that closed in the lower third (sellers on top)
      if (p !== null && p <= 0.33) closeNearLow++;
      // strength: green bar on high volume closing in the upper third
      if (d === "U" && p !== null && p >= 0.67) upCloseNearHigh++;
    }
    return { up, down, downStopping, closeNearLow, upCloseNearHigh };
  };
  const count = (arr: string[], c: string) => arr.filter((x) => x === c).length;
  const sinceLast = (set: string) => { for (let k = 1; k <= WINDOW; k++) if (set.includes(before[WINDOW - k]!)) return k; return null; };
  const out: Record<string, unknown> = {
    entryColor: colorOf(entryRatio),
    entryRatio: Math.round(entryRatio * 100) / 100,
    /** 48 bars before the entry candle, oldest → newest (the last letter = the bar right before the entry). */
    colors48: before.join(""),
    /** Candle of each of the same 48 bars: U green, D red, F flat (BingX price). */
    candles48: dirs.join(""),
    /** Volume colour + candle, e.g. «Pd» = purple on a red candle, «Ou» = orange on a green one. */
    colorCandle48: before.map((c, i) => c + (dirs[i] === "-" ? "-" : dirs[i]!.toLowerCase())).join(" "),
    historyBars: barTimes.length,
    hoursSincePurple: sinceLast("P"),
    hoursSinceRedOrPurple: sinceLast("PR"),
    hoursSinceOrangeOrHigher: sinceLast("PRO"),
  };
  for (const n of [6, 12, 24, 48]) {
    const w = last(n);
    out[`last${n}h`] = { P: count(w, "P"), R: count(w, "R"), O: count(w, "O"), G: count(w, "G"), B: count(w, "B"), S: count(w, "S"), colored: count(w, "P") + count(w, "R") + count(w, "O"), ...vsaCounts(n) };
  }
  out.welkinEntry = welkinAt(entry);
  /** Welkin colours of the 48 bars before the entry, oldest → newest (N = grey / empty). */
  out.welkin48 = welkin.join("");
  for (const n of [3, 6, 12, 24, 48]) out[`welkin${n}h`] = welkinCounts(n);
  /** Hours from the last grey bar back to the entry: how many non-empty bars in a row right before it. */
  let run = 0;
  for (let k = WINDOW - 1; k >= 0 && welkin[k] !== "N" && welkin[k] !== "-"; k--) run++;
  out.welkinNonGreyRunBeforeEntry = run;
  const e = candle(entry);
  out.entryCandle = dirOf(e);
  out.entryClosePos = closePos(e) === null ? null : Math.round(closePos(e)! * 100) / 100;
  return out;
}

