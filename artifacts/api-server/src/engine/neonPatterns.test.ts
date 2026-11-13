import assert from "node:assert/strict";
import test from "node:test";
import type { Candle } from "../market/bingx";
import type { FlowSeries } from "../market/coinglass";
import { computeZones, lucyColour } from "./neonZones";
import { NEON_PATTERNS, evaluateBounce, evaluateBreakout } from "./neonPatterns";
import { PATTERNS } from "./patterns";
import type { Snapshot } from "./snapshot";

const H1 = 3_600_000, H4 = 4 * H1;
const T0 = Date.UTC(2026, 6, 1);

/** 4H candles oscillating between ~95k (support, many pivot lows) and ~105k (resistance). */
function h4Series(n = 700): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const mid = 100_000 + 5_000 * Math.sin(i / 8);
    out.push({ time: T0 + i * H4, open: mid, high: mid * 1.004, low: mid * 0.996, close: mid, volume: 1 });
  }
  return out;
}

function snapshotWith(h1: Candle[], h4: Candle[], vol1h: Map<number, number>): Snapshot {
  return {
    at: h1.at(-1)!.time + H1,
    candles: { "1m": [], "5m": [], "15m": [], "1h": h1, "4h": h4, "1d": [] },
    flow: {} as FlowSeries,
    metrics: {} as Snapshot["metrics"],
    lucy: { "15m": null, "1h": vol1h, "4h": null },
  };
}

test("zones: the support and resistance of an oscillating 4H series", () => {
  const zones = computeZones(h4Series());
  assert.ok(zones.length >= 2);
  assert.ok(zones.some((z) => z.bottom < 96_000) && zones.some((z) => z.top > 104_000));
});

test("Lucy colour: blue on 20 dead bars but under the 120-bar average is grey", () => {
  assert.equal(lucyColour([...Array(100).fill(100), ...Array(19).fill(10), 15], 119), "N");
  assert.notEqual(lucyColour([...Array(119).fill(10), 15], 119), "N");
  assert.equal(lucyColour([...Array(119).fill(10), 15], 100), null);
});

test("ABNeon bounce 1h long: test of the support, first green reaction, Lucy not grey → fires with a stop under the test", () => {
  const h4 = h4Series();
  const zones = computeZones(h4);
  const sup = zones.filter((z) => z.top < 100_000).sort((a, b) => b.top - a.top)[0]!;
  const last4 = h4.at(-1)!.time + H4;
  // 1h: flat above the zone, a dip into it (test), then a green bar closing back above the bottom.
  const h1: Candle[] = [];
  const above = sup.top * 1.01;
  for (let i = 0; i < 150; i++) h1.push({ time: last4 + i * H1, open: above, high: above * 1.002, low: above * 0.998, close: above, volume: 1 });
  const t = h1.at(-1)!.time;
  h1.push({ time: t + H1, open: above, high: above, low: sup.bottom * 0.999, close: sup.bottom * 1.001, volume: 1 }); // test (red)
  h1.push({ time: t + 2 * H1, open: sup.bottom * 1.001, high: sup.top, low: sup.bottom, close: sup.top * 0.999, volume: 1 }); // reaction
  const vol = new Map<number, number>(h1.map((c, i) => [c.time, (i >= h1.length - 2 ? 5 : 1) * 1e9 * c.close]));
  const s = snapshotWith(h1, h4, vol);
  const res = evaluateBounce(s, "1h", "long");
  assert.equal(res.fires, true, res.reasons.join(","));
  assert.ok(res.levels!.stop < sup.bottom);
  assert.ok(res.levels!.targets[0]!.price > h1.at(-1)!.close);
  // Grey volume → no signal.
  const grey = snapshotWith(h1, h4, new Map(h1.map((c) => [c.time, 1e9 * c.close])));
  assert.equal(evaluateBounce(grey, "1h", "long").fires, false);
  // A breakout needs a crossed level → not on this bar.
  assert.equal(evaluateBreakout(s, "1h", "long").fires, false);
});

test("12 patterns registered, all live (owner 2026-11-13), unique keys", () => {
  assert.equal(NEON_PATTERNS.length, 12);
  assert.ok(NEON_PATTERNS.every((p) => p.live && p.profile === "h4"));
  assert.equal(new Set(PATTERNS.map((p) => p.key)).size, PATTERNS.length);
});
