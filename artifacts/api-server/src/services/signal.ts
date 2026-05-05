import { aggregator } from "./exchanges/aggregator";
import { cvdService } from "./cvd";
import { candleService } from "./candleService";
import { patternService } from "./patternService";

export interface SignalComponent {
  name: string;
  score: number;
  weight: number;
  description: string;
}

export interface SignalResult {
  score: number;
  direction: "long" | "short" | "neutral";
  confidence: number;
  components: SignalComponent[];
  suggestedLeverage: number;
  suggestedSl: number;
  suggestedTp: number;
  atrPct: number;
  vwap: number;
  updatedAt: string;
}

function clamp(val: number, min = -1, max = 1): number {
  return Math.max(min, Math.min(max, val));
}

// Weights: OB 0.20 + CVD 0.22 + Funding 0.08 + Momentum 0.13 + OI 0.05 + VWAP 0.12 + EMA 0.10 + Pattern 0.10 = 1.00
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
    weight: 0.22,
    description: `Trend: ${trend}, CVD: ${cvdService.getCurrentCvd().toFixed(2)}`,
  };
}

function calcFundingSignal(): SignalComponent {
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
    weight: 0.08,
    description: `Rate: ${(fundingRate * 100).toFixed(4)}% avg (${exchanges}) — ${score > 0 ? "shorts squeezed, longs favored" : score < 0 ? "longs squeezed, shorts favored" : "neutral"}`,
  };
}

function calcMomentumSignal(): SignalComponent {
  const trades = aggregator.getAllTrades().slice(0, 60);
  if (trades.length === 0) return { name: "Trade Momentum", score: 0, weight: 0.15, description: "No data" };

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

function calcOpenInterestSignal(): SignalComponent {
  const oi = aggregator.getPrimaryOpenInterest();
  const price = aggregator.getPrimaryPrice();
  const exchanges = aggregator.getActiveExchangeNames().join("+");
  if (price === 0 || oi === 0) return { name: "Open Interest", score: 0, weight: 0.05, description: "No OI data" };

  const oiUsd = oi * price;
  const cvdTrend = cvdService.getTrend();
  const score = cvdTrend === "bullish" ? 0.4 : cvdTrend === "bearish" ? -0.4 : 0;

  return {
    name: "Open Interest",
    score,
    weight: 0.05,
    description: `OI: $${(oiUsd / 1e9).toFixed(2)}B combined (${exchanges}) — ${cvdTrend}`,
  };
}

function calcVwapSignal(): SignalComponent {
  const price = aggregator.getPrimaryPrice();
  const vwap = candleService.getVwap();
  const atr = candleService.getAtr();

  if (vwap === 0 || price === 0) {
    return { name: "VWAP Deviation", score: 0, weight: 0.15, description: "Accumulating VWAP data..." };
  }

  const deviation = (price - vwap) / vwap;
  const score = clamp(deviation / 0.004 * 0.8);

  const sigma = atr > 0 ? Math.abs(price - vwap) / atr : 0;
  const direction = deviation >= 0 ? "above" : "below";
  const urgency = sigma > 2 ? " — extreme, mean reversion likely" : sigma > 1 ? " — extended" : "";

  return {
    name: "VWAP Deviation",
    score,
    weight: 0.12,
    description: `$${price.toFixed(1)} ${direction} VWAP $${vwap.toFixed(1)} by ${(Math.abs(deviation) * 100).toFixed(3)}% (${sigma.toFixed(1)}σ)${urgency}`,
  };
}

function calcEmaSignal(): SignalComponent {
  const ema9 = candleService.getEma(9);
  const ema21 = candleService.getEma(21);
  const price = aggregator.getPrimaryPrice();
  const candleCount = candleService.getCandleCount();

  if (ema9 === 0 || ema21 === 0 || candleCount < 5) {
    return { name: "EMA 9/21", score: 0, weight: 0.10, description: `Building candle history... (${candleCount} candles)` };
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
    weight: 0.10,
    description: `${crossLabel} | ${priceVsEma} | EMA9: $${ema9.toFixed(1)} EMA21: $${ema21.toFixed(1)}`,
  };
}

function calcPatternSignal(): SignalComponent {
  if (!patternService.isReady()) {
    return { name: "Historical Pattern", score: 0, weight: 0.10, description: "Загрузка исторических данных..." };
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
    score: Math.max(-1, Math.min(1, score)),
    weight: 0.10,
    description: `Топ совпадение: ${topMatch?.startDate ?? "—"} (r=${simPct}%) → ${fwdLabel} | Бычьих: ${bull} / Медвежьих: ${bear} / Нейтр: ${neutral} из ${result.topMatches.length}`,
  };
}

function calcCrossExchangeSignal(): SignalComponent {
  const agg = aggregator.getAggregatedTicker();
  if (!agg || Object.keys(agg.prices).length < 2) {
    return { name: "Cross-Exchange Spread", score: 0, weight: 0.05, description: "Need 2+ exchanges" };
  }

  const prices = Object.values(agg.prices);
  const max = Math.max(...prices);
  const min = Math.min(...prices);
  const spread = (max - min) / agg.avgPrice;

  let score = 0;
  if (spread > 0.0005) {
    const bestBidEx = agg.bestBid.exchange;
    const bestAskEx = agg.bestAsk.exchange;
    score = bestBidEx !== bestAskEx ? 0.2 : 0;
  }

  const priceParts = Object.entries(agg.prices)
    .map(([ex, p]) => `${ex}: $${p.toFixed(1)}`)
    .join(" | ");

  return {
    name: "Cross-Exchange Spread",
    score,
    weight: 0.00,
    description: priceParts,
  };
}

class SignalEngine {
  compute(): SignalResult {
    const components = [
      calcOrderbookImbalance(),
      calcCvdSignal(),
      calcFundingSignal(),
      calcMomentumSignal(),
      calcOpenInterestSignal(),
      calcVwapSignal(),
      calcEmaSignal(),
      calcPatternSignal(),
      calcCrossExchangeSignal(),
    ];

    const weightedComponents = components.filter(c => c.weight > 0);
    const totalWeight = weightedComponents.reduce((s, c) => s + c.weight, 0);
    const score = clamp(
      totalWeight > 0
        ? weightedComponents.reduce((s, c) => s + c.score * c.weight, 0) / totalWeight
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

    const slDistance = atr > 0
      ? Math.max(atr * 1.5, price * 0.0012)
      : price * 0.0015;
    const tpDistance = slDistance * 1.5;

    const slDir = direction === "long" ? -1 : 1;
    const tpDir = direction === "long" ? 1 : -1;

    return {
      score: parseFloat(score.toFixed(4)),
      direction,
      confidence: parseFloat(confidence.toFixed(4)),
      components,
      suggestedLeverage: leverage,
      suggestedSl: parseFloat((price + slDir * slDistance).toFixed(2)),
      suggestedTp: parseFloat((price + tpDir * tpDistance).toFixed(2)),
      atrPct: parseFloat(atrPct.toFixed(4)),
      vwap: parseFloat(vwap.toFixed(2)),
      updatedAt: new Date().toISOString(),
    };
  }
}

export const signalEngine = new SignalEngine();
