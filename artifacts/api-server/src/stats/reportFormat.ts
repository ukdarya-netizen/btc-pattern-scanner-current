/**
 * Period reports (owner 2026-11-12: "всё полезное из CAB и Нигилиста"). Pure part: schedule and text, no DB.
 * Schedule as CAB / Nihilist (Dubai, UTC+4): daily 22:00 (trades closed since local midnight), weekly Sunday 10:00
 * (the last 7 days), monthly on the 1st at 11:00 (the previous calendar month). A report missed by a restart goes
 * out late, within 24 h; each period is claimed once (btc_reports).
 * Layout as Nihilist / CAB: result by outcome (profit / stop / break-even / holding time), every closed trade with
 * how long it was in the position (daily) or the shortest – longest time (weekly / monthly), total, win rate as CAB
 * ((profit + break-even) / (profit + break-even + stop)), longs / shorts, patterns, the 3 best (weekly / monthly).
 * Closed trades only — open positions are never listed. The result is the clean price move: no leverage, no fees.
 * Plain text (no HTML).
 */
const TZ_MS = 4 * 3_600_000;
const DAY = 86_400_000;

export type ReportKind = "daily" | "weekly" | "monthly";
export type Schedule = { kind: ReportKind; at: number; from: number; to: number; key: string; title: string };

const pad = (n: number) => String(n).padStart(2, "0");
const local = (ms: number) => new Date(ms + TZ_MS); // read with getUTC*
const dmy = (ms: number) => { const d = local(ms); return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`; };
const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь"];

/** The latest scheduled report of a kind at or before `now` (UTC ms). */
export function latestSchedule(kind: ReportKind, now: number): Schedule {
  const localDay = Math.floor((now + TZ_MS) / DAY);
  const dayStart = (d: number) => d * DAY - TZ_MS;
  if (kind === "daily") {
    let d = localDay;
    if (dayStart(d) + 22 * 3_600_000 > now) d -= 1;
    const at = dayStart(d) + 22 * 3_600_000;
    return { kind, at, from: dayStart(d), to: at, key: `day:${dmy(dayStart(d))}`, title: `Итоги дня ${dmy(dayStart(d))}` };
  }
  if (kind === "weekly") {
    let d = localDay - ((localDay + 4) % 7); // 1970-01-01 was a Thursday: (day + 4) % 7 === 0 is Sunday
    if (dayStart(d) + 10 * 3_600_000 > now) d -= 7;
    const at = dayStart(d) + 10 * 3_600_000;
    return { kind, at, from: at - 7 * DAY, to: at, key: `week:${dmy(dayStart(d))}`, title: `Недельный отчёт ${dmy(at - 7 * DAY)} – ${dmy(at - 1)}` };
  }
  const l = local(now);
  let y = l.getUTCFullYear(), m = l.getUTCMonth();
  const monthStart = (yy: number, mm: number) => Date.UTC(yy, mm, 1) - TZ_MS;
  if (monthStart(y, m) + 11 * 3_600_000 > now) { m -= 1; if (m < 0) { m = 11; y -= 1; } }
  const at = monthStart(y, m) + 11 * 3_600_000;
  const py = m === 0 ? y - 1 : y, pm = m === 0 ? 11 : m - 1;
  return { kind, at, from: monthStart(py, pm), to: monthStart(y, m), key: `month:${py}-${pad(pm + 1)}`, title: `Месячный отчёт: ${MONTHS[pm]} ${py}` };
}

/** On-demand (/daily, /weekly, /monthly): today since local midnight, the last 7 days, this calendar month. */
export function onDemandSchedule(kind: ReportKind, now: number): Schedule {
  const localDay = Math.floor((now + TZ_MS) / DAY);
  if (kind === "daily") { const from = localDay * DAY - TZ_MS; return { kind, at: now, from, to: now, key: "", title: `Итоги дня ${dmy(from)} (на сейчас)` }; }
  if (kind === "weekly") return { kind, at: now, from: now - 7 * DAY, to: now, key: "", title: `Отчёт за 7 дней ${dmy(now - 7 * DAY)} – ${dmy(now)}` };
  const l = local(now);
  const from = Date.UTC(l.getUTCFullYear(), l.getUTCMonth(), 1) - TZ_MS;
  return { kind, at: now, from, to: now, key: "", title: `Отчёт за ${MONTHS[l.getUTCMonth()]} ${l.getUTCFullYear()} (на сейчас)` };
}

/** Delivery-queue id of a scheduled report: negative, unique per kind and period (never collides with events). */
export function reportEventId(s: Schedule): number {
  const base = s.kind === "daily" ? 100_000_000 : s.kind === "weekly" ? 200_000_000 : 300_000_000;
  return -(base + Math.floor((s.from + TZ_MS) / DAY));
}

export type ReportRow = {
  direction: string; patternKey: string; pnlPricePct: number | null; mfePct: number | null;
  closeReason: string | null; detectedAt: Date; closedAt: Date | null;
};

const pct = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}%`;
const res = (r: ReportRow) => r.pnlPricePct ?? 0;
const sum = (rows: ReportRow[]) => rows.reduce((a, r) => a + res(r), 0);
const held = (r: ReportRow) => Math.max(0, (r.closedAt ?? r.detectedAt).getTime() - r.detectedAt.getTime());
export function durationText(ms: number): string {
  const mins = Math.round(ms / 60_000);
  const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
  return d > 0 ? `${d}д ${h}ч` : h > 0 ? `${h}ч ${m}м` : `${m}м`;
}
const side = (d: string) => (d === "long" ? "лонг" : "шорт");

const GROUPS: Array<{ reason: string; title: string }> = [
  { reason: "take_profit", title: "✅ Профит (все цели)" },
  { reason: "stop", title: "❌ Стоп-лосс" },
  { reason: "breakeven", title: "🛡 Безубыток" },
  { reason: "timeout", title: "⏳ По времени" },
];

export function formatReport(s: Schedule, rows: ReportRow[], label: (key: string) => string): string {
  const lines = [`📊 Bitcoin Margin Master — ${s.title}`, ""];
  if (!rows.length) {
    lines.push(s.kind === "daily" ? "Закрытых сделок за день нет." : "Закрытых сделок за период нет.");
    return lines.join("\n");
  }
  const withList = s.kind === "daily";
  for (const g of GROUPS) {
    const xs = rows.filter((r) => r.closeReason === g.reason);
    if (!xs.length) continue;
    lines.push(`${g.title}: ${xs.length} | ${pct(sum(xs))}`);
    if (withList) {
      for (const r of [...xs].sort((a, b) => res(b) - res(a)))
        lines.push(`  • ${side(r.direction)} ${pct(res(r))} | пик ${pct(r.mfePct ?? 0)} | в позиции ${durationText(held(r))} | ${label(r.patternKey)}`);
    } else {
      const ms = xs.map(held);
      const lo = durationText(Math.min(...ms)), hi = durationText(Math.max(...ms));
      lines.push(`  • в позиции: ${lo === hi ? lo : `${lo} – ${hi}`}`);
    }
  }
  const n = (reason: string) => rows.filter((r) => r.closeReason === reason).length;
  const wins = n("take_profit") + n("breakeven"), denom = wins + n("stop");
  lines.push("", `💰 Итог: ${pct(sum(rows))} · сделок ${rows.length} · винрейт ${denom ? `${Math.round((wins / denom) * 100)}%` : "—"}`);
  const sides = (["long", "short"] as const).map((d) => { const xs = rows.filter((r) => r.direction === d); return xs.length ? `${d === "long" ? "Лонги" : "Шорты"}: ${xs.length} · ${pct(sum(xs))}` : null; }).filter(Boolean);
  if (sides.length) lines.push(sides.join(" | "));
  const by = new Map<string, ReportRow[]>();
  for (const r of rows) by.set(r.patternKey, [...(by.get(r.patternKey) ?? []), r]);
  lines.push("", "По паттернам:");
  for (const [k, xs] of [...by].sort((a, b) => sum(b[1]) - sum(a[1]))) lines.push(`• ${label(k)}: ${xs.length} · ${pct(sum(xs))}`);
  if (!withList && rows.length > 3) {
    lines.push("", "🏆 Лучшие 3:");
    for (const r of [...rows].sort((a, b) => res(b) - res(a)).slice(0, 3)) lines.push(`• ${side(r.direction)} ${pct(res(r))} | ${label(r.patternKey)} | в позиции ${durationText(held(r))}`);
  }
  lines.push("", "Результат — чистое движение цены: без плеча и комиссий.");
  return lines.join("\n");
}

// ── Morning market report (owner 2026-11-12): every day 09:00 Dubai — sentiment (Fear / Greed), liquidations
// over 24 h, price and its change over 24 h. Market data only, no trades. ──
export type MorningSchedule = { at: number; key: string; title: string; eventId: number };

export function morningSchedule(now: number): MorningSchedule {
  let d = Math.floor((now + TZ_MS) / DAY);
  if (d * DAY - TZ_MS + 9 * 3_600_000 > now) d -= 1;
  const at = d * DAY - TZ_MS + 9 * 3_600_000;
  return { at, key: `morning:${dmy(d * DAY - TZ_MS)}`, title: `BTC утром ${dmy(d * DAY - TZ_MS)}`, eventId: -(400_000_000 + d) };
}

export type MorningData = {
  price: number | null; change24hPct: number | null;
  liqLongUsd: number | null; liqShortUsd: number | null;
  fearGreed: { value: number; prev: number | null; label: string } | null;
};

const money = (v: number | null) => {
  if (v == null) return "—";
  const a = Math.abs(v);
  return a >= 1e9 ? `$${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `$${(a / 1e6).toFixed(1)}M` : `$${(a / 1e3).toFixed(0)}K`;
};

export function formatMorning(s: MorningSchedule, m: MorningData): string {
  const fg = m.fearGreed;
  const liq = m.liqLongUsd == null && m.liqShortUsd == null ? null : (m.liqLongUsd ?? 0) + (m.liqShortUsd ?? 0);
  return [
    `☀️ Bitcoin Margin Master — ${s.title}`,
    "",
    `Сентимент: ${fg ? `${fg.value} — ${fg.label}${fg.prev == null ? "" : ` (вчера ${fg.prev})`}` : "—"}`,
    `Ликвидации за сутки: ${money(liq)} · лонги ${money(m.liqLongUsd)} · шорты ${money(m.liqShortUsd)}`,
    `Цена: ${m.price == null ? "—" : `$${m.price.toFixed(1)}`}`,
    `Изменение цены за сутки: ${m.change24hPct == null ? "—" : pct(m.change24hPct)}`,
  ].join("\n");
}
