import type { Candle, Interval } from "../market/bingx";
import type { FlowBar, FlowSeries } from "../market/coinglass";

export type Candles = Record<Interval, Candle[]>;

/** Every metric is `null` when its input is missing — never a substitute. */
export type Metrics = {
  price: number;
  priceChangePct: Record<"5m" | "15m" | "1h" | "4h" | "24h", number | null>;
  atrPct: Record<"5m" | "15m" | "1h", number | null>;
  volumeRatio: Record<"5m" | "15m" | "1h", number | null>;
  oiChangePct: Record<"15m" | "1h" | "4h" | "24h", number | null>;
  liqLongUsd: Record<"15m" | "1h" | "4h", number | null>;
  liqShortUsd: Record<"15m" | "1h" | "4h", number | null>;
  /** Last 1h liquidations vs the average hour of the preceding 24h. */
  liqLongSpike1h: number | null;
  liqShortSpike1h: number | null;
  futTakerNetPct: Record<"15m" | "1h", number | null>;
  spotTakerNetPct: Record<"15m" | "1h", number | null>;
  spotCvdDeltaUsd: Record<"15m" | "1h" | "4h", number | null>;
  fundingRate: number | null;
  longShortRatio: number | null;
  longShortChange1h: number | null;
  orderbookImbalancePct: number | null;
};

export type Snapshot = {
  at: number;
  candles: Candles;
  flow: FlowSeries;
  metrics: Metrics;
};

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

function volumeRatio(candles: Candle[], lookback = 20): number | null {
  if (candles.length < lookback + 1) return null;
  const last = candles[candles.length - 1]!.volume;
  const prior = candles.slice(-(lookback + 1), -1);
  const mean = prior.reduce((s, c) => s + c.volume, 0) / lookback;
  return mean > 0 ? last / mean : null;
}

function sumLast(series: FlowBar[] | null, field: string, bars: number): number | null {
  if (!series || series.length < bars) return null;
  return series.slice(-bars).reduce((s, b) => s + (b[field] ?? 0), 0);
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

function spike(series: FlowBar[] | null, field: string): number | null {
  // 15m bars: last 4 = 1h; the 96 bars before = 24h baseline.
  if (!series || series.length < 100) return null;
  const lastHour = sumLast(series, field, 4)!;
  const base = series.slice(-100, -4).reduce((s, b) => s + (b[field] ?? 0), 0) / 24;
  return base > 0 ? lastHour / base : null;
}

function delta(series: FlowBar[] | null, field: string, bars: number): number | null {
  if (!series || series.length < bars + 1) return null;
  return series[series.length - 1]![field]! - series[series.length - 1 - bars]![field]!;
}

export function computeMetrics(candles: Candles, flow: FlowSeries): Metrics {
  const c5 = candles["5m"];
  const price = c5[c5.length - 1]?.close ?? Number.NaN;
  const lastOb = flow.orderbook?.[flow.orderbook.length - 1];
  const lastLs = flow.longShort?.[flow.longShort.length - 1];
  return {
    price,
    priceChangePct: {
      "5m": round(changePct(c5, 1)),
      "15m": round(changePct(candles["15m"], 1)),
      "1h": round(changePct(candles["1h"], 1)),
      "4h": round(changePct(candles["4h"], 1)),
      "24h": round(changePct(candles["1h"], 24)),
    },
    atrPct: {
      "5m": round(atrPct(c5)),
      "15m": round(atrPct(candles["15m"])),
      "1h": round(atrPct(candles["1h"])),
    },
    volumeRatio: {
      "5m": round(volumeRatio(c5)),
      "15m": round(volumeRatio(candles["15m"])),
      "1h": round(volumeRatio(candles["1h"])),
    },
    oiChangePct: {
      "15m": round(seriesChangePct(flow.oi, "close", 1)),
      "1h": round(seriesChangePct(flow.oi, "close", 4)),
      "4h": round(seriesChangePct(flow.oi, "close", 16)),
      "24h": round(seriesChangePct(flow.oi, "close", 96)),
    },
    liqLongUsd: {
      "15m": round(sumLast(flow.liquidations, "long", 1), 0),
      "1h": round(sumLast(flow.liquidations, "long", 4), 0),
      "4h": round(sumLast(flow.liquidations, "long", 16), 0),
    },
    liqShortUsd: {
      "15m": round(sumLast(flow.liquidations, "short", 1), 0),
      "1h": round(sumLast(flow.liquidations, "short", 4), 0),
      "4h": round(sumLast(flow.liquidations, "short", 16), 0),
    },
    liqLongSpike1h: round(spike(flow.liquidations, "long")),
    liqShortSpike1h: round(spike(flow.liquidations, "short")),
    futTakerNetPct: { "15m": round(netPct(flow.futuresTaker, 1)), "1h": round(netPct(flow.futuresTaker, 4)) },
    spotTakerNetPct: { "15m": round(netPct(flow.spotTaker, 1)), "1h": round(netPct(flow.spotTaker, 4)) },
    spotCvdDeltaUsd: {
      "15m": round(delta(flow.spotCvd, "cvd", 1), 0),
      "1h": round(delta(flow.spotCvd, "cvd", 4), 0),
      "4h": round(delta(flow.spotCvd, "cvd", 16), 0),
    },
    fundingRate: round(flow.funding?.[flow.funding.length - 1]?.close ?? null, 6),
    longShortRatio: round(lastLs?.ratio ?? null),
    longShortChange1h: round(seriesChangePct(flow.longShort, "ratio", 4)),
    orderbookImbalancePct:
      lastOb && lastOb.bids! + lastOb.asks! > 0
        ? round(((lastOb.bids! - lastOb.asks!) / (lastOb.bids! + lastOb.asks!)) * 100)
        : null,
  };
}
