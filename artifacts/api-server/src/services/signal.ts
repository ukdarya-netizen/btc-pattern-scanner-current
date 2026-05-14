import { aggregator } from "./exchanges/aggregator";
import { candleService } from "./candleService";
import { patternService } from "./patternService";
import { taService } from "./taService";
import { coinalyzeService } from "./coinalyzeService";
import { coinglassService } from "./coinglassService";
import type { LiqHeatmapBucket } from "./coinglassService";
import type { LiqMapBucket } from "./coinalyzeService";
import { telegramService } from "./telegram";
import { cvdService } from "./cvd";

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
}

// Unified bucket type for SL/TP logic
type Bucket = { price: number; longLiqUsd: number; shortLiqUsd: number; totalUsd: number };

// ─── Constants ───────────────────────────────────────────────
const MIN_SL_CLUSTER_USD  = 10_000_000;

// Debug gate notifications — rate-limited to avoid flooding the channel
let lastGateDebugTs = 0;
const GATE_DEBUG_INTERVAL_MS = 5 * 60 * 1000;
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

// ─── Merge liq buckets ────────────────────────────────────────
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
    const candidates = buckets
      .filter(b =>
        b.price < price &&
        b.price >= price * (1 - MAX_SL_RANGE_PCT) &&
        b.longLiqUsd >= MIN_SL_CLUSTER_USD
      )
      .sort((a, b) => b.price - a.price);

    const cluster = candidates[0];
    if (!cluster) return invalid;

    const slPrice = cluster.price * (1 + SL_CLUSTER_BUFFER);
    const distancePct = (price - slPrice) / price;

    if (distancePct < MIN_SL_DISTANCE_PCT)
      return { price: slPrice, source: "кластер слишком близко", valid: false, clusterUsd: cluster.longLiqUsd, distancePct };
    if (distancePct > MAX_SL_DISTANCE_PCT)
      return { price: slPrice, source: "кластер слишком далеко", valid: false, clusterUsd: cluster.longLiqUsd, distancePct };

    return {
      price: parseFloat(slPrice.toFixed(2)),
      source: `Над кластером лонгов $${cluster.price.toFixed(0)} (${(cluster.longLiqUsd / 1e6).toFixed(1)}M)`,
      valid: true, clusterUsd: cluster.longLiqUsd, distancePct,
    };

  } else {
    const candidates = buckets
      .filter(b =>
        b.price > price &&
        b.price <= price * (1 + MAX_SL_RANGE_PCT) &&
        b.shortLiqUsd >= MIN_SL_CLUSTER_USD
      )
      .sort((a, b) => a.price - b.price);

    const cluster = candidates[0];
    if (!cluster) return invalid;

    const slPrice = cluster.price * (1 - SL_CLUSTER_BUFFER);
    const distancePct = (slPrice - price) / price;

    if (distancePct < MIN_SL_DISTANCE_PCT)
      return { price: slPrice, source: "кластер слишком близко", valid: false, clusterUsd: cluster.shortLiqUsd, distancePct };
    if (distancePct > MAX_SL_DISTANCE_PCT)
      return { price: slPrice, source: "кластер слишком далеко", valid: false, clusterUsd: cluster.shortLiqUsd, distancePct };

    return {
      price: parseFloat(slPrice.toFixed(2)),
      source: `Под кластером шортов $${cluster.price.toFixed(0)} (${(cluster.shortLiqUsd / 1e6).toFixed(1)}M)`,
      valid: true, clusterUsd: cluster.shortLiqUsd, distancePct,
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
    const candidates = buckets
      .filter(b =>
        b.price > price &&
        b.price <= price * (1 + MAX_TP_RANGE_PCT) &&
        b.shortLiqUsd >= MIN_TP_CLUSTER_USD
      )
      .sort((a, b) => a.price - b.price);

    const cluster = candidates[0];
    if (!cluster) return invalid;

    const tpPrice = cluster.price * (1 - TP_CLUSTER_BUFFER);
    const distancePct = (tpPrice - price) / price;
    const rr = distancePct / slDistancePct;

    if (distancePct < MIN_TP_DISTANCE_PCT)
      return { price: tpPrice, source: "TP кластер слишком близко", valid: false, clusterUsd: cluster.shortLiqUsd, distancePct, rr };
    if (rr < MIN_RR_RATIO)
      return { price: tpPrice, source: `R:R ${rr.toFixed(2)} < ${MIN_RR_RATIO}`, valid: false, clusterUsd: cluster.shortLiqUsd, distancePct, rr };

    return {
      price: parseFloat(tpPrice.toFixed(2)),
      source: `Кластер шортов $${cluster.price.toFixed(0)} (${(cluster.shortLiqUsd / 1e6).toFixed(1)}M) | R:R ${rr.toFixed(2)}`,
      valid: true, clusterUsd: cluster.shortLiqUsd, distancePct, rr,
    };

  } else {
    const candidates = buckets
      .filter(b =>
        b.price < price &&
        b.price >= price * (1 - MAX_TP_RANGE_PCT) &&
        b.longLiqUsd >= MIN_TP_CLUSTER_USD
      )
      .sort((a, b) => b.price - a.price);

    const cluster = candidates[0];
    if (!cluster) return invalid;

    const tpPrice = cluster.price * (1 + TP_CLUSTER_BUFFER);
    const distancePct = (price - tpPrice) / price;
    const rr = distancePct / slDistancePct;

    if (distancePct < MIN_TP_DISTANCE_PCT)
      return { price: tpPrice, source: "TP кластер слишком близко", valid: false, clusterUsd: cluster.longLiqUsd, distancePct, rr };
    if (rr < MIN_RR_RATIO)
      return { price: tpPrice, source: `R:R ${rr.toFixed(2)} < ${MIN_RR_RATIO}`, valid: false, clusterUsd: cluster.longLiqUsd, distancePct, rr };

    return {
      price: parseFloat(tpPrice.toFixed(2)),
      source: `Кластер лонгов $${cluster.price.toFixed(0)} (${(cluster.longLiqUsd / 1e6).toFixed(1)}M) | R:R ${rr.toFixed(2)}`,
      valid: true, clusterUsd: cluster.longLiqUsd, distancePct, rr,
    };
  }
}

// ─── TA Signal Components ─────────────────────────────────────

function calcMTFTrendSignal(): SignalComponent {
  const ta = taService.getSnapshot();
  if (!ta || !ta.ready) {
    return { name: "MTF EMA Тренд (1H/4H/1D)", score: 0, weight: 0.35, description: ta?.readyReason ?? "Загрузка данных..." };
  }

  const scores = {
    "1H": ta.trend_1h === "bullish" ? 1 : ta.trend_1h === "bearish" ? -1 : 0,
    "4H": ta.trend_4h === "bullish" ? 1 : ta.trend_4h === "bearish" ? -1 : 0,
    "1D": ta.trend_1d === "bullish" ? 1 : ta.trend_1d === "bearish" ? -1 : 0,
  };

  // Weight: 1D counts most
  const weighted = scores["1H"] * 0.25 + scores["4H"] * 0.35 + scores["1D"] * 0.40;
  const score = clamp(weighted);

  const trendLabel = (t: string) => t === "bullish" ? "↑" : t === "bearish" ? "↓" : "→";
  const desc = `1H${trendLabel(ta.trend_1h)} 4H${trendLabel(ta.trend_4h)} 1D${trendLabel(ta.trend_1d)} | EMA21/50/200`;

  return { name: "MTF EMA Тренд (1H/4H/1D)", score, weight: 0.35, description: desc };
}

function calcVwapSignal(): SignalComponent {
  const ta = taService.getSnapshot();
  const price = aggregator.getPrimaryPrice();

  if (!ta || !ta.ready || ta.vwap_1h === 0 || price === 0) {
    return { name: "VWAP (дневной)", score: 0, weight: 0.15, description: "Загрузка..." };
  }

  const deviation = (price - ta.vwap_1h) / ta.vwap_1h;
  const score = clamp(deviation / 0.005 * 0.8);
  const dir = deviation >= 0 ? "выше" : "ниже";

  return {
    name: "VWAP (дневной)",
    score,
    weight: 0.15,
    description: `Цена $${price.toFixed(1)} ${dir} VWAP $${ta.vwap_1h.toFixed(1)} на ${(Math.abs(deviation) * 100).toFixed(2)}%`,
  };
}

function calcSRSignal(): SignalComponent {
  const ta = taService.getSnapshot();
  const price = aggregator.getPrimaryPrice();

  if (!ta || !ta.ready || price === 0) {
    return { name: "Уровни S/R", score: 0, weight: 0.25, description: "Загрузка..." };
  }

  const sup = ta.nearestSupport;
  const res = ta.nearestResistance;

  if (!sup && !res) {
    return { name: "Уровни S/R", score: 0, weight: 0.25, description: "Нет уровней в зоне ±5%" };
  }

  let score = 0;
  let desc = "";

  const supDist = sup ? (price - sup.price) / price : Infinity;
  const resDist = res ? (res.price - price) / price : Infinity;

  if (sup && supDist < 0.005) {
    score = clamp(0.6 + sup.strength * 0.08);
    desc = `Цена у поддержки $${sup.price.toFixed(0)} (сила: ${sup.strength}) — ЛОНГ зона`;
  } else if (res && resDist < 0.005) {
    score = clamp(-(0.6 + res.strength * 0.08));
    desc = `Цена у сопротивления $${res.price.toFixed(0)} (сила: ${res.strength}) — ШОРТ зона`;
  } else {
    // Between levels — score based on proximity ratio
    const ratio = sup && res ? (resDist - supDist) / (resDist + supDist) : 0;
    score = clamp(ratio * 0.4);
    const supStr = sup ? `Поддержка: $${sup.price.toFixed(0)} (${(supDist * 100).toFixed(1)}%)` : "нет";
    const resStr = res ? `Сопротивление: $${res.price.toFixed(0)} (${(resDist * 100).toFixed(1)}%)` : "нет";
    desc = `${supStr} | ${resStr}`;
  }

  return { name: "Уровни S/R", score, weight: 0.25, description: desc };
}

function calcCandlePatternSignal(): SignalComponent {
  const ta = taService.getSnapshot();

  if (!ta || !ta.ready || ta.patterns.length === 0) {
    return { name: "Паттерны свечей", score: 0, weight: 0.25, description: ta?.ready ? "Нет паттернов" : "Загрузка..." };
  }

  // Score: weighted average from all detected patterns
  let totalWeight = 0;
  let totalScore  = 0;

  for (const p of ta.patterns) {
    const dirScore = p.direction === "bullish" ? 1 : p.direction === "bearish" ? -1 : 0;
    // Higher TF patterns count more
    const tfWeight = p.name.includes("1D") ? 1.5 : p.name.includes("4H") ? 1.2 : 1.0;
    totalScore  += dirScore * p.strength * tfWeight;
    totalWeight += p.strength * tfWeight;
  }

  const score = totalWeight > 0 ? clamp(totalScore / totalWeight) : 0;
  const desc = ta.patterns.map(p => `${p.name} (${p.direction})`).join(" | ");

  return { name: "Паттерны свечей", score, weight: 0.25, description: desc };
}

// ─── Display-only components ──────────────────────────────────

function calcFundingDisplay(): SignalComponent {
  const fundingRate = aggregator.getPrimaryFundingRate();
  const exchanges = aggregator.getActiveExchangeNames().join("+");
  let score = 0;
  if (fundingRate > 0.001) score = -0.8;
  else if (fundingRate > 0.0005) score = -0.4;
  else if (fundingRate < -0.001) score = 0.8;
  else if (fundingRate < -0.0002) score = 0.4;

  const biasLabel = Math.abs(fundingRate) > 0.001
    ? (fundingRate > 0 ? " ⚠️ Толпа в лонгах" : " ⚠️ Толпа в шортах")
    : " — норма";

  return {
    name: "Funding Rate",
    score,
    weight: 0,
    description: `Rate: ${(fundingRate * 100).toFixed(4)}% (${exchanges})${biasLabel}`,
  };
}

function calcOiDeltaDisplay(): SignalComponent {
  const oi = coinglassService.getOiDelta();
  return {
    name: "OI Delta",
    score: oi.score,
    weight: 0,
    description: `5m: ${oi.delta5m > 0 ? "+" : ""}${(oi.delta5m * 100).toFixed(2)}% OI | цена 5m: ${oi.priceChange5m > 0 ? "+" : ""}${(oi.priceChange5m * 100).toFixed(2)}% | ${oi.interpretation}`,
  };
}

function calcOpenInterestDisplay(): SignalComponent {
  const oi = aggregator.getPrimaryOpenInterest();
  const price = aggregator.getPrimaryPrice();
  const exchanges = aggregator.getActiveExchangeNames().join("+");
  if (price === 0 || oi === 0) return { name: "Open Interest", score: 0, weight: 0, description: "Нет данных OI" };
  const oiUsd = oi * price;
  return {
    name: "Open Interest",
    score: 0,
    weight: 0,
    description: `OI: $${(oiUsd / 1e6).toFixed(1)}M (${exchanges})`,
  };
}

function calcLiquidationDisplay(): SignalComponent {
  const candles = coinalyzeService.getLatest2hCandles();
  if (candles.length < 2) {
    return { name: "Ликвидации (Coinalyze)", score: 0, weight: 0, description: "Загрузка..." };
  }
  const recent = candles.slice(-2);
  const recentLong  = recent.reduce((s, c) => s + c.longBtc, 0);
  const recentShort = recent.reduce((s, c) => s + c.shortBtc, 0);
  return {
    name: "Ликвидации (Coinalyze)",
    score: 0,
    weight: 0,
    description: `Лонги: ${recentLong.toFixed(2)} BTC | Шорты: ${recentShort.toFixed(2)} BTC (10 мин)`,
  };
}

function calcPatternDisplay(): SignalComponent {
  if (!patternService.isReady()) {
    return { name: "Historical Pattern", score: 0, weight: 0, description: "Загрузка исторических данных..." };
  }
  const result = patternService.getResult()!;
  const bull = result.bullishMatches;
  const bear = result.bearishMatches;
  const topMatch = result.topMatches[0];
  const simPct = topMatch ? (topMatch.similarity * 100).toFixed(1) : "0";
  const fwdLabel = topMatch ? `${topMatch.forwardPct >= 0 ? "+" : ""}${topMatch.forwardPct.toFixed(2)}% за 3д` : "";
  return {
    name: "Historical Pattern",
    score: 0,
    weight: 0,
    description: `Топ: ${topMatch?.startDate ?? "—"} (r=${simPct}%) → ${fwdLabel} | Б:${bull}/М:${bear}`,
  };
}


function calcCVDDisplay(): SignalComponent {
  const trend15m = cvdService.getTrend15m();
  const cvd1h    = taService.getCvdTrend("1h");
  const cvd4h    = taService.getCvdTrend("4h");

  const arrow = (t: string) => t === "bullish" ? "↑" : t === "bearish" ? "↓" : "→";

  const desc = [
    `15m${arrow(trend15m)}`,
    `1H${arrow(cvd1h.trend)} (${cvd1h.description})`,
    `4H${arrow(cvd4h.trend)} (${cvd4h.description})`,
  ].join(" | ");

  return { name: "CVD (15m/1H/4H)", score: 0, weight: 0, description: desc };
}

function calcCrossExchangeDisplay(): SignalComponent {
  const agg = aggregator.getAggregatedTicker();
  if (!agg || Object.keys(agg.prices).length < 2) {
    return { name: "Cross-Exchange Spread", score: 0, weight: 0, description: "Нужно 2+ биржи" };
  }
  const priceParts = Object.entries(agg.prices)
    .map(([ex, p]) => `${ex}: $${p.toFixed(1)}`)
    .join(" | ");
  return { name: "Cross-Exchange Spread", score: 0, weight: 0, description: priceParts };
}

// ─── Signal Engine ────────────────────────────────────────────

class SignalEngine {
  compute(): SignalResult {
    const ta = taService.getSnapshot();

    // Weighted TA components (total weight = 1.00)
    const weighted: SignalComponent[] = [
      calcMTFTrendSignal(),     // 0.35 — MTF EMA
      calcSRSignal(),           // 0.25 — S/R levels
      calcCandlePatternSignal(), // 0.25 — candle patterns
      calcVwapSignal(),         // 0.15 — VWAP
    ];

    // Display-only
    const displayOnly: SignalComponent[] = [
      calcFundingDisplay(),
      calcOiDeltaDisplay(),
      calcOpenInterestDisplay(),
      calcLiquidationDisplay(),
      calcPatternDisplay(),
      calcCVDDisplay(),
      calcCrossExchangeDisplay(),
    ];

    const components = [...weighted, ...displayOnly];

    const totalWeight = weighted.reduce((s, c) => s + c.weight, 0);
    const rawScore = clamp(
      totalWeight > 0
        ? weighted.reduce((s, c) => s + c.score * c.weight, 0) / totalWeight
        : 0
    );

    const score = parseFloat(rawScore.toFixed(4));
    const confidence = clamp(Math.abs(score) * 1.5, 0, 1);

    const price = aggregator.getPrimaryPrice() || 100_000;
    const atr = candleService.getAtr();
    const atrPct = atr > 0 ? (atr / price) * 100 : 0;
    const vwap = ta?.vwap_1h ?? candleService.getVwap();

    // Direction from score
    let direction: "long" | "short" | "neutral" = "neutral";
    if (score > 0.20) direction = "long";
    else if (score < -0.20) direction = "short";

    // Leverage based on ATR
    let leverage: number;
    if (atrPct > 0.5) leverage = 20;
    else if (atrPct > 0.3) leverage = 35;
    else if (atrPct > 0.2) leverage = 50;
    else if (atrPct > 0.1) leverage = 75;
    else leverage = 100;
    leverage = Math.round(leverage * (0.7 + Math.abs(score) * 0.3));
    leverage = Math.max(10, leverage);

    // SL / TP from liquidation clusters
    const buckets = getLiqBuckets();
    let slResult: SlResult = { price: 0, source: "нет кластера", valid: false, clusterUsd: 0, distancePct: 0 };
    let tpResult: TpResult = { price: 0, source: "нет кластера", valid: false, clusterUsd: 0, distancePct: 0, rr: 0 };

    if (direction !== "neutral") {
      slResult = calcSlFromLiqMap(direction, price, buckets);
      if (slResult.valid) {
        tpResult = calcTpFromLiqMap(direction, price, buckets, slResult.distancePct);
      }
    }

    const displaySl = slResult.valid
      ? slResult.price
      : direction === "long"  ? parseFloat((price * 0.985).toFixed(2))
      : direction === "short" ? parseFloat((price * 1.015).toFixed(2))
      : price;

    const displayTp = tpResult.valid
      ? tpResult.price
      : direction === "long"  ? parseFloat((price * 1.025).toFixed(2))
      : direction === "short" ? parseFloat((price * 0.975).toFixed(2))
      : price;

    // ── Gates ──────────────────────────────────────────────────

    // Gate 1: MTF EMA — all 3 timeframes agree direction
    const g1Passed = ta?.ready === true &&
      direction !== "neutral" &&
      (() => {
        const t1 = ta.trend_1h; const t4 = ta.trend_4h; const t1d = ta.trend_1d;
        if (direction === "long")  return t1 === "bullish" && t4 === "bullish" && t1d === "bullish";
        if (direction === "short") return t1 === "bearish" && t4 === "bearish" && t1d === "bearish";
        return false;
      })();
    const g1Reason = !ta?.ready
      ? `TA не готов: ${ta?.readyReason}`
      : g1Passed
        ? `1H${ta.trend_1h === "bullish" ? "↑" : "↓"} 4H${ta.trend_4h === "bullish" ? "↑" : "↓"} 1D${ta.trend_1d === "bullish" ? "↑" : "↓"} — все ТФ согласованы ✓`
        : `1H/4H/1D тренды расходятся (1H:${ta?.trend_1h} 4H:${ta?.trend_4h} 1D:${ta?.trend_1d}) ✗`;

    // Gate 2: Price relative to VWAP confirms direction
    const g2Passed = ta?.ready === true && ta.vwap_1h > 0 && direction !== "neutral" &&
      ((direction === "long"  && price > ta.vwap_1h) ||
       (direction === "short" && price < ta.vwap_1h));
    const g2Reason = !ta?.ready
      ? "TA не готов ✗"
      : g2Passed
        ? `Цена ${direction === "long" ? "выше" : "ниже"} VWAP $${ta?.vwap_1h.toFixed(1)} ✓`
        : `Цена ${direction === "long" ? "ниже" : "выше"} VWAP — против направления ✗`;

    // Gate 3: Price near S/R level (within 1%)
    const g3Passed = ta?.ready === true && direction !== "neutral" &&
      (() => {
        if (direction === "long"  && ta.nearestSupport)    return (price - ta.nearestSupport.price) / price <= 0.01;
        if (direction === "short" && ta.nearestResistance) return (ta.nearestResistance.price - price) / price <= 0.01;
        return false;
      })();
    const g3Reason = !ta?.ready
      ? "TA не готов ✗"
      : g3Passed
        ? `Цена у уровня ${direction === "long" ? `поддержки $${ta.nearestSupport?.price.toFixed(0)}` : `сопротивления $${ta.nearestResistance?.price.toFixed(0)}`} ✓`
        : `Нет уровня в 1% от цены (sup: ${ta?.nearestSupport ? "$" + ta.nearestSupport.price.toFixed(0) : "нет"}, res: ${ta?.nearestResistance ? "$" + ta.nearestResistance.price.toFixed(0) : "нет"}) ✗`;

    // Gate 4: Confirming candle pattern in correct direction
    const confirmPatterns = ta?.patterns?.filter(p =>
      (direction === "long"  && p.direction === "bullish") ||
      (direction === "short" && p.direction === "bearish")
    ) ?? [];
    const g4Passed = confirmPatterns.length > 0;
    const g4Reason = g4Passed
      ? `Паттерн: ${confirmPatterns.map(p => p.name).join(", ")} ✓`
      : `Нет подтверждающего паттерна свечей ✗`;

    // Gate 5: SL cluster
    const g5Passed = slResult.valid;
    const g5Reason = slResult.valid
      ? `${slResult.source} | ${(slResult.distancePct * 100).toFixed(2)}% ✓`
      : `${slResult.source} ✗`;

    // Gate 6: TP cluster + R:R
    const g6Passed = tpResult.valid;
    const g6Reason = tpResult.valid
      ? `${tpResult.source} ✓`
      : `${tpResult.source} ✗`;

    const gates: GateResult[] = [
      { name: "MTF EMA (1H/4H/1D)",            passed: g1Passed, reason: g1Reason },
      { name: "VWAP подтверждение",             passed: g2Passed, reason: g2Reason },
      { name: "Уровень S/R (в 1%)",             passed: g3Passed, reason: g3Reason },
      { name: "Паттерн свечи",                  passed: g4Passed, reason: g4Reason },
      { name: "SL кластер ($10M+)",             passed: g5Passed, reason: g5Reason },
      { name: "TP кластер ($7M+) + R:R",        passed: g6Passed, reason: g6Reason },
    ];

    const allGatesPassed = direction !== "neutral" && g1Passed && g2Passed && g3Passed && g4Passed && g5Passed && g6Passed;

    // Debug Telegram notification
    if (!allGatesPassed && direction !== "neutral" && Math.abs(score) >= 0.20) {
      const now = Date.now();
      if (now - lastGateDebugTs > GATE_DEBUG_INTERVAL_MS) {
        lastGateDebugTs = now;
        const firstFailed = gates.find(g => !g.passed);
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
      tpSource: tpResult.valid ? tpResult.source : "ожидание кластера",
      slSource: slResult.valid ? slResult.source : "ожидание кластера",
    };
  }
}

export const signalEngine = new SignalEngine();
