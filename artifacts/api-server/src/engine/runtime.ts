import { logger } from "../lib/logger";
import { getLastPrice, startLastPriceStream } from "../market/bingx";
import { syncCandles } from "../analysis/candleStore";
import { deliverNext } from "../telegram/telegram";
import { runReports } from "../stats/reports";
import { runSubscriptionNotices } from "../lib/subscriptionNotices";
import { setAdminCommandHandler, startTelegramSubscriptions } from "../telegram/subscribers";
import { startOpsMonitor, statusText } from "../ops/admin";
import { waitForEngineLease } from "../ops/lease";
import {
  catchUpFromCandles,
  catchUpPending,
  loadOpenSignals,
  markAllForCatchUp,
  onTick,
  startMfeFlush,
} from "../tracker/tracker";
import { PATTERNS } from "./patterns";
import { runCycle, scannerStatus } from "./scanner";

let stream: ReturnType<typeof startLastPriceStream> | null = null;
let lastTick: { price: number; at: number } | null = null;
let connected = false;

export function engineHealth() {
  return {
    connected,
    lastTickAt: lastTick ? new Date(lastTick.at).toISOString() : null,
    lastPrice: lastTick?.price ?? null,
  };
}

/** Live price for entries: the stream if fresh, otherwise one REST read. */
async function currentPrice(): Promise<number> {
  if (lastTick && Date.now() - lastTick.at < 5_000) return lastTick.price;
  return getLastPrice();
}

const labelOf = (key: string) => PATTERNS.find((p) => p.key === key)?.label ?? key;

export async function startEngine(): Promise<void> {
  // One engine per database: a second process waits instead of double-posting.
  await waitForEngineLease();
  const restored = await loadOpenSignals();
  logger.info({ restored }, "BTC engine: open signals restored");
  setAdminCommandHandler(() => statusText({
    lastPrice: lastTick?.price ?? null,
    streamConnected: connected,
    lastCandleCloseAt: scannerStatus.lastCandleCloseAt,
    missingFlow: scannerStatus.missingFlow,
    patternCount: PATTERNS.length,
    livePatternCount: PATTERNS.filter((p) => p.live).length,
  }));
  startTelegramSubscriptions();
  startOpsMonitor(() => scannerStatus);

  stream = startLastPriceStream({
    onTick: (tick) => {
      lastTick = tick;
      onTick(tick);
    },
    onStatus: (status, detail) => {
      connected = status === "connected";
      logger.info({ status, detail }, "BTC engine: price stream");
    },
  });

  // Replay 1m candles for any time without live ticks (restart, reconnect,
  // silent socket) before live ticks are applied again.
  setInterval(() => {
    if (!lastTick || Date.now() - lastTick.at > 20_000) markAllForCatchUp();
    if (catchUpPending()) {
      void catchUpFromCandles().catch((err) => logger.warn({ err }, "BTC engine: catch-up failed"));
    }
  }, 15_000);

  startMfeFlush();
  setInterval(() => void runCycle(currentPrice).catch((err) => logger.error({ err }, "cycle crashed")), 15_000);
  // Candle history for outcome labels (backfills on first start).
  const candleSync = () => void syncCandles().catch((err) => logger.warn({ err }, "candle sync failed"));
  candleSync();
  setInterval(candleSync, 60_000);
  // Automatic Telegram delivery: signal lifecycle events and (owner 2026-11-12, as CAB / Nihilist) the scheduled
  // reports — morning market 09:00, daily 22:00, weekly Sunday 10:00, monthly the 1st 11:00 (Dubai); never restart / diagnostics messages.
  setInterval(() => void deliverNext(labelOf).catch((err) => logger.warn({ err }, "telegram pass failed")), 3_000);
  setInterval(() => void runReports(labelOf).catch((err) => logger.warn({ err }, "reports pass failed")), 60_000);
  // Subscription notices (as CAB): 3 hours before the end and at the end to the subscriber, a summary to the owner.
  setInterval(() => void runSubscriptionNotices().catch((err) => logger.warn({ err }, "subscription notices failed")), 10 * 60_000);
}
