import { Router, type IRouter } from "express";
import { telegramService } from "../services/telegram";

const router: IRouter = Router();

router.post("/admin/notify", (req, res) => {
  const { message } = req.body as { message?: string };
  if (!message) { res.status(400).json({ ok: false, error: "message required" }); return; }
  telegramService.notifyChannel(message);
  res.json({ ok: true });
});

export default router;
