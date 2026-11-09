/** Ported from CAB (lib/wyckoff-metrics.ts, owner 2026-11-05), unchanged rules. */
import { computeVsa, type Ohlc, type VsaCandle } from "./vsa-cab";

const H1 = 3_600_000;
export const WYCKOFF_WINDOW = 48;
const LEVEL_LOOKBACK = 20;
const SPRING_RECOVERY_BARS = 3;
const SC_BOTTOM_ZONE = 0.1;
const SOS_SPREAD = 1.5;
const SOS_VOLUME = 1.5;
const LPS_MAX_VOLUME = 0.8;

// Rules are fixed up front (owner 2026-11-02) and are not tuned against
// outcomes. Observation only; all events are detected on closed 1H candles.
export interface WyckoffEvent {
  type:
    | "selling_climax"
    | "spring"
    | "sign_of_strength"
    | "last_point_of_support";
  time: string;
  level: number | null;
}

export interface WyckoffReading {
  entryCandle: string;
  windowBars: number;
  rangeTop: number | null;
  rangeBottom: number | null;
  rangeHeightPct: number | null;
  /** (entry close - bottom) / (top - bottom) */
  entryPositionInRange: number | null;
  events: WyckoffEvent[];
  phase:
    | "accumulation_then_markup"
    | "accumulation"
    | "breakout_without_base"
    | "none"
    | "insufficient_history";
}

export function computeWyckoff(
  candles: Ohlc[],
  volumes: Map<number, number> | null,
  entryCandleTime: number,
): WyckoffReading {
  const entryIdx = candles.findIndex((c) => c.time === entryCandleTime);
  const base = {
    entryCandle: new Date(entryCandleTime).toISOString(),
    windowBars: 0,
    rangeTop: null,
    rangeBottom: null,
    rangeHeightPct: null,
    entryPositionInRange: null,
    events: [] as WyckoffEvent[],
  };
  if (entryIdx < LEVEL_LOOKBACK + 20)
    return { ...base, phase: "insufficient_history" };
  const start = Math.max(0, entryIdx - WYCKOFF_WINDOW);
  const win = candles.slice(start, entryIdx + 1);
  const vsa = new Map<number, VsaCandle>();
  for (const v of computeVsa(
    candles,
    volumes,
    win.map((c) => c.time),
  ))
    vsa.set(Date.parse(v.time), v);
  const top = Math.max(...win.map((c) => c.high));
  const bottom = Math.min(...win.map((c) => c.low));
  const height = top - bottom;
  const entry = candles[entryIdx]!;
  const events: WyckoffEvent[] = [];
  const iso = (t: number) => new Date(t).toISOString();
  for (let i = start; i <= entryIdx; i++) {
    const c = candles[i]!;
    const v = vsa.get(c.time);
    const prior = candles.slice(Math.max(0, i - LEVEL_LOOKBACK), i);
    if (prior.length < LEVEL_LOOKBACK) continue;
    const support = Math.min(...prior.map((k) => k.low));
    const resistance = Math.max(...prior.map((k) => k.high));
    if (
      v?.label === "climax" &&
      (v.closePosition ?? 0) >= 0.5 &&
      c.low <= bottom + SC_BOTTOM_ZONE * height
    )
      events.push({ type: "selling_climax", time: iso(c.time), level: c.low });
    if (c.low < support) {
      const recovered = candles
        .slice(i, i + SPRING_RECOVERY_BARS + 1)
        .filter((k) => k.time <= entry.time)
        .some((k) => k.close > support);
      if (recovered)
        events.push({ type: "spring", time: iso(c.time), level: support });
    }
    if (
      c.close > resistance &&
      (v?.spreadRatio ?? 0) >= SOS_SPREAD &&
      (v?.volumeRatio ?? 0) >= SOS_VOLUME
    )
      events.push({
        type: "sign_of_strength",
        time: iso(c.time),
        level: resistance,
      });
  }
  const sos = events.filter((e) => e.type === "sign_of_strength");
  const firstSos = sos[0];
  if (firstSos) {
    const sosLevel = firstSos.level ?? 0;
    for (const c of candles.slice(0, entryIdx + 1)) {
      if (c.time <= Date.parse(firstSos.time)) continue;
      const v = vsa.get(c.time);
      if (
        v &&
        v.direction === "down" &&
        (v.volumeRatio ?? 99) < LPS_MAX_VOLUME &&
        c.low >= sosLevel
      )
        events.push({
          type: "last_point_of_support",
          time: iso(c.time),
          level: sosLevel,
        });
    }
  }
  const early = events.filter(
    (e) => e.type === "selling_climax" || e.type === "spring",
  );
  const phase: WyckoffReading["phase"] =
    firstSos && early.some((e) => e.time < firstSos.time)
      ? "accumulation_then_markup"
      : firstSos
        ? "breakout_without_base"
        : early.length > 0
          ? "accumulation"
          : "none";
  return {
    ...base,
    windowBars: win.length,
    rangeTop: top,
    rangeBottom: bottom,
    rangeHeightPct: bottom > 0 ? (height / bottom) * 100 : null,
    entryPositionInRange: height > 0 ? (entry.close - bottom) / height : null,
    events,
    phase,
  };
}
