import { Router } from "express";
import { fractalService } from "../services/fractalService";

const router = Router();

router.get("/fractal/signal", (_req, res) => {
  const combined = fractalService.getFractalSignal();
  const s1d = fractalService.getSignal1D();
  const s4h = fractalService.getSignal4H();

  if (!fractalService.isReady()) {
    res.json({ loading: true, valid: false, reason: "Фрактальный анализ загружается..." });
    return;
  }

  res.json({
    loading: false,
    combined,
    "1D": s1d,
    "4H": s4h,
  });
});

export default router;
