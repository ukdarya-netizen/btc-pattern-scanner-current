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

export async function sendSignalPhoto(
  chatId: string,
  caption: string,
  image: "new-signal" | "take-profit" | "stop-loss" | "position-update" = "new-signal",
): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN not set");
  const photo = await readFile(new URL(`./${image}.jpg`, import.meta.url));
  const form = new FormData();
  form.set("chat_id", chatId);
  form.set("caption", caption);
  form.set("photo", new Blob([new Uint8Array(photo)], { type: "image/jpeg" }), `${image}.jpg`);

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
  message?: { chat: { id: number; type: string }; text?: string };
};

export function subscriptionCommand(update: TelegramUpdate): "start" | "stop" | null {
  if (update.message?.chat.type !== "private") return null;
  const command = update.message.text?.trim().split(/\s+/)[0]?.split("@")[0]?.toLowerCase();
  return command === "/start" ? "start" : command === "/stop" ? "stop" : null;
}
