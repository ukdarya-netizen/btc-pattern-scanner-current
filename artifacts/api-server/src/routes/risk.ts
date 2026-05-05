import { Router } from "express";
import { riskManager } from "../services/riskManager";
import { aggregator } from "../services/exchanges/aggregator";
import { dbService } from "../services/dbService";

const router = Router();

router.get("/risk/stats", async (_req, res) => {
  const memStats = riskManager.getStats();

  if (memStats.totalTrades > 0) {
    res.json(memStats);
    return;
  }

  const db = await dbService.getDailyStats();
  if (db.totalTrades > 0) {
    const wins = db.wins ?? 0;
    const total = db.totalTrades;
    res.json({
      ...memStats,
      totalTrades: total,
      winningTrades: wins,
      losingTrades: total - wins,
      winRate: total > 0 ? wins / total : 0,
      dailyPnl: db.totalPnl,
      dailyPnlPct: memStats.dailyPnlPct,
    });
    return;
  }

  res.json(memStats);
});

router.get("/risk/positions", (_req, res) => {
  const price = aggregator.getPrimaryPrice();
  if (price > 0) riskManager.updatePositionPrices(price);
  res.json({ positions: riskManager.getPositions() });
});

export default router;
