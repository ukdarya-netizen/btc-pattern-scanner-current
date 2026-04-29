import { Router } from "express";
import { signalEngine } from "../services/signal";

const router = Router();

router.get("/signal/current", (_req, res) => {
  res.json(signalEngine.compute());
});

export default router;
