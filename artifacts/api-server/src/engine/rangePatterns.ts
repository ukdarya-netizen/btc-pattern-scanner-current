/**
 * BTC signals from the Auto Range Detector on 4h and 1d (owner's base,
 * 2026-10-25). Four setups per timeframe:
 *
 *  Breakout up / down — a confirmed range closes beyond its boundary by the
 *    indicator's buffer. Trade in the break direction. Stop: range midpoint
 *    (a close back to equilibrium means the break failed). Targets: measured
 *    move — boundary ± 1× and ± 2× range height.
 *  Deviation bull / bear — a confirmed range broke, then closed back inside
 *    within the indicator's window (failed break, liquidity sweep). Trade back
 *    into the range. Stop: beyond the swept extreme by 0.15 ATR. Targets: range
 *    midpoint, then the opposite boundary.
 *
 * Every signal also needs volume and flow in the trade direction on the same
 * bar (owner requirement). Missing data = no signal.
 */
import type { Candle } from "../market/bingx";
import type { Direction, ProfileKey } from "../config/profiles";
import type { Pattern, PatternResult } from "./patterns";
import type { Snapshot } from "./snapshot";
import { replayRanges, type RangeEvent, type RangeEventKind } from "./rangeDetector";

export type Setup = "breakout" | "deviation";

/** Volume confirmation thresholds (candle volume ÷ mean of the previous 20 bars). */
export const VOLUME_MULT_MIN: Record<Setup, number> = { breakout: 1.5, deviation: 1.2 };
/** Bars of history replayed so ATR(200) and the 500-bar calibration are filled. */
export const HISTORY_BARS = 1000;

const TF: Record<ProfileKey, "4h" | "1d"> = { h4: "4h", d1: "1d" };
/** Aggregated flow window matching one bar of the timeframe. */
const FLOW_WINDOW: Record<ProfileKey, "4h" | "24h"> = { h4: "4h", d1: "24h" };

function eventKind(setup: Setup, direction: Direction): RangeEventKind {
  if (setup === "breakout") return direction === "long" ? "breakout_up" : "breakout_down";
  return direction === "long" ? "deviation_bull" : "deviation_bear";
}

// All four setups of a timeframe share one replay of the same candle array.
const replayCache = new WeakMap<Candle[], ReturnType<typeof replayRanges>>();
function cachedReplay(candles: Candle[]) {
  let replay = replayCache.get(candles);
  if (!replay) {
    replay = replayRanges(candles);
    replayCache.set(candles, replay);
  }
  return replay;
}

export function volumeMultiple(candles: Candle[], lookback = 20): number | null {
  if (candles.length < lookback + 1) return null;
  const last = candles[candles.length - 1]!.volume;
  const mean = candles.slice(-(lookback + 1), -1).reduce((s, c) => s + c.volume, 0) / lookback;
  return Number.isFinite(last) && mean > 0 ? last / mean : null;
}

export function levelsFor(event: RangeEvent, setup: Setup, direction: Direction):
  { stop: number; targets: { price: number; fraction: number }[] } {
  const { top, bottom } = event.range;
  const height = top - bottom;
  const mid = (top + bottom) / 2;
  if (setup === "breakout") {
    return direction === "long"
      ? { stop: mid, targets: [{ price: top + height, fraction: 0.5 }, { price: top + 2 * height, fraction: 0.5 }] }
      : { stop: mid, targets: [{ price: bottom - height, fraction: 0.5 }, { price: bottom - 2 * height, fraction: 0.5 }] };
  }
  const buffer = 0.15 * event.atr;
  return direction === "long"
    ? { stop: event.sweepPrice! - buffer, targets: [{ price: mid, fraction: 0.5 }, { price: top, fraction: 0.5 }] }
    : { stop: event.sweepPrice! + buffer, targets: [{ price: mid, fraction: 0.5 }, { price: bottom, fraction: 0.5 }] };
}

export function evaluateRangeSetup(
  snapshot: Snapshot, profile: ProfileKey, setup: Setup, direction: Direction,
): PatternResult {
  const candles = snapshot.candles[TF[profile]];
  if (candles.length < 300) return { fires: false, reasons: ["history:no_data"] };
  const replay = cachedReplay(candles);
  const lastIndex = candles.length - 1;
  const event = replay.events.find((e) => e.index === lastIndex && e.kind === eventKind(setup, direction));
  const range = replay.active ?? replay.dormant;
  const base = {
    timeframe: TF[profile], setup,
    rangeActive: replay.active ? {
      top: replay.active.top, bottom: replay.active.bottom,
      bars: lastIndex - replay.active.leftIndex + 1, confirmed: replay.active.confirmed,
    } : null,
    rangeDormant: replay.dormant ? { ...replay.dormant } : null,
  };
  if (!event) {
    return { fires: false, reasons: [range ? "no_event_on_this_bar" : "no_range"], detail: base };
  }

  const volumeMult = volumeMultiple(candles);
  const window = FLOW_WINDOW[profile];
  const m = snapshot.metrics;
  const futCvd = m.futCvdUsd[window];
  const spotCvd = m.spotCvdUsd[window];
  const futTaker = window === "4h" ? m.futTakerNetPct["4h"] : null;
  const spotTaker = window === "4h" ? m.spotTakerNetPct["4h"] : null;
  const s = direction === "long" ? 1 : -1;
  const inDirection = (v: number | null) => (v === null ? null : v * s > 0);

  const conditions: Array<[string, boolean | null]> = [
    [`volume>=${VOLUME_MULT_MIN[setup]}x`, volumeMult === null ? null : volumeMult >= VOLUME_MULT_MIN[setup]],
    [`fut_cvd_${window}_${direction}`, inDirection(futCvd)],
  ];
  // A breakout must be carried by spot as well; a deviation is a rejection,
  // where futures flow turning is the earliest confirmation.
  if (setup === "breakout") conditions.push([`spot_cvd_${window}_${direction}`, inDirection(spotCvd)]);
  const reasons = conditions.filter(([, ok]) => ok !== true)
    .map(([name, ok]) => (ok === null ? `${name}:no_data` : name));

  const levels = levelsFor(event, setup, direction);
  const detail = {
    ...base,
    event: {
      kind: event.kind, top: event.range.top, bottom: event.range.bottom,
      heightPct: Number(event.range.heightPct.toFixed(3)), bars: event.range.bars,
      sweepPrice: event.sweepPrice, atr: event.atr,
    },
    volumeMult: volumeMult === null ? null : Number(volumeMult.toFixed(3)),
    flowWindow: window, futCvdUsd: futCvd, spotCvdUsd: spotCvd,
    futTakerNetPct: futTaker, spotTakerNetPct: spotTaker,
    levels,
  };
  return reasons.length
    ? { fires: false, reasons, detail }
    : { fires: true, reasons: ["ok"], levels, detail };
}

const LABEL: Record<Setup, Record<Direction, string>> = {
  breakout: { long: "Пробой диапазона вверх", short: "Пробой диапазона вниз" },
  deviation: { long: "Девиация: ложный пробой вниз", short: "Девиация: ложный пробой вверх" },
};

export const RANGE_PATTERNS: Pattern[] = (["h4", "d1"] as const).flatMap((profile) =>
  (["breakout", "deviation"] as const).flatMap((setup) =>
    (["long", "short"] as const).map((direction): Pattern => ({
      key: `${profile}_${setup}_${direction}`,
      label: `${LABEL[setup][direction]} · ${profile === "h4" ? "4h" : "1D"}`,
      direction,
      profile,
      live: true,
      evaluate: (snapshot) => evaluateRangeSetup(snapshot, profile, setup, direction),
    }))));
