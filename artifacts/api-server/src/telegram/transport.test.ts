import assert from "node:assert/strict";
import { test } from "node:test";
import { SIGNAL_CHANNEL, sendMessage, subscriptionCommand, telegramCall, TelegramError } from "./transport";

test("/start subscribes and /stop unsubscribes only in private chats", () => {
  const update = (text: string, type = "private") => ({
    update_id: 1, message: { chat: { id: 123, type }, text },
  });
  assert.equal(subscriptionCommand(update("/start")), "start");
  assert.equal(subscriptionCommand(update("/start@my_bot hello")), "start");
  assert.equal(subscriptionCommand(update("/stop")), "stop");
  assert.equal(subscriptionCommand(update("/start", "group")), null);
  assert.equal(subscriptionCommand(update("/stop", "channel")), null);
  assert.equal(subscriptionCommand(update("hello")), null);
});

test("signals use the requested channel", () => {
  assert.equal(SIGNAL_CHANNEL, "@bitcoinmarginmaster");
});

test("same signal text can be delivered separately to channel and private chat", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  const calls: object[] = [];
  process.env.TELEGRAM_BOT_TOKEN = "test-only";
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  };
  try {
    await sendMessage(SIGNAL_CHANNEL, "BTC test signal");
    await sendMessage("123", "BTC test signal");
    assert.deepEqual(calls, [
      { chat_id: SIGNAL_CHANNEL, text: "BTC test signal", disable_web_page_preview: true },
      { chat_id: "123", text: "BTC test signal", disable_web_page_preview: true },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = originalToken;
  }
});

test("Telegram API errors expose codes and retry delays, never raw descriptions or URLs", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = "test-only";
  globalThis.fetch = async () => new Response(JSON.stringify({
    ok: false, error_code: 429, description: "sensitive provider description",
    parameters: { retry_after: 45 },
  }), { status: 429 });
  try {
    await assert.rejects(telegramCall("sendMessage", {}), (err: unknown) => {
      assert.ok(err instanceof TelegramError);
      assert.equal(err.code, 429);
      assert.equal(err.retryAfter, 45);
      assert.equal(err.message, "Telegram API error 429");
      return true;
    });
    globalThis.fetch = async () => { throw new Error("URL containing test-only token"); };
    await assert.rejects(telegramCall("sendMessage", {}), { message: "Telegram network request failed" });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = originalToken;
  }
});
