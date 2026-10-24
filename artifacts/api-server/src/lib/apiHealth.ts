/**
 * External API health, ported from AltBullet: errors are logged; the admin
 * gets ONE Telegram alert per source when it has been down continuously for
 * more than 30 minutes (at most once per 6 hours), and a "restored" message
 * only after such an alert. Single errors and 429s are log-only.
 */
export type ApiName = "coinglass" | "bingx" | "bingx_stream" | "telegram";

export const OUTAGE_ALERT_AFTER_MS = 30 * 60_000;
export const OUTAGE_ALERT_COOLDOWN_MS = 6 * 60 * 60_000;

const LABELS: Record<ApiName, string> = {
  coinglass: "CoinGlass",
  bingx: "BingX REST",
  bingx_stream: "BingX поток цены",
  telegram: "Telegram",
};

type State = {
  downSince: number | null;
  lastError: string | null;
  lastSuccessAt: number | null;
  consecutiveFailures: number;
  alerted: boolean;
  lastAlertAt: number;
};

const states = new Map<ApiName, State>();
const state = (api: ApiName): State => {
  let s = states.get(api);
  if (!s) {
    s = { downSince: null, lastError: null, lastSuccessAt: null, consecutiveFailures: 0, alerted: false, lastAlertAt: 0 };
    states.set(api, s);
  }
  return s;
};

export function recordSuccess(api: ApiName, now = Date.now()): void {
  const s = state(api);
  s.lastSuccessAt = now;
  s.consecutiveFailures = 0;
  s.downSince = null;
}

export function recordFailure(api: ApiName, error: string, now = Date.now()): void {
  const s = state(api);
  s.consecutiveFailures += 1;
  s.lastError = error.slice(0, 200);
  if (s.downSince === null) s.downSince = now;
}

export type HealthAlert = { api: ApiName; kind: "down" | "restored"; text: string };

/** Decides which admin messages are due; call periodically. */
export function dueAlerts(now = Date.now()): HealthAlert[] {
  const alerts: HealthAlert[] = [];
  for (const [api, s] of states) {
    if (s.downSince !== null && now - s.downSince >= OUTAGE_ALERT_AFTER_MS &&
        (!s.alerted || now - s.lastAlertAt >= OUTAGE_ALERT_COOLDOWN_MS)) {
      s.alerted = true;
      s.lastAlertAt = now;
      const minutes = Math.round((now - s.downSince) / 60_000);
      alerts.push({
        api, kind: "down",
        text: `BTC Bullet: ${LABELS[api]} недоступен ${minutes} мин.${s.lastError ? `\nОшибка: ${s.lastError}` : ""}`,
      });
    } else if (s.downSince === null && s.alerted) {
      s.alerted = false;
      alerts.push({ api, kind: "restored", text: `BTC Bullet: ${LABELS[api]} снова работает.` });
    }
  }
  return alerts;
}

export function healthSnapshot(now = Date.now()) {
  return Object.fromEntries([...states].map(([api, s]) => [api, {
    ok: s.downSince === null,
    downForMin: s.downSince === null ? 0 : Math.round((now - s.downSince) / 60_000),
    consecutiveFailures: s.consecutiveFailures,
    lastError: s.lastError,
    lastSuccessAt: s.lastSuccessAt ? new Date(s.lastSuccessAt).toISOString() : null,
  }]));
}

export function resetHealthForTests(): void {
  states.clear();
}
