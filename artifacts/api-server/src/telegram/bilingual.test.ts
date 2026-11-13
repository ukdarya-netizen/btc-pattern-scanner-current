import test from "node:test";
import assert from "node:assert/strict";
import { bilingual, toEnglish } from "./bilingual";
import { formatEvent } from "./telegram";
import { formatMorning, formatReport, latestSchedule, morningSchedule, onDemandSchedule } from "../stats/reportFormat";
import { ENDED_TEXT, WARNING_TEXT } from "../lib/subscriptionNotices";

const CYR = /[А-Яа-яЁё]/;
const englishPart = (t: string) => t.split("🇬🇧 English")[1] ?? "";
const noCyrillic = (t: string, what: string) => {
  const en = englishPart(t);
  assert.ok(en.length > 0, `${what}: no English part`);
  const bad = en.split("\n").filter((l) => CYR.test(l));
  assert.deepEqual(bad, [], `${what}: Cyrillic left in English`);
};

const opened = new Date("2026-11-12T08:00:00Z");
const metrics: any = {
  price: 96000, priceChangePct: { "1h": 0.4, "4h": -1, "24h": 2 }, oiChangePct: { "15m": 0.1, "30m": 0.2, "1h": 0.3, "4h": 1, "24h": 2 },
  spotCvdUsd: { "15m": 1e6, "30m": 2e6, "1h": -3e6, "4h": 4e6 }, futCvdUsd: { "15m": 1e6, "30m": 2e6, "1h": 3e6, "4h": -4e6 },
  futTakerNetPct: { "15m": 1, "1h": 3, "4h": -2 }, spotTakerNetPct: { "15m": 1, "1h": 3, "4h": -2 },
  futVolumeMult: { "15m": 1.1, "1h": 1.5 }, spotVolumeMult: { "15m": 0.9, "1h": 1.2 },
  liqLongUsd: { "1h": 1e6, "24h": 1e7 }, liqShortUsd: { "1h": 2e6, "24h": 3e7 },
  fundingRatePct: 0.0051, fundingBingxPct: -0.06, whaleIndex: 12, whaleIndex4h: 3, longShortRatio: 1.5, orderbookBidAskRatio: 0.6,
  context: { heatmap: { topAbove: [{ price: 98000, distancePct: 2 }], topBelow: [{ price: 94000, distancePct: -2 }] }, hyperliquidWhales: { longUsd: 1e8, shortUsd: 2e8 } },
};
const base: any = {
  id: 1, direction: "long", profile: "h4", leverage: 20, live: true,
  entryPrice: 96000, initialStopPrice: 94080, stopPrice: 94080, liquidationPrice: 91600,
  targets: [{ price: 97920, fraction: 0.5, hitAt: "x" }, { price: 99840, fraction: 0.5, hitAt: null }],
  breakevenMoved: true, mfePct: 2.5, maePct: -0.4, detectedAt: opened, expiresAt: new Date(opened.getTime() + 10 * 86_400_000),
};
const ev = (kind: string, detail: Record<string, unknown>, hours = 26): any =>
  ({ id: 1, signalId: 1, kind, price: 97000, detail, createdAt: new Date(opened.getTime() + hours * 3_600_000) });

const SIGNALS: Array<[string, string, any]> = [
  ["h4_breakout_long", "Пробой диапазона вверх · 4h", { ...metrics, pattern: { event: { kind: "breakout", top: 95000, bottom: 93000, heightPct: 2.1, bars: 40, sweepPrice: null }, volumeMult: 1.4, flowWindow: "4h", futCvdUsd: 1e6, spotCvdUsd: 2e6 } }],
  ["d1_deviation_short", "Девиация: ложный пробой вверх · 1D", { ...metrics, pattern: { event: { kind: "deviation", top: 95000, bottom: 93000, heightPct: 2.1, bars: 40, sweepPrice: 95500 }, volumeMult: 1.4, flowWindow: "1d" } }],
  ["smc_4h_30m_short", "Smart Money: ордер-блок 4h + слом 30m · шорт", { ...metrics, pattern: { method: "smart_money", htf: "4h", ltf: "30m", block: { scope: "swing", bottom: 97000, top: 97500 }, chochLevel: 96500 } }],
  ["lc_long", "Каскад ликвидаций лонгов → отскок", { ...metrics, pattern: { method: "liquidation_cascade", spikeHourUsd: 5e7, spikeMult: 4.2, cascadeExtreme: 94000, reactionWickPct: 0.6 } }],
  ["lc_short", "Вынос шортов → откат", metrics],
  ["neon_bounce_1h_long", "ABNeon отскок · интрадей 1h · лонг", metrics],
];

test("every signal message: Russian, then English without Cyrillic, hashtags once at the end", () => {
  for (const [key, label, m] of SIGNALS) {
    const s = { ...base, patternKey: key, metrics: m };
    const kinds: Array<[string, any]> = [
      ["opened", ev("opened", {}, 0)],
      ["target_hit", ev("target_hit", { index: 0, breakevenMoved: true })],
      ["target_hit 2", ev("target_hit", { index: 1 })],
      ["position_update", ev("position_update", { movePct: 3 })],
      ...(["take_profit", "breakeven", "timeout", "stop"] as const).map((r): [string, any] => [`closed ${r}`, ev("closed", { reason: r, pnlPricePct: 1.2 })]),
    ];
    for (const [what, e] of kinds) {
      const t = bilingual(formatEvent(s, e, label));
      noCyrillic(t, `${key} ${what}`);
      const tagLines = t.split("\n").filter((l) => l.startsWith("#BTC"));
      assert.equal(tagLines.length, 1, `${key} ${what}: hashtags once`);
      assert.ok(t.trim().endsWith(tagLines[0]!), `${key} ${what}: hashtags at the end`);
    }
  }
});

test("reports, Market update and subscription notices: English without Cyrillic", () => {
  const rows: any[] = [
    { direction: "long", patternKey: "h4_breakout_long", pnlPricePct: 2, mfePct: 3, closeReason: "take_profit", detectedAt: new Date("2026-11-10T08:00:00Z"), closedAt: new Date("2026-11-12T10:00:00Z") },
    { direction: "short", patternKey: "lc_short", pnlPricePct: -1, mfePct: 0.2, closeReason: "stop", detectedAt: new Date("2026-11-12T08:00:00Z"), closedAt: new Date("2026-11-12T08:40:00Z") },
    { direction: "long", patternKey: "smc_4h_30m_long", pnlPricePct: 0.5, mfePct: 1, closeReason: "breakeven", detectedAt: new Date("2026-11-12T08:00:00Z"), closedAt: new Date("2026-11-12T11:00:00Z") },
    { direction: "long", patternKey: "d1_breakout_long", pnlPricePct: 0.1, mfePct: 1, closeReason: "timeout", detectedAt: new Date("2026-11-01T08:00:00Z"), closedAt: new Date("2026-11-12T11:00:00Z") },
  ];
  const label = (k: string) => ({ h4_breakout_long: "Пробой диапазона вверх · 4h", lc_short: "Вынос шортов → откат", smc_4h_30m_long: "Smart Money: ордер-блок 4h + слом 30m · лонг", d1_breakout_long: "Пробой диапазона вверх · 1D" } as Record<string, string>)[k]!;
  const now = Date.parse("2026-12-01T08:00:00Z");
  for (const kind of ["daily", "weekly", "monthly"] as const) {
    noCyrillic(bilingual(formatReport(latestSchedule(kind, now), rows, label)), `report ${kind}`);
    noCyrillic(bilingual(formatReport(onDemandSchedule(kind, now), rows, label)), `on demand ${kind}`);
    noCyrillic(bilingual(formatReport(latestSchedule(kind, now), [], label)), `empty ${kind}`);
  }
  noCyrillic(bilingual(formatMorning(morningSchedule(now), { price: 96000, change24hPct: -1.2, liqLongUsd: 1e8, liqShortUsd: 2e7, fearGreed: { value: 30, prev: 40, label: "Fear" } })), "market update");
  noCyrillic(bilingual(formatMorning(morningSchedule(now), { price: null, change24hPct: null, liqLongUsd: null, liqShortUsd: null, fearGreed: null })), "market update empty");
  noCyrillic(WARNING_TEXT, "subscription warning");
  noCyrillic(ENDED_TEXT, "subscription ended");
});

test("English wording of the key lines", () => {
  assert.equal(toEnglish("🎯 Цель 1: 97920.0 (+2.00%) — закрыть 50%, стоп в безубыток"), "🎯 TP 1: 97920.0 (+2.00%) — close 50%, stop to break-even");
  assert.equal(toEnglish("96000.0 → 97000.0 (+1.04%) | 1д 2ч"), "96000.0 → 97000.0 (+1.04%) | 1d 2h");
  assert.equal(toEnglish("Таймфрейм: 30m вход · 4h старший · интрадей"), "Timeframe: 30m entry · 4h higher TF · intraday");
});
