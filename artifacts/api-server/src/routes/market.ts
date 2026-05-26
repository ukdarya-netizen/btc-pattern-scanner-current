import { Router } from "express";
import { aggregator } from "../services/exchanges/aggregator";
import { cvdService } from "../services/cvd";
import { coinglassService } from "../services/coinglassService";

const router = Router();

router.get("/market/ticker", (_req, res) => {
  const agg = aggregator.getAggregatedTicker();
  if (!agg) {
    res.json({
      symbol: "BTCUSDT", price: 0, priceChange24h: 0, priceChangePct24h: 0,
      volume24h: 0, high24h: 0, low24h: 0, updatedAt: new Date().toISOString(),
    });
    return;
  }
  res.json({
    symbol: "BTCUSDT",
    price: parseFloat(agg.avgPrice.toFixed(2)),
    priceChange24h: parseFloat(agg.priceChange24h.toFixed(2)),
    priceChangePct24h: parseFloat(agg.priceChangePct24h.toFixed(4)),
    volume24h: parseFloat(agg.volume24h.toFixed(2)),
    high24h: agg.high24h,
    low24h: agg.low24h,
    updatedAt: agg.updatedAt,
    _meta: {
      exchanges: agg.prices,
      bestBid: agg.bestBid,
      bestAsk: agg.bestAsk,
    },
  });
});

router.get("/market/orderbook", (_req, res) => {
  const exchange = String((_req.query["exchange"] as string) ?? "");
  const agg = aggregator.getAggregatedOrderbook();

  if (!agg) {
    res.json({ symbol: "BTCUSDT", bids: [], asks: [], spread: 0, spreadPct: 0, imbalance: 0, updatedAt: new Date().toISOString() });
    return;
  }

  if (exchange && agg.byExchange[exchange]) {
    const ob = agg.byExchange[exchange];
    res.json({
      symbol: ob.symbol,
      bids: ob.bids.slice(0, 20),
      asks: ob.asks.slice(0, 20),
      spread: parseFloat(ob.spread.toFixed(2)),
      spreadPct: parseFloat(ob.spreadPct.toFixed(6)),
      imbalance: parseFloat(ob.imbalance.toFixed(4)),
      updatedAt: new Date(ob.updatedAt).toISOString(),
    });
    return;
  }

  res.json({
    symbol: "BTCUSDT",
    bids: agg.mergedBids.slice(0, 20),
    asks: agg.mergedAsks.slice(0, 20),
    spread: parseFloat(agg.bestSpread.spread.toFixed(2)),
    spreadPct: 0,
    imbalance: parseFloat(agg.avgImbalance.toFixed(4)),
    updatedAt: agg.updatedAt,
    _meta: {
      bestSpread: agg.bestSpread,
      worstSpread: agg.worstSpread,
      exchanges: Object.keys(agg.byExchange),
    },
  });
});

router.get("/market/trades", (_req, res) => {
  const trades = aggregator.getAllTrades().slice(0, 50).map(t => ({
    id: t.id,
    price: t.price,
    size: parseFloat(t.size.toFixed(6)),
    side: t.side,
    timestamp: new Date(t.timestamp).toISOString(),
    exchange: t.exchange,
  }));
  res.json({ trades });
});

router.get("/market/cvd", (_req, res) => {
  res.json({
    points: cvdService.getPoints(),
    currentCvd: parseFloat(cvdService.getCurrentCvd().toFixed(4)),
    trend: cvdService.getTrend(),
  });
});

router.get("/market/funding", (_req, res) => {
  const agg = aggregator.getAggregatedTicker();
  const cgOi = coinglassService.getAggregatedOi();

  // Prefer CoinGlass aggregated funding rate (25 exchanges) over Bybit-only
  const fundingRate = cgOi?.avgFundingRate ?? agg?.fundingRate ?? 0;
  const openInterest = cgOi?.totalOiUsd ?? agg?.openInterest ?? 0;
  const openInterestChange1h = cgOi?.h1ChangePct ?? 0;

  res.json({
    fundingRate,
    fundingRateByVol: cgOi?.avgFundingRateByVol ?? fundingRate,
    nextFundingTime: agg?.nextFundingTime
      ? new Date(agg.nextFundingTime).toISOString()
      : new Date(Date.now() + 8 * 3600000).toISOString(),
    openInterest,
    openInterestChange1h,
    openInterestChange4h: cgOi?.h4ChangePct ?? 0,
    openInterestChange24h: cgOi?.h24ChangePct ?? 0,
    longShortRatio: 1.0,
    source: cgOi ? "coinglass_aggregated" : "bybit",
  });
});

router.get("/market/oi", (_req, res) => {
  const cgOi = coinglassService.getAggregatedOi();
  if (!cgOi) {
    res.json({ available: false, exchanges: [] });
    return;
  }
  res.json({
    available: true,
    totalOiUsd: cgOi.totalOiUsd,
    m5ChangePct: cgOi.m5ChangePct,
    m15ChangePct: cgOi.m15ChangePct,
    h1ChangePct: cgOi.h1ChangePct,
    h4ChangePct: cgOi.h4ChangePct,
    h24ChangePct: cgOi.h24ChangePct,
    avgFundingRate: cgOi.avgFundingRate,
    avgFundingRateByVol: cgOi.avgFundingRateByVol,
    volUsd24h: cgOi.volUsd24h,
    oiVolRatio: cgOi.oiVolRatio,
    exchanges: cgOi.exchanges.slice(0, 10).map(e => ({
      exchange: e.exchange,
      oiUsd: e.oiUsd,
      h1ChangePct: e.h1ChangePct,
      h4ChangePct: e.h4ChangePct,
      fundingRate: e.fundingRate,
    })),
    updatedAt: new Date(cgOi.updatedAt).toISOString(),
  });
});

router.get("/market/exchanges", (_req, res) => {
  res.json({ exchanges: aggregator.getStatus() });
});

export default router;
