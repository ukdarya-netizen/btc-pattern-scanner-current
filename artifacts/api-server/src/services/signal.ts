import { bybitService } from "./bybit";
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
  const { bids, asks } = bybitService.orderbook;
  const bidVol = bids.slice(0, 10).reduce((s, l) => s + l.size, 0);
  const askVol = asks.slice(0, 10).reduce((s, l) => s + l.size, 0);
  const total = bidVol + askVol;
  const score = total > 0 ? clamp((bidVol - askVol) / total * 3) : 0;
  return {
    name: "Order Book Imbalance",
    score,
    weight: 0.25,
    description: `Bid vol: ${bidVol.toFixed(2)} BTC vs Ask vol: ${askVol.toFixed(2)} BTC`,
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
  const { fundingRate } = bybitService.ticker;
  let score = 0;
  if (fundingRate > 0.001) score = -0.5;
  else if (fundingRate > 0.0005) score = -0.25;
  else if (fundingRate < -0.001) score = 0.5;
  else if (fundingRate < -0.0005) score = 0.25;

  return {
    name: "Funding Rate",
    score,
    weight: 0.15,
    description: `Rate: ${(fundingRate * 100).toFixed(4)}% — ${score > 0 ? "longs squeezed, shorts favored" : score < 0 ? "shorts squeezed, longs favored" : "neutral"}`,
  };
}

function calcMomentumSignal(): SignalComponent {
  const { trades } = bybitService;
  const recent = trades.slice(0, 30);
  if (recent.length === 0) return { name: "Trade Momentum", score: 0, weight: 0.20, description: "No data" };

  const buyVol = recent.filter((t) => t.side === "buy").reduce((s, t) => s + t.size, 0);
  const sellVol = recent.filter((t) => t.side === "sell").reduce((s, t) => s + t.size, 0);
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
  const price = bybitService.ticker.lastPrice;
  const oi = bybitService.ticker.openInterest;
  if (price === 0 || oi === 0) return { name: "Open Interest", score: 0, weight: 0.10, description: "No OI data" };

  const oiInUsd = oi * price;
  const cvdTrend = cvdService.getTrend();
  let score = 0;
  if (cvdTrend === "bullish") score = 0.4;
  else if (cvdTrend === "bearish") score = -0.4;

  return {
    name: "Open Interest",
    score,
    weight: 0.10,
    description: `OI: $${(oiInUsd / 1e9).toFixed(2)}B — growing ${cvdTrend === "bullish" ? "with bullish" : cvdTrend === "bearish" ? "with bearish" : "neutral"} price`,
  };
}

function suggestLeverage(confidence: number, atr: number): number {
  const baseMax = 20;
  const confFactor = confidence;
  const leverage = Math.floor(baseMax * confFactor);
  return Math.max(3, Math.min(baseMax, leverage));
}

class SignalEngine {
  compute(): SignalResult {
    const components = [
      calcOrderbookImbalance(),
      calcCvdSignal(),
      calcFundingSignal(),
      calcMomentumSignal(),
      calcOpenInterestSignal(),
    ];

    const score = clamp(
      components.reduce((s, c) => s + c.score * c.weight, 0) /
        components.reduce((s, c) => s + c.weight, 0)
    );

    const absScore = Math.abs(score);
    const confidence = clamp(absScore * 1.5, 0, 1);

    let direction: "long" | "short" | "neutral" = "neutral";
    if (score > 0.25) direction = "long";
    else if (score < -0.25) direction = "short";

    const price = bybitService.ticker.lastPrice || 100000;
    const leverage = suggestLeverage(confidence, 500);
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
