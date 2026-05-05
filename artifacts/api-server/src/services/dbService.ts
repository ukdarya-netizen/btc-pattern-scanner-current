import { db } from "../db";
import { botSessions, trades, pnlSnapshots, openPositions } from "../db/schema";
import { desc, eq, gte, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import type { ClosedTrade, Position } from "./riskManager";
import { riskManager } from "./riskManager";

class DbService {
  private currentSessionId: number | null = null;

  async startSession(mode: string, maxLeverage: number, riskPct: number): Promise<number> {
    try {
      const [session] = await db.insert(botSessions).values({
        mode,
        maxLeverage,
        riskPct: String(riskPct),
        startedAt: new Date(),
      }).returning({ id: botSessions.id });
      this.currentSessionId = session.id;
      logger.info({ sessionId: session.id }, "Bot session started in DB");
      return session.id;
    } catch (e) {
      logger.error({ err: e }, "Failed to create bot session in DB");
      return -1;
    }
  }

  async stopSession(totalTrades: number, finalPnl: number): Promise<void> {
    if (!this.currentSessionId) return;
    try {
      await db.update(botSessions)
        .set({ stoppedAt: new Date(), totalTrades, finalPnl: String(finalPnl) })
        .where(eq(botSessions.id, this.currentSessionId));
      logger.info({ sessionId: this.currentSessionId, finalPnl }, "Bot session closed in DB");
      this.currentSessionId = null;
    } catch (e) {
      logger.error({ err: e }, "Failed to close bot session in DB");
    }
  }

  async saveTrade(trade: ClosedTrade, exchange = "Bybit"): Promise<void> {
    try {
      await db.insert(trades).values({
        id: trade.id,
        sessionId: this.currentSessionId,
        symbol: trade.symbol,
        side: trade.side,
        exchange,
        entryPrice: String(trade.entryPrice),
        exitPrice: String(trade.exitPrice),
        size: String(trade.size),
        leverage: trade.leverage,
        pnl: String(trade.pnl),
        pnlPct: String(trade.pnlPct),
        openedAt: new Date(trade.openedAt),
        closedAt: new Date(),
        closeReason: trade.closeReason,
      }).onConflictDoNothing();
      logger.info({ tradeId: trade.id, pnl: trade.pnl }, "Trade saved to DB");
    } catch (e) {
      logger.error({ err: e, tradeId: trade.id }, "Failed to save trade to DB");
    }
  }

  async saveSnapshot(equity: number, dailyPnl: number, openPos: number, balance?: number): Promise<void> {
    try {
      await db.insert(pnlSnapshots).values({
        sessionId: this.currentSessionId,
        equity: String(equity),
        dailyPnl: String(dailyPnl),
        openPositions: openPos,
        balance: balance !== undefined ? String(balance) : null,
        ts: new Date(),
      });
    } catch (e) {
      logger.error({ err: e }, "Failed to save P&L snapshot");
    }
  }

  async syncOpenPositions(positions: Position[]): Promise<void> {
    if (!this.currentSessionId) return;
    try {
      await db.delete(openPositions).where(eq(openPositions.sessionId, this.currentSessionId));
      if (positions.length > 0) {
        await db.insert(openPositions).values(
          positions.map(p => ({
            id: p.id,
            sessionId: this.currentSessionId!,
            symbol: p.symbol,
            side: p.side,
            exchange: "Bybit",
            entryPrice: String(p.entryPrice),
            currentPrice: String(p.currentPrice),
            size: String(p.size),
            leverage: p.leverage,
            stopLoss: String(p.stopLoss),
            takeProfit: String(p.takeProfit),
            openedAt: new Date(p.openedAt),
          }))
        ).onConflictDoNothing();
      }
    } catch (e) {
      logger.error({ err: e }, "Failed to sync open positions to DB");
    }
  }

  async getRecentTrades(limit = 100): Promise<typeof trades.$inferSelect[]> {
    try {
      return await db.select().from(trades).orderBy(desc(trades.closedAt)).limit(limit);
    } catch (e) {
      logger.error({ err: e }, "Failed to fetch recent trades from DB");
      return [];
    }
  }

  async getPnlChart(hours = 24): Promise<typeof pnlSnapshots.$inferSelect[]> {
    try {
      const since = new Date(Date.now() - hours * 3600 * 1000);
      return await db.select()
        .from(pnlSnapshots)
        .where(gte(pnlSnapshots.ts, since))
        .orderBy(pnlSnapshots.ts)
        .limit(500);
    } catch (e) {
      logger.error({ err: e }, "Failed to fetch P&L chart from DB");
      return [];
    }
  }

  async getDailyStats(): Promise<{ totalTrades: number; wins: number; totalPnl: number }> {
    try {
      const since = new Date(new Date().setHours(0, 0, 0, 0));
      const result = await db.select({
        totalTrades: sql<number>`count(*)::int`,
        wins: sql<number>`sum(case when pnl > 0 then 1 else 0 end)::int`,
        totalPnl: sql<number>`sum(pnl)::numeric`,
      }).from(trades).where(gte(trades.closedAt, since));
      return {
        totalTrades: result[0]?.totalTrades ?? 0,
        wins: result[0]?.wins ?? 0,
        totalPnl: parseFloat(String(result[0]?.totalPnl ?? "0")),
      };
    } catch (e) {
      logger.error({ err: e }, "Failed to compute daily stats");
      return { totalTrades: 0, wins: 0, totalPnl: 0 };
    }
  }

  async getStatsForPeriod(from: Date, to: Date): Promise<{
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnl: number;
    avgPnl: number;
    bestTrade: number;
    worstTrade: number;
    longTrades: number;
    shortTrades: number;
    grossProfit: number;
    grossLoss: number;
  }> {
    try {
      const { and, lte, between } = await import("drizzle-orm");
      const result = await db.select({
        totalTrades: sql<number>`count(*)::int`,
        wins: sql<number>`sum(case when pnl > 0 then 1 else 0 end)::int`,
        losses: sql<number>`sum(case when pnl <= 0 then 1 else 0 end)::int`,
        totalPnl: sql<number>`coalesce(sum(pnl), 0)::numeric`,
        avgPnl: sql<number>`coalesce(avg(pnl), 0)::numeric`,
        bestTrade: sql<number>`coalesce(max(pnl), 0)::numeric`,
        worstTrade: sql<number>`coalesce(min(pnl), 0)::numeric`,
        longTrades: sql<number>`sum(case when side = 'long' then 1 else 0 end)::int`,
        shortTrades: sql<number>`sum(case when side = 'short' then 1 else 0 end)::int`,
        grossProfit: sql<number>`coalesce(sum(case when pnl > 0 then pnl else 0 end), 0)::numeric`,
        grossLoss: sql<number>`coalesce(sum(case when pnl < 0 then pnl else 0 end), 0)::numeric`,
      }).from(trades).where(and(gte(trades.closedAt, from), lte(trades.closedAt, to)));

      const row = result[0];
      const total = row?.totalTrades ?? 0;
      const wins = row?.wins ?? 0;
      return {
        totalTrades: total,
        wins,
        losses: row?.losses ?? 0,
        winRate: total > 0 ? wins / total : 0,
        totalPnl: parseFloat(String(row?.totalPnl ?? "0")),
        avgPnl: parseFloat(String(row?.avgPnl ?? "0")),
        bestTrade: parseFloat(String(row?.bestTrade ?? "0")),
        worstTrade: parseFloat(String(row?.worstTrade ?? "0")),
        longTrades: row?.longTrades ?? 0,
        shortTrades: row?.shortTrades ?? 0,
        grossProfit: parseFloat(String(row?.grossProfit ?? "0")),
        grossLoss: parseFloat(String(row?.grossLoss ?? "0")),
      };
    } catch (e) {
      logger.error({ err: e }, "Failed to compute period stats");
      return { totalTrades: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0, avgPnl: 0, bestTrade: 0, worstTrade: 0, longTrades: 0, shortTrades: 0, grossProfit: 0, grossLoss: 0 };
    }
  }

  async initializeTodayStats(): Promise<void> {
    try {
      const since = new Date();
      since.setUTCHours(0, 0, 0, 0);
      const { and, lte } = await import("drizzle-orm");
      const todayTrades = await db.select().from(trades)
        .where(and(gte(trades.closedAt, since), lte(trades.closedAt, new Date())))
        .orderBy(desc(trades.closedAt));
      if (todayTrades.length > 0) {
        riskManager.loadClosedTrades(todayTrades);
        logger.info({ count: todayTrades.length }, "Today's trade history restored from DB on startup");
      }
    } catch (e) {
      logger.warn({ err: e }, "Could not restore today's trade history from DB");
    }
  }

  getCurrentSessionId() { return this.currentSessionId; }
}

export const dbService = new DbService();
