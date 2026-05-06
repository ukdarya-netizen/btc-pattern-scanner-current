import app from "./app";
import { logger } from "./lib/logger";
import { aggregator } from "./services/exchanges/aggregator";
import { cvdService } from "./services/cvd";
import { candleService } from "./services/candleService";
import { patternService } from "./services/patternService";
import { coinglassService } from "./services/coinglassService";
import { telegramService } from "./services/telegram";
import { botEngine } from "./services/botEngine";
import { statsScheduler } from "./services/statsScheduler";
import { dbService } from "./services/dbService";
import { signalTracker } from "./services/signalTracker";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

aggregator.init();
cvdService.start();
candleService.start();
void patternService.start();
coinglassService.startPolling();
telegramService.init();
statsScheduler.start();

void dbService.initializeTodayStats();

setTimeout(() => {
  botEngine.initChannelBroadcast();
  signalTracker.start();
}, 15000);

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Server listening");
});
