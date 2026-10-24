import assert from "node:assert/strict";
import { test } from "node:test";
import { dueAlerts, recordFailure, recordSuccess, resetHealthForTests } from "../lib/apiHealth";

test("API outage alerts once after 30 min, repeats only after 6 h, restored only after an alert", () => {
  resetHealthForTests();
  const t0 = 1_000_000;
  recordFailure("coinglass", "HTTP 500", t0);
  assert.deepEqual(dueAlerts(t0 + 29 * 60_000), []);
  const first = dueAlerts(t0 + 31 * 60_000);
  assert.equal(first.length, 1);
  assert.equal(first[0]!.kind, "down");
  assert.deepEqual(dueAlerts(t0 + 2 * 60 * 60_000), [], "no repeat inside 6 h");
  assert.equal(dueAlerts(t0 + 7 * 60 * 60_000).length, 1, "repeat after 6 h");
  recordSuccess("coinglass", t0 + 8 * 60 * 60_000);
  const restored = dueAlerts(t0 + 8 * 60 * 60_000);
  assert.equal(restored[0]?.kind, "restored");
  recordFailure("bingx", "timeout", t0);
  recordSuccess("bingx", t0 + 60_000);
  assert.deepEqual(dueAlerts(t0 + 2 * 60 * 60_000), [], "a short blip never alerts");
});

test("scanner watchdog alerts after 20 min idle, hourly at most, then reports recovery", async () => {
  const { watchdogDecision } = await import("./watchdog");
  const state = { alertedAt: null as number | null };
  const t0 = 10_000_000;
  const last = new Date(t0).toISOString();
  assert.equal(watchdogDecision(last, t0, t0 + 19 * 60_000, state), null);
  assert.equal(watchdogDecision(last, t0, t0 + 21 * 60_000, state), "alert");
  assert.equal(watchdogDecision(last, t0, t0 + 40 * 60_000, state), null);
  assert.equal(watchdogDecision(last, t0, t0 + 82 * 60_000, state), "alert");
  assert.equal(watchdogDecision(new Date(t0 + 83 * 60_000).toISOString(), t0, t0 + 84 * 60_000, state), "recovered");
});
