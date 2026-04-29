import { Router } from "express";
import { dbService } from "../services/dbService";
import { aggregator } from "../services/exchanges/aggregator";
import { riskManager } from "../services/riskManager";

const router = Router();

router.get("/history/trades", async (_req, res) => {
  const limit = Math.min(parseInt(String(_req.query["limit"] ?? "100")), 500);
  const dbTrades = await dbService.getRecentTrades(limit);
  const inMemory = riskManager.getClosedTrades();

  const dbIds = new Set(dbTrades.map(t => t.id));
  const memOnlyTrades = inMemory.filter(t => !dbIds.has(t.id));

  const all = [
    ...memOnlyTrades.map(t => ({
      id: t.id,
      symbol: t.symbol,
      side: t.side,
      exchange: "Bybit",
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      size: t.size,
      leverage: t.leverage,
      pnl: t.pnl,
      pnlPct: t.pnlPct,
      openedAt: t.openedAt,
      closedAt: t.closedAt,
      closeReason: t.closeReason,
    })),
    ...dbTrades.map(t => ({
      id: t.id,
      symbol: t.symbol,
      side: t.side,
      exchange: t.exchange,
      entryPrice: parseFloat(String(t.entryPrice)),
      exitPrice: parseFloat(String(t.exitPrice)),
      size: parseFloat(String(t.size)),
      leverage: t.leverage,
      pnl: parseFloat(String(t.pnl)),
      pnlPct: parseFloat(String(t.pnlPct)),
      openedAt: String(t.openedAt ?? ""),
      closedAt: String(t.closedAt ?? ""),
      closeReason: t.closeReason ?? "manual",
    })),
  ].slice(0, limit);

  const stats = await dbService.getDailyStats();
  res.json({ trades: all, stats });
});

router.get("/history/pnl", async (req, res) => {
  const hours = parseInt(String(req.query["hours"] ?? "24"));
  const snapshots = await dbService.getPnlChart(hours);
  res.json({
    points: snapshots.map(s => ({
      ts: String(s.ts),
      equity: parseFloat(String(s.equity)),
      dailyPnl: parseFloat(String(s.dailyPnl)),
      openPositions: s.openPositions,
    })),
    hours,
  });
});

router.get("/account/balance", async (_req, res) => {
  const balances = await aggregator.getAllBalances();
  const primary = balances["Bybit"] ?? balances["BingX"] ?? null;

  res.json({
    total: primary?.total ?? riskManager.getAccountBalance(),
    available: primary?.available ?? riskManager.getAccountBalance(),
    currency: "USDT",
    byExchange: Object.fromEntries(
      Object.entries(balances).map(([name, b]) => [name, {
        total: b.total,
        available: b.available,
      }])
    ),
  });
});

export default router;
