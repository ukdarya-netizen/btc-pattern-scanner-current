import { pgTable, serial, varchar, numeric, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";
const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });

export const patternSignals = pgTable("pattern_signals", {
  id: serial("id").primaryKey(),
  symbol: varchar("symbol", { length: 20 }).notNull(),
  pattern: varchar("pattern", { length: 40 }).notNull(),
  direction: varchar("direction", { length: 5 }).notNull().default("LONG"),
  price: numeric("price", { precision: 20, scale: 8 }).notNull(),
  cycleCount: integer("cycle_count").notNull().default(0),
  metrics: jsonb("metrics").notNull(),
  firedAt: timestamptz("fired_at").notNull().defaultNow(),
  closedAt: timestamptz("closed_at"),
}, (table) => [
  index("idx_pattern_signals_fired_at").on(table.firedAt),
  index("idx_pattern_signals_symbol_pattern").on(table.symbol, table.pattern),
]);

export type PatternSignal = typeof patternSignals.$inferSelect;
export type NewPatternSignal = typeof patternSignals.$inferInsert;
