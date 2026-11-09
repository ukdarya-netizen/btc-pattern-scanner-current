import assert from "node:assert/strict";
import test from "node:test";
import { runSmc, SmcEngine } from "./smc";
import { candlesFromCloses, path } from "./testCandles.test-helper";

const H = 60 * 60_000;

test("internal structure: bearish BOS, then bullish CHoCH with the order block at the leg low", () => {
  const closes = path([[90, 10], [100, 10], [84, 16], [104, 20]], 100);
  const candles = candlesFromCloses(closes, 0, H);
  const { events } = runSmc(candles);
  const flat = events.flatMap((list, index) => list.map((e) => ({ ...e, index }))).filter((e) => e.scope === "internal");
  const bear = flat.find((e) => e.dir === -1);
  const bull = flat.find((e) => e.dir === 1 && e.index > (bear?.index ?? 0));
  assert.ok(bear, "bearish break expected");
  assert.equal(bear.kind, "BOS");
  assert.ok(bull, "bullish break expected");
  assert.equal(bull.kind, "CHOCH");
  // Order block = lowest low between the broken pivot high and the breaking bar.
  const pivotIndex = candles.findIndex((c) => c.t === bull.pivotTime);
  const lows = candles.slice(pivotIndex, bull.index).map((c) => c.l);
  assert.equal(bull.orderBlock?.bottom, Math.min(...lows));
  assert.equal(bull.orderBlock?.bias, 1);
});

test("a bullish order block is removed once a later low trades below it", () => {
  const closes = path([[90, 10], [100, 10], [84, 16], [104, 20]], 100);
  const engine = new SmcEngine();
  for (const c of candlesFromCloses(closes, 0, H)) engine.push(c);
  const block = engine.snapshot().internalOrderBlocks.find((b) => b.bias === 1);
  assert.ok(block);
  const last = engine.snapshot().barTime!;
  engine.push({ t: last + H, o: 104, h: 104.5, l: block.barLow - 0.5, c: 103 });
  assert.equal(engine.snapshot().internalOrderBlocks.some((b) => b.id === block.id), false);
});

test("pivots need `size` later bars: nothing is confirmed early (no lookahead)", () => {
  // A low first (Pine legs start bearish, so the first confirmed pivot is a low).
  const closes = path([[95, 6], [110, 10], [100, 3]], 100);
  const engine = new SmcEngine();
  const candles = candlesFromCloses(closes, 0, H);
  candles.forEach((c) => engine.push(c));
  // Peak at bar 16 followed by only 3 lower bars: internal pivot (size 5) not yet confirmed.
  assert.equal(engine.snapshot().internalHigh, null);
  // The bar right after the peak opens at the peak close, so its high equals the
  // peak high (not strictly lower): the pivot needs 5 strictly lower highs after it.
  const last = candles[candles.length - 1];
  engine.push({ ...last, t: last.t + H });
  engine.push({ ...last, t: last.t + 2 * H });
  assert.equal(engine.snapshot().internalHigh, null);
  engine.push({ ...last, t: last.t + 3 * H });
  assert.ok(engine.snapshot().internalHigh !== null);
});
