import { pgTable, serial, varchar, numeric, integer, timestamp, index } from "drizzle-orm/pg-core";
const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });

export const botSessions = pgTable("bot_sessions", {
  id: serial("id").primaryKey(),
  mode: varchar("mode", { length: 10 }).notNull(),
  maxLeverage: integer("max_leverage").notNull(),
  riskPct: numeric("risk_pct", { precision: 5, scale: 2 }).notNull(),
  startedAt: timestamptz("started_at").notNull().defaultNow(),
  stoppedAt: timestamptz("stopped_at"),
  totalTrades: integer("total_trades").default(0),
  finalPnl: numeric("final_pnl", { precision: 12, scale: 4 }).default("0"),
});

export const trades = pgTable("trades", {
  id: varchar("id", { length: 64 }).primaryKey(),
  sessionId: integer("session_id").references(() => botSessions.id),
  symbol: varchar("symbol", { length: 20 }).notNull().default("BTCUSDT"),
  side: varchar("side", { length: 5 }).notNull(),
  exchange: varchar("exchange", { length: 20 }).notNull().default("Bybit"),
  entryPrice: numeric("entry_price", { precision: 16, scale: 4 }).notNull(),
  exitPrice: numeric("exit_price", { precision: 16, scale: 4 }).notNull(),
  size: numeric("size", { precision: 16, scale: 8 }).notNull(),
  leverage: integer("leverage").notNull().default(1),
  pnl: numeric("pnl", { precision: 16, scale: 4 }).notNull(),
  pnlPct: numeric("pnl_pct", { precision: 10, scale: 6 }).notNull(),
  openedAt: timestamptz("opened_at").notNull(),
  closedAt: timestamptz("closed_at").notNull().defaultNow(),
  closeReason: varchar("close_reason", { length: 20 }).default("manual"),
}, (table) => [
  index("idx_trades_closed_at").on(table.closedAt),
]);

export const pnlSnapshots = pgTable("pnl_snapshots", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").references(() => botSessions.id),
  ts: timestamptz("ts").notNull().defaultNow(),
  equity: numeric("equity", { precision: 16, scale: 4 }).notNull(),
  dailyPnl: numeric("daily_pnl", { precision: 16, scale: 4 }).notNull(),
  openPositions: integer("open_positions").notNull().default(0),
  balance: numeric("balance", { precision: 16, scale: 4 }),
}, (table) => [
  index("idx_pnl_snapshots_ts").on(table.ts),
  index("idx_pnl_snapshots_session").on(table.sessionId),
]);

export const openPositions = pgTable("open_positions", {
  id: varchar("id", { length: 64 }).primaryKey(),
  sessionId: integer("session_id").references(() => botSessions.id),
  symbol: varchar("symbol", { length: 20 }).notNull().default("BTCUSDT"),
  side: varchar("side", { length: 5 }).notNull(),
  exchange: varchar("exchange", { length: 20 }).notNull().default("Bybit"),
  entryPrice: numeric("entry_price", { precision: 16, scale: 4 }).notNull(),
  currentPrice: numeric("current_price", { precision: 16, scale: 4 }).notNull(),
  size: numeric("size", { precision: 16, scale: 8 }).notNull(),
  leverage: integer("leverage").notNull().default(1),
  stopLoss: numeric("stop_loss", { precision: 16, scale: 4 }).notNull(),
  takeProfit: numeric("take_profit", { precision: 16, scale: 4 }).notNull(),
  openedAt: timestamptz("opened_at").notNull().defaultNow(),
});

export type BotSession = typeof botSessions.$inferSelect;
export type NewBotSession = typeof botSessions.$inferInsert;
export type Trade = typeof trades.$inferSelect;
export type NewTrade = typeof trades.$inferInsert;
export type PnlSnapshot = typeof pnlSnapshots.$inferSelect;
export type NewPnlSnapshot = typeof pnlSnapshots.$inferInsert;
export type OpenPosition = typeof openPositions.$inferSelect;
