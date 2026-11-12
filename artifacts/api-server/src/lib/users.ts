/**
 * Accounts and access (owner 2026-11-12: «всё как в CAB и Нигилисте» — ported from Nihilist).
 * - Registration on the dashboard (name, email, Telegram Chat ID, password).
 * - The owner (shak.darya23@gmail.com) is approved at once and never expires;
 *   everyone else waits for the owner's approval (Telegram buttons or the
 *   «Пользователи» page). Approval from Telegram opens one month.
 * - Dashboard and bot are open only to approved users whose subscription has
 *   not ended (subscribed_until NULL = no end date).
 * Passwords: scrypt. Session tokens: HMAC-SHA256 with SESSION_SECRET, 7 days.
 */
import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { NextFunction, Request, Response } from "express";
import { pool } from "@workspace/db";
import { logger } from "./logger";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export type UserStatus = "pending" | "approved" | "blocked" | "inactive";
export type AccessStatus = UserStatus | "expired";
export type UserRow = {
  id: number; email: string; password_hash: string; name: string; chat_id: string | null;
  telegram_username: string | null; status: UserStatus; subscribed_until: Date | null;
  notify: boolean; notify_since: Date | null; created_at: Date; approved_at: Date | null; last_login_at: Date | null;
  last_activity_at: Date | null; bot_blocked_at: Date | null;
};

/** Owner (owner 2026-11-02): shak.darya23@gmail.com; BTC_OWNER_EMAIL overrides. */
export const DEFAULT_OWNER_EMAIL = "shak.darya23@gmail.com";
export const ownerEmail = (): string => (process.env.BTC_OWNER_EMAIL?.trim() || DEFAULT_OWNER_EMAIL).toLowerCase();
export const isOwnerEmail = (email: string | null | undefined): boolean =>
  ownerEmail() !== "" && (email ?? "").toLowerCase().trim() === ownerEmail();

// ---------------- tables ----------------
// Same shape and constraint names as lib/db/src/schema/users.ts, so the
// publish diff finds nothing to change.
let ready: Promise<void> | null = null;
export function ensureUserTables(): Promise<void> {
  ready ??= (async () => {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS btc_users (
        id serial PRIMARY KEY,
        email text NOT NULL,
        password_hash text NOT NULL,
        name text NOT NULL,
        chat_id text,
        telegram_username text,
        status text NOT NULL DEFAULT 'pending',
        subscribed_until timestamptz,
        notify boolean NOT NULL DEFAULT true,
        notify_since timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        approved_at timestamptz,
        last_login_at timestamptz,
        last_activity_at timestamptz,
        bot_blocked_at timestamptz,
        CONSTRAINT btc_users_email_unique UNIQUE (email),
        CONSTRAINT btc_users_chat_id_unique UNIQUE (chat_id)
      )`);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS btc_password_resets (
        id serial PRIMARY KEY,
        user_id integer NOT NULL,
        code text NOT NULL,
        expires_at timestamptz NOT NULL,
        used boolean NOT NULL DEFAULT false
      )`);
    await pool.query("CREATE INDEX IF NOT EXISTS btc_password_resets_user ON btc_password_resets (user_id)");
  })().catch((err) => { ready = null; throw err; });
  return ready;
}

// ---------------- passwords ----------------
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, saltHex, hashHex] = stored.split("$");
  if (kind !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const got = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

// ---------------- tokens ----------------
const TOKEN_TTL_MS = 7 * 86_400_000;
let fallbackSecret: string | null = null;
function secret(): string {
  const s = process.env.SESSION_SECRET?.trim();
  if (s) return s;
  if (!fallbackSecret) {
    fallbackSecret = randomBytes(32).toString("hex");
    logger.warn("btc: SESSION_SECRET not set — logins last until the next restart");
  }
  return fallbackSecret;
}
const b64 = (v: string | Buffer) => Buffer.from(v).toString("base64url");
const sign = (body: string) => createHmac("sha256", secret()).update(body).digest("base64url");

export type TokenPayload = { uid: number; email: string; role: "owner" | "user"; exp: number };

export function signToken(user: { id: number; email: string }, now = Date.now()): string {
  const payload: TokenPayload = { uid: user.id, email: user.email, role: isOwnerEmail(user.email) ? "owner" : "user", exp: now + TOKEN_TTL_MS };
  const body = b64(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

export function verifyToken(token: string, now = Date.now()): TokenPayload | null {
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const a = Buffer.from(sign(body)), b = Buffer.from(mac);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as TokenPayload;
    return typeof p.uid === "number" && typeof p.exp === "number" && p.exp > now ? p : null;
  } catch { return null; }
}

// ---------------- access ----------------
export function accessStatus(u: { email: string; status: string; subscribed_until: Date | null }, now = new Date()): AccessStatus {
  if (isOwnerEmail(u.email)) return u.status === "blocked" ? "blocked" : "approved";
  if (u.status === "approved" && u.subscribed_until && u.subscribed_until.getTime() <= now.getTime()) return "expired";
  return u.status === "approved" || u.status === "blocked" || u.status === "inactive" ? u.status : "pending";
}

export const EXPIRED_TEXT = "Подписка истекла. Свяжитесь с администратором для продления.";

/** Russian error for a status that is not allowed in (null = allowed). */
export function accessError(s: AccessStatus): { status: number; error: string; code?: string } | null {
  if (s === "approved") return null;
  if (s === "blocked") return { status: 403, error: "Доступ заблокирован", code: "blocked" };
  if (s === "pending") return { status: 403, error: "Запрос ожидает одобрения", code: "pending" };
  if (s === "inactive") return { status: 403, error: EXPIRED_TEXT, code: "inactive" };
  return { status: 403, error: EXPIRED_TEXT, code: "subscription_expired" };
}

export async function userById(id: number): Promise<UserRow | null> {
  await ensureUserTables();
  const { rows } = await pool.query<UserRow>("SELECT * FROM btc_users WHERE id = $1", [id]);
  return rows[0] ?? null;
}

export async function userByEmail(email: string): Promise<UserRow | null> {
  await ensureUserTables();
  const { rows } = await pool.query<UserRow>("SELECT * FROM btc_users WHERE email = $1", [email.toLowerCase().trim()]);
  return rows[0] ?? null;
}

export async function userByChatId(chatId: string | number): Promise<UserRow | null> {
  await ensureUserTables();
  const { rows } = await pool.query<UserRow>("SELECT * FROM btc_users WHERE chat_id = $1", [String(chatId)]);
  return rows[0] ?? null;
}

/** Chat of the owner: BTC_OWNER_CHAT_ID, else the Chat ID the owner registered with. */
export async function ownerChatId(): Promise<string | null> {
  const env = process.env.BTC_OWNER_CHAT_ID?.trim();
  if (env) return env;
  if (!ownerEmail()) return null;
  const owner = await userByEmail(ownerEmail());
  return owner?.chat_id ?? null;
}

export async function isOwnerChat(chatId: string | number): Promise<boolean> {
  const owner = await ownerChatId();
  return owner !== null && owner === String(chatId);
}

/**
 * SQL condition for a user who receives signals: approved, subscription not
 * ended (the owner never ends), signals on, Chat ID set. `$owner` = owner email.
 */
export const RECIPIENT_SQL = `u.status = 'approved' AND u.notify AND u.chat_id IS NOT NULL
  AND (u.email = $OWNER OR u.subscribed_until IS NULL OR u.subscribed_until > now())`;

export function recipientSql(ownerParam: string): string {
  return RECIPIENT_SQL.replace("$OWNER", ownerParam);
}

// ---------------- middleware ----------------
export type AuthedRequest = Request & { user?: UserRow; role?: "owner" | "user" };

function bearer(req: Request): string | null {
  const h = req.header("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

/** Signed in, approved, subscription active (owner always). */
export async function requireUser(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = bearer(req);
    const p = token ? verifyToken(token) : null;
    if (!p) { res.status(401).json({ error: "Требуется вход", code: "auth_required" }); return; }
    const user = await userById(p.uid);
    if (!user || user.email !== p.email) { res.status(401).json({ error: "Требуется вход", code: "auth_required" }); return; }
    const denied = accessError(accessStatus(user));
    if (denied) { res.status(denied.status).json({ error: denied.error, code: denied.code }); return; }
    req.user = user;
    req.role = isOwnerEmail(user.email) ? "owner" : "user";
    next();
  } catch (err) {
    logger.error({ err }, "btc: auth check failed");
    res.status(500).json({ error: "Ошибка сервера" });
  }
}

/** After requireUser: owner only. */
export function ownerOnly(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (req.role !== "owner") { res.status(403).json({ error: "Только для владельца" }); return; }
  next();
}
export const isOwnerReq = (req: Request) => (req as AuthedRequest).role === "owner";

export async function requireOwner(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  await requireUser(req, res, () => {
    if (req.role !== "owner") { res.status(403).json({ error: "Только для владельца" }); return; }
    next();
  });
}
