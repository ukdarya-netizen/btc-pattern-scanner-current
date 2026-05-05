import { Router } from "express";
import { liquidationService } from "../services/liquidationService";
import { coinglassService } from "../services/coinglassService";
import { coinalyzeService } from "../services/coinalyzeService";

const router = Router();

router.get("/liquidations/heatmap", (_req, res) => {
  const buckets = liquidationService.getHeatmapBuckets();
  const summary = liquidationService.getSummary();
  res.json({ buckets, summary });
});

router.get("/liquidations/events", (req, res) => {
  const limit = Math.min(parseInt(String(req.query["limit"] ?? "50")), 200);
  const events = liquidationService.getRecentEvents(limit);
  res.json({ events });
});

router.get("/liquidations/info", async (_req, res) => {
  const info = await coinglassService.getLiquidationInfo();
  res.json(info ?? {});
});

router.get("/liquidations/map", async (_req, res) => {
  const map = await coinalyzeService.getLiquidationMap();
  res.json(map ?? { buckets: [], currentPrice: 0, priceRange: { min: 0, max: 0 }, updatedAt: 0 });
});

router.get("/liquidations/coinalyze", async (req, res) => {
  const range = String(req.query["range"] ?? "24h");
  const candles = range === "2h" ? await coinalyzeService.get2h() : await coinalyzeService.get24h();
  res.json({ candles, range });
});

export default router;
