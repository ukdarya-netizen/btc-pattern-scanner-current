import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("automatic startup and operational diagnostics cannot send Telegram messages; reports and signals do", () => {
  const admin = readFileSync(new URL("./admin.ts", import.meta.url), "utf8");
  const runtime = readFileSync(new URL("../engine/runtime.ts", import.meta.url), "utf8");
  assert.doesNotMatch(admin, /sendMessage|sendAdmin|notifyRestart/);
  assert.doesNotMatch(runtime, /notifyRestart/);
  // Owner 2026-11-12 (as CAB / Nihilist): the scheduled period reports are sent.
  assert.match(runtime, /runReports\(labelOf\)/);
  assert.match(runtime, /deliverNext\(labelOf\)/);
  assert.match(runtime, /setAdminCommandHandler/);
});
