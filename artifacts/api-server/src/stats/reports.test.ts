import test from "node:test";
import assert from "node:assert/strict";
import { formatReport, latestSchedule, reportEventId } from "./reportFormat";

const label = (k: string) => (k === "p1" ? "Пробой рейнджа 4H" : k);
const at = (iso: string) => Date.parse(iso);

test("schedule as CAB / Nihilist (Dubai): daily 22:00, weekly Sunday 10:00, monthly the 1st 11:00", () => {
  const d = latestSchedule("daily", at("2026-11-12T18:30:00Z")); // 22:30 Dubai
  assert.equal(new Date(d.at).toISOString(), "2026-11-12T18:00:00.000Z");
  assert.equal(new Date(d.from).toISOString(), "2026-11-11T20:00:00.000Z");
  const before = latestSchedule("daily", at("2026-11-12T17:30:00Z")); // 21:30 Dubai → yesterday's
  assert.equal(new Date(before.at).toISOString(), "2026-11-11T18:00:00.000Z");
  const w = latestSchedule("weekly", at("2026-11-12T10:00:00Z")); // Thursday → last Sunday 08.11 10:00
  assert.equal(new Date(w.at).toISOString(), "2026-11-08T06:00:00.000Z");
  const m = latestSchedule("monthly", at("2026-11-12T10:00:00Z"));
  assert.equal(m.title, "Месячный отчёт: октябрь 2026");
  assert.equal(new Date(m.from).toISOString(), "2026-09-30T20:00:00.000Z");
  assert.ok(reportEventId(d) < 0 && reportEventId(d) !== reportEventId(w));
});

test("daily lists every closed trade with its time in position; weekly gives ranges and the best 3; clean move", () => {
  const t0 = new Date("2026-11-12T06:00:00Z");
  const r = (pnl: number, reason: string, hours: number, dir = "long") => ({
    direction: dir, patternKey: "p1", pnlPricePct: pnl, mfePct: pnl + 1, closeReason: reason,
    detectedAt: t0, closedAt: new Date(t0.getTime() + hours * 3_600_000),
  });
  const rows = [r(4, "take_profit", 5), r(-2, "stop", 2), r(1, "breakeven", 30, "short"), r(0.5, "timeout", 50)];
  const d = formatReport(latestSchedule("daily", at("2026-11-12T18:30:00Z")), rows, label);
  assert.match(d, /✅ Профит \(все цели\): 1 \| \+4\.00%\n  • лонг \+4\.00% \| пик \+5\.00% \| в позиции 5ч 0м \| Пробой рейнджа 4H/);
  assert.match(d, /💰 Итог: \+3\.50% · сделок 4 · винрейт 67%/);
  assert.match(d, /Лонги: 3 · \+2\.50% \| Шорты: 1 · \+1\.00%/);
  assert.match(d, /без плеча и комиссий/);
  assert.doesNotMatch(d, /марж|<[a-z]/i);
  const w = formatReport(latestSchedule("weekly", at("2026-11-12T10:00:00Z")), rows, label);
  assert.match(w, /в позиции: 5ч 0м/);
  assert.match(w, /🏆 Лучшие 3:/);
  assert.doesNotMatch(w, /пик \+/);
  const empty = formatReport(latestSchedule("daily", at("2026-11-12T18:30:00Z")), [], label);
  assert.match(empty, /Закрытых сделок за день нет/);
});
