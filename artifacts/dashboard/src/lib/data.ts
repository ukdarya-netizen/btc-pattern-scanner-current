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
export type Filter = { pattern: string; direction: string; style: "" | Style; result: "all" | "win" | "loss" | "flat" };
export const NO_FILTER: Filter = { pattern: "", direction: "", style: "", result: "all" };

export type Tab = "positions" | "overview" | "history" | "patterns" | "subscribers" | "service";

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
    (f.result === "all" || (f.result === "win" ? res(s) > 0 : f.result === "loss" ? res(s) < 0 : res(s) === 0)));
}

/** Closed trades of the last `days` days (0 = all). */
export const inPeriod = (rows: Signal[], days: number) =>
  days ? rows.filter((s) => s.closedAt && Date.parse(s.closedAt) >= Date.now() - days * 86_400_000) : rows;

export type Summary = { n: number; wins: number; winRate: number | null; sum: number; avg: number | null };
export function summarize(rows: Signal[]): Summary {
  const vals = rows.map(res);
  const sum = vals.reduce((a, b) => a + b, 0);
  const wins = vals.filter((v) => v > 0).length;
  return { n: rows.length, wins, winRate: rows.length ? (100 * wins) / rows.length : null, sum, avg: rows.length ? sum / rows.length : null };
}
