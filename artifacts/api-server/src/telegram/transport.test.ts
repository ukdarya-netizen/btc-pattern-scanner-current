import assert from "node:assert/strict";
import { test } from "node:test";
import { SIGNAL_CHANNEL, sendMessage, sendSignalPhoto, splitSignalCaption, subscriptionCommand, telegramCall, TelegramError } from "./transport";

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

test("signal photo uses Telegram multipart upload with its caption", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  let captured: FormData | undefined;
  process.env.TELEGRAM_BOT_TOKEN = "test-only";
  globalThis.fetch = async (_url, init) => {
    captured = init?.body as FormData;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  };
  try {
    await sendSignalPhoto("123", "BTC test signal");
    assert.equal(captured?.get("chat_id"), "123");
    assert.equal(captured?.get("caption"), "BTC test signal");
    const photo = captured?.get("photo") as File;
    assert.equal(photo.name, "new-signal.jpg");
    assert.equal(photo.type, "image/jpeg");
    assert.ok(photo.size > 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = originalToken;
  }
});

test("take-profit photo uses its matching image asset", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  let captured: FormData | undefined;
  process.env.TELEGRAM_BOT_TOKEN = "test-only";
  globalThis.fetch = async (_url, init) => {
    captured = init?.body as FormData;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  };
  try {
    await sendSignalPhoto("123", "Цель 1 достигнута", "take-profit");
    const photo = captured?.get("photo") as File;
    assert.equal(captured?.get("caption"), "Цель 1 достигнута");
    assert.equal(photo.name, "take-profit.jpg");
    assert.ok(photo.size > 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = originalToken;
  }
});

test("stop-loss photo uses its matching image asset", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  let captured: FormData | undefined;
  process.env.TELEGRAM_BOT_TOKEN = "test-only";
  globalThis.fetch = async (_url, init) => {
    captured = init?.body as FormData;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  };
  try {
    await sendSignalPhoto("123", "Стоп-лосс", "stop-loss");
    const photo = captured?.get("photo") as File;
    assert.equal(captured?.get("caption"), "Стоп-лосс");
    assert.equal(photo.name, "stop-loss.jpg");
    assert.ok(photo.size > 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = originalToken;
  }
});

test("position-update photo uses its matching image asset", async () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.TELEGRAM_BOT_TOKEN;
  let captured: FormData | undefined;
  process.env.TELEGRAM_BOT_TOKEN = "test-only";
  globalThis.fetch = async (_url, init) => {
    captured = init?.body as FormData;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  };
  try {
    await sendSignalPhoto("123", "Обновление позиции", "position-update");
    const photo = captured?.get("photo") as File;
    assert.equal(captured?.get("caption"), "Обновление позиции");
    assert.equal(photo.name, "position-update.jpg");
    assert.ok(photo.size > 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = originalToken;
  }
});

test("long signal captions split on a line without dropping content", () => {
  const text = `${"x".repeat(600)}\n${"y".repeat(600)}`;
  const { caption, remainder } = splitSignalCaption(text);
  assert.equal(caption, "x".repeat(600));
  assert.equal(remainder, "y".repeat(600));
  assert.equal(`${caption}\n${remainder}`, text);
  assert.equal(splitSignalCaption("short signal").remainder, "");
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

test("report pictures (owner 2026-11-13): report kind in the queued text; picture found by the usual names", async () => {
  const { parseReportMark, reportMark } = await import("../stats/reports");
  assert.deepEqual(parseReportMark(`${reportMark("daily")}text`), { kind: "daily", body: "text" });
  assert.deepEqual(parseReportMark("__BTC_REPORT__\nold"), { kind: null, body: "old" });
  assert.equal(parseReportMark("__BTC_MARKET_UPDATE__\nx"), null);
  const { writeFile, rm } = await import("node:fs/promises");
  const { imageFile } = await import("./transport");
  const p = new URL("./weekly_report.png", import.meta.url);
  await writeFile(p, Buffer.from([1, 2, 3]));
  try {
    assert.equal((await imageFile("report-weekly"))?.name, "weekly_report.png");
    assert.equal(await imageFile("report-monthly"), null);
  } finally { await rm(p); }
});
