import { Router, type IRouter } from "express";
import { altScanner } from "../services/altScanner";
import { dbService } from "../services/dbService";

const router: IRouter = Router();

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

export default router;
