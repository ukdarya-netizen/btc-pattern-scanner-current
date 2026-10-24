import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeHeatmap } from "./context";

test("heatmap summary splits liquidity into BTC-scale bands above and below price", () => {
  const price = 100_000;
  const prices = [99_500, 98_500, 97_000, 101_500, 100_400, 120_000];
  const values = [10, 20, 30, 40, 50, 999];
  const s = summarizeHeatmap(prices, values, price, "t")!;
  assert.deepEqual(s.below, { "0-1%": 10, "1-2%": 20, "2-5%": 30, "5-10%": 0 });
  assert.deepEqual(s.above, { "0-1%": 50, "1-2%": 40, "2-5%": 0, "5-10%": 0 });
  assert.equal(s.topAbove[0]!.price, 100_400);
  assert.equal(s.aboveBelowRatio5pct, 1.5);
  assert.equal(summarizeHeatmap([], [], price, "t"), null);
});
