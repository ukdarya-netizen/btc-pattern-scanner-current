import app from "./app";
import { startEngine } from "./engine/runtime";
import { logger } from "./lib/logger";
import { ensureUserTables } from "./lib/users";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Server listening");
  // Owner 2026-11-12: no requests from dev — the engine (BingX, CoinGlass, Telegram) runs only in the deployment.
  const deployed = process.env.REPLIT_DEPLOYMENT === "1" || process.env.NODE_ENV === "production";
  if (!deployed) {
    logger.warn("BTC engine not started: not the production deployment (dev makes no requests)");
    return;
  }
  if (process.env.BTC_ENGINE_ENABLED === "false") {
    logger.warn("BTC engine disabled by BTC_ENGINE_ENABLED=false");
    return;
  }
  // Accounts (owner 2026-11-12): the tables exist before the first delivery picks recipients from them.
  ensureUserTables()
    .catch((err) => logger.error({ err }, "btc: user tables not created"))
    .then(() => startEngine())
    .catch((engineErr) => {
      logger.error({ err: engineErr }, "BTC engine failed to start");
    });
});
