import assert from "node:assert/strict";
import { test } from "node:test";
import { applyCandle, applyTick, type PositionState } from "./positionEngine";
import {
  liquidationPrice,
  marginPnlPct,
  maxStopPct,
  stopPriceFor,
  targetPricesFor,
} from "../lib/tradeMath";
import { PROFILES } from "../config/profiles";

function position(direction: "long" | "short", overrides: Partial<PositionState> = {}): PositionState {
  const entry = 100_000;
  return {
    direction,
    entryPrice: entry,
    stopPrice: stopPriceFor(entry, 1, direction),
    targets: targetPricesFor(entry, [{ pct: 1, fraction: 0.5 }, { pct: 2, fraction: 0.5 }], direction),
    remainingFraction: 1,
    realizedPricePct: 0,
    realizedExitNotional: 0,
    breakevenMoved: false,
    breakevenAfterFirstTarget: true,
    mfePct: 0,
    maePct: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
    closed: false,
    closeReason: null,
    exitPrice: null,
    ...overrides,
  };
}

test("every profile's default stop sits inside the liquidation guard", () => {
  for (const profile of Object.values(PROFILES)) {
    assert.ok(profile.defaultStopPct < maxStopPct(profile.leverage), profile.key);
    const fractions = profile.defaultTargets.reduce((s, t) => s + t.fraction, 0);
    assert.ok(Math.abs(fractions - 1) < 1e-9, profile.key);
  }
  assert.ok(Math.abs(liquidationPrice(100_000, 100, "long") - 99_400) < 1e-6);
  assert.ok(Math.abs(liquidationPrice(100_000, 100, "short") - 100_600) < 1e-6);
});

test("long: first target, breakeven, then breakeven close", () => {
  const state = position("long");
  assert.deepEqual(applyTick(state, 100_500, 1), []);
  const first = applyTick(state, 101_000, 2);
  assert.deepEqual(first.map((e) => e.kind), ["target_hit", "breakeven_moved"]);
  assert.equal(state.stopPrice, 100_000);
  const closed = applyTick(state, 99_990, 3);
  assert.equal(closed[0]?.kind, "closed");
  assert.equal(state.closeReason, "breakeven");
  assert.ok(Math.abs(state.realizedPricePct - 0.5) < 1e-9, "half closed at +1%, half at 0%");
});

test("short: stop is adverse up-move and fills at the stop price", () => {
  const state = position("short");
  applyTick(state, 101_500, 1);
  assert.equal(state.closeReason, "stop");
  assert.equal(state.exitPrice, 101_000);
  assert.ok(Math.abs(state.realizedPricePct + 1) < 1e-9);
});

test("short: both targets give take_profit", () => {
  const state = position("short");
  applyTick(state, 99_000, 1);
  applyTick(state, 97_900, 2);
  assert.equal(state.closeReason, "take_profit");
  assert.ok(Math.abs(state.realizedPricePct - 1.5) < 1e-9);
  assert.ok(state.mfePct >= 2.1 - 1e-9);
});

test("candle touching stop and target counts the stop first", () => {
  const state = position("long");
  applyCandle(state, { high: 101_200, low: 98_900, close: 100_000, closeTime: 10 });
  assert.equal(state.closeReason, "stop");
});

test("timeout closes at the observed price", () => {
  const state = position("long", { expiresAt: 5 });
  applyTick(state, 100_300, 6);
  assert.equal(state.closeReason, "timeout");
  assert.equal(state.exitPrice, 100_300);
});

test("margin PnL includes leverage and taker fees on both sides", () => {
  // +0.35% move at 100x: 35% gross, fees 0.05% × (1 + 1.0035) × 100 ≈ 10.02%
  const pnl = marginPnlPct(0.35, 1.0035, 100);
  assert.ok(Math.abs(pnl - (35 - 0.05 * 2.0035 * 100)) < 1e-9);
});
