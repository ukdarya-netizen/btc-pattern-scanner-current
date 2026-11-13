import test from "node:test";
import assert from "node:assert/strict";
import { formatMorning, morningSchedule } from "./reportFormat";
import { parseFearGreed, parseFearGreedHistory } from "../market/fearGreed";

test("morning report: 09:00 Dubai (05:00 UTC), the latest at or before now", () => {
  const s = morningSchedule(Date.parse("2026-11-12T05:30:00Z"));
  assert.equal(new Date(s.at).toISOString(), "2026-11-12T05:00:00.000Z");
  assert.equal(s.key, "morning:12.11.2026");
  const before = morningSchedule(Date.parse("2026-11-12T04:59:00Z"));
  assert.equal(before.key, "morning:11.11.2026");
  assert.ok(s.eventId < 0 && s.eventId !== before.eventId);
});

test("morning report text: sentiment, liquidations 24h, price, change 24h; plain text", () => {
  const t = formatMorning(morningSchedule(Date.parse("2026-11-12T05:30:00Z")), {
    price: 96120.46, change24hPct: -1.854, liqLongUsd: 250_100_000, liqShortUsd: 62_200_000,
    fearGreed: { value: 62, prev: 55, label: "Greed" },
  });
  assert.equal(t, [
    "☀️ Bitcoin Margin Master — Market update 12.11.2026",
    "",
    "Сентимент: 62 — Greed (вчера 55)",
    "Ликвидации за сутки: $312.3M · лонги $250.1M · шорты $62.2M",
    "Цена: $96120.5",
    "Изменение цены за сутки: −1.85%",
  ].join("\n"));
  const empty = formatMorning(morningSchedule(Date.now()), { price: null, change24hPct: null, liqLongUsd: null, liqShortUsd: null, fearGreed: null });
  assert.match(empty, /Сентимент: —\nЛиквидации за сутки: — · лонги — · шорты —\nЦена: —\nИзменение цены за сутки: —$/);
});

test("fear & greed: last two points by time; out-of-range values ignored", () => {
  assert.deepEqual(parseFearGreed([{ data_list: [40, 71, 55], time_list: [1, 3, 2] }]), { value: 71, prev: 55, label: "Greed" });
  assert.deepEqual(parseFearGreed({ data_list: [18], time_list: [1] }), { value: 18, prev: null, label: "Extreme Fear" });
  assert.equal(parseFearGreed([{ data_list: [4611285.1] }]), null);
  assert.equal(parseFearGreed(null), null);
});

test("fear & greed history: by time, seconds → ms, last N days", () => {
  assert.deepEqual(parseFearGreedHistory([{ data_list: [40, 71, 55], time_list: [1_700_000_000, 1_700_172_800, 1_700_086_400] }], 2),
    [{ t: 1_700_086_400_000, v: 55, p: null }, { t: 1_700_172_800_000, v: 71, p: null }]);
  // BTC price of the day (price_list) for the BTC line over the chart (owner 2026-11-13).
  assert.deepEqual(parseFearGreedHistory([{ data_list: [40, 71], price_list: [90000, 95000], time_list: [1_700_000_000, 1_700_086_400] }], 2),
    [{ t: 1_700_000_000_000, v: 40, p: 90000 }, { t: 1_700_086_400_000, v: 71, p: 95000 }]);
});
