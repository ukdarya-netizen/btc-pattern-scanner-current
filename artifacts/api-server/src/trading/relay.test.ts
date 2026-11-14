import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyReceipt, decimal, messagesOf, type EventRow, type SignalRow } from "./messages";

const s: SignalRow = {
  id: 7, pattern_key: "range_d1_breakout_long", direction: "long", profile: "d1", leverage: 10,
  entry_price: 90000, initial_stop_price: 85000, targets: [{ price: 93600, fraction: 0.5 }, { price: 97200, fraction: 0.5 }],
  detected_at: new Date("2026-11-14T00:00:00Z"), expires_at: new Date("2026-12-29T00:00:00Z"),
};
const ev = (id: number, kind: string, price: number | null, detail: Record<string, unknown>): EventRow =>
  ({ id, kind, price, detail, created_at: new Date("2026-11-14T00:01:00Z") });

test("signal: entry, stop, targets, BE after TP1, hold hours", () => {
  const [m] = messagesOf(s, [ev(1, "opened", 90000, {})]);
  assert.equal(m!.id, "btc-signal-7");
  const p = m!.payload as Record<string, any>;
  assert.equal(p.symbol, "BTCUSDT"); assert.equal(p.side, "long"); assert.equal(p.stopLoss, "85000");
  assert.equal(p.exitRules.maxHoldHours, 45 * 24); assert.equal(p.exitRules.breakevenAfterFirstTake, true);
  assert.deepEqual(p.exitRules.takeProfits.map((t: any) => t.closeFractionOfInitial), [0.5, 0.5]);
});

test("TP1 → partial close + stop to entry; TP2 → one close", () => {
  const msgs = messagesOf(s, [
    ev(1, "opened", 90000, {}),
    ev(5, "target_hit", 93600, { index: 0, breakevenMoved: true, at: 1 }),
    ev(9, "target_hit", 97200, { index: 1, breakevenMoved: true, at: 2 }),
    ev(10, "closed", 97200, { reason: "take_profit", at: 2 }),
  ]);
  assert.deepEqual(msgs.map((m) => m.id), ["btc-signal-7", "btc-7-1", "btc-7-2", "btc-7-3"]);
  assert.equal(msgs[1]!.payload.partial, true); assert.equal(msgs[1]!.payload.closeFractionOfInitial, 0.5);
  assert.equal(msgs[2]!.payload.type, "move_stop"); assert.equal(msgs[2]!.payload.stopPrice, "90000");
  assert.equal(msgs[3]!.payload.type, "close"); assert.equal(msgs[3]!.payload.reason, "profit");
});

test("break-even and timeout reasons; ids stable", () => {
  const be = messagesOf(s, [ev(1, "opened", 90000, {}), ev(5, "target_hit", 93600, { index: 0, breakevenMoved: true, at: 1 }), ev(6, "closed", 90000, { reason: "breakeven", at: 3 })]);
  assert.equal(be.at(-1)!.payload.reason, "breakeven_stop");
  const to = messagesOf(s, [ev(1, "opened", 90000, {}), ev(2, "closed", 91000, { reason: "timeout", at: 3 })]);
  assert.deepEqual(to.map((m) => m.id), ["btc-signal-7", "btc-7-1"]); assert.equal(to[1]!.payload.reason, "expired");
});

test("receipts", () => {
  assert.equal(classifyReceipt("signal", 201, {}, "x"), "delivered");
  assert.equal(classifyReceipt("signal", 409, {}, "x"), "delivered");
  assert.equal(classifyReceipt("command", 200, { stored: true, commandId: "btc-7-1" }, "btc-7-1"), "delivered");
  assert.equal(classifyReceipt("command", 200, { stored: false }, "btc-7-1"), "retry");
  assert.equal(classifyReceipt("command", 422, {}, "btc-7-1"), "quarantined");
  assert.equal(classifyReceipt("signal", 503, null, "x"), "retry");
  assert.equal(decimal(0.000012345), "0.000012345");
});
