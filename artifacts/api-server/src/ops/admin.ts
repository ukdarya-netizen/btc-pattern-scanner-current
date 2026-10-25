/**
 * Operational diagnostics stay in server logs. Automatic restarts, API
 * outages and watchdog recovery must not send Telegram notifications.
 * Explicit admin commands still return status on request.
 */
import { db, btcSignalsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { PROFILES, type ProfileKey } from "../config/profiles";
import { dueAlerts, healthSnapshot } from "../lib/apiHealth";
import { logger } from "../lib/logger";
import { coinglassGovernorStats } from "../market/coinglass";
import { watchdogDecision, type WatchdogState } from "./watchdog";


export function adminChatIds(): string[] {
  return (process.env.TELEGRAM_ADMIN_CHAT_IDS ?? "")
    .split(",").map((id) => id.trim()).filter(Boolean);
}

const watchdog: WatchdogState = { alertedAt: null };

export function startOpsMonitor(getScanner: () => { lastCandleCloseAt: string | null; lastError: string | null }): void {
  const startedAt = Date.now();
  setInterval(() => {
    void (async () => {
      for (const alert of dueAlerts()) logger.warn({ alert }, "BTC API health");
      const s = getScanner();
      const decision = watchdogDecision(s.lastCandleCloseAt, startedAt, Date.now(), watchdog);
      if (decision === "alert") {
        const minutes = Math.round((Date.now() - (s.lastCandleCloseAt ? Date.parse(s.lastCandleCloseAt) : startedAt)) / 60_000);
        logger.warn({ minutes, lastError: s.lastError }, "BTC scanner idle");
      } else if (decision === "recovered") {
        logger.info("BTC scanner recovered");
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
