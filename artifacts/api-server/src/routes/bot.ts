import { Router } from "express";
import { botEngine } from "../services/botEngine";
import { StartBotBody } from "@workspace/api-zod";

const router = Router();

router.get("/bot/state", (_req, res) => {
  res.json(botEngine.getState());
});

router.post("/bot/start", async (req, res) => {
  const parsed = StartBotBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  await botEngine.start(parsed.data);
  res.json(botEngine.getState());
});

router.post("/bot/stop", async (_req, res) => {
  await botEngine.stop();
  res.json(botEngine.getState());
});

export default router;
