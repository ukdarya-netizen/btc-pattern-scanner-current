import { Router } from "express";
import { coinglassService } from "../services/coinglassService";

const router = Router();

router.get("/coinglass/history", (_req, res) => {
  res.json({
    fundingRate: coinglassService.getFundingRateTrend(),
    longShort:   coinglassService.getLongShortTrend(),
  });
});

export default router;
