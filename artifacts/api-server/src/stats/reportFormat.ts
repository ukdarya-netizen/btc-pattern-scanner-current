import { PROFILES, type ProfileKey } from "../config/profiles";

/** Reports follow the owner's clock (Dubai, UTC+4, no DST). */
const TZ_OFFSET_MS = 4 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

export type Period = { kind: "day" | "week" | "month"; key: string; start: Date; end: Date; title: string };

const pad = (n: number) => String(n).padStart(2, "0");
const localDate = (ms: number) => new Date(ms + TZ_OFFSET_MS); // read with getUTC*
const label = (ms: number) => {
  const d = localDate(ms);
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
};

/** Completed periods that end at or before `now` (the latest one of each kind). */
export function completedPeriods(now: number): Period[] {
  const local = localDate(now);
  const dayStartLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const todayStart = dayStartLocal - TZ_OFFSET_MS;
  const yesterday = todayStart - DAY;
  const weekday = (local.getUTCDay() + 6) % 7; // Monday = 0
  const weekStart = todayStart - weekday * DAY;
  const prevWeek = weekStart - 7 * DAY;
  const monthStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - TZ_OFFSET_MS;
  const prevMonthLocal = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - 1, 1));
  const prevMonthStart = prevMonthLocal.getTime() - TZ_OFFSET_MS;
  const ym = `${prevMonthLocal.getUTCFullYear()}-${pad(prevMonthLocal.getUTCMonth() + 1)}`;
  const months = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август",
    "сентябрь", "октябрь", "ноябрь", "декабрь"];
  const isoDay = (ms: number) => {
    const d = localDate(ms);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  };
  return [
    { kind: "day", key: `day:${isoDay(yesterday)}`, start: new Date(yesterday), end: new Date(todayStart),
      title: `Итоги дня ${label(yesterday)}` },
    { kind: "week", key: `week:${isoDay(prevWeek)}`, start: new Date(prevWeek), end: new Date(weekStart),
      title: `Итоги недели ${label(prevWeek)}–${label(weekStart - DAY)}` },
    { kind: "month", key: `month:${ym}`, start: new Date(prevMonthStart), end: new Date(monthStart),
      title: `Итоги месяца: ${months[prevMonthLocal.getUTCMonth()]} ${prevMonthLocal.getUTCFullYear()}` },
  ];
}

export type Closed = {
  profile: string; direction: string; patternKey: string;
  pnlMarginPct: number | null; pnlPricePct: number | null; closeReason: string | null;
};

const sign = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;

/**
 * Live signals closed inside the period. Plain text (no HTML). A trade counts
 * as a win only when margin PnL after fees is positive.
 */
export function formatReport(title: string, rows: Closed[]): string | null {
  if (rows.length === 0) return null;
  const lines = [`BTC · ${title}`, `Закрыто сделок: ${rows.length}`];
  for (const key of Object.keys(PROFILES) as ProfileKey[]) {
    const group = rows.filter((r) => r.profile === key);
    if (!group.length) continue;
    const wins = group.filter((r) => (r.pnlMarginPct ?? 0) > 0).length;
    const sum = group.reduce((s, r) => s + (r.pnlMarginPct ?? 0), 0);
    const parts = (["long", "short"] as const).map((dir) => {
      const g = group.filter((r) => r.direction === dir);
      if (!g.length) return null;
      const w = g.filter((r) => (r.pnlMarginPct ?? 0) > 0).length;
      return `${dir === "long" ? "лонг" : "шорт"} ${w}/${g.length}`;
    }).filter(Boolean);
    lines.push("",
      `${PROFILES[key].label} x${PROFILES[key].leverage}: ${wins} из ${group.length} в плюс (${Math.round((wins / group.length) * 100)}%)`,
      `Сумма к марже: ${sign(sum)} · в среднем ${sign(sum / group.length)}`,
      `По направлениям: ${parts.join(", ")}`,
    );
  }
  const best = rows.reduce((a, b) => ((b.pnlMarginPct ?? -Infinity) > (a.pnlMarginPct ?? -Infinity) ? b : a));
  const worst = rows.reduce((a, b) => ((b.pnlMarginPct ?? Infinity) < (a.pnlMarginPct ?? Infinity) ? b : a));
  lines.push("",
    `Лучшая: ${sign(best.pnlMarginPct ?? 0)} к марже (${sign(best.pnlPricePct ?? 0)} цены)`,
    `Худшая: ${sign(worst.pnlMarginPct ?? 0)} к марже (${sign(worst.pnlPricePct ?? 0)} цены)`,
    "Результат к марже — с плечом и с учётом комиссий.",
  );
  return lines.join("\n");
}

