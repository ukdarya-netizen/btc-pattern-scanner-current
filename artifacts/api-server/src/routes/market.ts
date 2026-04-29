import { Router } from "express";
import { bybitService } from "../services/bybit";
import { cvdService } from "../services/cvd";
import { riskManager } from "../services/riskManager";

const router = Router();

router.get("/market/ticker", (_req, res) => {
  const t = bybitService.ticker;
  const priceChange = t.lastPrice - t.prevPrice24h;
  res.json({
    symbol: t.symbol,
    price: t.lastPrice,
    priceChange24h: parseFloat(priceChange.toFixed(2)),
    priceChangePct24h: parseFloat((t.price24hPcnt * 100).toFixed(4)),
    volume24h: parseFloat(t.volume24h.toFixed(2)),
    high24h: t.highPrice24h,
    low24h: t.lowPrice24h,
    updatedAt: new Date().toISOString(),
  });
});

router.get("/market/orderbook", (_req, res) => {
  const ob = bybitService.orderbook;
  const bids = ob.bids.slice(0, 20);
  const asks = ob.asks.slice(0, 20);

  let bidTotal = 0;
  const bidsWithTotal = bids.map((l) => {
    bidTotal += l.size;
    return { price: l.price, size: l.size, total: parseFloat(bidTotal.toFixed(4)) };
  });

  let askTotal = 0;
  const asksWithTotal = asks.map((l) => {
    askTotal += l.size;
    return { price: l.price, size: l.size, total: parseFloat(askTotal.toFixed(4)) };
  });

  const spread = asks.length > 0 && bids.length > 0 ? asks[0].price - bids[0].price : 0;
  const midPrice = asks.length > 0 && bids.length > 0 ? (asks[0].price + bids[0].price) / 2 : 0;
  const spreadPct = midPrice > 0 ? spread / midPrice * 100 : 0;

  const bidVol = bids.reduce((s, l) => s + l.size, 0);
  const askVol = asks.reduce((s, l) => s + l.size, 0);
  const totalVol = bidVol + askVol;
  const imbalance = totalVol > 0 ? (bidVol - askVol) / totalVol : 0;

  res.json({
    symbol: ob.symbol,
    bids: bidsWithTotal,
    asks: asksWithTotal,
    spread: parseFloat(spread.toFixed(2)),
    spreadPct: parseFloat(spreadPct.toFixed(6)),
    imbalance: parseFloat(imbalance.toFixed(4)),
    updatedAt: new Date(ob.updatedAt).toISOString(),
  });
});

router.get("/market/trades", (_req, res) => {
  const trades = bybitService.trades.slice(0, 50).map((t) => ({
    id: t.id,
    price: t.price,
    size: parseFloat(t.size.toFixed(6)),
    side: t.side,
    timestamp: new Date(t.timestamp).toISOString(),
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
  const t = bybitService.ticker;
  res.json({
    fundingRate: t.fundingRate,
    nextFundingTime: t.nextFundingTime > 0 ? new Date(t.nextFundingTime).toISOString() : new Date(Date.now() + 8 * 3600000).toISOString(),
    openInterest: t.openInterest,
    openInterestChange1h: 0,
    longShortRatio: 1.0,
  });
});

export default router;
