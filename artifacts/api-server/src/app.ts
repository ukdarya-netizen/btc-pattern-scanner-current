import express, { type Express } from "express";
import cors from "cors";

const app: Express = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/api/healthz", (_req, res) => {
  res.json({ ok: true });
});

export default app;
