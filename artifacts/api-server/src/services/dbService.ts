import { db } from "../db";
import { patternSignals } from "../db/schema";
import { desc } from "drizzle-orm";
import { logger } from "../lib/logger";
import type { PatternHit } from "./altScanner";

class DbService {
  async savePatternSignal(hit: PatternHit): Promise<void> {
    try {
      await db.insert(patternSignals).values({
        symbol: hit.symbol,
        pattern: hit.pattern,
        direction: hit.direction,
        price: String(hit.metrics.price),
        cycleCount: hit.cycleCount,
        metrics: hit.metrics,
        firedAt: new Date().toISOString(),
      });
      logger.info({ symbol: hit.symbol, pattern: hit.pattern }, "Pattern signal saved to DB");
    } catch (e) {
      logger.error({ err: e }, "Failed to save pattern signal to DB");
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
}

export const dbService = new DbService();
