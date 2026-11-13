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

export class TelegramError extends Error {
  constructor(public code: number, public retryAfter = 0) {
    super(`Telegram API error ${code}`);
  }
}

export async function telegramCall<T>(method: string, payload: object): Promise<T> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
  let response: Response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(method === "getUpdates" ? 40_000 : 10_000),
    });
  } catch {
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

export type ReportImageKind = "daily" | "weekly" | "monthly";
export type SignalImage = "new-signal" | "take-profit" | "stop-loss" | "position-update" | "market-update" | `report-${ReportImageKind}`;

/**
 * The picture next to the bundle: <name>.jpg / .jpeg / .png (market-update and the reports are the owner's own files).
 * Reports (owner 2026-11-13: the pictures she uploaded): report-daily, daily-report, daily_report, report_daily, then
 * a common «report» picture.
 */
export async function imageFile(image: SignalImage): Promise<{ bytes: Buffer; type: string; name: string } | null> {
  const m = /^report-(daily|weekly|monthly)$/.exec(image);
  const names = m ? [`report-${m[1]}`, `${m[1]}-report`, `${m[1]}_report`, `report_${m[1]}`, "report"] : [image];
  for (const name of names) {
    for (const [ext, type] of [["jpg", "image/jpeg"], ["jpeg", "image/jpeg"], ["png", "image/png"]] as const) {
      try {
        return { bytes: await readFile(new URL(`./${name}.${ext}`, import.meta.url)), type, name: `${name}.${ext}` };
      } catch { /* next */ }
    }
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
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("Telegram network request failed");
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
