import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * One virtual BTC position per fired signal. Prices are BingX BTC-USDT last
 * prices; PnL is measured in price % (gross) and in % of margin (levered,
 * net of modelled taker fees) so each trade type is comparable.
 */
export const btcSignalsTable = pgTable(
  "btc_signals",
  {
    id: serial("id").primaryKey(),
    patternKey: text("pattern_key").notNull(),
    direction: text("direction").notNull(), // long | short
    profile: text("profile").notNull(), // scalp | intraday | swing
    leverage: integer("leverage").notNull(),
    status: text("status").notNull().default("open"), // open | closed
    /** false = shadow signal: tracked for statistics, never published. */
    live: boolean("live").notNull().default(false),
    entryPrice: doublePrecision("entry_price").notNull(),
    initialStopPrice: doublePrecision("initial_stop_price").notNull(),
    stopPrice: doublePrecision("stop_price").notNull(),
    liquidationPrice: doublePrecision("liquidation_price").notNull(),
    /** [{ price, fraction, hitAt|null }] in order of distance from entry. */
    targets: jsonb("targets").notNull(),
    remainingFraction: doublePrecision("remaining_fraction").notNull().default(1),
    /** Σ fraction × signed price move % of already closed parts. */
    realizedPricePct: doublePrecision("realized_price_pct").notNull().default(0),
    /** Σ fraction × exitPrice/entry of already closed parts (fee model). */
    realizedExitNotional: doublePrecision("realized_exit_notional").notNull().default(0),
    breakevenMoved: boolean("breakeven_moved").notNull().default(false),
    mfePct: doublePrecision("mfe_pct").notNull().default(0),
    maePct: doublePrecision("mae_pct").notNull().default(0),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
    candleCloseAt: timestamp("candle_close_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closeReason: text("close_reason"), // take_profit | stop | breakeven | timeout
    exitPrice: doublePrecision("exit_price"),
    pnlPricePct: doublePrecision("pnl_price_pct"),
    pnlMarginPct: doublePrecision("pnl_margin_pct"),
    /** Every metric the pattern saw at decision time (analysis input). */
    metrics: jsonb("metrics").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    statusIdx: index("btc_signals_status_idx").on(t.status),
    patternIdx: index("btc_signals_pattern_idx").on(t.patternKey, t.profile, t.direction),
  }),
);

/** Lifecycle events; each is delivered to Telegram at most once. */
export const btcSignalEventsTable = pgTable(
  "btc_signal_events",
  {
    id: serial("id").primaryKey(),
    signalId: integer("signal_id").notNull(),
    eventKey: text("event_key").notNull(),
    kind: text("kind").notNull(), // opened | target_hit | closed
    price: doublePrecision("price"),
    detail: jsonb("detail").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    telegramSentAt: timestamp("telegram_sent_at", { withTimezone: true }),
    telegramAttempts: integer("telegram_attempts").notNull().default(0),
  },
  (t) => ({
    eventKeyIdx: uniqueIndex("btc_signal_events_key_idx").on(t.eventKey),
    unsentIdx: index("btc_signal_events_unsent_idx").on(t.telegramSentAt),
  }),
);

/** Every pattern evaluation (fired and not fired) with its metrics. */
export const btcDecisionsTable = pgTable(
  "btc_decisions",
  {
    id: serial("id").primaryKey(),
    cycleAt: timestamp("cycle_at", { withTimezone: true }).notNull(),
    candleCloseAt: timestamp("candle_close_at", { withTimezone: true }).notNull(),
    patternKey: text("pattern_key").notNull(),
    direction: text("direction").notNull(),
    profile: text("profile").notNull(),
    decision: text("decision").notNull(), // fired | rejected | suppressed
    reasons: jsonb("reasons").notNull(),
    price: doublePrecision("price"),
    metrics: jsonb("metrics").notNull(),
    signalId: integer("signal_id"),
  },
  (t) => ({
    patternIdx: index("btc_decisions_pattern_idx").on(t.patternKey, t.cycleAt),
    uniqueEval: uniqueIndex("btc_decisions_unique_eval_idx").on(
      t.patternKey, t.direction, t.profile, t.candleCloseAt,
    ),
  }),
);

export type BtcSignal = typeof btcSignalsTable.$inferSelect;
export type BtcSignalInsert = typeof btcSignalsTable.$inferInsert;
export type BtcSignalEvent = typeof btcSignalEventsTable.$inferSelect;

/** One row per published period report; guarantees each is sent once. */
export const btcReportsTable = pgTable("btc_reports", {
  periodKey: text("period_key").primaryKey(), // day:2026-10-24 | week:2026-10-19 | month:2026-10
  text: text("text").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  attempts: integer("attempts").notNull().default(0),
});

/** Market metrics of every 5m cycle (history for the dashboard and analysis). */
export const btcMarketSnapshotsTable = pgTable("btc_market_snapshots", {
  candleCloseAt: timestamp("candle_close_at", { withTimezone: true }).primaryKey(),
  price: doublePrecision("price").notNull(),
  metrics: jsonb("metrics").notNull(),
  missing: jsonb("missing").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** BingX BTC-USDT closed candles (1m and 15m), the base for outcome labels. */
export const btcCandlesTable = pgTable("btc_candles", {
  interval: text("interval").notNull(), // 1m | 15m
  openTime: timestamp("open_time", { withTimezone: true }).notNull(),
  open: doublePrecision("open").notNull(),
  high: doublePrecision("high").notNull(),
  low: doublePrecision("low").notNull(),
  close: doublePrecision("close").notNull(),
  volume: doublePrecision("volume").notNull(),
}, (t) => ({
  pk: uniqueIndex("btc_candles_pk").on(t.interval, t.openTime),
}));
