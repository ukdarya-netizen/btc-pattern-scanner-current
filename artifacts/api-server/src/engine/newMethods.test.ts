import assert from "node:assert/strict";
import test from "node:test";
import type { Candle } from "../market/bingx";
import type { FlowSeries } from "../market/coinglass";
import { LC, cascadeState, evaluateLiqCascade } from "./liqCascade";
import { evaluateSmc } from "./smcPatterns";
import { PATTERNS } from "./patterns";
import { entryStudy } from "./entryStudy";
import { mfReadings } from "../market/moneyFlow";
import type { Snapshot } from "./snapshot";

const M15 = 15 * 60_000;
const T0 = Date.UTC(2026, 9, 1);

/** 15m bars: flat with small liquidations, a long-liquidation cascade with a 2% dump, then a reaction bar. */
function cascadeSeries(reaction: boolean) {
  const bars = [] as Array<{ t: number; liq: number; o: number; h: number; l: number; c: number }>;
  let p = 100_000;
  for (let i = 0; i < 140; i++) bars.push({ t: T0 + i * M15, liq: 1_000_000, o: p, h: p * 1.001, l: p * 0.999, c: p });
  for (let i = 0; i < 4; i++) { const o = p; p *= 0.995; bars.push({ t: T0 + (140 + i) * M15, liq: 6_000_000, o, h: o * 1.001, l: p * 0.997, c: p }); }
  for (let i = 0; i < 4; i++) bars.push({ t: T0 + (144 + i) * M15, liq: 900_000, o: p, h: p * 1.001, l: p * 0.999, c: p });
  bars.push(reaction
    ? { t: T0 + 148 * M15, liq: 500_000, o: p, h: p * 1.002, l: p * 0.993, c: p * 1.0015 }
    : { t: T0 + 148 * M15, liq: 500_000, o: p, h: p * 1.001, l: p * 0.999, c: p });
  return bars;
}

test("cascade: a spike of long liquidations with a dump, exhausted, then a lower-wick reaction → fires once", () => {
  const st = cascadeState(cascadeSeries(true), 1);
  assert.ok(st.spike !== null);
  assert.equal(st.now!.exhausted, true);
  assert.ok(st.now!.wickPct >= LC.WICK_MIN_PCT, String(st.now!.wickPct));
  assert.equal(st.now!.ok, true);
  assert.equal(st.firedBefore, false);
  const none = cascadeState(cascadeSeries(false), 1);
  assert.equal(none.now!.ok, false);
  // The same spike never fires a second time on a later qualifying bar.
  const twice = [...cascadeSeries(true)];
  const p = twice.at(-1)!.c;
  twice.push({ t: twice.at(-1)!.t + M15, liq: 400_000, o: p, h: p * 1.002, l: p * 0.993, c: p * 1.0015 });
  assert.equal(cascadeState(twice, 1).firedBefore, true);
});

test("cascade pattern: fires with levels 1.5R / 3R and the stop below the cascade low", () => {
  const bars = cascadeSeries(true);
  const c15: Candle[] = bars.map((b) => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c, volume: 1 }));
  const c1h: Candle[] = Array.from({ length: 40 }, (_, i) => ({ time: T0 + i * 3_600_000, open: 100_000, high: 100_300, low: 99_700, close: 100_000, volume: 1 }));
  const flow = { liquidations: bars.map((b) => ({ time: b.t, long: b.liq, short: 100_000 })) } as unknown as FlowSeries;
  const snap = { at: bars.at(-1)!.t + M15, candles: { "1m": [], "5m": [], "15m": c15, "1h": c1h, "4h": [], "1d": [] }, flow, metrics: {} } as unknown as Snapshot;
  const r = evaluateLiqCascade(snap, "long");
  assert.equal(r.fires, true, JSON.stringify(r.reasons));
  const entry = c15.at(-1)!.close;
  const low = Math.min(...c15.slice(140).map((c) => c.low));
  assert.ok(r.levels!.stop < low && r.levels!.stop < entry);
  const risk = entry - r.levels!.stop;
  assert.ok(Math.abs(r.levels!.targets[0]!.price - (entry + 1.5 * risk)) < 1e-6);
  assert.ok(Math.abs(r.levels!.targets[1]!.price - (entry + 3 * risk)) < 1e-6);
  const short = evaluateLiqCascade(snap, "short");
  assert.equal(short.fires, false);
});

test("Smart Money runs on BTC-shaped data without errors (random walk), and the registry holds every method", () => {
  let p = 60_000;
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 - 0.5; };
  const mk = (n: number, span: number, end: number): Candle[] => Array.from({ length: n }, (_, i) => {
    const o = p; p = Math.max(1000, p * (1 + rnd() * 0.02)); const h = Math.max(o, p) * 1.003, l = Math.min(o, p) * 0.997;
    return { time: end - (n - i) * span, open: o, high: h, low: l, close: p, volume: 100 + 50 * Math.abs(rnd()) };
  });
  const end = Date.UTC(2026, 10, 9, 12);
  const snap = {
    at: end, flow: {}, metrics: {},
    candles: { "1m": [], "5m": [], "15m": mk(840, M15, end), "1h": mk(420, 3_600_000, end), "4h": mk(1000, 4 * 3_600_000, end), "1d": mk(1000, 86_400_000, end) },
  } as unknown as Snapshot;
  for (const [h, l] of [["4h", "30m"], ["4h", "1h"], ["1d", "30m"], ["1d", "1h"]] as const) {
    for (const d of ["long", "short"] as const) {
      const r = evaluateSmc(snap, h, l, d);
      assert.ok(Array.isArray(r.reasons) && r.reasons.length > 0);
      if (r.fires) assert.ok(r.levels && r.levels.targets.length === 2);
    }
  }
  const keys = PATTERNS.map((x) => x.key);
  assert.equal(keys.filter((k) => k.startsWith("smc_")).length, 8);
  assert.deepEqual(keys.filter((k) => k.startsWith("lc_")), ["lc_long", "lc_short"]);
  assert.equal(new Set(keys).size, keys.length);
  const study = entryStudy(snap.candles["1h"], snap.candles["15m"], "short", end, { method: "liquidation_cascade", cascadeExtreme: 61_000 });
  assert.ok(study && !("error" in study), JSON.stringify(study).slice(0, 200));
});

test("MFI / Chaikin readings: bounded MFI, CMF in [-1, 1], null on a missing volume bar", () => {
  const bars = Array.from({ length: 200 }, (_, i) => ({ t: i, h: 101 + Math.sin(i / 5), l: 99 + Math.sin(i / 5), c: 100 + Math.sin(i / 5) + 0.3, v: 1000 + i }));
  const r = mfReadings(bars, 199, 72);
  assert.ok(r.mfi14! >= 0 && r.mfi14! <= 100);
  assert.ok(r.cmf20! >= -1 && r.cmf20! <= 1);
  bars[195]!.v = NaN;
  assert.equal(mfReadings(bars, 199, 72).cmf20, null);
});
