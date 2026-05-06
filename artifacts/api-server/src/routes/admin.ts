import { Router } from "express";
import { statsScheduler } from "../services/statsScheduler";

const router = Router();

router.post("/admin/report/daily", async (_req, res) => {
  await statsScheduler.sendDailyNow();
  res.json({ ok: true, sent: "daily" });
});

router.post("/admin/report/weekly", async (_req, res) => {
  await statsScheduler.sendWeeklyNow();
  res.json({ ok: true, sent: "weekly" });
});

export default router;
