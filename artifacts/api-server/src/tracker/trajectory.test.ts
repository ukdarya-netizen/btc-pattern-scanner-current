import test from "node:test";
import assert from "node:assert/strict";
import { duePoint, trajectoryPoint } from "./trajectory";

const M = 60_000, H = 60 * M, D = 24 * H;

test("trajectory points: 15m … 72h, then every 24 h; only within 15 minutes after the point", () => {
  assert.equal(duePoint(10 * M), null);
  assert.equal(duePoint(15 * M), "15m");
  assert.equal(duePoint(29 * M), "15m");
  assert.equal(duePoint(30 * M), "30m");
  assert.equal(duePoint(H + 5 * M), "1h");
  assert.equal(duePoint(H + 20 * M), null);
  assert.equal(duePoint(12 * H + 10 * M), "12h");
  assert.equal(duePoint(3 * D), "72h");
  assert.equal(duePoint(3 * D + D / 2), null);
  assert.equal(duePoint(4 * D + 5 * M), "96h");
  assert.equal(duePoint(10 * D), "240h");
});

test("trajectory point: clean move in the trade's direction, trade state, market without heatmap maps; close uses the exit", () => {
  const detectedAt = new Date("2026-11-12T08:00:00Z");
  const row: any = { id: 1, direction: "short", entryPrice: 100_000, detectedAt, status: "open", closedAt: null, exitPrice: null,
    stopPrice: 101_000, breakevenMoved: false, remainingFraction: 1, mfePct: 1.2, maePct: -0.4, pnlPricePct: null, closeReason: null, keys: [] };
  const m: any = { price: 99_000, oiChangePct: { "1h": 0.5 }, context: { heatmap: { below: { a: 1 }, above: { b: 2 }, topAbove: [], topBelow: [], aboveBelowRatio5pct: 1.1 }, dominance: null } };
  const p = trajectoryPoint(row, m, detectedAt.getTime() + H, "1h") as any;
  assert.equal(p.pctFromEntry, 1);
  assert.equal(p.elapsedMs, H);
  assert.equal(p.peakPct, 1.2);
  assert.equal(p.market.oiChangePct["1h"], 0.5);
  assert.equal(p.market.context.heatmap.below, undefined);
  assert.equal(p.market.context.heatmap.aboveBelowRatio5pct, 1.1);
  const c = trajectoryPoint({ ...row, status: "closed", exitPrice: 101_000, closeReason: "stop", pnlPricePct: -1 }, m, detectedAt.getTime() + 2 * H, "close") as any;
  assert.equal(c.price, 101_000);
  assert.equal(c.pctFromEntry, -1);
  assert.equal(c.closeReason, "stop");
});
