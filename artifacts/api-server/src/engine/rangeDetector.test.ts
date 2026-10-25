import assert from "node:assert/strict";
import { test } from "node:test";
import { atrSeries, replayRanges } from "./rangeDetector";
import { rangeScenario, RANGE_MID } from "./rangeFixture.test-helper";

test("ATR is Wilder's RMA seeded with the SMA, like ta.atr", () => {
  const candles = [10, 12, 11, 13].map((close, i) => ({ time: i, open: close, high: close + 1, low: close - 1, close, volume: 1 }));
  const atr = atrSeries(candles, 2);
  assert.ok(Number.isNaN(atr[0]!));
  assert.equal(atr[1], (2 + 3) / 2); // TR0 = 2, TR1 = max(2, |13-10|, |11-10|) = 3
  assert.equal(atr[2], (2.5 * 1 + 2) / 2); // TR2 = max(2, |12-12|, |10-12|) = 2
});

test("a confirmed tight range that closes above top + 0.15 ATR is a breakout up on that bar", () => {
  const candles = rangeScenario([{ close: RANGE_MID + 4, volume: 300 }]);
  const last = candles.length - 1;
  const events = replayRanges(candles).events.filter((e) => e.index === last);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.kind, "breakout_up");
  assert.ok(Math.abs(events[0]!.range.top - (RANGE_MID + 1.2)) < 1e-9);
  assert.ok(Math.abs(events[0]!.range.bottom - (RANGE_MID - 1.2)) < 1e-9);
  assert.ok(events[0]!.range.bars >= 100);
});

test("a close only inside the breakout buffer is not a break", () => {
  const candles = rangeScenario([{ close: RANGE_MID + 1.25 }]);
  const replay = replayRanges(candles);
  assert.equal(replay.events.filter((e) => e.index === candles.length - 1).length, 0);
  assert.ok(replay.active?.confirmed);
});

test("a break down that closes back inside within the window is a bullish deviation at the swept low", () => {
  const candles = rangeScenario([{ close: RANGE_MID - 3 }, { close: RANGE_MID - 3.5, low: RANGE_MID - 4.2 },
    { close: RANGE_MID - 0.5, volume: 250 }]);
  const last = candles.length - 1;
  const replay = replayRanges(candles);
  const breakDown = replay.events.find((e) => e.index === last - 2);
  assert.equal(breakDown?.kind, "breakout_down");
  const deviation = replay.events.find((e) => e.index === last);
  assert.equal(deviation?.kind, "deviation_bull");
  assert.equal(deviation?.sweepPrice, RANGE_MID - 4.2);
  assert.ok(replay.active?.confirmed, "the range is revived after the deviation");
});

test("a break that stays outside past the window is final (no deviation)", () => {
  const candles = rangeScenario(Array.from({ length: 12 }, (_, i) => ({ close: RANGE_MID - 4 - i * 0.3 })));
  const replay = replayRanges(candles);
  assert.equal(replay.events.some((e) => e.kind.startsWith("deviation") && e.index > candles.length - 13), false);
  assert.equal(replay.dormant, null);
});
