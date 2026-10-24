/**
 * Operator notifications, ported from AltBullet's policy:
 *  - "Бот перезапущен" on every start (owner: this message must stay)
 *  - external API outage > 30 min, at most once per 6 h per source, plus a
 *    "restored" message only after such an alert (lib/apiHealth)
 *  - scanner watchdog: no completed 5m cycle for 20 min → alert, at most
 *    hourly, with a recovery message
 * Recipients: TELEGRAM_ADMIN_CHAT_IDS (comma-separated private chat IDs).
 * Nothing here ever goes to the signal channel.
 */
import { db, btcSignalsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { PROFILES, type ProfileKey } from "../config/profiles";
import { dueAlerts, healthSnapshot } from "../lib/apiHealth";
import { logger } from "../lib/logger";
import { coinglassGovernorStats } from "../market/coinglass";
import { sendMessage } from "../telegram/transport";
import { watchdogDecision, type WatchdogState } from "./watchdog";


export function adminChatIds(): string[] {
  return (process.env.TELEGRAM_ADMIN_CHAT_IDS ?? "")
    .split(",").map((id) => id.trim()).filter(Boolean);
}

export async function sendAdmin(text: string): Promise<void> {
  for (const chatId of adminChatIds()) {
    try {
      await sendMessage(chatId, text);
    } catch (err) {
      logger.warn({ err }, "admin notification failed");
    }
  }
}

export async function notifyRestart(openSignals: number): Promise<void> {
  const at = new Date().toLocaleString("ru-RU", { timeZone: "Asia/Dubai" });
  await sendAdmin(`BTC Bullet: бот перезапущен (${at}, Дубай). Открытых позиций восстановлено: ${openSignals}.`);
}

const watchdog: WatchdogState = { alertedAt: null };

export function startOpsMonitor(getScanner: () => { lastCandleCloseAt: string | null; lastError: string | null }): void {
  const startedAt = Date.now();
  setInterval(() => {
    void (async () => {
      for (const alert of dueAlerts()) await sendAdmin(alert.text);
      const s = getScanner();
      const decision = watchdogDecision(s.lastCandleCloseAt, startedAt, Date.now(), watchdog);
      if (decision === "alert") {
        const minutes = Math.round((Date.now() - (s.lastCandleCloseAt ? Date.parse(s.lastCandleCloseAt) : startedAt)) / 60_000);
        await sendAdmin(`BTC Bullet: сканер не завершал цикл ${minutes} мин.${s.lastError ? `\nПоследняя ошибка: ${s.lastError}` : ""}`);
      } else if (decision === "recovered") {
        await sendAdmin("BTC Bullet: сканер снова работает.");
      }
    })().catch((err) => logger.warn({ err }, "ops monitor pass failed"));
  }, 60_000);
}

/** Text for the admin /status command (plain text). */
export async function statusText(input: {
  lastPrice: number | null;
  streamConnected: boolean;
  lastCandleCloseAt: string | null;
  missingFlow: string[];
  patternCount: number;
  livePatternCount: number;
}): Promise<string> {
  const open = await db.select().from(btcSignalsTable).where(eq(btcSignalsTable.status, "open"));
  const health = healthSnapshot();
  const cg = coinglassGovernorStats();
  const lines = [
    "BTC Bullet · статус",
    `Цена: ${input.lastPrice ?? "—"} · поток ${input.streamConnected ? "на связи" : "НЕТ СВЯЗИ"}`,
    `Последняя свеча: ${input.lastCandleCloseAt ? new Date(input.lastCandleCloseAt).toLocaleString("ru-RU", { timeZone: "Asia/Dubai" }) : "—"}`,
    `Нет данных: ${input.missingFlow.join(", ") || "—"}`,
    `Паттернов: ${input.patternCount} (в канал ${input.livePatternCount})`,
    `CoinGlass: ok ${cg.ok}, ошибок ${cg.failed}, 429 ${cg.rateLimited}`,
    ...Object.entries(health).filter(([, h]) => !h.ok).map(([api, h]) => `Сбой ${api}: ${h.downForMin} мин — ${h.lastError ?? ""}`),
    `Открытых позиций: ${open.length}`,
    ...open.slice(0, 15).map((s) => {
      const move = input.lastPrice
        ? ((s.direction === "long" ? 1 : -1) * (input.lastPrice - s.entryPrice) / s.entryPrice) * 100
        : null;
      return `#${s.id} ${PROFILES[s.profile as ProfileKey]?.label ?? s.profile} ${s.direction === "long" ? "лонг" : "шорт"} ${s.live ? "" : "(тень) "}вход ${s.entryPrice.toFixed(1)} · ${move === null ? "—" : `${move >= 0 ? "+" : ""}${move.toFixed(2)}%`}`;
    }),
  ];
  return lines.join("\n");
}
