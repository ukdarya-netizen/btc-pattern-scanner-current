/**
 * Registration, login, password reset and the owner's user management
 * (owner 2026-11-12: «всё как в CAB и Нигилисте» — ported from Nihilist). Messages in Russian.
 */
import { Router, type IRouter } from "express";
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";
import {
  accessError, accessStatus, ensureUserTables, hashPassword, isOwnerEmail, requireOwner, requireUser, signToken,
  userByChatId, userByEmail, userById, verifyPassword, type AuthedRequest, type UserRow,
} from "../lib/users";
import {
  BLOCKED_TEXT, DEACTIVATED_TEXT, PASSWORD_CHANGED_TEXT, getBotUsername, notifyOwnerRegistration, sendQuiet, subscriptionRenewedText, subscriptionStartedText,
} from "../telegram/bot";

const router: IRouter = Router();

// Registration spam guard: 10 requests per address per hour.
const hits = new Map<string, number[]>();
function limited(ip: string, max = 10, windowMs = 3_600_000): boolean {
  const now = Date.now();
  const list = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 10_000) hits.clear();
  return list.length > max;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
export const validChatId = (v: string) => /^\d{1,20}$/.test(v) && Number(v) > 0;

router.get("/auth/bot", async (_req, res) => {
  res.json({ username: await getBotUsername() });
});

router.post("/auth/register", async (req, res) => {
  try {
    await ensureUserTables();
    if (limited(`reg:${req.ip ?? "?"}`)) { res.status(429).json({ error: "Слишком много запросов. Попробуйте позже." }); return; }
    const email = str(req.body?.email).toLowerCase().trim();
    const password = str(req.body?.password);
    const name = str(req.body?.name).trim();
    const chatId = str(req.body?.chatId).trim();
    const telegramUsername = str(req.body?.telegramUsername).trim().replace(/^@/, "") || null;
    if (!email || !password || !name || !chatId) { res.status(400).json({ error: "Заполните все обязательные поля" }); return; }
    if (password.length < 6) { res.status(400).json({ error: "Пароль: минимум 6 символов" }); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { res.status(400).json({ error: "Неверный email" }); return; }
    if (!validChatId(chatId)) { res.status(400).json({ error: "Неверный Telegram Chat ID" }); return; }
    if (name.length > 100 || email.length > 200 || (telegramUsername?.length ?? 0) > 64) {
      res.status(400).json({ error: "Слишком длинное значение" }); return;
    }

    const owner = isOwnerEmail(email);
    const existing = await userByEmail(email);
    const prev = existing ? accessStatus(existing) : null;
    // Blocked, expired or deactivated accounts may ask again (as CAB); others are taken.
    if (existing && prev !== "blocked" && prev !== "expired" && prev !== "inactive") {
      res.status(409).json({ error: "Этот email уже зарегистрирован" }); return;
    }
    // Security (owner 2026-11-10): a repeat request overwrites the password, so it is accepted only from the
    // Telegram Chat ID the account already has — knowing someone's email is not enough to take the account.
    if (existing?.chat_id && existing.chat_id !== chatId) {
      res.status(409).json({ error: "Этот email уже зарегистрирован с другим Telegram Chat ID. Напишите администратору." }); return;
    }
    const byChat = await userByChatId(chatId);
    if (byChat && byChat.id !== existing?.id) {
      res.status(409).json({ error: "Этот Telegram Chat ID уже зарегистрирован" }); return;
    }

    const passwordHash = await hashPassword(password);
    if (existing) {
      await pool.query(
        `UPDATE btc_users SET password_hash = $2, name = $3, chat_id = $4, telegram_username = $5, status = 'pending', approved_at = NULL
         WHERE id = $1`,
        [existing.id, passwordHash, name, chatId, telegramUsername],
      );
      void notifyOwnerRegistration({ id: existing.id, name, email, chatId, telegramUsername }, prev === "blocked" ? "blocked" : "expired")
        .catch((err) => logger.warn({ err }, "btc: owner not notified of a registration"));
      res.json({ ok: true, autoApproved: false, resubmitted: true });
      return;
    }

    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO btc_users (email, password_hash, name, chat_id, telegram_username, status, approved_at, notify_since)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id`,
      [email, passwordHash, name, chatId, telegramUsername, owner ? "approved" : "pending", owner ? new Date() : null],
    );
    if (!owner) {
      void notifyOwnerRegistration({ id: rows[0]!.id, name, email, chatId, telegramUsername }, null)
        .catch((err) => logger.warn({ err }, "btc: owner not notified of a registration"));
    }
    res.json({ ok: true, autoApproved: owner });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") { res.status(409).json({ error: "Этот email или Chat ID уже зарегистрирован" }); return; }
    logger.error({ err }, "btc: register failed");
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

router.post("/auth/login", async (req, res) => {
  try {
    if (limited(`login:${req.ip ?? "?"}`, 30, 15 * 60_000)) { res.status(429).json({ error: "Слишком много попыток. Попробуйте через 15 минут." }); return; }
    const email = str(req.body?.email).toLowerCase().trim();
    const password = str(req.body?.password);
    if (!email || !password) { res.status(400).json({ error: "Введите email и пароль" }); return; }
    const user = await userByEmail(email);
    if (!user || !(await verifyPassword(password, user.password_hash))) { res.status(401).json({ error: "Неверный email или пароль" }); return; }
    const denied = accessError(accessStatus(user));
    if (denied) { res.status(denied.status).json({ error: denied.error, code: denied.code }); return; }
    await pool.query("UPDATE btc_users SET last_login_at = now() WHERE id = $1", [user.id]);
    const role = isOwnerEmail(user.email) ? "owner" : "user";
    res.json({ ok: true, token: signToken(user), name: user.name, email: user.email, role });
  } catch (err) {
    logger.error({ err }, "btc: login failed");
    res.status(500).json({ error: "Ошибка сервера" });
  }
});

router.get("/auth/me", requireUser, (req: AuthedRequest, res) => {
  const u = req.user!;
  res.json({ id: u.id, email: u.email, name: u.name, role: req.role, subscribedUntil: isOwnerEmail(u.email) ? null : u.subscribed_until });
});

// Presence (as CAB): the dashboard pings every 30 s while the tab is visible.
router.post("/auth/heartbeat", requireUser, async (req: AuthedRequest, res) => {
  await pool.query("UPDATE btc_users SET last_activity_at = now() WHERE id = $1", [req.user!.id]);
  res.status(204).end();
});

router.post("/auth/reset-confirm", async (req, res) => {
  try {
    if (limited(`reset:${req.ip ?? "?"}`, 20, 15 * 60_000)) { res.status(429).json({ error: "Слишком много попыток. Попробуйте через 15 минут." }); return; }
    const email = str(req.body?.email).toLowerCase().trim();
    const code = str(req.body?.code).trim();
    const newPassword = str(req.body?.newPassword);
    if (!email || !code || !newPassword) { res.status(400).json({ error: "Обязательные поля: email, code, newPassword" }); return; }
    if (newPassword.length < 6) { res.status(400).json({ error: "Пароль должен быть не менее 6 символов" }); return; }
    const user = await userByEmail(email);
    if (!user) { res.status(400).json({ error: "Неверный email или код" }); return; }
    const { rows } = await pool.query<{ id: number }>(
      "SELECT id FROM btc_password_resets WHERE user_id = $1 AND code = $2 AND NOT used AND expires_at > now() LIMIT 1",
      [user.id, code],
    );
    if (!rows[0]) {
      // Security (owner 2026-11-10): 5 wrong codes for one account burn its active code (no guessing from many addresses).
      if (limited(`reset-user:${user.id}`, 5, 15 * 60_000)) await pool.query("DELETE FROM btc_password_resets WHERE user_id = $1", [user.id]);
      res.status(400).json({ error: "Неверный или устаревший код" }); return;
    }
    await pool.query("UPDATE btc_users SET password_hash = $2 WHERE id = $1", [user.id, await hashPassword(newPassword)]);
    await pool.query("UPDATE btc_password_resets SET used = true WHERE id = $1", [rows[0].id]);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "btc: reset-confirm failed");
    res.status(500).json({ error: "Ошибка при сбросе пароля" });
  }
});

// ---------------- owner: users ----------------
const ONLINE_MS = 90_000;
const publicUser = (u: UserRow) => ({
  id: u.id, email: u.email, name: u.name, chatId: u.chat_id, telegramUsername: u.telegram_username,
  subscribedUntil: isOwnerEmail(u.email) ? null : u.subscribed_until, status: accessStatus(u), notify: u.notify,
  owner: isOwnerEmail(u.email), createdAt: u.created_at, approvedAt: u.approved_at, lastLoginAt: u.last_login_at,
  lastActivityAt: u.last_activity_at, online: Boolean(u.last_activity_at && Date.now() - u.last_activity_at.getTime() < ONLINE_MS),
  botBlockedAt: u.bot_blocked_at,
});

router.get("/admin/users/pending-count", requireOwner, async (_req, res) => {
  const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM btc_users WHERE status = 'pending'");
  res.json({ count: rows[0]?.n ?? 0 });
});

router.get("/admin/users", requireOwner, async (_req, res) => {
  const { rows } = await pool.query<UserRow>("SELECT * FROM btc_users ORDER BY created_at");
  res.json(rows.map(publicUser));
});

/** «Подписчики» (as CAB members): everyone + signal recipients now and new today (Dubai day). */
router.get("/admin/members", requireOwner, async (_req, res) => {
  const { rows } = await pool.query<UserRow>("SELECT * FROM btc_users ORDER BY created_at");
  const members = rows.map(publicUser);
  const dayStart = Math.floor((Date.now() + 4 * 3_600_000) / 86_400_000) * 86_400_000 - 4 * 3_600_000;
  const recipients = rows.filter((u) => accessStatus(u) === "approved" && u.notify && u.chat_id);
  res.json({
    members,
    subscribers: {
      active: recipients.length,
      newToday: recipients.filter((u) => (u.approved_at?.getTime() ?? 0) >= dayStart).length,
    },
  });
});

router.patch("/admin/users/:id", requireOwner, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const before = Number.isSafeInteger(id) ? await userById(id) : null;
    if (!before) { res.status(404).json({ error: "Пользователь не найден" }); return; }
    const body = (req.body ?? {}) as { status?: string; subscribedUntil?: string | null; chatId?: string | null; newPassword?: string };
    if (body.status !== undefined && !["approved", "blocked", "pending", "inactive"].includes(body.status)) {
      res.status(400).json({ error: "Неверный статус" }); return;
    }
    if (body.newPassword !== undefined && (typeof body.newPassword !== "string" || body.newPassword.length < 6)) {
      res.status(400).json({ error: "Пароль: минимум 6 символов" }); return;
    }
    let until: Date | null | undefined;
    if (body.subscribedUntil !== undefined) {
      until = body.subscribedUntil ? new Date(body.subscribedUntil) : null;
      if (until && Number.isNaN(until.getTime())) { res.status(400).json({ error: "Неверная дата" }); return; }
    }
    let chatId: string | null | undefined;
    if (body.chatId !== undefined) {
      chatId = body.chatId?.trim() || null;
      if (chatId !== null && !validChatId(chatId)) { res.status(400).json({ error: "Неверный Telegram Chat ID" }); return; }
      if (chatId !== null) {
        const other = await userByChatId(chatId);
        if (other && other.id !== id) { res.status(409).json({ error: "Этот Telegram Chat ID уже связан с другим пользователем" }); return; }
      }
    }
    if (body.status === undefined && until === undefined && chatId === undefined && body.newPassword === undefined) {
      res.status(400).json({ error: "Нет данных для обновления" }); return;
    }
    if (isOwnerEmail(before.email) && body.status && body.status !== "approved") {
      res.status(400).json({ error: "Владельца нельзя заблокировать" }); return;
    }
    if (body.newPassword !== undefined) {
      await pool.query("UPDATE btc_users SET password_hash = $2 WHERE id = $1", [id, await hashPassword(body.newPassword)]);
      sendQuiet(before.chat_id, PASSWORD_CHANGED_TEXT);
      if (body.status === undefined && until === undefined && chatId === undefined) { res.json({ ok: true }); return; }
    }

    const next: UserRow = {
      ...before,
      ...(body.status !== undefined ? { status: body.status as UserRow["status"] } : {}),
      ...(until !== undefined ? { subscribed_until: until } : {}),
      ...(chatId !== undefined ? { chat_id: chatId } : {}),
    };
    const wasActive = accessStatus(before) === "approved";
    const isActive = accessStatus(next) === "approved";
    await pool.query(
      `UPDATE btc_users SET status = $2, subscribed_until = $3, chat_id = $4,
         approved_at = CASE WHEN $2 = 'approved' THEN (CASE WHEN status = 'approved' THEN approved_at END) ELSE NULL END,
         notify = CASE WHEN $5 THEN true ELSE notify END,
         notify_since = CASE WHEN $5 THEN now() ELSE notify_since END
       WHERE id = $1`,
      [id, next.status, next.subscribed_until, next.chat_id, isActive && !wasActive],
    );
    // approved_at: kept while approved, set now on approval.
    await pool.query("UPDATE btc_users SET approved_at = now() WHERE id = $1 AND status = 'approved' AND approved_at IS NULL", [id]);

    const chat = next.chat_id;
    if (!wasActive && isActive) sendQuiet(chat, subscriptionStartedText(isOwnerEmail(next.email) ? null : next.subscribed_until));
    else if (wasActive && isActive && until !== undefined && until !== null
      && (!before.subscribed_until || until.getTime() > before.subscribed_until.getTime())) {
      sendQuiet(chat, subscriptionRenewedText(until));
    }
    if (before.status !== "blocked" && next.status === "blocked") sendQuiet(chat, BLOCKED_TEXT);
    if (before.status !== "inactive" && next.status === "inactive") sendQuiet(chat, DEACTIVATED_TEXT);
    res.json({ ok: true });
  } catch (err) {
    if ((err as { code?: string }).code === "23505") { res.status(409).json({ error: "Этот Telegram Chat ID уже связан с другим пользователем" }); return; }
    logger.error({ err }, "btc: admin user update failed");
    res.status(500).json({ error: "Ошибка при обновлении" });
  }
});

router.delete("/admin/users/:id", requireOwner, async (req: AuthedRequest, res) => {
  const id = Number(req.params.id);
  if (req.user?.id === id) { res.status(400).json({ error: "Нельзя удалить свой аккаунт" }); return; }
  await pool.query("DELETE FROM btc_password_resets WHERE user_id = $1", [id]);
  await pool.query("DELETE FROM btc_users WHERE id = $1", [id]);
  res.json({ ok: true });
});

export default router;
