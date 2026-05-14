import { aggregator } from "./exchanges/aggregator";
import { cvdService } from "./cvd";
import { candleService } from "./candleService";
import { patternService } from "./patternService";
import { fractalService, FRACTAL_MIN_SIGNAL_SCORE } from "./fractalService";
import type { FractalSignal } from "./fractalService";
import { coinalyzeService } from "./coinalyzeService";
import { coinglassService } from "./coinglassService";
import type { LiqHeatmapBucket } from "./coinglassService";
import type { LiqMapBucket } from "./coinalyzeService";
import { telegramService } from "./telegram";
import { checkWhaleActivity } from "./whaleTrackerService";
import { checkImbalance } from "./orderbookService";

export interface SignalComponent {
  name: string;
  score: number;
  weight: number;
  description: string;
}

export interface GateResult {
  name: string;
  passed: boolean;
  reason: string;
}

export interface SignalResult {
  score: number;
  direction: "long" | "short" | "neutral";
  confidence: number;
  components: SignalComponent[];
  gates: GateResult[];
  allGatesPassed: boolean;
  suggestedLeverage: number;
  suggestedSl: number;
  suggestedTp: number;
  slValid: boolean;
  tpValid: boolean;
  atrPct: number;
  vwap: number;
  updatedAt: string;
  tpSource?: string;
  slSource?: string;
  fractalSignal?: FractalSignal;
}

// Unified bucket type for SL/TP logic
type Bucket = { price: number; longLiqUsd: number; shortLiqUsd: number; totalUsd: number };

// ─── Constants ───────────────────────────────────────────────
const MIN_SL_CLUSTER_USD  = 10_000_000;

// Debug gate notifications — rate-limited to avoid flooding the channel
let lastGateDebugTs = 0;
const GATE_DEBUG_INTERVAL_MS = 5 * 60 * 1000; // max once per 5 min
const MAX_SL_RANGE_PCT    = 0.04;
const MIN_SL_DISTANCE_PCT = 0.004;
const MAX_SL_DISTANCE_PCT = 0.025;
const SL_CLUSTER_BUFFER   = 0.0008;

const MIN_TP_CLUSTER_USD  = 7_000_000;
const MAX_TP_RANGE_PCT    = 0.08;
const MIN_TP_DISTANCE_PCT = 0.015;
const MIN_RR_RATIO        = 1.2;
const TP_CLUSTER_BUFFER   = 0.001;

function clamp(val: number, min = -1, max = 1): number {
  return Math.max(min, Math.min(max, val));
}

// ─── Merge liq buckets from coinglass (primary) or coinalyze (fallback) ──────
function getLiqBuckets(): Bucket[] {
  const cgHeatmap = coinglassService.getCachedHeatmap();
  if (cgHeatmap && cgHeatmap.buckets.length > 0) {
    return cgHeatmap.buckets;
  }
  const caMap = coinalyzeService.getCachedMap();
  if (caMap && caMap.buckets.length > 0) {
    return caMap.buckets.map((b: LiqMapBucket): Bucket => ({
      price: b.price,
      longLiqUsd: b.longLiqUsd,
      shortLiqUsd: b.shortLiqUsd,
      totalUsd: b.totalUsd,
    }));
  }
  return [];
}

// ─── SL from cluster ──────────────────────────────────────────
interface SlResult {
  price: number;
  source: string;
  valid: boolean;
  clusterUsd: number;
  distancePct: number;
}

function calcSlFromLiqMap(
  direction: "long" | "short",
  price: number,
  buckets: Bucket[]
): SlResult {
  const invalid: SlResult = { price: 0, source: "нет кластера", valid: false, clusterUsd: 0, distancePct: 0 };
  if (buckets.length === 0) return invalid;

  if (direction === "long") {
    // Nearest long liq cluster BELOW price (cascade danger for longs)
    const candidates = buckets
      .filter(b =>
        b.price < price &&
        b.price >= price * (1 - MAX_SL_RANGE_PCT) &&
        b.longLiqUsd >= MIN_SL_CLUSTER_USD
      )
      .sort((a, b) => b.price - a.price); // closest first

    const cluster = candidates[0];
    if (!cluster) return invalid;

    // Exit just ABOVE the cluster to avoid cascade
    const slPrice = cluster.price * (1 + SL_CLUSTER_BUFFER);
    const distancePct = (price - slPrice) / price;

    if (distancePct < MIN_SL_DISTANCE_PCT) {
      return { price: slPrice, source: "кластер слишком близко", valid: false, clusterUsd: cluster.longLiqUsd, distancePct };
    }
    if (distancePct > MAX_SL_DISTANCE_PCT) {
      return { price: slPrice, source: "кластер слишком далеко", valid: false, clusterUsd: cluster.longLiqUsd, distancePct };
    }

    return {
      price: parseFloat(slPrice.toFixed(2)),
      source: `Над кластером лонгов $${cluster.price.toFixed(0)} (${(cluster.longLiqUsd / 1e6).toFixed(1)}M) — до каскада`,
      valid: true,
      clusterUsd: cluster.longLiqUsd,
      distancePct,
    };

  } else {
    // Nearest short liq cluster ABOVE price (cascade danger for shorts)
    const candidates = buckets
      .filter(b =>
        b.price > price &&
        b.price <= price * (1 + MAX_SL_RANGE_PCT) &&
        b.shortLiqUsd >= MIN_SL_CLUSTER_USD
      )
      .sort((a, b) => a.price - b.price); // closest first

    const cluster = candidates[0];
    if (!cluster) return invalid;

    // Exit just BELOW the cluster
    const slPrice = cluster.price * (1 - SL_CLUSTER_BUFFER);
    const distancePct = (slPrice - price) / price;

    if (distancePct < MIN_SL_DISTANCE_PCT) {
      return { price: slPrice, source: "кластер слишком близко", valid: false, clusterUsd: cluster.shortLiqUsd, distancePct };
    }
    if (distancePct > MAX_SL_DISTANCE_PCT) {
      return { price: slPrice, source: "кластер слишком далеко", valid: false, clusterUsd: cluster.shortLiqUsd, distancePct };
    }

    return {
      price: parseFloat(slPrice.toFixed(2)),
      source: `Под кластером шортов $${cluster.price.toFixed(0)} (${(cluster.shortLiqUsd / 1e6).toFixed(1)}M) — до каскада`,
      valid: true,
      clusterUsd: cluster.shortLiqUsd,
      distancePct,
    };
  }
}

// ─── TP from cluster ──────────────────────────────────────────
interface TpResult {
  price: number;
  source: string;
  valid: boolean;
  clusterUsd: number;
  distancePct: number;
  rr: number;
}

function calcTpFromLiqMap(
  direction: "long" | "short",
  price: number,
  buckets: Bucket[],
  slDistancePct: number
): TpResult {
  const invalid: TpResult = { price: 0, source: "нет кластера", valid: false, clusterUsd: 0, distancePct: 0, rr: 0 };
  if (buckets.length === 0 || slDistancePct <= 0) return invalid;

  if (direction === "long") {
    // Short liq cluster ABOVE price = upside magnet (shorts squeezed = price drawn up)
    const candidates = buckets
      .filter(b =>
        b.price > price &&
        b.price <= price * (1 + MAX_TP_RANGE_PCT) &&
        b.shortLiqUsd >= MIN_TP_CLUSTER_USD
      )
      .sort((a, b) => a.price - b.price); // closest first

    const cluster = candidates[0];
    if (!cluster) return invalid;

    // Take profit just BELOW cluster (before shorts close and movement stalls)
    const tpPrice = cluster.price * (1 - TP_CLUSTER_BUFFER);
    const distancePct = (tpPrice - price) / price;
    const rr = distancePct / slDistancePct;

    if (distancePct < MIN_TP_DISTANCE_PCT) {
      return { price: tpPrice, source: "TP кластер слишком близко", valid: false, clusterUsd: cluster.shortLiqUsd, distancePct, rr };
    }
    if (rr < MIN_RR_RATIO) {
      return {
        price: tpPrice,
        source: `R:R ${rr.toFixed(2)} < ${MIN_RR_RATIO} (недостаточно)`,
        valid: false, clusterUsd: cluster.shortLiqUsd, distancePct, rr,
      };
    }

    return {
      price: parseFloat(tpPrice.toFixed(2)),
      source: `Кластер шортов $${cluster.price.toFixed(0)} (${(cluster.shortLiqUsd / 1e6).toFixed(1)}M) | R:R ${rr.toFixed(2)}`,
      valid: true,
      clusterUsd: cluster.shortLiqUsd,
      distancePct,
      rr,
    };

  } else {
    // Long liq cluster BELOW price = downside magnet (longs stopped out = price drawn down)
    const candidates = buckets
      .filter(b =>
        b.price < price &&
        b.price >= price * (1 - MAX_TP_RANGE_PCT) &&
        b.longLiqUsd >= MIN_TP_CLUSTER_USD
      )
      .sort((a, b) => b.price - a.price); // closest first

    const cluster = candidates[0];
    if (!cluster) return invalid;

    // Take profit just ABOVE cluster
    const tpPrice = cluster.price * (1 + TP_CLUSTER_BUFFER);
    const distancePct = (price - tpPrice) / price;
    const rr = distancePct / slDistancePct;

    if (distancePct < MIN_TP_DISTANCE_PCT) {
      return { price: tpPrice, source: "TP кластер слишком близко", valid: false, clusterUsd: cluster.longLiqUsd, distancePct, rr };
    }
    if (rr < MIN_RR_RATIO) {
      return {
        price: tpPrice,
        source: `R:R ${rr.toFixed(2)} < ${MIN_RR_RATIO} (недостаточно)`,
        valid: false, clusterUsd: cluster.longLiqUsd, distancePct, rr,
      };
    }

    return {
      price: parseFloat(tpPrice.toFixed(2)),
      source: `Кластер лонгов $${cluster.price.toFixed(0)} (${(cluster.longLiqUsd / 1e6).toFixed(1)}M) | R:R ${rr.toFixed(2)}`,
      valid: true,
      clusterUsd: cluster.longLiqUsd,
      distancePct,
      rr,
    };
  }
}

// ─── Funding analysis ─────────────────────────────────────────
interface FundingAnalysis {
  extreme: boolean;
  bias: "long_crowded" | "short_crowded" | "normal";
  contrarian: "short" | "long" | "none";
  scoreModifier: number; // multiplier for signal score
}

function analyzeFunding(rate: number): FundingAnalysis {
  if (rate > 0.001) {
    return { extreme: true, bias: "long_crowded", contrarian: "short", scoreModifier: 1.0 };
  }
  if (rate > 0.0005) {
    return { extreme: false, bias: "long_crowded", contrarian: "short", scoreModifier: 1.0 };
  }
  if (rate < -0.001) {
    return { extreme: true, bias: "short_crowded", contrarian: "long", scoreModifier: 1.0 };
  }
  if (rate < -0.0002) {
    return { extreme: false, bias: "short_crowded", contrarian: "long", scoreModifier: 1.0 };
  }
  return { extreme: false, bias: "normal", contrarian: "none", scoreModifier: 1.0 };
}

function applyFundingModifier(score: number, funding: FundingAnalysis, direction: "long" | "short" | "neutral"): number {
  if (!funding.extreme || direction === "neutral") return score;

  const withCrowd =
    (funding.bias === "long_crowded"  && direction === "long") ||
    (funding.bias === "short_crowded" && direction === "short");

  if (withCrowd) {
    return score * 0.7; // going with the crowded side = risky
  } else {
    return score * 1.2; // contrarian = smart money alignment
  }
}

// ─── Signal components ────────────────────────────────────────

function calcMtfCvdSignal(): SignalComponent {
  const alignment = cvdService.getAlignment();
  return {
    name: "MTF CVD (1m/5m/15m)",
    score: alignment.score,
    weight: 0.30,
    description: `${alignment.description} | strong: ${alignment.strong} | trend: ${alignment.trend}`,
  };
}

function calcCvdSignal(): SignalComponent {
  const points = cvdService.getPoints();
  const trend = cvdService.getTrend();
  let score = 0;
  if (trend === "bullish") score = 0.6;
  else if (trend === "bearish") score = -0.6;

  if (points.length >= 5) {
    const recent = points.slice(-5);
    const avg = recent.reduce((s, p) => s + p.delta, 0) / recent.length;
    const magnitude = clamp(avg / 5, -0.4, 0.4);
    score = clamp(score + magnitude);
  }

  return {
    name: "CVD Trend",
    score,
    weight: 0.15,
    description: `Trend: ${trend}, CVD: ${cvdService.getCurrentCvd().toFixed(2)}`,
  };
}

function calcOrderbookImbalance(): SignalComponent {
  const ob = aggregator.getAggregatedOrderbook();
  if (!ob) return { name: "Order Book Imbalance", score: 0, weight: 0.20, description: "No data" };

  const bidVol = ob.mergedBids.slice(0, 10).reduce((s, l) => s + l.size, 0);
  const askVol = ob.mergedAsks.slice(0, 10).reduce((s, l) => s + l.size, 0);
  const total = bidVol + askVol;
  const score = total > 0 ? clamp((bidVol - askVol) / total * 3) : 0;

  const exchanges = Object.keys(ob.byExchange).join(", ");
  return {
    name: "Order Book Imbalance",
    score,
    weight: 0.20,
    description: `Bid: ${bidVol.toFixed(2)} BTC vs Ask: ${askVol.toFixed(2)} BTC (${exchanges})`,
  };
}

function calcMomentumSignal(): SignalComponent {
  const trades = aggregator.getAllTrades().slice(0, 60);
  if (trades.length === 0) return { name: "Trade Momentum", score: 0, weight: 0.13, description: "No data" };

  const exchanges = [...new Set(trades.map(t => t.exchange))].join("+");
  const buyVol = trades.filter(t => t.side === "buy").reduce((s, t) => s + t.size, 0);
  const sellVol = trades.filter(t => t.side === "sell").reduce((s, t) => s + t.size, 0);
  const total = buyVol + sellVol;
  const score = total > 0 ? clamp((buyVol - sellVol) / total * 2) : 0;

  return {
    name: "Trade Momentum",
    score,
    weight: 0.13,
    description: `Buy: ${buyVol.toFixed(2)} BTC vs Sell: ${sellVol.toFixed(2)} BTC (${exchanges}, last 60 trades)`,
  };
}

function calcVwapSignal(): SignalComponent {
  const price = aggregator.getPrimaryPrice();
  const vwap = candleService.getVwap();
  const atr = candleService.getAtr();

  if (vwap === 0 || price === 0) {
    return { name: "VWAP Deviation", score: 0, weight: 0.10, description: "Accumulating VWAP data..." };
  }

  const deviation = (price - vwap) / vwap;
  const score = clamp(deviation / 0.004 * 0.8);
  const sigma = atr > 0 ? Math.abs(price - vwap) / atr : 0;
  const direction = deviation >= 0 ? "above" : "below";
  const urgency = sigma > 2 ? " — extreme, mean reversion likely" : sigma > 1 ? " — extended" : "";

  return {
    name: "VWAP Deviation",
    score,
    weight: 0.10,
    description: `$${price.toFixed(1)} ${direction} VWAP $${vwap.toFixed(1)} by ${(Math.abs(deviation) * 100).toFixed(3)}% (${sigma.toFixed(1)}σ)${urgency}`,
  };
}

function calcEmaSignal(): SignalComponent {
  const ema9 = candleService.getEma(9);
  const ema21 = candleService.getEma(21);
  const price = aggregator.getPrimaryPrice();
  const candleCount = candleService.getCandleCount();

  if (ema9 === 0 || ema21 === 0 || candleCount < 5) {
    return { name: "EMA 9/21", score: 0, weight: 0.07, description: `Building candle history... (${candleCount} candles)` };
  }

  let score = 0;
  if (ema9 > ema21) score = 0.5;
  else if (ema9 < ema21) score = -0.5;
  if (price > ema9 && score > 0) score = clamp(score + 0.3);
  if (price < ema9 && score < 0) score = clamp(score - 0.3);

  const crossLabel = ema9 > ema21 ? "Bullish (9>21)" : "Bearish (9<21)";
  const priceVsEma = price > ema9 ? "Price above EMA9" : "Price below EMA9";

  return {
    name: "EMA 9/21",
    score: clamp(score),
    weight: 0.07,
    description: `${crossLabel} | ${priceVsEma} | EMA9: $${ema9.toFixed(1)} EMA21: $${ema21.toFixed(1)}`,
  };
}

function calcLiquidationSignal(): SignalComponent {
  const candles = coinalyzeService.getLatest2hCandles();

  if (candles.length < 6) {
    return {
      name: "Ликвидации (Coinalyze)",
      score: 0,
      weight: 0.05,
      description: coinalyzeService.isReady() ? "Недостаточно данных" : "Загрузка...",
    };
  }

  const recent = candles.slice(-2);
  const baseline = candles.slice(-12, -2);

  const recentLong = recent.reduce((s, c) => s + c.longBtc, 0);
  const recentShort = recent.reduce((s, c) => s + c.shortBtc, 0);
  const recentTotal = recentLong + recentShort;

  const baseLong  = baseline.reduce((s, c) => s + c.longBtc, 0)  / Math.max(baseline.length, 1);
  const baseShort = baseline.reduce((s, c) => s + c.shortBtc, 0) / Math.max(baseline.length, 1);

  const recentLongAvg  = recentLong  / recent.length;
  const recentShortAvg = recentShort / recent.length;

  const longSpike  = baseLong  > 0.001 ? recentLongAvg  / baseLong  : recentLongAvg  > 0.01 ? 2 : 1;
  const shortSpike = baseShort > 0.001 ? recentShortAvg / baseShort : recentShortAvg > 0.01 ? 2 : 1;

  let score = 0;
  const spikeThreshold = 1.5;

  if (shortSpike >= spikeThreshold || longSpike >= spikeThreshold) {
    const netSpike = shortSpike - longSpike;
    score = clamp(netSpike / 3);
  }

  const absRatio = recentTotal > 0.001 ? (recentShort - recentLong) / recentTotal : 0;
  score = clamp(score * 0.6 + absRatio * 0.4);

  const shortSpikeLbl = shortSpike >= spikeThreshold ? ` ⚡x${shortSpike.toFixed(1)}` : "";
  const longSpikeLbl  = longSpike  >= spikeThreshold ? ` ⚡x${longSpike.toFixed(1)}`  : "";
  const desc = `Лонги: ${recentLong.toFixed(2)} BTC${longSpikeLbl} | Шорты: ${recentShort.toFixed(2)} BTC${shortSpikeLbl} (последние 10 мин, все биржи)`;

  return { name: "Ликвидации (Coinalyze)", score, weight: 0.05, description: desc };
}

// ─── Display-only components (weight: 0) ─────────────────────

function calcPatternDisplay(): SignalComponent {
  if (!patternService.isReady()) {
    return { name: "Historical Pattern", score: 0, weight: 0, description: "Загрузка исторических данных..." };
  }
  const result = patternService.getResult()!;
  const score = parseFloat(result.signal.toFixed(4));
  const bull = result.bullishMatches;
  const bear = result.bearishMatches;
  const neutral = result.topMatches.length - bull - bear;
  const topMatch = result.topMatches[0];
  const simPct = topMatch ? (topMatch.similarity * 100).toFixed(1) : "0";
  const fwdLabel = topMatch ? `${topMatch.forwardPct >= 0 ? "+" : ""}${topMatch.forwardPct.toFixed(2)}% за 3д` : "";

  return {
    name: "Historical Pattern",
    score: clamp(score),
    weight: 0,
    description: `Топ: ${topMatch?.startDate ?? "—"} (r=${simPct}%) → ${fwdLabel} | Б:${bull}/М:${bear}/Н:${neutral}`,
  };
}

function calcFundingDisplay(): SignalComponent {
  const fundingRate = aggregator.getPrimaryFundingRate();
  const exchanges = aggregator.getActiveExchangeNames().join("+");
  const fa = analyzeFunding(fundingRate);
  let score = 0;
  if (fundingRate > 0.001) score = -0.8;
  else if (fundingRate > 0.0005) score = -0.4;
  else if (fundingRate < -0.001) score = 0.8;
  else if (fundingRate < -0.0002) score = 0.4;

  const biasLabel = fa.extreme
    ? (fa.bias === "long_crowded" ? " ⚠️ Толпа в лонгах — экстремум" : " ⚠️ Толпа в шортах — экстремум")
    : (fa.bias !== "normal" ? ` (${fa.bias})` : " — норма");

  return {
    name: "Funding Rate",
    score,
    weight: 0,
    description: `Rate: ${(fundingRate * 100).toFixed(4)}% avg (${exchanges})${biasLabel}`,
  };
}

function calcOiDeltaDisplay(): SignalComponent {
  const oi = coinglassService.getOiDelta();
  return {
    name: "OI Delta",
    score: oi.score,
    weight: 0,
    description: `5m: ${oi.delta5m > 0 ? "+" : ""}${(oi.delta5m * 100).toFixed(2)}% OI | price 5m: ${oi.priceChange5m > 0 ? "+" : ""}${(oi.priceChange5m * 100).toFixed(2)}% | ${oi.interpretation}`,
  };
}

function calcOpenInterestDisplay(): SignalComponent {
  const oi = aggregator.getPrimaryOpenInterest();
  const price = aggregator.getPrimaryPrice();
  const exchanges = aggregator.getActiveExchangeNames().join("+");
  if (price === 0 || oi === 0) return { name: "Open Interest", score: 0, weight: 0, description: "Нет данных OI" };
  const oiUsd = oi * price;
  const alignment = cvdService.getAlignment();
  return {
    name: "Open Interest",
    score: 0,
    weight: 0,
    description: `OI: $${(oiUsd / 1e6).toFixed(1)}M (${exchanges}) — MTF CVD: ${alignment.description}`,
  };
}

function calcCrossExchangeDisplay(): SignalComponent {
  const agg = aggregator.getAggregatedTicker();
  if (!agg || Object.keys(agg.prices).length < 2) {
    return { name: "Cross-Exchange Spread", score: 0, weight: 0, description: "Need 2+ exchanges" };
  }
  const priceParts = Object.entries(agg.prices)
    .map(([ex, p]) => `${ex}: $${p.toFixed(1)}`)
    .join(" | ");
  return { name: "Cross-Exchange Spread", score: 0, weight: 0, description: priceParts };
}

function calcCrossExchangeDivergence(): SignalComponent {
  const agg = aggregator.getAggregatedOrderbook();
  if (!agg || Object.keys(agg.byExchange).length < 2) {
    return { name: "Cross-Exchange Divergence", score: 0, weight: 0, description: "Нужно 2+ биржи" };
  }

  const imbalances: Record<string, number> = {};
  for (const [exchange, ob] of Object.entries(agg.byExchange)) {
    imbalances[exchange] = ob.imbalance;
  }

  const values = Object.values(imbalances);
  const maxDivergence = Math.max(...values) - Math.min(...values);
  const avgImbalance = values.reduce((s, v) => s + v, 0) / values.length;

  const desc = Object.entries(imbalances)
    .map(([ex, im]) => `${ex}: ${(im * 100).toFixed(1)}%`)
    .join(" | ");
  const warning = maxDivergence > 0.3
    ? ` ⚠️ Расхождение ${(maxDivergence * 100).toFixed(0)}% — возможна манипуляция`
    : "";

  return {
    name: "Cross-Exchange Divergence",
    score: avgImbalance,
    weight: 0,
    description: desc + warning,
  };
}

// ─── Signal Engine ────────────────────────────────────────────

class SignalEngine {
  compute(): SignalResult {
    // Weighted components (sum of weights = 1.00)
    const weighted: SignalComponent[] = [
      calcMtfCvdSignal(),        // 0.30 — PRIMARY
      calcCvdSignal(),           // 0.15
      calcOrderbookImbalance(),  // 0.20
      calcMomentumSignal(),      // 0.13
      calcVwapSignal(),          // 0.10
      calcEmaSignal(),           // 0.07
      calcLiquidationSignal(),   // 0.05
    ];

    // Display-only (weight 0)
    const displayOnly: SignalComponent[] = [
      calcPatternDisplay(),
      calcFundingDisplay(),
      calcOiDeltaDisplay(),
      calcOpenInterestDisplay(),
      calcCrossExchangeDisplay(),
      calcCrossExchangeDivergence(),
    ];

    const components = [...weighted, ...displayOnly];

    const totalWeight = weighted.reduce((s, c) => s + c.weight, 0);
    let rawScore = clamp(
      totalWeight > 0
        ? weighted.reduce((s, c) => s + c.score * c.weight, 0) / totalWeight
        : 0
    );

    // Funding modifier (soft filter — not a gate)
    const fundingRate = aggregator.getPrimaryFundingRate();
    const fundingAnalysis = analyzeFunding(fundingRate);

    // Determine direction first (needed for funding modifier)
    const alignment = cvdService.getAlignment();
    let direction: "long" | "short" | "neutral" = "neutral";

    // Gate 1 check: MTF CVD alignment strong = direction source
    if (alignment.strong) {
      direction = alignment.trend === "bullish" ? "long" : "short";
    } else if (rawScore > 0.25) {
      direction = "long";
    } else if (rawScore < -0.25) {
      direction = "short";
    }

    // Apply funding modifier
    rawScore = clamp(applyFundingModifier(rawScore, fundingAnalysis, direction));

    const score = parseFloat(rawScore.toFixed(4));
    const confidence = clamp(Math.abs(score) * 1.5, 0, 1);

    const price = aggregator.getPrimaryPrice() || 100_000;
    const atr = candleService.getAtr();
    const atrPct = atr > 0 ? (atr / price) * 100 : 0;
    const vwap = candleService.getVwap();

    // ── Leverage: HIGH volatility = LESS leverage (fixed, not inverted) ──
    let leverage: number;
    if (atrPct > 0.5) {
      leverage = 20;
    } else if (atrPct > 0.3) {
      leverage = 35;
    } else if (atrPct > 0.2) {
      leverage = 50;
    } else if (atrPct > 0.1) {
      leverage = 75;
    } else {
      leverage = 100;
    }
    const signalQuality = Math.abs(score);
    leverage = Math.round(leverage * (0.7 + signalQuality * 0.3));
    leverage = Math.max(10, leverage);

    // ── SL / TP: fractal-first, cluster fallback ──
    const buckets = getLiqBuckets();
    const dirSign = direction === "long" ? 1 : direction === "short" ? -1 : 0;

    let slResult: SlResult = { price: 0, source: "нет кластера", valid: false, clusterUsd: 0, distancePct: 0 };
    let tpResult: TpResult = { price: 0, source: "нет кластера", valid: false, clusterUsd: 0, distancePct: 0, rr: 0 };

    // ── Fractal gate (primary filter) ──
    const fractalSig = fractalService.getFractalSignal();
    const fractalGatePassed =
      fractalSig !== null &&
      fractalSig.valid &&
      fractalSig.overall_signal_score >= FRACTAL_MIN_SIGNAL_SCORE &&
      fractalSig.direction === direction;
    const fractalGateReason = fractalSig !== null && fractalSig.valid
      ? `Фрактал: ${fractalSig.overall_signal_score.toFixed(2)} (${(fractalSig.probability * 100).toFixed(0)}%) ${fractalSig.reason}`
      : (fractalSig?.reason ?? "Фрактальный сигнал не готов");

    if (fractalGatePassed && fractalSig && fractalSig.suggested_sl_pct > 0 && fractalSig.suggested_tp_pct > 0) {
      // Convert stored percentage (e.g. 1.187) to decimal (0.01187)
      const slPctDecimal = fractalSig.suggested_sl_pct / 100;
      const tpPctDecimal = fractalSig.suggested_tp_pct / 100;

      slResult.price = parseFloat((direction === "long"
        ? price * (1 - slPctDecimal)
        : price * (1 + slPctDecimal)).toFixed(2));
      slResult.source = `Фрактал: ${fractalSig.suggested_sl_pct.toFixed(2)}%`;
      slResult.valid = true;
      slResult.distancePct = slPctDecimal;

      tpResult.price = parseFloat((direction === "long"
        ? price * (1 + tpPctDecimal)
        : price * (1 - tpPctDecimal)).toFixed(2));
      tpResult.source = `Фрактал: ${fractalSig.suggested_tp_pct.toFixed(2)}%`;
      tpResult.valid = true;
      tpResult.distancePct = tpPctDecimal;
      tpResult.rr = tpPctDecimal / slPctDecimal;
    } else if (direction !== "neutral") {
      // Fallback to liquidation clusters
      slResult = calcSlFromLiqMap(direction, price, buckets);
      if (slResult.valid) {
        tpResult = calcTpFromLiqMap(direction, price, buckets, slResult.distancePct);
      }
    }

    // Fallback display prices (for UI only when gates fail)
    const displaySl = slResult.valid
      ? slResult.price
      : direction === "long"  ? parseFloat((price * (1 - 0.015)).toFixed(2))
      : direction === "short" ? parseFloat((price * (1 + 0.015)).toFixed(2))
      : price;

    const displayTp = tpResult.valid
      ? tpResult.price
      : direction === "long"  ? parseFloat((price * (1 + 0.025)).toFixed(2))
      : direction === "short" ? parseFloat((price * (1 - 0.025)).toFixed(2))
      : price;

    // ── Gates ──
    const obComp = weighted.find(c => c.name === "Order Book Imbalance");

    // Gate 1: CVD 5m/15m — both timeframes must agree (1m ignored)
    const align5m15m = cvdService.get5m15mAlignment();
    const gate1Passed = align5m15m.strong && direction !== "neutral";
    const gate1Reason = align5m15m.strong
      ? `${align5m15m.description} — 5м и 15м согласованы ✓`
      : `CVD (${align5m15m.description}) — 5м и 15м расходятся ✗`;

    // Gate 2: Order Book — wall check within 0.5% of price
    const obGate  = checkImbalance(direction as "long" | "short");
    const obPassed = obGate.pass;
    const obReason = obGate.reason;

    // Gate 3: SL on cluster
    const gate3Passed = slResult.valid;
    const gate3Reason = slResult.valid
      ? `${slResult.source} | dist: ${(slResult.distancePct * 100).toFixed(2)}% ✓`
      : `${slResult.source} ✗`;

    // Gate 4: TP on cluster + R:R ≥ 1.5
    const gate4Passed = tpResult.valid;
    const gate4Reason = tpResult.valid
      ? `${tpResult.source} | dist: ${(tpResult.distancePct * 100).toFixed(2)}% ✓`
      : `${tpResult.source} ✗`;

    // Gate 5: Whale activity — large directional trades in last 2 min
    const whaleGate = checkWhaleActivity(direction as "long" | "short");
    const gate5Passed = direction === "neutral" ? false : whaleGate.pass;
    const gate5Reason = whaleGate.reason;

    // Gate 6: Funding Rate (contrarian filter) — uses already-computed fundingAnalysis
    const gate6Passed = !fundingAnalysis.extreme || fundingAnalysis.contrarian === direction;
    const gate6Reason = gate6Passed
      ? `Фандинг не экстремальный или контр-тренд ✓`
      : `Фандинг ${fundingAnalysis.bias} — ${fundingAnalysis.contrarian} ✗`;

    const gates: GateResult[] = [
      { name: "CVD (5м/15м)",                  passed: gate1Passed, reason: gate1Reason },
      { name: "Стакан (плита 0.5%)",            passed: obPassed,    reason: obReason },
      { name: "Активность китов (3м)",          passed: gate5Passed, reason: gate5Reason },
      { name: "SL кластер ($10M+)",             passed: gate3Passed, reason: gate3Reason },
      { name: "TP кластер ($7M+) + R:R",        passed: gate4Passed, reason: gate4Reason },
      { name: "Фандинг",                        passed: gate6Passed, reason: gate6Reason },
    ];

    const allGatesPassed = direction !== "neutral" && gate1Passed && obPassed && gate3Passed && gate4Passed && gate5Passed && gate6Passed;

    // Debug: notify Telegram when a meaningful signal is blocked by a gate (rate-limited)
    if (!allGatesPassed && direction !== "neutral" && Math.abs(score) >= 0.25) {
      const now = Date.now();
      if (now - lastGateDebugTs > GATE_DEBUG_INTERVAL_MS) {
        lastGateDebugTs = now;
        const failedGates = gates.filter(g => !g.passed);
        const firstFailed = failedGates[0];
        const dirLabel = direction === "long" ? "ЛОНГ" : "ШОРТ";
        const debugMsg = firstFailed
          ? `[DEBUG] 🚫 ${dirLabel} отклонен: ${firstFailed.reason}`
          : `[DEBUG] 🚫 ${dirLabel} заблокирован (score=${score.toFixed(3)})`;
        telegramService.notifyChannel(debugMsg);
      }
    }

    return {
      score,
      direction,
      confidence: parseFloat(confidence.toFixed(4)),
      components,
      gates,
      allGatesPassed,
      suggestedLeverage: leverage,
      suggestedSl: displaySl,
      suggestedTp: displayTp,
      slValid: slResult.valid,
      tpValid: tpResult.valid,
      atrPct: parseFloat(atrPct.toFixed(4)),
      vwap: parseFloat(vwap.toFixed(2)),
      updatedAt: new Date().toISOString(),
      tpSource: tpResult.valid ? tpResult.source : slResult.valid ? tpResult.source : "ожидание кластера",
      slSource: slResult.valid ? slResult.source : "ожидание кластера",
      fractalSignal: fractalSig ?? undefined,
    };
  }
}

export const signalEngine = new SignalEngine();
