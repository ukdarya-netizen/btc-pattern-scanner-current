/**
 * BTC Bullet bot (owner 2026-11-12: "кнопки, описание, всё как у CAB и Нигилиста"). Plain text only (no HTML).
 * Bot profile: description («Что умеет этот бот?») and short description, the command menu.
 * Public: /start (subscribe + welcome with buttons), /myid, /menu, /daily, /weekly, /monthly (reports on the
 * channel's signals), /subscription (status and date), /stop and /unsubscribe (with a confirmation).
 * Admin (TELEGRAM_ADMIN_CHAT_IDS): /status, /open.
 */
import { db, btcSignalsTable, btcTelegramSubscribersTable } from "@workspace/db";
import { and, eq, gte } from "drizzle-orm";
import { logger } from "../lib/logger";
import { PATTERNS } from "../engine/patterns";
import { SIGNAL_CHANNEL, answerCallback, sendMessageKb, telegramCall, type InlineKeyboard, type TelegramUpdate } from "./transport";

const TZ = "Asia/Dubai";
const CHANNEL_URL = `https://t.me/${SIGNAL_CHANNEL.replace(/^@/, "")}`;
export const CONTACT = "@The_Lucy_x";

export const BOT_DESCRIPTION = [
  "BTC Bullet — сигналы только по биткоину: фьючерсы BTC-USDT, лонги и шорты.",
  "",
  "Пробои и девиации рейнджа, Smart Money, каскады ликвидаций, уровни ABNeon. Объёмы по всем биржам: спот и фьючерсы.",
  "",
  "Вход, стоп, цели и сопровождение каждой сделки до закрытия, отчёты за день, неделю и месяц. Нажми /start.",
].join("\n");
export const BOT_SHORT_DESCRIPTION = "Сигналы по BTC-USDT: лонги и шорты, вход, стоп, цели и сопровождение до закрытия.";

type Command = { command: string; aliases?: string[]; menu?: string; admin?: boolean };
export const COMMANDS: Command[] = [
  { command: "/start", menu: "Подписаться и начать" },
  { command: "/menu", menu: "Все команды" },
  { command: "/daily", menu: "Отчёт за день" },
  { command: "/weekly", menu: "Отчёт за неделю" },
  { command: "/monthly", menu: "Отчёт за месяц" },
  { command: "/subscription", aliases: ["/sub"], menu: "Статус подписки" },
  { command: "/myid", menu: "Показать Chat ID" },
  { command: "/stop", aliases: ["/unsubscribe"], menu: "Отписаться от сигналов" },
  { command: "/status", admin: true },
  { command: "/open", admin: true },
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
  "₿ BTC Bullet — Bitcoin Margin Master",
  "",
  "Сигналы только по биткоину: фьючерсы BTC-USDT, лонги и шорты.",
  "",
  "Что ты получаешь:",
  "",
  "✅ Сигналы со входом, стопом и целями.",
  "✅ Сопровождение каждой сделки: цели, безубыток, закрытие.",
  "✅ Отчёты за день, неделю и месяц — /menu.",
  "",
  `📢 Все сигналы дублируются в канал ${SIGNAL_CHANNEL}.`,
  "",
  `По вопросам — ${CONTACT}`,
].join("\n");
export const menuText = () => [
  "📋 Команды",
  "",
  "/daily — отчёт за день",
  "/weekly — отчёт за неделю",
  "/monthly — отчёт за месяц",
  "/subscription — статус подписки",
  "/myid — твой Chat ID",
  "/stop — отписаться",
].join("\n");
const fmtDate = (d: Date) => d.toLocaleString("ru-RU", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

export const welcomeKeyboard = (): InlineKeyboard => [
  [{ text: "📢 Канал сигналов", url: CHANNEL_URL }],
  [{ text: "📊 Отчёт за неделю", callback_data: "report_weekly" }, { text: "📅 Подписка", callback_data: "subscription" }],
];
const unsubscribeKeyboard = (): InlineKeyboard => [[
  { text: "✅ Да, отписаться", callback_data: "unsubscribe_yes" },
  { text: "↩️ Нет, остаться", callback_data: "unsubscribe_no" },
]];
const reportKeyboard = (): InlineKeyboard => [[
  { text: "День", callback_data: "report_daily" }, { text: "Неделя", callback_data: "report_weekly" }, { text: "Месяц", callback_data: "report_monthly" },
]];

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
  const vals = closed.map((s) => s.pnlMarginPct ?? 0);
  const sum = vals.reduce((a, b) => a + b, 0);
  const wins = vals.filter((v) => v > 0).length;
  const lines = [`📊 BTC Bullet — отчёт ${PERIOD[kind].title}`, ""];
  if (!closed.length) lines.push("Закрытых сделок за период нет.");
  else {
    lines.push(
      `Закрыто: ${closed.length} · в плюсе ${wins} (${Math.round((100 * wins) / closed.length)}%)`,
      `Итог к марже: ${pct(sum)} · в среднем ${pct(sum / closed.length)}`,
      `Лучшая: ${pct(Math.max(...vals))} · худшая: ${pct(Math.min(...vals))}`,
    );
    for (const side of ["long", "short"] as const) {
      const xs = closed.filter((s) => s.direction === side);
      if (xs.length) lines.push(`${side === "long" ? "Лонги" : "Шорты"}: ${xs.length} · ${pct(xs.reduce((a, s) => a + (s.pnlMarginPct ?? 0), 0))}`);
    }
    const by = new Map<string, number[]>();
    for (const s of closed) by.set(s.patternKey, [...(by.get(s.patternKey) ?? []), s.pnlMarginPct ?? 0]);
    lines.push("", "По паттернам:");
    for (const [k, v] of [...by].sort((a, b) => b[1].reduce((x, y) => x + y, 0) - a[1].reduce((x, y) => x + y, 0))) {
      lines.push(`• ${label(k)}: ${v.length} · ${pct(v.reduce((x, y) => x + y, 0))}`);
    }
  }
  lines.push("", `Открыто сейчас: ${open.length}`, "", "Результат к марже — с плечом и за вычетом комиссий.");
  return lines.join("\n");
}

// ---------------- subscription ----------------
async function setSubscribed(chatId: string, active: boolean): Promise<void> {
  const values = { chatId, active, subscribedAt: new Date(), updatedAt: new Date() };
  await db.insert(btcTelegramSubscribersTable).values(values)
    .onConflictDoUpdate({ target: btcTelegramSubscribersTable.chatId, set: active ? values : { active, updatedAt: new Date() } });
}
async function subscriptionText(chatId: string): Promise<string> {
  const [row] = await db.select().from(btcTelegramSubscribersTable).where(eq(btcTelegramSubscribersTable.chatId, chatId));
  if (!row || !row.active) return "🔕 Подписка не активна.\n\nНажми /start, чтобы получать сигналы.";
  return `✅ Подписка активна с ${fmtDate(row.subscribedAt)} (Дубай).\n\nСигналы приходят сюда и в канал ${SIGNAL_CHANNEL}.`;
}

const isAdmin = (chatId: string) => (process.env.TELEGRAM_ADMIN_CHAT_IDS ?? "").split(",").map((x) => x.trim()).includes(chatId);

/** One update: a command in a private chat or a button press. */
export async function handleUpdate(update: TelegramUpdate, admin: ((command: string) => Promise<string>) | null): Promise<void> {
  const cb = update.callback_query;
  if (cb?.message) {
    const chatId = String(cb.message.chat.id);
    await answerCallback(cb.id).catch(() => undefined);
    const data = cb.data ?? "";
    if (data.startsWith("report_")) {
      const kind = data.slice(7) as Kind;
      if (kind in PERIOD) await sendMessageKb(chatId, await reportText(kind), reportKeyboard());
    } else if (data === "subscription") {
      await sendMessageKb(chatId, await subscriptionText(chatId));
    } else if (data === "unsubscribe_yes") {
      await setSubscribed(chatId, false);
      await sendMessageKb(chatId, "❌ Подписка отменена.\n\nСигналы больше не будут приходить. Нажми /start, чтобы включить их снова.");
    } else if (data === "unsubscribe_no") {
      await sendMessageKb(chatId, "👍 Подписка остаётся, сигналы продолжат приходить.");
    }
    return;
  }
  const msg = update.message;
  if (!msg || msg.chat.type !== "private") return;
  const chatId = String(msg.chat.id);
  const cmd = parseCommand(msg.text);
  if (!cmd) return;
  switch (cmd) {
    case "/start":
      await setSubscribed(chatId, true);
      await sendMessageKb(chatId, welcomeText(), welcomeKeyboard());
      return;
    case "/menu":
      await sendMessageKb(chatId, menuText(), reportKeyboard());
      return;
    case "/daily": case "/weekly": case "/monthly":
      await sendMessageKb(chatId, await reportText(cmd.slice(1) as Kind), reportKeyboard());
      return;
    case "/subscription":
      await sendMessageKb(chatId, await subscriptionText(chatId));
      return;
    case "/myid":
      await sendMessageKb(chatId, `🆔 Твой Telegram Chat ID: ${chatId}`);
      return;
    case "/stop":
      await sendMessageKb(chatId, "❓ Точно отписаться?\n\nСигналы перестанут приходить. Вернуться — /start.", unsubscribeKeyboard());
      return;
    case "/status": case "/open":
      if (isAdmin(chatId) && admin) await sendMessageKb(chatId, await admin(cmd));
      return;
    default:
      await sendMessageKb(chatId, "❓ Такой команды нет. Все команды — /menu.");
  }
}

/** Bot profile and command menu, set on every start (idempotent). */
export async function setupBotProfile(): Promise<void> {
  const warn = (what: string) => (err: unknown) => logger.warn({ err }, `telegram ${what} failed`);
  await telegramCall("setMyCommands", { commands: BOT_MENU }).catch(warn("setMyCommands"));
  await telegramCall("setMyDescription", { description: BOT_DESCRIPTION }).catch(warn("setMyDescription"));
  await telegramCall("setMyShortDescription", { short_description: BOT_SHORT_DESCRIPTION }).catch(warn("setMyShortDescription"));
}
