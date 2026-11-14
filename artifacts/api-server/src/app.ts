import express, { type Express } from "express";
import cors from "cors";
import btcRoutes from "./routes/btc";
import marketRoutes from "./routes/market";
import authRoutes from "./routes/auth";
import tradingSyncRoutes from "./routes/tradingSync";
import { requireUser } from "./lib/users";

const app: Express = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/api/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.set("trust proxy", 1);
// Owner 2026-11-12 (as CAB / Nihilist): registration, login and the owner's «Подписчики» under /api/auth and
// /api/admin; the dashboard data only for approved users with an active subscription (the owner always).
// Lucy's Trading Bot (owner 2026-11-14): position sync, by its own token, not a user login.
app.use("/api", tradingSyncRoutes);
app.use("/api", authRoutes);
app.use("/api/btc", requireUser);
app.use("/api", btcRoutes);
app.use("/api", marketRoutes);

export default app;
