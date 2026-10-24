import type { Candle, Interval } from "../market/bingx";
import type { FlowBar, FlowSeries } from "../market/coinglass";

export type Candles = Record<Interval, Candle[]>;

type Tf = "15m" | "30m" | "1h" | "4h" | "24h";
type ByTf<K extends string> = Record<K, number | null>;

/**
 * Market metrics at decision time — the AltBullet set, for BTC. Every value is
 * `null` when its input is missing; nothing is substituted. Flow windows are
 * built from closed 15m CoinGlass bars (aggregated across exchanges).
 */
export type Metrics = {
  price: number;
  priceChangePct: ByTf<"5m" | "15m" | "30m" | "1h" | "3h" | "4h" | "24h">;
  atrPct: ByTf<"5m" | "15m" | "1h" | "4h">;
  /** BingX BTC-USDT candle volume: last closed candle ÷ mean of previous 20. */
  bingxVolumeMult: ByTf<"5m" | "15m" | "1h">;
  /** Aggregated futures volume (taker buy+sell) of the window ÷ mean of the same window over the prior 24h. */
  futVolumeMult: ByTf<"15m" | "1h" | "4h">;
  spotVolumeMult: ByTf<"15m" | "1h" | "4h">;
  futVolumeUsd: ByTf<"1h" | "24h">;
  spotVolumeUsd: ByTf<"1h" | "24h">;
  oiUsd: number | null;
  oiChangePct: ByTf<Tf>;
  /** Taker net buy % = (buy − sell) / (buy + sell). */
  futTakerNetPct: ByTf<Exclude<Tf, "24h">>;
  spotTakerNetPct: ByTf<Exclude<Tf, "24h">>;
  /** Futures CVD = Σ(taker buy − sell) in USD over the window. */
  futCvdUsd: ByTf<Tf>;
  /** Spot CVD change in USD over the window (CoinGlass aggregated CVD). */
  spotCvdUsd: ByTf<Tf>;
  spotCvdBullish: Record<Exclude<Tf, "24h">, boolean | null>;
  liqLongUsd: ByTf<Tf>;
  liqShortUsd: ByTf<Tf>;
  /** Last 1h liquidations ÷ average hour of the preceding 24h. */
  liqLongSpike1h: number | null;
  liqShortSpike1h: number | null;
  fundingRatePct: number | null;
  longShortRatio: number | null;
  longShortChangePct: ByTf<"1h" | "4h">;
  orderbookBidAskRatio: number | null;
  orderbookImbalancePct: number | null;
  whaleIndex: number | null;
  whaleIndexChange4h: number | null;
};

export type Snapshot = {
  at: number;
  candles: Candles;
  flow: FlowSeries;
  metrics: Metrics;
};

const BARS: Record<Tf, number> = { "15m": 1, "30m": 2, "1h": 4, "4h": 16, "24h": 96 };

const round = (v: number | null, digits = 4): number | null =>
  v === null || !Number.isFinite(v) ? null : Number(v.toFixed(digits));

function changePct(candles: Candle[], bars: number): number | null {
  if (candles.length < bars + 1) return null;
  const last = candles[candles.length - 1]!.close;
  const base = candles[candles.length - 1 - bars]!.close;
  return base > 0 ? ((last - base) / base) * 100 : null;
}

export function atrPct(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const tail = candles.slice(-(period + 1));
  let sum = 0;
  for (let i = 1; i < tail.length; i++) {
    const c = tail[i]!;
    const prev = tail[i - 1]!.close;
    sum += Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev));
  }
  const last = tail[tail.length - 1]!.close;
  return last > 0 ? (sum / period / last) * 100 : null;
}

function candleVolumeMult(candles: Candle[], lookback = 20): number | null {
  if (candles.length < lookback + 1) return null;
  const last = candles[candles.length - 1]!.volume;
  const prior = candles.slice(-(lookback + 1), -1);
  const mean = prior.reduce((s, c) => s + c.volume, 0) / lookback;
  return mean > 0 ? last / mean : null;
}

function sumLast(series: FlowBar[] | null, field: string, bars: number, skip = 0): number | null {
  if (!series || series.length < bars + skip) return null;
  const end = series.length - skip;
  return series.slice(end - bars, end).reduce((s, b) => s + (b[field] ?? 0), 0);
}

function seriesChangePct(series: FlowBar[] | null, field: string, bars: number): number | null {
  if (!series || series.length < bars + 1) return null;
  const last = series[series.length - 1]![field]!;
  const base = series[series.length - 1 - bars]![field]!;
  return base !== 0 ? ((last - base) / Math.abs(base)) * 100 : null;
}

function netPct(series: FlowBar[] | null, bars: number): number | null {
  const buy = sumLast(series, "buy", bars);
  const sell = sumLast(series, "sell", bars);
  if (buy === null || sell === null || buy + sell <= 0) return null;
  return ((buy - sell) / (buy + sell)) * 100;
}

function netUsd(series: FlowBar[] | null, bars: number): number | null {
  const buy = sumLast(series, "buy", bars);
  const sell = sumLast(series, "sell", bars);
  return buy === null || sell === null ? null : buy - sell;
}

function volumeUsd(series: FlowBar[] | null, bars: number): number | null {
  const buy = sumLast(series, "buy", bars);
  const sell = sumLast(series, "sell", bars);
  return buy === null || sell === null ? null : buy + sell;
}

/** Window volume ÷ mean of the same-size windows over the preceding 24h. */
function volumeMult(series: FlowBar[] | null, bars: number): number | null {
  if (!series || series.length < bars + 96) return null;
  const last = volumeUsd(series, bars)!;
  const prior = series.slice(-(bars + 96), -bars).reduce((s, b) => s + (b.buy ?? 0) + (b.sell ?? 0), 0);
  const mean = (prior / 96) * bars;
  return mean > 0 ? last / mean : null;
}

function spike(series: FlowBar[] | null, field: string): number | null {
  if (!series || series.length < 100) return null;
  const lastHour = sumLast(series, field, 4)!;
  const base = series.slice(-100, -4).reduce((s, b) => s + (b[field] ?? 0), 0) / 24;
  return base > 0 ? lastHour / base : null;
}

function delta(series: FlowBar[] | null, field: string, bars: number): number | null {
  if (!series || series.length < bars + 1) return null;
  return series[series.length - 1]![field]! - series[series.length - 1 - bars]![field]!;
}

const byTf = <K extends Tf>(keys: readonly K[], fn: (bars: number) => number | null, digits = 4) =>
  Object.fromEntries(keys.map((k) => [k, round(fn(BARS[k]), digits)])) as ByTf<K>;

const TFS = ["15m", "30m", "1h", "4h", "24h"] as const;
const TFS_NO_DAY = ["15m", "30m", "1h", "4h"] as const;

export function computeMetrics(candles: Candles, flow: FlowSeries): Metrics {
  const c5 = candles["5m"];
  const price = c5[c5.length - 1]?.close ?? Number.NaN;
  const lastOb = flow.orderbook?.[flow.orderbook.length - 1];
  const lastLs = flow.longShort?.[flow.longShort.length - 1];
  const lastOi = flow.oi?.[flow.oi.length - 1];
  const spotCvd = byTf(TFS, (b) => delta(flow.spotCvd, "cvd", b), 0);
  const whale = flow.whaleIndex;
  return {
    price,
    priceChangePct: {
      "5m": round(changePct(c5, 1)),
      "15m": round(changePct(candles["15m"], 1)),
      "30m": round(changePct(candles["15m"], 2)),
      "1h": round(changePct(candles["1h"], 1)),
      "3h": round(changePct(candles["1h"], 3)),
      "4h": round(changePct(candles["4h"], 1)),
      "24h": round(changePct(candles["1h"], 24)),
    },
    atrPct: {
      "5m": round(atrPct(c5)),
      "15m": round(atrPct(candles["15m"])),
      "1h": round(atrPct(candles["1h"])),
      "4h": round(atrPct(candles["4h"])),
    },
    bingxVolumeMult: {
      "5m": round(candleVolumeMult(c5)),
      "15m": round(candleVolumeMult(candles["15m"])),
      "1h": round(candleVolumeMult(candles["1h"])),
    },
    futVolumeMult: byTf(["15m", "1h", "4h"] as const, (b) => volumeMult(flow.futuresTaker, b)),
    spotVolumeMult: byTf(["15m", "1h", "4h"] as const, (b) => volumeMult(flow.spotTaker, b)),
    futVolumeUsd: byTf(["1h", "24h"] as const, (b) => volumeUsd(flow.futuresTaker, b), 0),
    spotVolumeUsd: byTf(["1h", "24h"] as const, (b) => volumeUsd(flow.spotTaker, b), 0),
    oiUsd: round(lastOi?.close ?? null, 0),
    oiChangePct: byTf(TFS, (b) => seriesChangePct(flow.oi, "close", b)),
    futTakerNetPct: byTf(TFS_NO_DAY, (b) => netPct(flow.futuresTaker, b)),
    spotTakerNetPct: byTf(TFS_NO_DAY, (b) => netPct(flow.spotTaker, b)),
    futCvdUsd: byTf(TFS, (b) => netUsd(flow.futuresTaker, b), 0),
    spotCvdUsd: spotCvd,
    spotCvdBullish: Object.fromEntries(TFS_NO_DAY.map((k) => [k, spotCvd[k] === null ? null : spotCvd[k]! > 0])) as
      Record<(typeof TFS_NO_DAY)[number], boolean | null>,
    liqLongUsd: byTf(TFS, (b) => sumLast(flow.liquidations, "long", b), 0),
    liqShortUsd: byTf(TFS, (b) => sumLast(flow.liquidations, "short", b), 0),
    liqLongSpike1h: round(spike(flow.liquidations, "long")),
    liqShortSpike1h: round(spike(flow.liquidations, "short")),
    fundingRatePct: round(flow.funding?.[flow.funding.length - 1]?.close ?? null, 6),
    longShortRatio: round(lastLs?.ratio ?? null),
    longShortChangePct: byTf(["1h", "4h"] as const, (b) => seriesChangePct(flow.longShort, "ratio", b)),
    orderbookBidAskRatio: lastOb && lastOb.asks! > 0 ? round(lastOb.bids! / lastOb.asks!) : null,
    orderbookImbalancePct:
      lastOb && lastOb.bids! + lastOb.asks! > 0
        ? round(((lastOb.bids! - lastOb.asks!) / (lastOb.bids! + lastOb.asks!)) * 100)
        : null,
    whaleIndex: round(whale?.[whale.length - 1]?.value ?? null),
    whaleIndexChange4h: whale && whale.length >= 5
      ? round(whale[whale.length - 1]!.value! - whale[whale.length - 5]!.value!)
      : null,
  };
}
