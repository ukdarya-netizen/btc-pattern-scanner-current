import app from "./app";
import { logger } from "./lib/logger";
import { telegramService } from "./services/telegram";
import { altScanner } from "./services/altScanner";
import { apiStatusService } from "./services/apiStatus";
import { testConnection } from "./db";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error("PORT environment variable is required but was not provided.");
}

const port = Number(rawPort);
if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

telegramService.init();
altScanner.start();

apiStatusService.register("coinalyze", "Coinalyze", async () => {
  const key = process.env["COINALYZE_API_KEY"];
  if (!key) return { ok: false, message: "нет API-ключа" };
  const res = await fetch("https://api.coinalyze.net/v1/exchanges", { headers: { api_key: key } });
  return res.ok ? { ok: true, message: "OK" } : { ok: false, message: `HTTP ${res.status}` };
});

apiStatusService.register("telegram", "Telegram", async () => {
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) return { ok: false, message: "нет токена" };
  const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
  const data = (await res.json()) as { ok: boolean; result?: { username?: string } };
  return data.ok
    ? { ok: true, message: data.result?.username ? `@${data.result.username}` : "OK" }
    : { ok: false, message: "ошибка авторизации" };
});

apiStatusService.register("database", "База данных", async () => {
  const ok = await testConnection();
  return ok ? { ok: true, message: "OK" } : { ok: false, message: "нет соединения" };
});

apiStatusService.start();

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }
  logger.info({ port }, "Server listening");
});
