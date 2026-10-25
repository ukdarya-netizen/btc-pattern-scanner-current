import assert from "node:assert/strict";
import { test } from "node:test";
import { computeMetrics, type Snapshot } from "./snapshot";
import { evaluateRangeSetup, RANGE_PATTERNS } from "./rangePatterns";
import { rangeScenario, RANGE_MID } from "./rangeFixture.test-helper";
import { levelsAtEntry } from "./levels";
import type { FlowSeries } from "../market/coinglass";

const emptyFlow: FlowSeries = {
  oi: null, liquidations: null, futuresTaker: null, spotTaker: null,
  spotCvd: null, funding: null, longShort: null, orderbook: null, whaleIndex: null, whaleIndex4h: null,
};

function snapshotWith(candles4h: ReturnType<typeof rangeScenario>, flow: { fut: number | null; spot: number | null }): Snapshot {
  const metrics = computeMetrics({ "1m": [], "5m": candles4h.slice(-30), "15m": [], "1h": [], "4h": candles4h, "1d": [] }, emptyFlow);
  metrics.futCvdUsd = { ...metrics.futCvdUsd, "4h": flow.fut };
  metrics.spotCvdUsd = { ...metrics.spotCvdUsd, "4h": flow.spot };
  return { at: 0, candles: { "1m": [], "5m": [], "15m": [], "1h": [], "4h": candles4h, "1d": [] }, flow: emptyFlow, metrics };
}

test("only 4h and 1d setups exist: breakout and deviation, long and short", () => {
  assert.deepEqual(RANGE_PATTERNS.map((p) => p.key).sort(), [
    "d1_breakout_long", "d1_breakout_short", "d1_deviation_long", "d1_deviation_short",
    "h4_breakout_long", "h4_breakout_short", "h4_deviation_long", "h4_deviation_short",
  ]);
});

test("a breakout fires only with volume and both futures and spot flow in its direction", () => {
  const strong = rangeScenario([{ close: RANGE_MID + 4, volume: 300 }]);
  const ok = evaluateRangeSetup(snapshotWith(strong, { fut: 5e7, spot: 2e7 }), "h4", "breakout", "long");
  assert.equal(ok.fires, true, JSON.stringify(ok.reasons));
  assert.ok(Math.abs(ok.levels!.stop - RANGE_MID) < 1e-9, "stop at the range midpoint");
  assert.deepEqual(ok.levels!.targets.map((t) => Number(t.price.toFixed(6))),
    [Number((RANGE_MID + 1.2 + 2.4).toFixed(6)), Number((RANGE_MID + 1.2 + 4.8).toFixed(6))]);

  assert.deepEqual(evaluateRangeSetup(snapshotWith(strong, { fut: 5e7, spot: -1e6 }), "h4", "breakout", "long").reasons,
    ["spot_cvd_4h_long"]);
  assert.deepEqual(evaluateRangeSetup(snapshotWith(strong, { fut: 5e7, spot: null }), "h4", "breakout", "long").reasons,
    ["spot_cvd_4h_long:no_data"], "no data — no signal");
  assert.equal(evaluateRangeSetup(snapshotWith(strong, { fut: 5e7, spot: 2e7 }), "h4", "breakout", "short").fires, false);

  const quiet = rangeScenario([{ close: RANGE_MID + 4, volume: 120 }]);
  assert.deepEqual(evaluateRangeSetup(snapshotWith(quiet, { fut: 5e7, spot: 2e7 }), "h4", "breakout", "long").reasons,
    ["volume>=1.5x"]);
});

test("a bullish deviation trades back into the range with the stop beyond the swept low", () => {
  const candles = rangeScenario([{ close: RANGE_MID - 3 }, { close: RANGE_MID - 3.5, low: RANGE_MID - 4.2 },
    { close: RANGE_MID - 0.5, volume: 250 }]);
  const result = evaluateRangeSetup(snapshotWith(candles, { fut: 1e7, spot: -5e6 }), "h4", "deviation", "long");
  assert.equal(result.fires, true, JSON.stringify(result.reasons));
  assert.ok(result.levels!.stop < RANGE_MID - 4.2);
  assert.deepEqual(result.levels!.targets.map((t) => Number(t.price.toFixed(6))), [RANGE_MID, RANGE_MID + 1.2]);
  const against = evaluateRangeSetup(snapshotWith(candles, { fut: -1e7, spot: 5e6 }), "h4", "deviation", "long");
  assert.deepEqual(against.reasons, ["fut_cvd_4h_long"]);
});

test("levels are re-checked at the live entry", () => {
  const levels = { stop: 99, targets: [{ price: 103, fraction: 0.5 }, { price: 106, fraction: 0.5 }] };
  const ok = levelsAtEntry(100, "long", 20, levels);
  assert.ok(!("refused" in ok) && Math.abs(ok.stopPct - 1) < 1e-9);
  assert.deepEqual(levelsAtEntry(103.5, "long", 20, levels), { refused: "entry_past_first_target" });
  assert.deepEqual(levelsAtEntry(98, "long", 20, levels), { refused: "entry_beyond_stop" });
  assert.deepEqual(levelsAtEntry(100, "long", 20, { ...levels, stop: 95 }), { refused: "liquidation_guard" },
    "x20: 5% stop is beyond 80% of the ~4.6% liquidation distance");
  const short = levelsAtEntry(100, "short", 10, { stop: 104, targets: [{ price: 97, fraction: 0.5 }, { price: 94, fraction: 0.5 }] });
  assert.ok(!("refused" in short));
});
