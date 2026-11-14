import assert from "node:assert/strict";
import test from "node:test";
import type { Candle } from "../market/bingx";
import type { FlowSeries } from "../market/coinglass";
import { computeZones, lucyColour } from "./neonZones";
import { NEON_PATTERNS, evaluateBounce, evaluateBreakout } from "./neonPatterns";
import { PATTERNS } from "./patterns";
import type { Snapshot } from "./snapshot";

const D1 = 86_400_000;
const T0 = Date.UTC(2024, 0, 1);

/** 1D candles oscillating between ~95k (support, many pivot lows) and ~105k (resistance). */
function d1Series(n = 700): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const mid = 100_000 + 5_000 * Math.sin(i / 8);
    out.push({ time: T0 + i * D1, open: mid, high: mid * 1.004, low: mid * 0.996, close: mid, volume: 1 });
  }
  return out;
}

function snapshotWith(d1: Candle[], vol1d: Map<number, number>): Snapshot {
  return {
    at: d1.at(-1)!.time + D1,
    candles: { "1m": [], "5m": [], "15m": [], "1h": [], "4h": [], "1d": d1 },
    flow: {} as FlowSeries,
    metrics: {} as Snapshot["metrics"],
    lucy: { "15m": null, "1h": null, "4h": null, "1d": vol1d },
  };
}

test("zones: the support and resistance of an oscillating series", () => {
  const zones = computeZones(d1Series());
  assert.ok(zones.length >= 2);
  assert.ok(zones.some((z) => z.bottom < 96_000) && zones.some((z) => z.top > 104_000));
});

test("Lucy colour: blue on 20 dead bars but under the 120-bar average is grey", () => {
  assert.equal(lucyColour([...Array(100).fill(100), ...Array(19).fill(10), 15], 119), "N");
  assert.notEqual(lucyColour([...Array(119).fill(10), 15], 119), "N");
  assert.equal(lucyColour([...Array(119).fill(10), 15], 100), null);
});

test("ABNeon bounce 1D long (owner 2026-11-14: 1D zones, 1D signal): test of the support, first green reaction, Lucy not grey → fires", () => {
  const base = d1Series();
  const sup = computeZones(base.slice(-640)).filter((z) => z.top < 100_000).sort((a, b) => b.top - a.top)[0]!;
  // The last bars: a dip into the support (test, red) and a green bar closing back inside.
  const t = base.at(-1)!.time;
  const above = sup.top * 1.01;
  const d1 = [...base,
    { time: t + D1, open: above, high: above, low: sup.bottom * 0.999, close: sup.bottom * 1.001, volume: 1 },
    { time: t + 2 * D1, open: sup.bottom * 1.001, high: sup.top, low: sup.bottom, close: sup.top * 0.999, volume: 1 },
  ];
  const vol = new Map<number, number>(d1.map((c, i) => [c.time, (i >= d1.length - 2 ? 5 : 1) * 1e9 * c.close]));
  const res = evaluateBounce(snapshotWith(d1, vol), "1d", "long");
  assert.equal(res.fires, true, res.reasons.join(","));
  assert.ok(res.levels!.stop < sup.bottom);
  assert.ok(res.levels!.targets[0]!.price > d1.at(-1)!.close);
  // Grey volume → no signal.
  assert.equal(evaluateBounce(snapshotWith(d1, new Map(d1.map((c) => [c.time, 1e9 * c.close]))), "1d", "long").fires, false);
  // A breakout needs a crossed level → not on this bar.
  assert.equal(evaluateBreakout(snapshotWith(d1, vol), "1d", "long").fires, false);
});

test("owner 2026-11-14: only the 1D ABNeon / Stealth are on (profile d1); 15m / 1h / 4h switched off; range 4h off", () => {
  assert.equal(NEON_PATTERNS.length, 16);
  const on = NEON_PATTERNS.filter((p) => !p.off);
  assert.deepEqual(on.map((p) => p.key).sort(), ["neon_bounce_1d_long", "neon_bounce_1d_short", "neon_breakout_1d_long", "neon_breakout_1d_short"]);
  assert.ok(on.every((p) => p.live && p.profile === "d1" && p.evalTf === undefined));
  assert.ok(PATTERNS.filter((p) => p.key.startsWith("h4_")).every((p) => p.off));
  assert.ok(PATTERNS.filter((p) => p.key.startsWith("d1_")).every((p) => !p.off));
  assert.equal(new Set(PATTERNS.map((p) => p.key)).size, PATTERNS.length);
});
