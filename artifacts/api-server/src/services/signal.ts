import { aggregator } from "./exchanges/aggregator";
import { cvdService } from "./cvd";
import { candleService } from "./candleService";
import { patternService } from "./patternService";
import { coinalyzeService } from "./coinalyzeService";

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
  atrPct: number;
  vwap: number;
  updatedAt: string;
  tpSource?: string;
  slSource?: string;
}

// Weights: Pattern 0.30 + CVD 0.20 + OB 0.15 + Momentum 0.13 + VWAP 0.10 + EMA 0.07 + Liquidations 0.05 = 1.00
// Funding + OI: weight 0 (display only)

function clamp(val: number, min = -1, max = 1): number {
  return Math.max(min, Math.min(max, val));
}

function calcPatternSignal(): SignalComponent {
  if (!patternService.isReady()) {
    return { name: "Historical Pattern", score: 0, weight: 0.30, description: "Загрузка исторических данных..." };
  }

  const result = patternService.getResult()!;
  const score = parseFloat(result.signal.toFixed(4));
  const bull = result.bullishMatches;
  const bear = result.bearishMatches;
  const neutral = result.topMatches.length - bull - bear;
  const topMatch = result.topMatches[0];
  const simPct = topMatch ? (topMatch.similarity * 100).toFixed(1) : "0";
  const fwdLabel = topMatch
    ? `${topMatch.forwardPct >= 0 ? "+" : ""}${topMatch.forwardPct.toFixed(2)}% за 3д`
    : "";

  return {
    name: "Historical Pattern",
    score: clamp(score),
    weight: 0.30,
    description: `Топ совпадение: ${topMatch?.startDate ?? "—"} (r=${simPct}%) → ${fwdLabel} | Бычьих: ${bull} / Медвежьих: ${bear} / Нейтр: ${neutral} из ${result.topMatches.length}`,
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
    weight: 0.20,
    description: `Trend: ${trend}, CVD: ${cvdService.getCurrentCvd().toFixed(2)}`,
  };
}

function calcOrderbookImbalance(): SignalComponent {
  const ob = aggregator.getAggregatedOrderbook();
  if (!ob) return { name: "Order Book Imbalance", score: 0, weight: 0.15, description: "No data" };

  const bidVol = ob.mergedBids.slice(0, 10).reduce((s, l) => s + l.size, 0);
  const askVol = ob.mergedAsks.slice(0, 10).reduce((s, l) => s + l.size, 0);
  const total = bidVol + askVol;
  const score = total > 0 ? clamp((bidVol - askVol) / total * 3) : 0;

  const exchanges = Object.keys(ob.byExchange).join(", ");
  return {
    name: "Order Book Imbalance",
    score,
    weight: 0.15,
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

  // Recent = last 2 candles (10 min), baseline = previous 4-12 candles
  const recent = candles.slice(-2);
  const baseline = candles.slice(-12, -2);

  const recentLong = recent.reduce((s, c) => s + c.longBtc, 0);
  const recentShort = recent.reduce((s, c) => s + c.shortBtc, 0);
  const recentTotal = recentLong + recentShort;

  const baseLong = baseline.reduce((s, c) => s + c.longBtc, 0) / Math.max(baseline.length, 1);
  const baseShort = baseline.reduce((s, c) => s + c.shortBtc, 0) / Math.max(baseline.length, 1);

  // Per-candle averages for recent period
  const recentLongAvg = recentLong / recent.length;
  const recentShortAvg = recentShort / recent.length;

  // Spike ratios vs baseline (capped to avoid division by zero)
  const longSpike = baseLong > 0.001 ? recentLongAvg / baseLong : recentLongAvg > 0.01 ? 2 : 1;
  const shortSpike = baseShort > 0.001 ? recentShortAvg / baseShort : recentShortAvg > 0.01 ? 2 : 1;

  // Net ratio: positive = short spike (bullish), negative = long spike (bearish)
  // Short liquidations → price went up (shorts squeezed) → bullish signal
  // Long liquidations  → price went down (longs stopped out) → bearish signal
  let score = 0;
  const spikeThreshold = 1.5; // need 50% above baseline to count

  if (shortSpike >= spikeThreshold || longSpike >= spikeThreshold) {
    const netSpike = shortSpike - longSpike;
    score = clamp(netSpike / 3); // normalize: spike ratio diff of 3x → full score
  }

  // Also factor in absolute recent ratio
  const absRatio = recentTotal > 0.001
    ? (recentShort - recentLong) / recentTotal
    : 0;
  score = clamp(score * 0.6 + absRatio * 0.4);

  const shortSpikeLbl = shortSpike >= spikeThreshold ? ` ⚡x${shortSpike.toFixed(1)}` : "";
  const longSpikeLbl = longSpike >= spikeThreshold ? ` ⚡x${longSpike.toFixed(1)}` : "";
  const desc = `Лонги: ${recentLong.toFixed(2)} BTC${longSpikeLbl} | Шорты: ${recentShort.toFixed(2)} BTC${shortSpikeLbl} (последние 10 мин, все биржи)`;

  return {
    name: "Ликвидации (Coinalyze)",
    score,
    weight: 0.05,
    description: desc,
  };
}

// Display-only (weight 0) — shown on dashboard but don't affect score
function calcFundingDisplay(): SignalComponent {
  const fundingRate = aggregator.getPrimaryFundingRate();
  const exchanges = aggregator.getActiveExchangeNames().join("+");
  let score = 0;
  if (fundingRate > 0.001) score = -0.5;
  else if (fundingRate > 0.0005) score = -0.25;
  else if (fundingRate < -0.001) score = 0.5;
  else if (fundingRate < -0.0005) score = 0.25;

  return {
    name: "Funding Rate",
    score,
    weight: 0,
    description: `Rate: ${(fundingRate * 100).toFixed(4)}% avg (${exchanges}) — ${score !== 0 ? (score > 0 ? "аномально низкий (лонги платят мало)" : "аномально высокий (шорты платят)") : "норма"}`,
  };
}

function calcOpenInterestDisplay(): SignalComponent {
  const oi = aggregator.getPrimaryOpenInterest();
  const price = aggregator.getPrimaryPrice();
  const exchanges = aggregator.getActiveExchangeNames().join("+");
  if (price === 0 || oi === 0) return { name: "Open Interest", score: 0, weight: 0, description: "Нет данных OI" };

  const oiUsd = oi * price;
  const cvdTrend = cvdService.getTrend();
  return {
    name: "Open Interest",
    score: 0,
    weight: 0,
    description: `OI: $${(oiUsd / 1e6).toFixed(1)}M (${exchanges}) — тренд CVD: ${cvdTrend}`,
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

class SignalEngine {
  compute(): SignalResult {
    // Weighted components (affect score)
    const weighted: SignalComponent[] = [
      calcPatternSignal(),       // 30% — PRIMARY
      calcCvdSignal(),           // 20%
      calcOrderbookImbalance(),  // 15%
      calcMomentumSignal(),      // 13%
      calcVwapSignal(),          // 10%
      calcEmaSignal(),           //  7%
      calcLiquidationSignal(),   //  5%
    ];

    // Display-only (weight 0, shown for context)
    const displayOnly: SignalComponent[] = [
      calcFundingDisplay(),
      calcOpenInterestDisplay(),
      calcCrossExchangeDisplay(),
    ];

    const components = [...weighted, ...displayOnly];

    const totalWeight = weighted.reduce((s, c) => s + c.weight, 0);
    const score = clamp(
      totalWeight > 0
        ? weighted.reduce((s, c) => s + c.score * c.weight, 0) / totalWeight
        : 0
    );

    const confidence = clamp(Math.abs(score) * 1.5, 0, 1);

    let direction: "long" | "short" | "neutral" = "neutral";
    if (score > 0.25) direction = "long";
    else if (score < -0.25) direction = "short";

    const price = aggregator.getPrimaryPrice() || 100000;
    const atr = candleService.getAtr();
    const atrPct = atr > 0 ? (atr / price) * 100 : 0;
    const vwap = candleService.getVwap();

    let leverage: number;
    if (atrPct > 0.4) leverage = 75;
    else if (atrPct > 0.2) leverage = 85;
    else leverage = 100;

    const atrSlDistance = atr > 0 ? Math.max(atr * 1.5, price * 0.0012) : price * 0.0015;

    // ── Cluster-based TP / SL using liquidation map ──
    const MIN_TP_CLUSTER_USD = 3_000_000;  // need $3M+ cluster to use as TP target
    const MIN_SL_CLUSTER_USD = 1_500_000;  // need $1.5M+ cluster as SL danger zone
    const MAX_TP_RANGE = 0.08;             // look up to 8% away for TP
    const MAX_SL_RANGE = 0.05;             // look up to 5% away for SL reference

    const liqMap = coinalyzeService.getCachedMap();
    const buckets = liqMap?.buckets ?? [];

    let suggestedTp: number;
    let suggestedSl: number;
    let tpSource: string;
    let slSource: string;

    if (direction === "long") {
      // TP: nearest significant SHORT liq cluster ABOVE price (shorts squeezed = upside magnet)
      const tpCluster = buckets
        .filter(b => b.price > price && b.price <= price * (1 + MAX_TP_RANGE) && b.shortLiqUsd >= MIN_TP_CLUSTER_USD)
        .sort((a, b) => a.price - b.price)[0];

      if (tpCluster) {
        suggestedTp = parseFloat((tpCluster.price * 0.999).toFixed(2)); // just before cluster
        tpSource = `Кластер шортов $${tpCluster.price.toFixed(0)} (${(tpCluster.shortLiqUsd / 1e6).toFixed(1)}M шортов)`;
      } else {
        suggestedTp = parseFloat((price + atrSlDistance * 1.5).toFixed(2));
        tpSource = "ATR × 1.5 (нет кластера в диапазоне)";
      }

      // SL: nearest large LONG liq cluster BELOW price (cascade danger zone)
      const slCluster = buckets
        .filter(b => b.price < price && b.price >= price * (1 - MAX_SL_RANGE) && b.longLiqUsd >= MIN_SL_CLUSTER_USD)
        .sort((a, b) => b.price - a.price)[0]; // closest to current price

      const atrSlPrice = price - atrSlDistance;
      if (slCluster && slCluster.price > atrSlPrice) {
        // Cluster is between price and ATR SL → exit BEFORE cascade (slightly above cluster)
        suggestedSl = parseFloat((slCluster.price * 1.0005).toFixed(2));
        slSource = `Выше кластера лонгов $${slCluster.price.toFixed(0)} (${(slCluster.longLiqUsd / 1e6).toFixed(1)}M) — до каскада`;
      } else {
        suggestedSl = parseFloat(atrSlPrice.toFixed(2));
        slSource = "ATR × 1.5 (кластер далеко или отсутствует)";
      }

    } else if (direction === "short") {
      // TP: nearest significant LONG liq cluster BELOW price (longs stopped = downside magnet)
      const tpCluster = buckets
        .filter(b => b.price < price && b.price >= price * (1 - MAX_TP_RANGE) && b.longLiqUsd >= MIN_TP_CLUSTER_USD)
        .sort((a, b) => b.price - a.price)[0]; // closest below

      if (tpCluster) {
        suggestedTp = parseFloat((tpCluster.price * 1.001).toFixed(2)); // just above cluster
        tpSource = `Кластер лонгов $${tpCluster.price.toFixed(0)} (${(tpCluster.longLiqUsd / 1e6).toFixed(1)}M лонгов)`;
      } else {
        suggestedTp = parseFloat((price - atrSlDistance * 1.5).toFixed(2));
        tpSource = "ATR × 1.5 (нет кластера в диапазоне)";
      }

      // SL: nearest large SHORT liq cluster ABOVE price (cascade danger for shorts)
      const slCluster = buckets
        .filter(b => b.price > price && b.price <= price * (1 + MAX_SL_RANGE) && b.shortLiqUsd >= MIN_SL_CLUSTER_USD)
        .sort((a, b) => a.price - b.price)[0]; // closest above

      const atrSlPrice = price + atrSlDistance;
      if (slCluster && slCluster.price < atrSlPrice) {
        suggestedSl = parseFloat((slCluster.price * 0.9995).toFixed(2));
        slSource = `Ниже кластера шортов $${slCluster.price.toFixed(0)} (${(slCluster.shortLiqUsd / 1e6).toFixed(1)}M) — до каскада`;
      } else {
        suggestedSl = parseFloat(atrSlPrice.toFixed(2));
        slSource = "ATR × 1.5 (кластер далеко или отсутствует)";
      }

    } else {
      suggestedTp = parseFloat((price + atrSlDistance * 1.5).toFixed(2));
      suggestedSl = parseFloat((price - atrSlDistance).toFixed(2));
      tpSource = "ATR (нейтральное направление)";
      slSource = "ATR (нейтральное направление)";
    }

    // ── Entry gates ──
    const dirSign = direction === "long" ? 1 : direction === "short" ? -1 : 0;
    const cvdComp      = weighted.find(c => c.name === "CVD Trend");
    const momentumComp = weighted.find(c => c.name === "Trade Momentum");
    const patternComp  = weighted.find(c => c.name === "Historical Pattern");

    // Gate 1 (PRIMARY): Pattern — correlation ≥ 75%, signal strength ≥ 0.20, direction match
    const MIN_PATTERN_SIMILARITY = 0.75;
    const MIN_PATTERN_SIGNAL = 0.20;
    let patternPassed = false;
    let patternReason = "";
    if (!patternService.isReady()) {
      patternReason = "Исторические данные загружаются";
    } else if (direction === "neutral") {
      patternReason = "Направление нейтральное";
    } else {
      const pr = patternService.getResult()!;
      const topSim = pr.topMatches[0]?.similarity ?? 0;
      const pScore = patternComp?.score ?? 0;
      const pAbs = Math.abs(pScore);
      const dirOk = pScore * dirSign > 0;
      const simOk = topSim >= MIN_PATTERN_SIMILARITY;
      const strengthOk = pAbs >= MIN_PATTERN_SIGNAL;
      patternPassed = dirOk && simOk && strengthOk;
      const simStr = `топ r=${(topSim * 100).toFixed(1)}% ${simOk ? "✓" : `< ${(MIN_PATTERN_SIMILARITY * 100).toFixed(0)}% ✗`}`;
      const strStr = `сила |${pScore.toFixed(3)}| ${strengthOk ? "✓" : `< ${MIN_PATTERN_SIGNAL} ✗`}`;
      const dirStr = dirOk ? "направление ✓" : "направление ✗";
      patternReason = `${simStr} | ${strStr} | ${dirStr}`;
    }
    const gate1: GateResult = { name: "Паттерн-матчинг (первичный)", passed: patternPassed, reason: patternReason };

    // Gate 2: Volume — CVD AND Momentum both confirm direction
    let volumePassed = false;
    let volumeReason = "";
    if (direction === "neutral") {
      volumeReason = "Направление нейтральное";
    } else {
      const cvdOk = cvdComp ? cvdComp.score * dirSign > 0 : false;
      const momOk = momentumComp ? momentumComp.score * dirSign > 0 : false;
      volumePassed = cvdOk && momOk;
      const cvdStr = `CVD ${cvdComp ? (cvdComp.score >= 0 ? "+" : "") + cvdComp.score.toFixed(2) : "?"} ${cvdOk ? "✓" : "✗"}`;
      const momStr = `Мом. ${momentumComp ? (momentumComp.score >= 0 ? "+" : "") + momentumComp.score.toFixed(2) : "?"} ${momOk ? "✓" : "✗"}`;
      volumeReason = `${cvdStr} | ${momStr}`;
    }
    const gate2: GateResult = { name: "Объём (CVD + Моментум)", passed: volumePassed, reason: volumeReason };

    const gates: GateResult[] = [gate1, gate2];
    // Pattern is primary and sufficient — Gate 2 is informational context only
    const allGatesPassed = direction !== "neutral" && gate1.passed;

    return {
      score: parseFloat(score.toFixed(4)),
      direction,
      confidence: parseFloat(confidence.toFixed(4)),
      components,
      gates,
      allGatesPassed,
      suggestedLeverage: leverage,
      suggestedSl,
      suggestedTp,
      atrPct: parseFloat(atrPct.toFixed(4)),
      vwap: parseFloat(vwap.toFixed(2)),
      updatedAt: new Date().toISOString(),
      tpSource,
      slSource,
    };
  }
}

export const signalEngine = new SignalEngine();
