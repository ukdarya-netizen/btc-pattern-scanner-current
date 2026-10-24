export const WATCHDOG_ALERT_AFTER_MS = 20 * 60_000;
export const WATCHDOG_REPEAT_MS = 60 * 60_000;

export type WatchdogState = { alertedAt: number | null };

/** Pure decision for the scanner watchdog. */
export function watchdogDecision(lastCandleCloseAt: string | null, startedAt: number, now: number,
  state: WatchdogState): "alert" | "recovered" | null {
  const last = lastCandleCloseAt ? Date.parse(lastCandleCloseAt) : startedAt;
  const idle = now - last;
  if (idle >= WATCHDOG_ALERT_AFTER_MS) {
    if (state.alertedAt === null || now - state.alertedAt >= WATCHDOG_REPEAT_MS) {
      state.alertedAt = now;
      return "alert";
    }
    return null;
  }
  if (state.alertedAt !== null) {
    state.alertedAt = null;
    return "recovered";
  }
  return null;
}

