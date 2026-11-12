import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { telegramUserFromInitData } from "./ownerAccess";

const TOKEN = "123:abc";
function sign(fields: Record<string, string>): string {
  const check = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = createHmac("sha256", "WebAppData").update(TOKEN).digest();
  const hash = createHmac("sha256", secret).update(check).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

test("MiniApp initData: a valid signature gives the Telegram user id", () => {
  const now = 1_800_000_000;
  const data = sign({ auth_date: String(now - 60), user: JSON.stringify({ id: 42, first_name: "D" }), query_id: "q" });
  assert.equal(telegramUserFromInitData(data, TOKEN, now), "42");
});

test("MiniApp initData: a wrong token, a changed field or an old date are refused", () => {
  const now = 1_800_000_000;
  const data = sign({ auth_date: String(now - 60), user: JSON.stringify({ id: 42 }) });
  assert.equal(telegramUserFromInitData(data, "999:zzz", now), null);
  assert.equal(telegramUserFromInitData(data.replace("42", "43"), TOKEN, now), null);
  const old = sign({ auth_date: String(now - 2 * 86_400), user: JSON.stringify({ id: 42 }) });
  assert.equal(telegramUserFromInitData(old, TOKEN, now), null);
  assert.equal(telegramUserFromInitData("", TOKEN, now), null);
});
