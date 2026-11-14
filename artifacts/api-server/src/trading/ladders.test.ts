import assert from "node:assert/strict";
import { test } from "node:test";
import { LADDERS, familyOf, simulate, type Candle } from "./ladders";

const k = (t: number, h: number, l: number, c = (h + l) / 2): Candle => ({ t, h, l, c });
const steps = (id: string) => LADDERS.find((l) => l.id === id)!.steps([{ price: 104, fraction: 0.5 }, { price: 108, fraction: 0.5 }]);
const base = { side: "long" as const, entry: 100, stop: 97, startAt: 0, endAt: 100, now: 1000 };

test("+1% then +2%: take everything", () => {
  const r = simulate({ ...base, steps: steps("be1_take2"), candles: [k(1, 101.2, 99.5), k(2, 102.1, 100.5)] });
  assert.equal(r.exit, "take"); assert.ok(Math.abs(r.pct - (2 - 0.1)) < 1e-9);
});
test("+1% then back to entry: break-even (from the next candle)", () => {
  const r = simulate({ ...base, steps: steps("be1_take3"), candles: [k(1, 101.5, 99.6), k(2, 100.5, 99.9)] });
  assert.equal(r.exit, "breakeven"); assert.ok(Math.abs(r.pct + 0.1) < 1e-9);
});
test("stop and target in one candle: the stop", () => {
  const r = simulate({ ...base, steps: steps("be1_take2"), candles: [k(1, 102.5, 96.5)] });
  assert.equal(r.exit, "stop"); assert.ok(Math.abs(r.pct - (-3 - 0.1)) < 1e-9);
});
test("quarters: +1 and +2 then entry → 0.75% − fees", () => {
  const r = simulate({ ...base, steps: steps("be1_q25"), candles: [k(1, 102.2, 99.8), k(2, 100.4, 99.9)] });
  assert.equal(r.exit, "breakeven"); assert.ok(Math.abs(r.pct - (0.25 * 1 + 0.25 * 2 - 0.1)) < 1e-9);
});
test("as Bitcoin MM: half at target 1, rest at target 2; short mirrored", () => {
  const r = simulate({ ...base, steps: steps("mm"), candles: [k(1, 104.5, 99), k(2, 108.2, 103)] });
  assert.ok(Math.abs(r.pct - (0.5 * 4 + 0.5 * 8 - 0.1)) < 1e-9);
  const s = simulate({ side: "short", entry: 100, stop: 103, startAt: 0, endAt: 100, now: 1000, steps: LADDERS[1]!.steps([]), candles: [k(1, 100.2, 97.9)] });
  assert.equal(s.exit, "take"); assert.ok(Math.abs(s.pct - 1.9) < 1e-9);
});
test("holding time: closed at the last price; unfinished stays pending", () => {
  assert.equal(simulate({ ...base, endAt: 3, steps: steps("be1_take3"), candles: [k(1, 100.5, 99.5), k(3, 100.3, 99.9, 100.2)] }).exit, "timeout");
  assert.equal(simulate({ ...base, now: 2, steps: steps("be1_take3"), candles: [k(1, 100.5, 99.5)] }).done, false);
});
test("families", () => {
  assert.equal(familyOf("d1_deviation_short"), "range_1d"); assert.equal(familyOf("neon_bounce_1d_long"), "levels_1d");
  assert.equal(familyOf("smc_4h_30m_long"), "smc_4h"); assert.equal(familyOf("smc_1d_1h_short"), "smc_1d"); assert.equal(familyOf("lc_short"), "cascade");
});
