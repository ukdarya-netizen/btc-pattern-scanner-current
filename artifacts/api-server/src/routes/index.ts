import { Router, type IRouter } from "express";
import healthRouter from "./health";
import scannerRouter from "./scanner";
import adminRouter from "./admin";

const router: IRouter = Router();

router.use(healthRouter);
router.use(scannerRouter);
router.use(adminRouter);

export default router;
