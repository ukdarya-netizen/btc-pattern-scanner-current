import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

export type StatsRow = {
  patternKey: string;
  profile: string;
  direction: string;
  live: boolean;
  total: number;
  open: number;
  closed: number;
  wins: number;
  losses: number;
  winRatePct: number | null;
  avgPnlPricePct: number | null;
  avgPnlMarginPct: number | null;
  sumPnlMarginPct: number | null;
  avgMfePct: number | null;
  avgMaePct: number | null;
  takeProfit: number;
  stop: number;
  breakeven: number;
  timeout: number;
};

/**
 * Per pattern × trade type × direction × live/shadow. A win is a closed trade
 * with positive margin PnL after fees (breakeven closes lose the fees and
 * therefore count as losses, which is what the account actually sees).
 */
export async function getStats(sinceDays?: number): Promise<StatsRow[]> {
  const since = sinceDays && sinceDays > 0
    ? sql`AND detected_at > now() - (${sinceDays} * interval '1 day')`
    : sql``;
  const result = await db.execute(sql`
    SELECT pattern_key AS "patternKey", profile, direction, live,
           count(*)::int AS total,
           count(*) FILTER (WHERE status = 'open')::int AS open,
           count(*) FILTER (WHERE status = 'closed')::int AS closed,
           count(*) FILTER (WHERE status = 'closed' AND pnl_margin_pct > 0)::int AS wins,
           count(*) FILTER (WHERE status = 'closed' AND pnl_margin_pct <= 0)::int AS losses,
           round((100.0 * count(*) FILTER (WHERE status = 'closed' AND pnl_margin_pct > 0)
             / nullif(count(*) FILTER (WHERE status = 'closed'), 0))::numeric, 1)::float AS "winRatePct",
           round(avg(pnl_price_pct) FILTER (WHERE status = 'closed')::numeric, 3)::float AS "avgPnlPricePct",
           round(avg(pnl_margin_pct) FILTER (WHERE status = 'closed')::numeric, 2)::float AS "avgPnlMarginPct",
           round(sum(pnl_margin_pct) FILTER (WHERE status = 'closed')::numeric, 2)::float AS "sumPnlMarginPct",
           round(avg(mfe_pct)::numeric, 3)::float AS "avgMfePct",
           round(avg(mae_pct)::numeric, 3)::float AS "avgMaePct",
           count(*) FILTER (WHERE close_reason = 'take_profit')::int AS "takeProfit",
           count(*) FILTER (WHERE close_reason = 'stop')::int AS stop,
           count(*) FILTER (WHERE close_reason = 'breakeven')::int AS breakeven,
           count(*) FILTER (WHERE close_reason = 'timeout')::int AS timeout
      FROM btc_signals
     WHERE true ${since}
     GROUP BY pattern_key, profile, direction, live
     ORDER BY profile, pattern_key, direction
  `);
  return result.rows as unknown as StatsRow[];
}

export type DailyRow = { day: string; profile: string; live: boolean; closed: number; wins: number; sumPnlMarginPct: number };

/** Closed trades per Dubai calendar day (UTC+4), per trade type and mode. */
export async function getDailyStats(days = 30): Promise<DailyRow[]> {
  const result = await db.execute(sql`
    SELECT to_char((closed_at AT TIME ZONE 'UTC') + interval '4 hours', 'YYYY-MM-DD') AS day,
           profile, live,
           count(*)::int AS closed,
           count(*) FILTER (WHERE pnl_margin_pct > 0)::int AS wins,
           round(coalesce(sum(pnl_margin_pct), 0)::numeric, 2)::float AS "sumPnlMarginPct"
      FROM btc_signals
     WHERE status = 'closed' AND closed_at > now() - (${days} * interval '1 day')
     GROUP BY 1, 2, 3
     ORDER BY 1, 2
  `);
  return result.rows as unknown as DailyRow[];
}
