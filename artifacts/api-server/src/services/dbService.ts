import { db } from "../db";
import { patternSignals } from "../db/schema";
import { desc, eq, isNull, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import type { PatternHit } from "./altScanner";

class DbService {
  async savePatternSignal(hit: PatternHit): Promise<number | null> {
    try {
      const [row] = await db
        .insert(patternSignals)
        .values({
          symbol: hit.symbol,
          pattern: hit.pattern,
          direction: hit.direction,
          price: String(hit.metrics.price),
          cycleCount: hit.cycleCount,
          metrics: hit.metrics,
          firedAt: new Date().toISOString(),
        })
        .returning({ id: patternSignals.id });
      logger.info({ symbol: hit.symbol, pattern: hit.pattern }, "Pattern signal saved to DB");
      return row?.id ?? null;
    } catch (e) {
      logger.error({ err: e }, "Failed to save pattern signal to DB");
      return null;
    }
  }

  async getRecentSignals(limit = 100) {
    try {
      return await db.select().from(patternSignals).orderBy(desc(patternSignals.firedAt)).limit(limit);
    } catch (e) {
      logger.error({ err: e }, "Failed to fetch recent pattern signals");
      return [];
    }
  }

  async getOpenSignals() {
    try {
      return await db.select().from(patternSignals).where(isNull(patternSignals.closedAt)).orderBy(desc(patternSignals.firedAt));
    } catch (e) {
      logger.error({ err: e }, "Failed to fetch open pattern signals");
      return [];
    }
  }

  async closeSignal(id: number, closePrice: number, pnlPct: number): Promise<void> {
    try {
      await db
        .update(patternSignals)
        .set({ closedAt: new Date().toISOString(), closePrice: String(closePrice), pnlPct: String(pnlPct) })
        .where(eq(patternSignals.id, id));
    } catch (e) {
      logger.error({ err: e, id }, "Failed to close pattern signal");
    }
  }

  async getOverallStats() {
    try {
      const [row] = await db
        .select({
          total: sql<number>`count(*)`,
          closed: sql<number>`count(*) filter (where ${patternSignals.closedAt} is not null)`,
          wins: sql<number>`count(*) filter (where ${patternSignals.pnlPct}::numeric > 0)`,
          losses: sql<number>`count(*) filter (where ${patternSignals.pnlPct}::numeric <= 0)`,
          avgPnlPct: sql<number>`avg(${patternSignals.pnlPct}::numeric) filter (where ${patternSignals.closedAt} is not null)`,
          open: sql<number>`count(*) filter (where ${patternSignals.closedAt} is null)`,
        })
        .from(patternSignals);
      const closed = Number(row?.closed ?? 0);
      const wins = Number(row?.wins ?? 0);
      return {
        total: Number(row?.total ?? 0),
        open: Number(row?.open ?? 0),
        closed,
        wins,
        losses: Number(row?.losses ?? 0),
        winRate: closed > 0 ? (wins / closed) * 100 : 0,
        avgPnlPct: row?.avgPnlPct !== null && row?.avgPnlPct !== undefined ? Number(row.avgPnlPct) : 0,
      };
    } catch (e) {
      logger.error({ err: e }, "Failed to compute overall stats");
      return { total: 0, open: 0, closed: 0, wins: 0, losses: 0, winRate: 0, avgPnlPct: 0 };
    }
  }

  async getPatternStats() {
    try {
      const rows = await db
        .select({
          pattern: patternSignals.pattern,
          total: sql<number>`count(*)`,
          closed: sql<number>`count(*) filter (where ${patternSignals.closedAt} is not null)`,
          wins: sql<number>`count(*) filter (where ${patternSignals.pnlPct}::numeric > 0)`,
          avgPnlPct: sql<number>`avg(${patternSignals.pnlPct}::numeric) filter (where ${patternSignals.closedAt} is not null)`,
        })
        .from(patternSignals)
        .groupBy(patternSignals.pattern)
        .orderBy(desc(sql`count(*)`));
      return rows.map((r) => {
        const closed = Number(r.closed);
        const wins = Number(r.wins);
        return {
          pattern: r.pattern,
          total: Number(r.total),
          closed,
          wins,
          winRate: closed > 0 ? (wins / closed) * 100 : 0,
          avgPnlPct: r.avgPnlPct !== null && r.avgPnlPct !== undefined ? Number(r.avgPnlPct) : 0,
        };
      });
    } catch (e) {
      logger.error({ err: e }, "Failed to compute pattern stats");
      return [];
    }
  }
}

export const dbService = new DbService();
