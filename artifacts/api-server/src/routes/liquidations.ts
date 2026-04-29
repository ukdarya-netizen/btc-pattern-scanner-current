import { Router } from "express";
import { liquidationService } from "../services/liquidationService";
import { coinglassService } from "../services/coinglassService";

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

export default router;
