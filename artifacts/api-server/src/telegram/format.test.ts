import test from "node:test";
import assert from "node:assert/strict";
import { eventImage, formatEvent, inPosition, isStale, systemLines } from "./telegram";

const opened = new Date("2026-11-12T08:00:00Z");
const signal: any = {
  id: 1, patternKey: "h4_breakout_long", direction: "long", profile: "h4", leverage: 20, live: true,
  entryPrice: 96000, initialStopPrice: 94080, stopPrice: 94080, liquidationPrice: 91600,
  targets: [{ price: 97920, fraction: 0.5, hitAt: null }, { price: 99840, fraction: 0.5, hitAt: null }],
  breakevenMoved: false, mfePct: 0, maePct: 0, detectedAt: opened, expiresAt: new Date(opened.getTime() + 10 * 86_400_000), metrics: {},
};
const ev = (kind: string, price: number, detail: Record<string, unknown>, hours: number): any =>
  ({ id: 1, signalId: 1, kind, price, detail, createdAt: new Date(opened.getTime() + hours * 3_600_000) });

test("opened: system, pattern, timeframe, entry, stop, targets with what to do, no leverage, hashtags; plain text", () => {
  const t = formatEvent(signal, ev("opened", 96000, {}, 0), "Пробой диапазона вверх · 4h");
  assert.match(t, /^₿ BITCOIN MARGIN MASTER · BTC ЛОНГ\nСистема: Диапазон \(рейндж\)\nПаттерн: Пробой диапазона вверх\nТаймфрейм: 4h · свинг\nМакс\. удержание: 10д\n/);
  assert.doesNotMatch(t, /Плечо|x20|ликвидация ≈/);
  assert.match(t, /🎯 Цель 1: 97920\.0 \(\+2\.00%\) — закрыть 50%, стоп в безубыток/);
  assert.match(t, /🎯 Цель 2: 99840\.0 \(\+4\.00%\) — закрыть остаток/);
  assert.match(t, /#BTC #h4_breakout_long #long #swing$/);
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

test("system lines: Smart Money and liquidation cascade", () => {
  const smc = systemLines({ patternKey: "smc_4h_30m_short", detectedAt: opened, expiresAt: null } as any, "Smart Money: ордер-блок 4h + слом 30m · шорт");
  assert.deepEqual(smc, ["Система: Smart Money", "Паттерн: ордер-блок 4h + слом структуры (CHoCH) 30m", "Таймфрейм: 30m вход · 4h старший · интрадей"]);
  const lc = systemLines({ patternKey: "lc_long", detectedAt: opened, expiresAt: null } as any, "Каскад ликвидаций лонгов → отскок");
  assert.deepEqual(lc, ["Система: Каскад ликвидаций", "Паттерн: Каскад ликвидаций лонгов → отскок", "Таймфрейм: 15m · скальп"]);
});

test("closed take-profit events use the Take Profit image", () => {
  assert.equal(eventImage("closed", { reason: "take_profit" }), "take-profit");
  assert.equal(eventImage("target_hit", { index: 1 }), "take-profit");
  assert.equal(eventImage("closed", { reason: "stop" }), "stop-loss");
  assert.equal(eventImage("closed", { reason: "breakeven" }), null);
});

test("entry metrics as CAB: OI, CVD, takers, volume, liquidations, funding BingX + CoinGlass, WI, crowd, OB", async () => {
  const { metricLines, fundingLine } = await import("./telegram");
  const t = metricLines({
    price: 96000, priceChangePct: { "1h": 0.4, "4h": -1, "24h": 2 } as any, oiChangePct: { "15m": 0.1, "30m": 0.2, "1h": 0.3, "4h": 1, "24h": 2 } as any,
    spotCvdUsd: { "15m": 1e6 } as any, futCvdUsd: {} as any, futTakerNetPct: { "1h": 3 } as any, spotTakerNetPct: {} as any,
    futVolumeMult: { "1h": 1.5 } as any, spotVolumeMult: {} as any, liqLongUsd: { "1h": 1e6, "24h": 1e7 } as any, liqShortUsd: { "1h": 0, "24h": 0 } as any,
    fundingRatePct: 0.0051, fundingBingxPct: 0.01, whaleIndex: 12, whaleIndex4h: 3, longShortRatio: 1.5, orderbookBidAskRatio: 0.6,
  }).join("\n");
  assert.match(t, /OI: 15m \+0\.10% · 30m \+0\.20% · 1h \+0\.30% · 4h \+1\.00% · 24h \+2\.00%/);
  assert.match(t, /Ликвидации 1h: лонги \$1\.0M · шорты \$0K · 24h: лонги \$10\.0M · шорты \$0K · 1h\/24h 10\.0%/);
  assert.match(t, /⚖️ Фандинг \(8ч\): BingX \+0\.0100% · CoinGlass OI-взвеш\. \+0\.0051%/);
  assert.match(t, /📊 WI \+12\.0🟢 \(4h \+3\.0\) · Толпа 60% лонг \(Binance\) · OB 0\.60x🔴/);
  assert.equal(fundingLine(0.12, null), "⚠️ Фандинг (8ч): BingX +0.1200% — лонги перегреты");
});

test("position updates carry the market now (OI, CVD, takers, funding …); without fresh metrics no block", async () => {
  const { bilingual } = await import("./bilingual");
  const { setLiveMetrics, liveMetrics, LIVE_METRICS_FRESH_MS } = await import("../engine/liveMetrics");
  const m: any = {
    price: 97000, priceChangePct: { "1h": 0.4 }, oiChangePct: { "15m": 0.1, "1h": 0.3 }, spotCvdUsd: { "15m": 1e6 }, futCvdUsd: {},
    futTakerNetPct: { "1h": 3 }, spotTakerNetPct: {}, futVolumeMult: {}, spotVolumeMult: {}, liqLongUsd: {}, liqShortUsd: {},
    fundingRatePct: 0.0051, fundingBingxPct: 0.01,
  };
  for (const [kind, detail] of [["position_update", { sequence: 1, movePct: 1.04 }], ["target_hit", { index: 0, breakevenMoved: true }]] as const) {
    const t = formatEvent(signal, ev(kind, 97000, { ...detail, metrics: m }, 3), "Пробой рейнджа 4H");
    assert.match(t, /📊 Рынок сейчас \(CoinGlass, все биржи\)\nЦена: 1h \+0\.40%/);
    assert.match(t, /OI: 15m \+0\.10%/);
    assert.match(t, /Фандинг \(8ч\): BingX \+0\.0100%/);
    assert.ok(t.indexOf("Рынок сейчас") < t.lastIndexOf("#"), "metrics before the hashtags");
    assert.match(bilingual(t), /📊 Market now \(CoinGlass, all exchanges\)/);
    const bare = formatEvent(signal, ev(kind, 97000, { ...detail }, 3), "Пробой рейнджа 4H");
    assert.doesNotMatch(bare, /Рынок сейчас/);
  }
  setLiveMetrics(m, 1_000_000);
  assert.equal(liveMetrics(1_000_000 + LIVE_METRICS_FRESH_MS), m);
  assert.equal(liveMetrics(1_000_001 + LIVE_METRICS_FRESH_MS), null);
});
