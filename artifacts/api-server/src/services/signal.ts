import { aggregator } from "./exchanges/aggregator";
import { cvdService } from "./cvd";

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
  updatedAt: string;
}

function clamp(val: number, min = -1, max = 1): number {
  return Math.max(min, Math.min(max, val));
}

function calcOrderbookImbalance(): SignalComponent {
  const ob = aggregator.getAggregatedOrderbook();
  if (!ob) return { name: "Order Book Imbalance", score: 0, weight: 0.25, description: "No data" };

  const bidVol = ob.mergedBids.slice(0, 10).reduce((s, l) => s + l.size, 0);
  const askVol = ob.mergedAsks.slice(0, 10).reduce((s, l) => s + l.size, 0);
  const total = bidVol + askVol;
  const score = total > 0 ? clamp((bidVol - askVol) / total * 3) : 0;

  const exchanges = Object.keys(ob.byExchange).join(", ");
  return {
    name: "Order Book Imbalance",
    score,
    weight: 0.25,
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
    weight: 0.30,
    description: `Trend: ${trend}, CVD: ${cvdService.getCurrentCvd().toFixed(2)}`,
  };
}

function calcFundingSignal(): SignalComponent {
  const fundingRate = aggregator.getPrimaryFundingRate();
  let score = 0;
  if (fundingRate > 0.001) score = -0.5;
  else if (fundingRate > 0.0005) score = -0.25;
  else if (fundingRate < -0.001) score = 0.5;
  else if (fundingRate < -0.0005) score = 0.25;

  return {
    name: "Funding Rate",
    score,
    weight: 0.15,
    description: `Rate: ${(fundingRate * 100).toFixed(4)}% — ${score > 0 ? "shorts squeezed, longs favored" : score < 0 ? "longs squeezed, shorts favored" : "neutral"}`,
  };
}

function calcMomentumSignal(): SignalComponent {
  const trades = aggregator.getPrimaryTrades().slice(0, 30);
  if (trades.length === 0) return { name: "Trade Momentum", score: 0, weight: 0.20, description: "No data" };

  const buyVol = trades.filter(t => t.side === "buy").reduce((s, t) => s + t.size, 0);
  const sellVol = trades.filter(t => t.side === "sell").reduce((s, t) => s + t.size, 0);
  const total = buyVol + sellVol;
  const score = total > 0 ? clamp((buyVol - sellVol) / total * 2) : 0;

  return {
    name: "Trade Momentum",
    score,
    weight: 0.20,
    description: `Buy: ${buyVol.toFixed(2)} BTC vs Sell: ${sellVol.toFixed(2)} BTC (last 30 trades)`,
  };
}

function calcOpenInterestSignal(): SignalComponent {
  const oi = aggregator.getPrimaryOpenInterest();
  const price = aggregator.getPrimaryPrice();
  if (price === 0 || oi === 0) return { name: "Open Interest", score: 0, weight: 0.10, description: "No OI data" };

  const oiUsd = oi * price;
  const cvdTrend = cvdService.getTrend();
  let score = cvdTrend === "bullish" ? 0.4 : cvdTrend === "bearish" ? -0.4 : 0;

  return {
    name: "Open Interest",
    score,
    weight: 0.10,
    description: `OI: $${(oiUsd / 1e9).toFixed(2)}B — ${cvdTrend}`,
  };
}

function calcCrossExchangeSignal(): SignalComponent {
  const agg = aggregator.getAggregatedTicker();
  if (!agg || Object.keys(agg.prices).length < 2) {
    return { name: "Cross-Exchange Spread", score: 0, weight: 0.00, description: "Need 2+ exchanges" };
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
    const leverage = Math.max(3, Math.min(20, Math.floor(20 * confidence)));
    const slPct = Math.max(0.3, 1.5 / leverage);
    const tpPct = slPct * 2;
    const slDir = direction === "long" ? -1 : 1;
    const tpDir = direction === "long" ? 1 : -1;

    return {
      score: parseFloat(score.toFixed(4)),
      direction,
      confidence: parseFloat(confidence.toFixed(4)),
      components,
      suggestedLeverage: leverage,
      suggestedSl: parseFloat((price * (1 + slDir * slPct / 100)).toFixed(2)),
      suggestedTp: parseFloat((price * (1 + tpDir * tpPct / 100)).toFixed(2)),
      updatedAt: new Date().toISOString(),
    };
  }
}

export const signalEngine = new SignalEngine();
