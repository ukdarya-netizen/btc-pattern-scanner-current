import assert from "node:assert/strict";
import { test } from "node:test";
import { computeMetrics } from "./snapshot";
import type { Candle } from "../market/bingx";
import type { FlowSeries } from "../market/coinglass";

const candles = (n: number, step: number, start = 100): Candle[] =>
  Array.from({ length: n }, (_, i) => ({
    time: i * step, open: start + i, high: start + i + 1, low: start + i - 1,
    close: start + i + 0.5, volume: i === n - 1 ? 300 : 100,
  }));

const emptyFlow: FlowSeries = {
  oi: null, liquidations: null, futuresTaker: null, spotTaker: null,
  spotCvd: null, funding: null, longShort: null, orderbook: null, whaleIndex: null, whaleIndex4h: null,
};
const allCandles = () => ({
  "1m": [], "5m": candles(50, 300_000), "15m": candles(50, 900_000),
  "1h": candles(50, 3_600_000), "4h": candles(50, 14_400_000), "1d": [],
});

test("missing flow series stay null instead of being substituted", () => {
  const m = computeMetrics(allCandles(), emptyFlow);
  assert.equal(m.oiChangePct["1h"], null);
  assert.equal(m.futTakerNetPct["15m"], null);
  assert.equal(m.spotCvdBullish["1h"], null);
  assert.equal(m.orderbookImbalancePct, null);
  assert.equal(m.whaleIndex, null);
  assert.equal(m.bingxVolumeMult["5m"], 3);
  assert.ok(m.priceChangePct["3h"]! > 0);
});

test("OI per timeframe, CVD, taker, volume multiple and liquidation spike from closed 15m bars", () => {
  const bars = Array.from({ length: 120 }, (_, i) => ({ time: i * 900_000 }));
  const flow: FlowSeries = {
    ...emptyFlow,
    oi: bars.map((b, i) => ({ ...b, close: i === 119 ? 110 : i >= 116 ? 105 : 100 })),
    futuresTaker: bars.map((b, i) => ({ ...b, buy: i >= 116 ? 300 : 75, sell: i >= 116 ? 100 : 25 })),
    spotCvd: bars.map((b, i) => ({ ...b, cvd: i * 10 })),
    liquidations: bars.map((b, i) => ({ ...b, long: i >= 116 ? 1000 : 10, short: 10 })),
  };
  const m = computeMetrics(allCandles(), flow);
  assert.ok(Math.abs(m.oiChangePct["15m"]! - 4.7619) < 1e-3);
  assert.equal(m.oiChangePct["1h"], 10);
  assert.equal(m.futTakerNetPct["1h"], 50);
  assert.equal(m.futCvdUsd["1h"], 800);
  assert.equal(m.spotCvdUsd["1h"], 40);
  assert.equal(m.spotCvdBullish["4h"], true);
  assert.equal(m.futVolumeMult["1h"], 4);
  assert.ok(m.liqLongSpike1h! > 50);
});
