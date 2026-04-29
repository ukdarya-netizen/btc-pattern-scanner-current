import { Router } from "express";
import { riskManager } from "../services/riskManager";
import { bybitService } from "../services/bybit";

const router = Router();

router.get("/risk/stats", (_req, res) => {
  res.json(riskManager.getStats());
});

router.get("/risk/positions", (_req, res) => {
  const price = bybitService.ticker.lastPrice;
  if (price > 0) riskManager.updatePositionPrices(price);
  res.json({ positions: riskManager.getPositions() });
});

export default router;
