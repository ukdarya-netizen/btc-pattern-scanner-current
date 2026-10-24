import express, { type Express } from "express";
import cors from "cors";
import btcRoutes from "./routes/btc";
import { requireDashboardPin } from "./lib/dashboardAccess";

const app: Express = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/api/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.set("trust proxy", 1);
app.use("/api/btc", requireDashboardPin);
app.use("/api", btcRoutes);

export default app;
