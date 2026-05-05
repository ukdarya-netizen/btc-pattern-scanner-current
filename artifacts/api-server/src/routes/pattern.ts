import { Router } from "express";
import { patternService } from "../services/patternService";

const router = Router();

router.get("/pattern/current", (_req, res) => {
  const result = patternService.getResult();
  if (!result) {
    res.json({
      signal: 0,
      confidence: 0,
      bullishMatches: 0,
      bearishMatches: 0,
      topMatches: [],
      currentReturns: [],
      updatedAt: new Date().toISOString(),
      loading: true,
    });
    return;
  }
  res.json({ ...result, loading: false });
});

export default router;
