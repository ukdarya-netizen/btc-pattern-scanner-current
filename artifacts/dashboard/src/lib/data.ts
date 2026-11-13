import type { Decision, Metrics, OutcomeGroup, Pattern, Signal, Status, Style } from "./api";
import { styleOfTf } from "./api";

/** Everything the dashboard shows; open / closed already cut to the chosen mode (channel or shadow). */
export type Data = {
  status: Status | null;
  open: Signal[];
  closed: Signal[];
  market: { candleCloseAt: string | null; metrics: Metrics | null } | null;
  outcomes: OutcomeGroup[];
  decisions: Decision[];
};

export type Mode = "live" | "shadow";
export type Reason = "" | "take_profit" | "stop" | "breakeven" | "timeout";
export type Filter = { pattern: string; direction: string; style: "" | Style; result: "all" | "win" | "loss" | "flat"; reason: Reason };
export const NO_FILTER: Filter = { pattern: "", direction: "", style: "", result: "all", reason: "" };

export type Tab = "positions" | "overview" | "history" | "patterns" | "reference" | "subscribers" | "service" | "health";

/** Result of a trade: the clean price move, no leverage, no fees (owner 2026-11-12). */
export const res = (s: Signal) => s.pnlPricePct ?? 0;

export function styleOf(patterns: Pattern[], key: string): Style {
  return styleOfTf(patterns.find((p) => p.key === key)?.tf);
}

export function applyFilter(rows: Signal[], f: Filter, patterns: Pattern[]): Signal[] {
  return rows.filter((s) =>
    (!f.pattern || s.patternKey === f.pattern) &&
    (!f.direction || s.direction === f.direction) &&
    (!f.style || styleOf(patterns, s.patternKey) === f.style) &&
    (!f.reason || s.closeReason === f.reason) &&
    (f.result === "all" || (f.result === "win" ? res(s) > 0 : f.result === "loss" ? res(s) < 0 : res(s) === 0)));
}

/** Month of a time in Dubai, "2026-11" (statistics by month as CAB / Nihilist). */
export const dubaiMonth = (iso: string) => {
  const d = new Date(Date.parse(iso) + 4 * 3_600_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};
/** Day of a time in Dubai, "2026-11-12". */
export const dubaiDayKey = (iso: string) => new Date(Date.parse(iso) + 4 * 3_600_000).toISOString().slice(0, 10);
const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];
export const monthName = (key: string) => { const [y, m] = key.split("-"); return `${MONTHS[Number(m) - 1]} ${y}`; };

/** Period: "all", the last N days ("7", "14", "30", "90") or a calendar month ("2026-11", Dubai). */
export type Period = string;
export const inPeriod = (rows: Signal[], period: Period) => {
  if (period === "all") return rows;
  if (/^\d{4}-\d{2}$/.test(period)) return rows.filter((s) => s.closedAt && dubaiMonth(s.closedAt) === period);
  const days = Number(period);
  return rows.filter((s) => s.closedAt && Date.parse(s.closedAt) >= Date.now() - days * 86_400_000);
};
/** The period choices: all, 7 / 14 / 30 / 90 days, then every month with closed trades (newest first). */
export function periodOptions(closed: Signal[]): Array<[Period, string]> {
  const months = [...new Set(closed.filter((s) => s.closedAt).map((s) => dubaiMonth(s.closedAt!)))].sort().reverse();
  return [["all", "Всё время"], ["7", "7 дней"], ["14", "14 дней"], ["30", "30 дней"], ["90", "90 дней"], ...months.map((m): [Period, string] => [m, monthName(m)])];
}

/**
 * Win rate as CAB / Nihilist / the reports: (all targets + break-even) / (all targets + break-even + stop);
 * a close by holding time is not counted in it. `wins` = trades with a move in profit.
 */
export type Summary = { n: number; wins: number; winRate: number | null; sum: number; avg: number | null; best: number | null; worst: number | null };
export function summarize(rows: Signal[]): Summary {
  const vals = rows.map(res);
  const sum = vals.reduce((a, b) => a + b, 0);
  const wins = vals.filter((v) => v > 0).length;
  const c = (r: string) => rows.filter((s) => s.closeReason === r).length;
  const good = c("take_profit") + c("breakeven"), denom = good + c("stop");
  return {
    n: rows.length, wins, winRate: denom ? (100 * good) / denom : null, sum, avg: rows.length ? sum / rows.length : null,
    best: vals.length ? Math.max(...vals) : null, worst: vals.length ? Math.min(...vals) : null,
  };
}
