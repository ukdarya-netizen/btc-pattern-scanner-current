/**
 * Signals to Lucy's Trading Bot (owner 2026-11-14: Bitcoin Margin Master becomes its third connected bot).
 * The same three channels as CAB and Nihilist:
 *   1. entry signal  — POST BTC_TRADING_SIGNAL_URL when a channel (live) trade opens;
 *   2. commands      — POST BTC_TRADING_COMMAND_URL: target 1 (partial close + stop to entry), the close
 *                      (take profit / stop / break-even / holding time), numbered per signal;
 *   3. position sync — GET /api/trading/position-sync here, polled by the bot (routes/tradingSync.ts).
 * Header x-trading-token = BTC_TRADING_TOKEN on all three.
 *
 * No new table (a table the schema does not know would make a publish propose DROP): the messages of a signal are
 * derived from its lifecycle events (btc_signal_events: opened, target_hit, closed — append-only, ordered by id), and
 * the delivery state lives on its `opened` event (detail.trading: how many messages were delivered, attempts, next
 * attempt, last answer). Each message is repeated with the same id until the bot stores it; 400 / 422 stop the
 * signal (quarantined, with the answer). Only signals that opened at most 15 minutes before they are first seen
 * are sent (no backlog of old trades). Fail-closed: no token or URLs = nothing is sent; production only.
 */
import { pool } from "@workspace/db";
import { classifyReceipt, backoffMs, messagesOf, type EventRow, type SignalRow } from "./messages";
export { sourceSignalId } from "./messages";
import { logger } from "../lib/logger";

const INTERVAL_MS = 5_000;
const FRESH_MS = 15 * 60_000;

const signalUrl = () => process.env.BTC_TRADING_SIGNAL_URL?.trim() || null;
const commandUrl = () => process.env.BTC_TRADING_COMMAND_URL?.trim() || null;
export const tradingToken = () => process.env.BTC_TRADING_TOKEN?.trim() || null;
export function relayEnabled(): boolean {
  return Boolean(tradingToken() && signalUrl() && commandUrl()) && process.env.REPLIT_DEPLOYMENT === "1";
}

type Trading = { state: "sending" | "done" | "quarantined" | "skipped_old"; sent: number; attempts: number; nextAt: number; http: number | null; answer: string | null };

async function setTrading(openedEventId: number, t: Trading): Promise<void> {
  await pool.query(`UPDATE btc_signal_events SET detail = detail || jsonb_build_object('trading', $2::jsonb) WHERE id = $1`, [openedEventId, JSON.stringify(t)]);
}

let delivering = false;
export async function deliverDue(now = Date.now()): Promise<void> {
  if (delivering || !relayEnabled()) return;
  delivering = true;
  try {
    // Channel signals whose relay is not finished (no state yet, or still sending).
    const { rows: sigs } = await pool.query<SignalRow & { opened_id: number; trading: Trading | null; opened_at: Date }>(
      `SELECT s.id, s.pattern_key, s.direction, s.profile, s.leverage, s.entry_price, s.initial_stop_price, s.targets,
              s.detected_at, s.expires_at, e.id AS opened_id, e.detail->'trading' AS trading, e.created_at AS opened_at
         FROM btc_signals s JOIN btc_signal_events e ON e.signal_id = s.id AND e.kind = 'opened'
        WHERE s.live AND (e.detail->'trading' IS NULL OR e.detail->'trading'->>'state' = 'sending')
        ORDER BY s.id LIMIT 20`,
    );
    for (const s of sigs) {
      let t: Trading = s.trading ?? { state: "sending", sent: 0, attempts: 0, nextAt: 0, http: null, answer: null };
      if (!s.trading && now - s.opened_at.getTime() > FRESH_MS) {
        await setTrading(s.opened_id, { ...t, state: "skipped_old" });
        continue;
      }
      if (t.nextAt > now) continue;
      const { rows: events } = await pool.query<EventRow>(
        "SELECT id, kind, price, detail, created_at FROM btc_signal_events WHERE signal_id = $1 AND kind IN ('opened','target_hit','closed') ORDER BY id", [s.id]);
      const msgs = messagesOf(s, events);
      // Send what is due, in order; stop at the first one the bot did not store.
      while (t.sent < msgs.length) {
        const m = msgs[t.sent]!;
        let status = 0, body: unknown = null, answer = "";
        try {
          const res = await fetch((m.kind === "signal" ? signalUrl() : commandUrl())!, {
            method: "POST", headers: { "Content-Type": "application/json", "x-trading-token": tradingToken()! },
            body: JSON.stringify(m.payload), signal: AbortSignal.timeout(10_000),
          });
          status = res.status;
          answer = (await res.text()).slice(0, 500);
          try { body = JSON.parse(answer); } catch { body = null; }
        } catch (err) {
          answer = err instanceof Error ? err.message.slice(0, 200) : "network_error";
        }
        const r = classifyReceipt(m.kind, status, body, m.id);
        if (r === "delivered") { t = { ...t, sent: t.sent + 1, attempts: 0, nextAt: 0, http: status, answer: null }; continue; }
        const attempts = t.attempts + 1;
        t = r === "quarantined"
          ? { ...t, state: "quarantined", attempts, http: status, answer: `${m.id}: ${answer}` }
          : { ...t, attempts, nextAt: now + backoffMs(attempts), http: status || null, answer: `${m.id}: ${answer}` };
        logger.warn({ id: m.id, status, receipt: r }, "btc: trading bot did not store the message");
        break;
      }
      const finished = t.state === "sending" && t.sent >= msgs.length && events.some((e) => e.kind === "closed");
      await setTrading(s.opened_id, finished ? { ...t, state: "done" } : t);
    }
  } catch (err) {
    logger.warn({ err }, "btc: trading relay pass failed");
  } finally {
    delivering = false;
  }
}

export function startTradingRelay(): void {
  if (!relayEnabled()) {
    logger.info("btc: trading relay off (needs BTC_TRADING_TOKEN, BTC_TRADING_SIGNAL_URL, BTC_TRADING_COMMAND_URL; published deployment)");
    return;
  }
  setInterval(() => void deliverDue(), INTERVAL_MS).unref?.();
}
