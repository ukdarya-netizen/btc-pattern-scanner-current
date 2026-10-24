import assert from "node:assert/strict";
import { test } from "node:test";
import { firstTouch } from "./outcome";

const base = { entry: 100, stopPct: 1, target: { pct: 2, fraction: 1 }, decidedAt: 0, maxHoldMs: 10, intervalMs: 1, now: 100 };

test("long: target before stop; short mirrors; same candle counts as stop", () => {
  const up = firstTouch({ ...base, direction: "long", candles: [{ openTime: 0, high: 101, low: 99.5 }, { openTime: 1, high: 102.1, low: 100 }] });
  assert.equal(up.label, "target_first");
  assert.ok(up.mfePct >= 2.1 - 1e-9);
  const short = firstTouch({ ...base, direction: "short", candles: [{ openTime: 0, high: 100.5, low: 97.9 }] });
  assert.equal(short.label, "target_first");
  const both = firstTouch({ ...base, direction: "long", candles: [{ openTime: 0, high: 103, low: 98.9 }] });
  assert.equal(both.label, "stop_first");
});

test("candles before the decision and after max hold are ignored", () => {
  const r = firstTouch({ ...base, direction: "long", decidedAt: 5, candles: [{ openTime: 4, high: 110, low: 90 }, { openTime: 20, high: 110, low: 99.5 }] });
  assert.equal(r.label, "timeout");
  const pending = firstTouch({ ...base, direction: "long", now: 3, candles: [] });
  assert.equal(pending.label, "pending");
});
