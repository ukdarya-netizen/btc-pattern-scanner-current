import { boolean, index, integer, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const btcTelegramSubscribersTable = pgTable("btc_telegram_subscribers", {
  chatId: text("chat_id").primaryKey(),
  active: boolean("active").notNull().default(true),
  subscribedAt: timestamp("subscribed_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const btcTelegramStateTable = pgTable("btc_telegram_state", {
  key: text("key").primaryKey(),
  nextUpdateId: integer("next_update_id").notNull().default(0),
});

export const btcTelegramDeliveriesTable = pgTable("btc_telegram_deliveries", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id").notNull(),
  chatId: text("chat_id").notNull(),
  channel: boolean("channel").notNull(),
  text: text("text").notNull(),
  status: text("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
}, (t) => ({
  recipient: uniqueIndex("btc_telegram_delivery_recipient_idx").on(t.eventId, t.chatId),
  pending: index("btc_telegram_delivery_pending_idx").on(t.status, t.nextAttemptAt),
}));
