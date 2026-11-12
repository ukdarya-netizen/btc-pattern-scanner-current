import assert from "node:assert/strict";
import { test } from "node:test";
import { BOT_DESCRIPTION, BOT_MENU, BOT_SHORT_DESCRIPTION, parseCommand, welcomeKeyboard, welcomeText } from "./bot";

test("bot profile fits Telegram limits and the menu has no admin commands", () => {
  assert.ok(BOT_DESCRIPTION.length <= 512, String(BOT_DESCRIPTION.length));
  assert.ok(BOT_SHORT_DESCRIPTION.length <= 120, String(BOT_SHORT_DESCRIPTION.length));
  assert.ok(!BOT_MENU.some((c) => c.command === "status" || c.command === "open"));
  assert.ok(BOT_MENU.some((c) => c.command === "start") && BOT_MENU.some((c) => c.command === "stop"));
});

test("commands: aliases, bot mentions, unknown", () => {
  assert.equal(parseCommand("/start"), "/start");
  assert.equal(parseCommand("/START@btc_bot hi"), "/start");
  assert.equal(parseCommand("/unsubscribe"), "/stop");
  assert.equal(parseCommand("/sub"), "/subscription");
  assert.equal(parseCommand("hello"), null);
  assert.equal(parseCommand("/foo"), "/foo");
});

test("welcome: plain text with the channel button", () => {
  assert.ok(!/<[a-z]/i.test(welcomeText()));
  assert.ok(welcomeKeyboard().flat().some((b) => "url" in b && b.url === "https://t.me/bitcoinmarginmaster"));
});
