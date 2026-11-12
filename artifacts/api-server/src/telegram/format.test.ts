import test from "node:test";
import assert from "node:assert/strict";
import { formatEvent, inPosition, isStale } from "./telegram";

const opened = new Date("2026-11-12T08:00:00Z");
const signal: any = {
  id: 1, patternKey: "range_breakout_h4_long", direction: "long", profile: "h4", leverage: 20, live: true,
  entryPrice: 96000, initialStopPrice: 94080, stopPrice: 94080, liquidationPrice: 91600,
  targets: [{ price: 97920, fraction: 0.5, hitAt: null }, { price: 99840, fraction: 0.5, hitAt: null }],
  breakevenMoved: false, mfePct: 0, maePct: 0, detectedAt: opened, metrics: {},
};
const ev = (kind: string, price: number, detail: Record<string, unknown>, hours: number): any =>
  ({ id: 1, signalId: 1, kind, price, detail, createdAt: new Date(opened.getTime() + hours * 3_600_000) });

test("opened: header, style, entry, stop, targets with what to do, leverage, hashtags; plain text", () => {
  const t = formatEvent(signal, ev("opened", 96000, {}, 0), "Пробой рейнджа 4H");
  assert.match(t, /^₿ BITCOIN MARGIN MASTER · BTC ЛОНГ\nПробой рейнджа 4H · свинг \(4h\)/);
  assert.match(t, /🎯 Цель 1: 97920\.0 \(\+2\.00%\) — закрыть 50%, стоп в безубыток/);
  assert.match(t, /🎯 Цель 2: 99840\.0 \(\+4\.00%\) — закрыть остаток/);
  assert.match(t, /#BTC #range_breakout_h4_long #long #swing$/);
  assert.doesNotMatch(t, /<[a-z]/i);
});

test("target and close: entry → price | time in position, what is left, peak, clean result", () => {
  const s1 = { ...signal, breakevenMoved: true, stopPrice: 96000, targets: [{ ...signal.targets[0], hitAt: "x" }, signal.targets[1]] };
  const t = formatEvent(s1, ev("target_hit", 97920, { index: 0, breakevenMoved: true }, 5.5), "Пробой рейнджа 4H");
  assert.match(t, /96000\.0 → 97920\.0 \(\+2\.00%\) \| 5ч 30м/);
  assert.match(t, /✂️ Закрыто 50% · в позиции 50%/);
  assert.match(t, /⏳ Дальше: цель 2 — 99840\.0/);
  assert.match(t, /#target1$/);
  const c = formatEvent({ ...s1, mfePct: 3.1 }, ev("closed", 96000, { reason: "breakeven", pnlPricePct: 1 }, 30), "Пробой рейнджа 4H");
  assert.match(c, /^🏁 ПОЗИЦИЯ ЗАКРЫТА — BTC ЛОНГ\n🔵 БЕЗУБЫТОК/);
  assert.match(c, /\| 1д 6ч/);
  assert.match(c, /Взято целей: 1 из 2/);
  assert.match(c, /Итог: \+1\.00% — чистое движение цены, без плеча и комиссий/);
  assert.doesNotMatch(c, /марж/);
  assert.match(c, /#breakeven$/);
});

test("delivery age: a signal after 15 minutes is stale, an update only after 6 hours; time in position", () => {
  const now = Date.now();
  assert.equal(isStale("opened", new Date(now - 16 * 60_000), now), true);
  assert.equal(isStale("opened", new Date(now - 5 * 60_000), now), false);
  assert.equal(isStale("closed", new Date(now - 5 * 3_600_000), now), false);
  assert.equal(isStale("closed", new Date(now - 7 * 3_600_000), now), true);
  assert.equal(inPosition("2026-11-12T00:00:00Z", "2026-11-12T00:45:00Z"), "45м");
});
