import test from "node:test";
import assert from "node:assert/strict";
import { computeIndicators, emaSeries, rsiSeries, tfIndicators } from "./indicators";

const candles = (closes: number[]) => closes.map((c, i) => ({ time: i * 60_000, open: c, high: c * 1.001, low: c * 0.999, close: c, volume: 1 }));

test("indicators: RSI 100 on a steady rise, EMA seeded with the SMA (TradingView), short history → null", () => {
  const up = Array.from({ length: 260 }, (_, i) => 100 + i);
  assert.equal(rsiSeries(up, 14).at(-1), 100);
  assert.deepEqual(emaSeries([1, 2, 3, 4], 3), [null, null, 2, 3]);
  const t = tfIndicators(candles(up))!;
  assert.ok(t.distEma200Pct! > 0 && t.distSma50Pct! > 0, "price above the averages on a rise");
  assert.ok(t.macd! > 0 && t.plusDi! > t.minusDi!);
  assert.equal(tfIndicators(candles(up.slice(0, 20))), null);
  const short = tfIndicators(candles(up.slice(0, 100)))!;
  assert.equal(short.ema200, null);
  assert.equal(short.sma200, null);
  assert.deepEqual(Object.keys(computeIndicators({ "1h": candles(up) })), ["15m", "1h", "4h", "1d"]);
});
