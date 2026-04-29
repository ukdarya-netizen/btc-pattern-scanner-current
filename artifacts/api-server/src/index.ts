import app from "./app";
import { logger } from "./lib/logger";
import { bybitService } from "./services/bybit";
import { cvdService } from "./services/cvd";
import { telegramService } from "./services/telegram";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

bybitService.connect();
cvdService.start();
telegramService.init();

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
});
