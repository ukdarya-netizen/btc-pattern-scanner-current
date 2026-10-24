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
  spotCvd: null, funding: null, longShort: null, orderbook: null,
};

test("missing flow series stay null instead of being substituted", () => {
  const m = computeMetrics(
    { "1m": [], "5m": candles(50, 300_000), "15m": candles(50, 900_000), "1h": candles(50, 3_600_000), "4h": candles(50, 14_400_000) },
    emptyFlow,
  );
  assert.equal(m.oiChangePct["1h"], null);
  assert.equal(m.futTakerNetPct["15m"], null);
  assert.equal(m.orderbookImbalancePct, null);
  assert.equal(m.volumeRatio["5m"], 3);
  assert.ok(m.priceChangePct["5m"]! > 0);
});

test("taker net, OI change and liquidation spike come from closed 15m bars", () => {
  const bars = Array.from({ length: 101 }, (_, i) => ({ time: i * 900_000 }));
  const flow: FlowSeries = {
    ...emptyFlow,
    oi: bars.map((b, i) => ({ ...b, close: i === 100 ? 110 : 100 })),
    futuresTaker: bars.map((b) => ({ ...b, buy: 75, sell: 25 })),
    liquidations: bars.map((b, i) => ({ ...b, long: i >= 97 ? 1000 : 10, short: 10 })),
  };
  const m = computeMetrics({ "1m": [], "5m": candles(30, 300_000), "15m": [], "1h": [], "4h": [] }, flow);
  assert.equal(m.oiChangePct["15m"], 10);
  assert.equal(m.futTakerNetPct["1h"], 50);
  assert.ok(m.liqLongSpike1h! > 50);
});
