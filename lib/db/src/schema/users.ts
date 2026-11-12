import { boolean, index, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Accounts (owner 2026-11-12: registration «как в CAB и Нигилисте»). Created at runtime by
 * artifacts/api-server/src/lib/users.ts with the same shape and constraint names, so the publish diff finds
 * nothing to change. Signals go to approved users whose subscription has not ended (subscribed_until NULL = no end);
 * the owner (by email) is approved automatically and never expires.
 */
export const btcUsersTable = pgTable("btc_users", {
  id: serial("id").primaryKey(),
  email: text("email").notNull().unique("btc_users_email_unique"),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  chatId: text("chat_id").unique("btc_users_chat_id_unique"),
  telegramUsername: text("telegram_username"),
  status: text("status").notNull().default("pending"),
  subscribedUntil: timestamp("subscribed_until", { withTimezone: true }),
  notify: boolean("notify").notNull().default(true),
  notifySince: timestamp("notify_since", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }),
  botBlockedAt: timestamp("bot_blocked_at", { withTimezone: true }),
});

/** One-time password reset codes sent by the bot (/resetpassword), 15 minutes. */
export const btcPasswordResetsTable = pgTable("btc_password_resets", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull(),
  code: text("code").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  used: boolean("used").notNull().default(false),
}, (t) => ({ user: index("btc_password_resets_user").on(t.userId) }));
