import { Router, type IRouter } from "express";
import { altScanner } from "../services/altScanner";
import { dbService } from "../services/dbService";
import { apiStatusService } from "../services/apiStatus";

const router: IRouter = Router();

router.get("/scanner/api-status", (_req, res) => {
  res.json(apiStatusService.getAll());
});

router.get("/scanner/metrics", (_req, res) => {
  res.json(altScanner.getLatestMetrics());
});

router.get("/scanner/hits", (_req, res) => {
  res.json(altScanner.getRecentHits());
});

router.get("/scanner/signals", async (_req, res) => {
  const signals = await dbService.getRecentSignals(100);
  res.json(signals);
});

router.get("/scanner/open-positions", (_req, res) => {
  res.json(altScanner.getOpenPositions());
});

router.get("/scanner/stats/overall", async (_req, res) => {
  const stats = await dbService.getOverallStats();
  res.json(stats);
});

router.get("/scanner/stats/patterns", async (_req, res) => {
  const stats = await dbService.getPatternStats();
  res.json(stats);
});

export default router;
