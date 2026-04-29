import { Router, type IRouter } from "express";
import healthRouter from "./health";
import marketRouter from "./market";
import signalRouter from "./signal";
import botRouter from "./bot";
import riskRouter from "./risk";

const router: IRouter = Router();

router.use(healthRouter);
router.use(marketRouter);
router.use(signalRouter);
router.use(botRouter);
router.use(riskRouter);

export default router;
