/**
 * Bitcoin Margin Master bot (owner 2026-11-12: «всё как в CAB и Нигилисте» — private access ported from Nihilist).
 * Public: /start (welcome + Mini App / site / subscription buttons), /myid, /subscription, /resetpassword.
 * Subscribers (registered in the Dashboard, approved, subscription active) and the owner: /menu, /daily, /weekly,
 * /monthly, /stop (/unsubscribe). Owner: approve / block buttons on a new registration.
 * Admin (TELEGRAM_ADMIN_CHAT_IDS): /status, /open. Plain text only (no HTML).
 */
import { randomInt } from "node:crypto";
import { db, btcSignalsTable, pool } from "@workspace/db";
import { and, eq, gte } from "drizzle-orm";
import { logger } from "../lib/logger";
import { PATTERNS } from "../engine/patterns";
import { accessStatus, isOwnerChat, isOwnerEmail, ownerChatId, userByChatId, userById, type UserRow } from "../lib/users";
import { SIGNAL_CHANNEL, answerCallback, editMessage, sendMessageKb, telegramCall, type InlineKeyboard, type TelegramUpdate } from "./transport";

const TZ = "Asia/Dubai";
const CHANNEL_URL = `https://t.me/${SIGNAL_CHANNEL.replace(/^@/, "")}`;
export const CONTACT = "@The_Lucy_x";
/** The dashboard (site and Telegram Mini App). */
export const MINI_APP_URL = "https://bitcoin-margin-master.replit.app/";
export const BOT_NAME = "Bitcoin Margin Master";

export const BOT_DESCRIPTION = [
  "Bitcoin Margin Master — сигналы только по биткоину: фьючерсы BTC-USDT, лонги и шорты.",
  "",
  "Пробои и девиации рейнджа, Smart Money, каскады ликвидаций, уровни ABNeon. Объёмы по всем биржам: спот и фьючерсы.",
  "",
  "Вход, стоп, цели и сопровождение каждой сделки до закрытия, отчёты, Dashboard со статистикой.",
  "",
  "Закрытый доступ: регистрация в Dashboard и одобрение. Нажми /start.",
].join("\n");
export const BOT_SHORT_DESCRIPTION = "Сигналы по BTC-USDT: лонги и шорты, вход, стоп, цели и сопровождение до закрытия.";

type Access = "public" | "subscriber" | "admin";
type Command = { command: string; aliases?: string[]; access: Access; privateOnly?: boolean; menu?: string };
export const COMMANDS: Command[] = [
  { command: "/start", access: "public", menu: "Начать работу с ботом" },
  { command: "/myid", access: "public", menu: "Показать Chat ID" },
  { command: "/menu", access: "subscriber" },
  { command: "/daily", access: "subscriber", menu: "Отчёт за день" },
  { command: "/weekly", access: "subscriber", menu: "Отчёт за неделю" },
  { command: "/monthly", access: "subscriber", menu: "Отчёт за месяц" },
  { command: "/subscription", aliases: ["/sub", "/expiry"], access: "public", menu: "Статус и даты подписки" },
  { command: "/stop", aliases: ["/unsubscribe"], access: "subscriber", privateOnly: true, menu: "Отписаться от сигналов" },
  { command: "/resetpassword", access: "public", privateOnly: true, menu: "Сбросить пароль Dashboard" },
  { command: "/status", access: "admin" },
  { command: "/open", access: "admin" },
];
export const BOT_MENU = COMMANDS.flatMap((c) => (c.menu ? [{ command: c.command.slice(1), description: c.menu }] : []));

export function parseCommand(text: string | undefined): string | null {
  const token = text?.trim().split(/\s+/)[0]?.toLowerCase();
  if (!token?.startsWith("/")) return null;
  const cmd = token.split("@")[0]!;
  const found = COMMANDS.find((c) => c.command === cmd || c.aliases?.includes(cmd));
  return found ? found.command : cmd;
}

// ---------------- texts ----------------
export const welcomeText = () => [
  "₿ Bitcoin Margin Master",
  "",
  "Сигналы только по биткоину: фьючерсы BTC-USDT, лонги и шорты.",
  "",
  "Что ты получаешь внутри:",
  "",
  "✅ Сигналы со входом, стопом и целями.",
  "✅ Сопровождение каждой сделки: цели, безубыток, закрытие.",
  "✅ Отчёты за день, неделю и месяц.",
  "✅ Dashboard — открытые позиции, история сигналов, статистика.",
  "",
  "📱 Доступ через Mini App прямо в Telegram",
  "Регистрация, позиции и история — всё открывается внутри Telegram. Нажми кнопку «📱 Открыть приложение» ниже.",
  "",
  "💎 Доступ ограничен",
  "Бот работает в закрытом режиме: сигналы приходят только после регистрации в Dashboard и одобрения доступа.",
  "",
  "🆔 Как узнать Chat ID",
  "Нажми /myid в меню бота — бот отправит твой Chat ID. Его нужно указать при регистрации.",
  "",
  `По вопросам оплаты и доступа — ${CONTACT}`,
].join("\n");
export const menuText = () => [
  "📋 Доступные команды",
  "",
  "/daily — отчёт за день",
  "/weekly — отчёт за неделю",
  "/monthly — отчёт за месяц",
  "/subscription — начало и окончание подписки",
  "/stop — отписаться",
].join("\n");
const UNSUBSCRIBE_CONFIRM = "❓ Точно хочешь отписаться?\n\nСигналы перестанут приходить. Снова подключиться — через /start.";
const UNSUBSCRIBED = "❌ Подписка отменена.\n\nСигналы больше не будут приходить.\nНапиши /start, чтобы включить их снова.";
const ALREADY = "✅ У тебя уже есть доступ!\n\nСигналы приходят автоматически. Используй /menu для отчётов.";
const BACK_ON = "\n\n✅ Сигналы снова включены.";
const RESET_NO_ACCOUNT = "❌ Аккаунт с этим Telegram Chat ID не найден.\n\nЗарегистрируйся в Dashboard и укажи свой Chat ID.";
const resetCodeText = (code: string) => [
  `🔑 Код сброса пароля: ${code}`, "", "⏱ Действителен 15 минут.", "",
  "Открой Dashboard → страница входа → «Забыли пароль?» и введи email, этот код и новый пароль.",
].join("\n");
const UNKNOWN = "❓ Такой команды нет. Все команды — /menu.";
const PRIVATE_ONLY = "🔒 Эта команда работает только в личном чате с ботом.";

const longDate = (d: Date) => d.toLocaleDateString("ru-RU", { timeZone: TZ, day: "numeric", month: "long", year: "numeric" });
const subDate = (d: Date) => `${d.toLocaleString("ru-RU", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })} Дубай`;
function remaining(until: Date, now: number): string {
  const ms = until.getTime() - now;
  if (ms <= 0) return "срок уже истёк";
  const days = Math.floor(ms / 86_400_000), hours = Math.floor((ms % 86_400_000) / 3_600_000);
  return days > 0 ? `${days} дн. ${hours} ч.` : `${hours} ч.`;
}

export function subscriptionStatus(user: UserRow | null, now = Date.now()) {
  if (!user) return { found: false as const };
  const owner = isOwnerEmail(user.email);
  return {
    found: true as const,
    active: accessStatus(user, new Date(now)) === "approved" && user.notify,
    start: user.approved_at ?? user.created_at,
    until: owner ? null : user.subscribed_until,
  };
}
export function subscriptionStatusText(s: ReturnType<typeof subscriptionStatus>, now = Date.now()): string {
  if (!s.found) return ["📅 Статус подписки", "", "Подписка для этого Telegram-аккаунта не найдена.", `По вопросам доступа — ${CONTACT}`].join("\n");
  return [
    `${s.active ? "✅" : "❌"} Подписка ${s.active ? "активна" : "неактивна"}`,
    "",
    `🟢 Начало: ${subDate(s.start)}`,
    `🏁 Окончание: ${s.until ? subDate(s.until) : "не установлена"}`,
    s.until ? `⏳ Осталось: ${remaining(s.until, now)}` : "⏳ Срок: не ограничен",
  ].join("\n");
}

// ---------------- notifications from the owner's actions ----------------
export const subscriptionStartedText = (until: Date | null) => [
  "🎉 Ваша подписка активирована!", "", "Доступ к сигналам, статистике и Dashboard открыт.", "Добро пожаловать в Bitcoin Margin Master.",
  ...(until ? ["", `📅 Подписка активна до: ${longDate(until)}`] : []),
  "", "Открой меню бота и нажми /start, чтобы увидеть все возможности.",
  "", "🔑 Забыли пароль от Dashboard?", "Нажми /resetpassword в меню бота — придёт одноразовый код для сброса.",
].join("\n");
export const subscriptionRenewedText = (until: Date | null) =>
  ["🔄 Ваша подписка продлена!", "", ...(until ? [`📅 Действует до: ${longDate(until)}`, ""] : []), "Удачной торговли! 🚀"].join("\n");
export const DEACTIVATED_TEXT = `📴 Подписка деактивирована\n\nВаш доступ к Bitcoin Margin Master был деактивирован администратором.\n\nПо вопросам — ${CONTACT}`;
export const PASSWORD_CHANGED_TEXT = "🔑 Пароль изменён\n\nВаш пароль был сброшен администратором. Если это были не вы — обратитесь к администратору.";
export const BLOCKED_TEXT = `🚫 Доступ приостановлен\n\nВаш доступ к Bitcoin Margin Master был заблокирован администратором. По вопросам — ${CONTACT}`;

// ---------------- keyboards (as CAB / Nihilist) ----------------
const subscriptionKeyboard = (): InlineKeyboard => [[{ text: "📅 Дата окончания подписки", callback_data: "subscription_status" }]];
const unsubscribeKeyboard = (): InlineKeyboard => [[
  { text: "✅ Да, отписаться", callback_data: "unsubscribe_yes" },
  { text: "❌ Нет, остаться", callback_data: "unsubscribe_no" },
]];
const reportKeyboard = (): InlineKeyboard => [[
  { text: "День", callback_data: "report_daily" }, { text: "Неделя", callback_data: "report_weekly" }, { text: "Месяц", callback_data: "report_monthly" },
]];
/** Mini App, website, channel, subscription end date. */
export const welcomeKeyboard = (): InlineKeyboard => [
  [{ text: "📱 Открыть приложение", web_app: { url: MINI_APP_URL } }],
  [{ text: "🌐 Открыть сайт", url: MINI_APP_URL }],
  [{ text: "📢 Канал сигналов", url: CHANNEL_URL }],
  ...subscriptionKeyboard(),
];

// ---------------- reports (channel signals only) ----------------
type Kind = "daily" | "weekly" | "monthly";
const PERIOD: Record<Kind, { days: number; title: string }> = {
  daily: { days: 1, title: "за сутки" }, weekly: { days: 7, title: "за неделю" }, monthly: { days: 30, title: "за 30 дней" },
};
const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
const label = (key: string) => PATTERNS.find((p) => p.key === key)?.label ?? key;

export async function reportText(kind: Kind, now = Date.now()): Promise<string> {
  const since = new Date(now - PERIOD[kind].days * 86_400_000);
  const closed = await db.select().from(btcSignalsTable)
    .where(and(eq(btcSignalsTable.live, true), gte(btcSignalsTable.closedAt, since)));
  const open = await db.select().from(btcSignalsTable)
    .where(and(eq(btcSignalsTable.live, true), eq(btcSignalsTable.status, "open")));
  const vals = closed.map((s) => s.pnlPricePct ?? 0);
  const sum = vals.reduce((a, b) => a + b, 0);
  const wins = vals.filter((v) => v > 0).length;
  const lines = [`📊 Bitcoin Margin Master — отчёт ${PERIOD[kind].title}`, ""];
  if (!closed.length) lines.push("Закрытых сделок за период нет.");
  else {
    lines.push(
      `Закрыто: ${closed.length} · в плюсе ${wins} (${Math.round((100 * wins) / closed.length)}%)`,
      `Движение цены, сумма: ${pct(sum)} · в среднем ${pct(sum / closed.length)}`,
      `Лучшая: ${pct(Math.max(...vals))} · худшая: ${pct(Math.min(...vals))}`,
    );
    for (const side of ["long", "short"] as const) {
      const xs = closed.filter((s) => s.direction === side);
      if (xs.length) lines.push(`${side === "long" ? "Лонги" : "Шорты"}: ${xs.length} · ${pct(xs.reduce((a, s) => a + (s.pnlPricePct ?? 0), 0))}`);
    }
    const by = new Map<string, number[]>();
    for (const s of closed) by.set(s.patternKey, [...(by.get(s.patternKey) ?? []), s.pnlPricePct ?? 0]);
    lines.push("", "По паттернам:");
    for (const [k, v] of [...by].sort((a, b) => b[1].reduce((x, y) => x + y, 0) - a[1].reduce((x, y) => x + y, 0))) {
      lines.push(`• ${label(k)}: ${v.length} · ${pct(v.reduce((x, y) => x + y, 0))}`);
    }
  }
  lines.push("", `Открыто сейчас: ${open.length}`, "", "Результат — чистое движение цены: без плеча и комиссий.");
  return lines.join("\n");
}

// ---------------- owner ----------------
export async function notifyOwnerRegistration(
  u: { id: number; name: string; email: string; chatId: string; telegramUsername: string | null },
  resubmitted: "blocked" | "expired" | null,
): Promise<void> {
  const owner = await ownerChatId();
  if (!owner) { logger.warn("btc: new registration, owner chat unknown (BTC_OWNER_EMAIL / Chat ID)"); return; }
  const tg = u.telegramUsername ? `@${u.telegramUsername} · ID: ${u.chatId}` : `ID: ${u.chatId}`;
  const head = resubmitted ? "🔐 Повторный запрос доступа к Dashboard" : "🔐 Новый запрос доступа к Dashboard";
  const reason = resubmitted === "blocked" ? ["", "Аккаунт был заблокирован — пользователь запросил доступ снова."]
    : resubmitted === "expired" ? ["", "Подписка истекла — пользователь запросил доступ снова."] : [];
  await sendMessageKb(owner, [head, "", `👤 ${u.name}`, `📧 ${u.email}`, `💬 ${tg}`, ...reason].join("\n"), [[
    { text: "✅ Одобрить", callback_data: `approve_user:${u.id}` },
    { text: "❌ Заблокировать", callback_data: `block_user:${u.id}` },
  ]]);
}

/** A message outside a reply (owner actions). */
export function sendQuiet(chatId: string | null, text: string, keyboard?: InlineKeyboard): void {
  if (!chatId) return;
  void sendMessageKb(chatId, text, keyboard).catch((err) => logger.warn({ err }, "btc: bot message not delivered"));
}

let botUsername: string | null = null;
/** Bot @username for the registration hint (getMe, cached). */
export async function getBotUsername(): Promise<string | null> {
  if (botUsername || !process.env.TELEGRAM_BOT_TOKEN) return botUsername;
  try { botUsername = (await telegramCall<{ username?: string }>("getMe", {})).username ?? null; } catch { /* unknown for now */ }
  return botUsername;
}

// ---------------- handlers ----------------
const isAdmin = (chatId: string) => (process.env.TELEGRAM_ADMIN_CHAT_IDS ?? "").split(",").map((x) => x.trim()).includes(chatId);

async function isSubscriberChat(chatId: string): Promise<{ user: UserRow | null; ok: boolean }> {
  const user = await userByChatId(chatId);
  const ok = (user !== null && accessStatus(user) === "approved") || await isOwnerChat(chatId);
  return { user, ok };
}

const ownerDate = (d: Date) => d.toLocaleDateString("ru-RU", { timeZone: TZ, day: "numeric", month: "long", year: "numeric" });
const monthLater = (from: Date) => { const d = new Date(from); d.setMonth(d.getMonth() + 1); return d; };

async function handleCallback(cq: NonNullable<TelegramUpdate["callback_query"]>): Promise<void> {
  await answerCallback(cq.id).catch(() => undefined);
  const msg = cq.message;
  if (!msg) return;
  const chatId = String(msg.chat.id);
  const data = cq.data ?? "";

  if (data === "subscription_status") {
    await sendMessageKb(chatId, subscriptionStatusText(subscriptionStatus(await userByChatId(String(cq.from.id)))), subscriptionKeyboard());
    return;
  }
  if (data.startsWith("approve_user:") || data.startsWith("block_user:")) {
    if (!await isOwnerChat(cq.from.id)) { await sendMessageKb(chatId, "⛔ Это может сделать только владелец."); return; }
    const id = Number(data.slice(data.indexOf(":") + 1));
    const before = Number.isSafeInteger(id) && id > 0 ? await userById(id) : null;
    if (!before) { await editMessage(chatId, msg.message_id, "❌ Пользователь не найден."); return; }
    if (data.startsWith("approve_user:")) {
      const now = new Date();
      const until = monthLater(now);
      const wasActive = accessStatus(before, now) === "approved";
      await pool.query(
        `UPDATE btc_users SET status = 'approved', approved_at = now(), subscribed_until = $2,
           notify = true, notify_since = COALESCE(CASE WHEN $3 THEN notify_since END, now()) WHERE id = $1`,
        [id, until, wasActive],
      );
      await editMessage(chatId, msg.message_id, `✅ ${before.name} одобрен(а)\n📧 ${before.email}\n📅 до ${ownerDate(until)}`);
      sendQuiet(before.chat_id, wasActive ? subscriptionRenewedText(until) : subscriptionStartedText(until));
    } else {
      await pool.query("UPDATE btc_users SET status = 'blocked', approved_at = NULL WHERE id = $1", [id]);
      await editMessage(chatId, msg.message_id, `❌ ${before.name} заблокирован(а)\n📧 ${before.email}`);
      if (before.status !== "blocked") sendQuiet(before.chat_id, BLOCKED_TEXT);
    }
    logger.info({ id, data }, "btc: user status changed from Telegram");
    return;
  }
  if (msg.chat.type !== "private") { await sendMessageKb(chatId, PRIVATE_ONLY); return; }
  const { user, ok } = await isSubscriberChat(String(cq.from.id));
  if (!ok) { await sendMessageKb(chatId, welcomeText(), welcomeKeyboard()); return; }
  if (data.startsWith("report_")) {
    const kind = data.slice(7) as Kind;
    if (kind in PERIOD) await sendMessageKb(chatId, await reportText(kind), reportKeyboard());
  } else if (data === "unsubscribe_confirm") {
    await editMessage(chatId, msg.message_id, UNSUBSCRIBE_CONFIRM, unsubscribeKeyboard());
  } else if (data === "unsubscribe_yes") {
    if (user) await pool.query("UPDATE btc_users SET notify = false WHERE id = $1", [user.id]);
    await editMessage(chatId, msg.message_id, UNSUBSCRIBED);
  } else if (data === "unsubscribe_no") {
    await editMessage(chatId, msg.message_id, ALREADY, [[{ text: "❌ Отписаться", callback_data: "unsubscribe_confirm" }]]);
  }
}

async function handleMessage(m: NonNullable<TelegramUpdate["message"]>, admin: ((command: string) => Promise<string>) | null): Promise<void> {
  const chatId = String(m.chat.id);
  const isPrivate = m.chat.type === "private";
  const cmd = parseCommand(m.text);
  if (!cmd) return;
  const def = COMMANDS.find((c) => c.command === cmd);
  if (!def) { if (isPrivate) await sendMessageKb(chatId, UNKNOWN); return; }
  if (def.privateOnly && !isPrivate) { await sendMessageKb(chatId, PRIVATE_ONLY); return; }

  switch (def.command) {
    case "/myid": {
      // As CAB: the Chat ID is a code span — one tap copies it (plain text + entity, no HTML).
      const text = [`🆔 Твой Telegram Chat ID: ${chatId}`, "", "Нажми на Chat ID, чтобы скопировать, и укажи его при регистрации в Dashboard."].join("\n");
      await telegramCall("sendMessage", { chat_id: chatId, text, entities: [{ type: "code", offset: text.indexOf(chatId), length: chatId.length }] });
      return;
    }
    case "/start": {
      const user = isPrivate ? await userByChatId(chatId) : null;
      let extra = "";
      if (user && accessStatus(user) === "approved" && !user.notify) {
        await pool.query("UPDATE btc_users SET notify = true, notify_since = now(), bot_blocked_at = NULL WHERE id = $1", [user.id]);
        extra = BACK_ON;
      } else if (user?.bot_blocked_at) {
        await pool.query("UPDATE btc_users SET bot_blocked_at = NULL WHERE id = $1", [user.id]);
      }
      await sendMessageKb(chatId, welcomeText() + extra, welcomeKeyboard());
      return;
    }
    case "/subscription":
      await sendMessageKb(chatId, subscriptionStatusText(subscriptionStatus(await userByChatId(chatId))), subscriptionKeyboard());
      return;
    case "/resetpassword": {
      const user = await userByChatId(chatId);
      if (!user) { await sendMessageKb(chatId, RESET_NO_ACCOUNT); return; }
      const code = String(randomInt(100000, 1000000));
      await pool.query("DELETE FROM btc_password_resets WHERE user_id = $1", [user.id]);
      await pool.query("INSERT INTO btc_password_resets (user_id, code, expires_at) VALUES ($1, $2, now() + interval '15 minutes')", [user.id, code]);
      await sendMessageKb(chatId, resetCodeText(code));
      return;
    }
    case "/status": case "/open":
      if (isAdmin(chatId) && admin) await sendMessageKb(chatId, await admin(def.command));
      return;
  }

  const { ok } = await isSubscriberChat(chatId);
  if (!ok) { await sendMessageKb(chatId, welcomeText(), welcomeKeyboard()); return; }
  switch (def.command) {
    case "/menu":
      await sendMessageKb(chatId, menuText(), reportKeyboard());
      return;
    case "/stop":
      await sendMessageKb(chatId, UNSUBSCRIBE_CONFIRM, unsubscribeKeyboard());
      return;
    case "/daily": case "/weekly": case "/monthly":
      await sendMessageKb(chatId, await reportText(def.command.slice(1) as Kind), reportKeyboard());
      return;
  }
}

/** One update: a command or a button press. */
export async function handleUpdate(update: TelegramUpdate, admin: ((command: string) => Promise<string>) | null): Promise<void> {
  if (update.callback_query) await handleCallback(update.callback_query);
  else if (update.message) await handleMessage(update.message, admin);
}

/** Bot profile, command menu and the Mini App menu button, set on every start (idempotent). */
export async function setupBotProfile(): Promise<void> {
  const warn = (what: string) => (err: unknown) => logger.warn({ err }, `telegram ${what} failed`);
  await telegramCall("setMyName", { name: BOT_NAME }).catch(warn("setMyName"));
  await telegramCall("setMyCommands", { commands: BOT_MENU }).catch(warn("setMyCommands"));
  await telegramCall("setMyDescription", { description: BOT_DESCRIPTION }).catch(warn("setMyDescription"));
  await telegramCall("setMyShortDescription", { short_description: BOT_SHORT_DESCRIPTION }).catch(warn("setMyShortDescription"));
  await telegramCall("setChatMenuButton", { menu_button: { type: "web_app", text: "Приложение", web_app: { url: MINI_APP_URL } } })
    .catch(warn("setChatMenuButton"));
}
