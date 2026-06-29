import { Router } from "express";
import { statsScheduler } from "../services/statsScheduler";
import { telegramService } from "../services/telegram";
import { coinglassService } from "../services/coinglassService";

const router = Router();

router.post("/admin/report/daily", async (_req, res) => {
  await statsScheduler.sendDailyNow();
  res.json({ ok: true, sent: "daily" });
});

router.post("/admin/report/weekly", async (_req, res) => {
  await statsScheduler.sendWeeklyNow();
  res.json({ ok: true, sent: "weekly" });
});

router.post("/admin/notify", (req, res) => {
  const { message } = req.body as { message?: string };
  if (!message) { res.status(400).json({ ok: false, error: "message required" }); return; }
  telegramService.notifyChannel(message);
  res.json({ ok: true });
});

router.post("/admin/report/market", async (_req, res) => {
  await statsScheduler.sendMarketReportNow();
  res.json({ ok: true, sent: "market" });
});

router.get("/admin/coinglass-check", async (_req, res) => {
  const result = await coinglassService.checkSubscriptionAndEndpoints();
  res.json(result);
});

export default router;
