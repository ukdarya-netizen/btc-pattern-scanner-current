/**
 * Ported from CAB (lib/vsa-metrics.ts, owner 2026-11-05): the same VSA classification, pure part only.
 * Volume here = BingX volume (Nihilist has no aggregated volume history).
 */

const H1 = 3_600_000;
const BASELINE = 20;

// Thresholds are fixed up front (owner 2026-11-02) and must not be tuned
// against outcomes: spread/volume are ratios to the mean of the previous 20 1H candles.
export const VSA_THRESHOLDS = {
  wideSpread: 1.5,
  narrowSpread: 0.8,
  highVolume: 2,
  elevatedVolume: 1.5,
  lowVolume: 0.8,
  strongClose: 0.7,
} as const;

export interface VsaCandle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** aggregated CoinGlass futures volume, USD */
  volumeUsd: number | null;
  spreadRatio: number | null;
  volumeRatio: number | null;
  closePosition: number | null;
  direction: "up" | "down" | "flat";
  label: string | null;
}

export interface Ohlc {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export function classify(
  c: Pick<
    VsaCandle,
    "spreadRatio" | "volumeRatio" | "closePosition" | "direction"
  >,
): string | null {
  const { spreadRatio: s, volumeRatio: v, closePosition: p } = c;
  if (s === null || v === null || p === null) return null;
  const T = VSA_THRESHOLDS;
  if (s >= T.wideSpread && v >= T.highVolume) return "climax";
  if (v >= T.elevatedVolume && s < T.narrowSpread) return "effort_no_result";
  if (c.direction === "up" && s < T.narrowSpread && v < T.lowVolume)
    return "no_demand";
  if (c.direction === "down" && s < T.narrowSpread && v < T.lowVolume)
    return "test";
  if (c.direction === "up" && p >= T.strongClose && v >= T.elevatedVolume)
    return "demand_strong_close";
  return "neutral";
}

/** VSA reading of the candles with the given start times (ascending history required). */
export function computeVsa(
  candles: Ohlc[],
  volumes: Map<number, number> | null,
  targetTimes: number[],
): VsaCandle[] {
  const out: VsaCandle[] = [];
  for (const t of targetTimes) {
    const i = candles.findIndex((c) => c.time === t);
    if (i < 0) continue;
    const c = candles[i]!;
    const prior = candles.slice(Math.max(0, i - BASELINE), i);
    const spread = c.high - c.low;
    const avgSpread =
      prior.length === BASELINE
        ? prior.reduce((a, k) => a + (k.high - k.low), 0) / BASELINE
        : null;
    const vol = volumes?.get(t) ?? null;
    const priorVols = prior.map((k) => volumes?.get(k.time));
    const avgVol =
      prior.length === BASELINE && priorVols.every((v) => v !== undefined)
        ? (priorVols as number[]).reduce((a, v) => a + v, 0) / BASELINE
        : null;
    const base = {
      time: new Date(t).toISOString(),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volumeUsd: vol,
      spreadRatio: avgSpread && avgSpread > 0 ? spread / avgSpread : null,
      volumeRatio: vol !== null && avgVol && avgVol > 0 ? vol / avgVol : null,
      closePosition: spread > 0 ? (c.close - c.low) / spread : null,
      direction: (c.close > c.open
        ? "up"
        : c.close < c.open
          ? "down"
          : "flat") as "up" | "down" | "flat",
    };
    out.push({ ...base, label: classify(base) });
  }
  return out;
}

