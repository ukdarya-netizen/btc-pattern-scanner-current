import type { DailyRow, Decision, Metrics, OutcomeGroup, Signal, StatsRow, Status } from "./api";

export type Data = {
  status: Status | null;
  stats: StatsRow[];
  open: Signal[];
  closed: Signal[];
  market: { candleCloseAt: string | null; metrics: Metrics | null } | null;
  daily: DailyRow[];
  outcomes: OutcomeGroup[];
  decisions: Decision[];
};

export type Filter = {
  pattern: string; direction: string; profile: string; mode: "all" | "live" | "shadow"; result: "all" | "win" | "loss" | "flat";
};
export const NO_FILTER: Filter = { pattern: "", direction: "", profile: "", mode: "all", result: "all" };

export type Tab = "overview" | "positions" | "history" | "patterns" | "decisions" | "market";

export const won = (s: { pnlMarginPct: number | null }) => (s.pnlMarginPct ?? 0) > 0;

export function applyFilter(rows: Signal[], f: Filter): Signal[] {
  return rows.filter((s) =>
    (!f.pattern || s.patternKey === f.pattern) &&
    (!f.direction || s.direction === f.direction) &&
    (!f.profile || s.profile === f.profile) &&
    (f.mode === "all" || (f.mode === "live") === s.live) &&
    (f.result === "all" || (f.result === "win" ? (s.pnlMarginPct ?? 0) > 0 : f.result === "loss" ? (s.pnlMarginPct ?? 0) < 0 : (s.pnlMarginPct ?? 0) === 0)));
}

/** Closed signals of the last `days` days (0 = all). */
export const inPeriod = (rows: Signal[], days: number) =>
  days ? rows.filter((s) => s.closedAt && Date.parse(s.closedAt) >= Date.now() - days * 86_400_000) : rows;

export type Summary = { n: number; wins: number; winRate: number | null; sum: number; avg: number | null };
export function summarize(rows: Signal[]): Summary {
  const vals = rows.map((s) => s.pnlMarginPct ?? 0);
  const sum = vals.reduce((a, b) => a + b, 0);
  const wins = rows.filter(won).length;
  return { n: rows.length, wins, winRate: rows.length ? (100 * wins) / rows.length : null, sum, avg: rows.length ? sum / rows.length : null };
}
