import { readFile } from "node:fs/promises";

export const SIGNAL_CHANNEL = "@bitcoinmarginmaster";
const TELEGRAM_CAPTION_LIMIT = 1000;

export function splitSignalCaption(text: string): { caption: string; remainder: string } {
  if (text.length <= TELEGRAM_CAPTION_LIMIT) return { caption: text, remainder: "" };
  let splitAt = text.lastIndexOf("\n", TELEGRAM_CAPTION_LIMIT);
  if (splitAt < 1) splitAt = TELEGRAM_CAPTION_LIMIT;
  return {
    caption: text.slice(0, splitAt),
    remainder: text.slice(splitAt + (text[splitAt] === "\n" ? 1 : 0)),
  };
}

/** Telegram text limit is 4096 — a long text (a month report) goes in parts cut at line ends (owner 2026-11-15). */
export const TELEGRAM_TEXT_LIMIT = 4096;
export function splitText(text: string, limit = TELEGRAM_TEXT_LIMIT): { part: string; rest: string } {
  if (text.length <= limit) return { part: text, rest: "" };
  let at = text.lastIndexOf("\n", limit);
  if (at < 1) at = limit;
  return { part: text.slice(0, at), rest: text.slice(at + (text[at] === "\n" ? 1 : 0)) };
}

export class TelegramError extends Error {
  constructor(public code: number, public retryAfter = 0) {
    super(`Telegram API error ${code}`);
  }
}
/**
 * No answer from Telegram in time (owner 2026-11-15: duplicates). The message may well have been delivered — sending
 * it again is what made the copies, so a timed-out delivery is not repeated.
 */
export class TelegramTimeout extends Error {
  constructor(method: string) { super(`Telegram ${method}: no answer in time`); }
}
const timeoutOr = (err: unknown, method: string) =>
  err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError") ? new TelegramTimeout(method) : new Error("Telegram network request failed");

export async function telegramCall<T>(method: string, payload: object): Promise<T> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(method === "getUpdates" ? 40_000 : 30_000),
    });
  } catch (err) {
    if (method !== "getUpdates") throw timeoutOr(err, method);
    // Native fetch errors may contain the credential-bearing URL.
    throw new Error("Telegram network request failed");
  }
  const body = await response.json() as {
    ok: boolean; result: T; error_code?: number; parameters?: { retry_after?: number };
  };
  if (!response.ok || !body.ok) {
    throw new TelegramError(body.error_code ?? response.status, body.parameters?.retry_after);
  }
  return body.result;
}

export async function sendMessage(chatId: string, text: string): Promise<void> {
  await telegramCall("sendMessage", { chat_id: chatId, text, disable_web_page_preview: true });
}

export type SignalImage = "new-signal" | "take-profit" | "stop-loss" | "position-update" | "market-update";

/**
 * Telegram images are limited to signal events and the morning market update.
 */
export async function imageFile(image: SignalImage): Promise<{ bytes: Buffer; type: string; name: string } | null> {
  const candidates = image === "stop-loss"
    ? [["png", "image/png"], ["jpg", "image/jpeg"], ["jpeg", "image/jpeg"]] as const
    : [["jpg", "image/jpeg"], ["jpeg", "image/jpeg"], ["png", "image/png"]] as const;
  for (const [ext, type] of candidates) {
    try {
      return { bytes: await readFile(new URL(`./${image}.${ext}`, import.meta.url)), type, name: `${image}.${ext}` };
    } catch { /* next */ }
  }
  return null;
}

export async function sendSignalPhoto(
  chatId: string,
  caption: string,
  image: SignalImage = "new-signal",
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
  const file = await imageFile(image);
  if (!file) throw new Error(`picture ${image} not found`);
  const form = new FormData();
  form.set("chat_id", chatId);
  form.set("caption", caption);
  form.set("photo", new Blob([new Uint8Array(file.bytes)], { type: file.type }), file.name);

  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw timeoutOr(err, "sendPhoto");
  }
  const body = await response.json() as {
    ok: boolean; error_code?: number; parameters?: { retry_after?: number };
  };
  if (!response.ok || !body.ok) {
    throw new TelegramError(body.error_code ?? response.status, body.parameters?.retry_after);
  }
}

export type TelegramUpdate = {
  update_id: number;
  message?: { chat: { id: number; type: string }; text?: string; from?: { id: number; username?: string } };
  callback_query?: { id: string; data?: string; from: { id: number }; message?: { message_id: number; chat: { id: number; type: string } } };
};

export type InlineButton = { text: string; callback_data: string } | { text: string; url: string } | { text: string; web_app: { url: string } };
export type InlineKeyboard = InlineButton[][];

/** A plain-text message with inline buttons (owner 2026-11-12: buttons as in CAB and Nihilist). */
export async function sendMessageKb(chatId: string, text: string, keyboard?: InlineKeyboard): Promise<void> {
  await telegramCall("sendMessage", {
    chat_id: chatId, text, disable_web_page_preview: true,
    ...(keyboard?.length ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });
}

/** Replace the text (and buttons) of a message the bot sent — owner approve / block, unsubscribe confirm. */
export async function editMessage(chatId: string, messageId: number, text: string, keyboard?: InlineKeyboard): Promise<void> {
  await telegramCall("editMessageText", {
    chat_id: chatId, message_id: messageId, text, disable_web_page_preview: true,
    ...(keyboard?.length ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  });
}

export async function answerCallback(id: string, text?: string): Promise<void> {
  await telegramCall("answerCallbackQuery", { callback_query_id: id, ...(text ? { text } : {}) });
}

export function subscriptionCommand(update: TelegramUpdate): "start" | "stop" | null {
  if (update.message?.chat.type !== "private") return null;
  const command = update.message.text?.trim().split(/\s+/)[0]?.split("@")[0]?.toLowerCase();
  return command === "/start" ? "start" : command === "/stop" ? "stop" : null;
}
