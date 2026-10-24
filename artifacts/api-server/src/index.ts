import app from "./app";
import { startEngine } from "./engine/runtime";
import { logger } from "./lib/logger";

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
  if (process.env.BTC_ENGINE_ENABLED === "false") {
    logger.warn("BTC engine disabled by BTC_ENGINE_ENABLED=false");
    return;
  }
  startEngine().catch((engineErr) => {
    logger.error({ err: engineErr }, "BTC engine failed to start");
  });
});
