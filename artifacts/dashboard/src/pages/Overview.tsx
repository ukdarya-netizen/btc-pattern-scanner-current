import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { REASON, STYLE_LABEL, type Signal, type Style, asset, dir, duration, heldMs, liveMove, num, price, signed, time, tone } from "../lib/api";
import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { type Data, type Filter, type Mode, NO_FILTER, type Period, type Tab, dubaiDayEnd, dubaiDayKey, dubaiDayStart, dubaiMonth, inPeriod, monthName, res, styleOf, summarize } from "../lib/data";
import { Card, type Col, Crown, Pill, SortTable, Tile } from "../components/ui";

const GOLD = "#f2b10f";
const AXIS = { stroke: "#8a7d63", fontSize: 11 };
const TIP = { contentStyle: { background: "#120f0a", border: "1px solid #5a4417", borderRadius: 8 }, labelStyle: { color: "#d8c9a6" } };

const OUTCOMES: Array<{ reason: Filter["reason"]; label: string; tone: string }> = [
  { reason: "take_profit", label: "Цели", tone: "text-emerald-400" },
  { reason: "breakeven", label: "Безубыток", tone: "text-sky-300" },
  { reason: "stop", label: "Стоп", tone: "text-rose-400" },
  { reason: "timeout", label: "По времени", tone: "text-amber-300" },
];
const WEEK = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];

/** Month calendar of the daily result by close day (Dubai), as CAB «Архив статистики» / Nihilist «Архив по дням». */
function DayArchive({ closed, openDay }: { closed: Signal[]; openDay: (key: string) => void }) {
  const now = new Date(Date.now() + 4 * 3_600_000);
  const [month, setMonth] = useState(() => `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`);
  const [y, m] = month.split("-").map(Number) as [number, number];
  const byDay = new Map<string, Signal[]>();
  for (const s of closed) if (s.closedAt) { const k = dubaiDayKey(s.closedAt); byDay.set(k, [...(byDay.get(k) ?? []), s]); }
  const daysIn = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  const cells = [...Array(lead).fill(null), ...Array.from({ length: daysIn }, (_, i) => i + 1)] as Array<number | null>;
  const monthRows = closed.filter((s) => s.closedAt && dubaiMonth(s.closedAt) === month);
  const ms = summarize(monthRows);
  const shift = (k: number) => { const d = new Date(Date.UTC(y, m - 1 + k, 1)); setMonth(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`); };
  return (
    <Card title="Архив по дням (Дубай)" right={
      <div className="flex items-center gap-2 text-xs">
        <button onClick={() => shift(-1)} aria-label="Предыдущий месяц" className="p-1 text-muted-foreground hover:text-gold"><ChevronLeft className="h-4 w-4" /></button>
        <span className="w-32 text-center capitalize">{monthName(month)}</span>
        <button onClick={() => shift(1)} aria-label="Следующий месяц" className="p-1 text-muted-foreground hover:text-gold"><ChevronRight className="h-4 w-4" /></button>
      </div>
    }>
      <div className="grid grid-cols-7 gap-1 text-center text-[10px] uppercase text-muted-foreground">{WEEK.map((w) => <div key={w}>{w}</div>)}</div>
      <div className="mt-1 grid grid-cols-7 gap-1">
        {cells.map((d, i) => {
          if (d === null) return <div key={`e${i}`} />;
          const key = `${month}-${String(d).padStart(2, "0")}`;
          const xs = byDay.get(key) ?? [];
          const sum = xs.reduce((a, s) => a + res(s), 0);
          return (
            <button key={key} type="button" disabled={!xs.length} onClick={() => openDay(key)} className={`min-h-14 rounded-md border p-1 text-left ${xs.length ? (sum >= 0 ? "border-emerald-500/30 bg-emerald-500/5 hover:border-emerald-400/70" : "border-rose-500/30 bg-rose-500/5 hover:border-rose-400/70") : "border-border/50 cursor-default"}`}>
              <div className="text-[10px] text-muted-foreground">{d}</div>
              {xs.length > 0 && <div className={`text-xs font-semibold tabular-nums ${tone(sum)}`}>{signed(sum, 1)}</div>}
              {xs.length > 0 && <div className="text-[10px] text-muted-foreground">{xs.length} сд.</div>}
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">За месяц: {ms.n} сделок · {signed(ms.sum, 1)} · винрейт {ms.winRate == null ? "—" : `${num(ms.winRate, 0)}%`}</p>
    </Card>
  );
}

/** Month by the OPENING date (owner 2026-11-14: «позиции, которые были открыты в этом месяце»); results of the closed ones. */
type MonthRow = { month: string; signals: number; open: number; rows: Signal[] } & ReturnType<typeof summarize>;
/** Every Dubai day from the first to the last key (empty days included, so the charts read as a calendar). */
function dayRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
const dayLabel = (key: string) => `${key.slice(8, 10)}.${key.slice(5, 7)}`;

export function Overview({ data, period, setPeriod, mode, go }: { data: Data; period: Period; setPeriod: (p: Period) => void; mode: Mode; go: (t: Tab, f?: Partial<Filter>) => void }) {
  const last = data.status?.stream.lastPrice ?? null;
  const patterns = data.status?.patterns ?? [];
  const closed = inPeriod(data.closed, period);
  const all = summarize(closed);
  const side = (d: string) => summarize(closed.filter((s) => s.direction === d));
  const style = (st: Style) => summarize(closed.filter((s) => styleOf(patterns, s.patternKey) === st));
  const openMove = data.open.map((s) => liveMove(s, last) ?? 0).reduce((a, b) => a + b, 0);

  // Owner 2026-11-14: both charts on a continuous calendar of Dubai days — from the first signal of the period (or the
  // first day of the chosen month) to today / the month end; a day without closes is 0, the curve stays flat.
  const byClose = [...closed].filter((s) => s.closedAt).sort((a, b) => Date.parse(a.closedAt!) - Date.parse(b.closedAt!));
  const dayMap = new Map<string, { v: number; n: number }>();
  for (const s of byClose) { const k = dubaiDayKey(s.closedAt!); const x = dayMap.get(k) ?? { v: 0, n: 0 }; dayMap.set(k, { v: x.v + res(s), n: x.n + 1 }); }
  const todayKey = dubaiDayKey(new Date().toISOString());
  const firstSignal = [...data.open, ...data.closed].map((s) => dubaiDayKey(s.detectedAt)).sort()[0] ?? null;
  const isMonth = /^\d{4}-\d{2}$/.test(period);
  const monthEnd = isMonth ? (() => { const [yy, mm] = period.split("-").map(Number) as [number, number]; return new Date(Date.UTC(yy, mm, 0)).toISOString().slice(0, 10); })() : null;
  const startKey = isMonth ? `${period}-01` : period === "all" ? firstSignal : dubaiDayKey(new Date(Date.now() - Number(period) * 86_400_000).toISOString());
  const endKey = monthEnd && monthEnd < todayKey ? monthEnd : todayKey;
  const days = startKey && byClose.length ? dayRange(startKey < (dubaiDayKey(byClose[0]!.closedAt!)) ? startKey : dubaiDayKey(byClose[0]!.closedAt!), endKey) : [];
  let acc = 0;
  const daily = days.map((k) => { const x = dayMap.get(k); acc += x?.v ?? 0; return { key: k, day: dayLabel(k), v: Number((x?.v ?? 0).toFixed(2)), n: x?.n ?? 0, acc: Number(acc.toFixed(2)) }; });

  const holds = closed.map((s) => heldMs(s)).sort((a, b) => a - b);
  const winRate = (s: { winRate: number | null }) => (s.winRate == null ? "—" : `${num(s.winRate, 0)}%`);
  // Counters (as CAB / Nihilist): signals today (Dubai), all signals, open now, time in a trade (shortest – longest).
  const today = dubaiDayKey(new Date().toISOString());
  const allSignals = [...data.open, ...data.closed];
  const todayN = allSignals.filter((s) => dubaiDayKey(s.detectedAt) === today).length;
  const best = [...closed].sort((a, b) => res(b) - res(a))[0] ?? null;
  const peaks = closed.map((s) => s.mfePct);
  const avgPeak = peaks.length ? peaks.reduce((a, b) => a + b, 0) / peaks.length : null;
  const reached = (x: number) => closed.filter((s) => s.mfePct >= x).length;
  const label = (k: string) => patterns.find((p) => p.key === k)?.label ?? k;
  // Statistics by month of OPENING (Dubai); a click lists the month's positions (owner 2026-11-14), the period stays.
  const [openMonth, setOpenMonth] = useState<string | null>(null);
  const months = new Map<string, Signal[]>();
  for (const s of allSignals) { const k = dubaiMonth(s.detectedAt); months.set(k, [...(months.get(k) ?? []), s]); }
  const monthRows: MonthRow[] = [...months].map(([month, xs]) => ({
    month, signals: xs.length, open: xs.filter((s) => !s.closedAt).length, rows: xs, ...summarize(xs.filter((s) => s.closedAt)),
  }));
  const shownMonth = monthRows.find((r) => r.month === openMonth) ?? null;
  const monthCols: Col<MonthRow>[] = [
    { head: "Месяц", cell: (r) => <span className="capitalize text-foreground">{monthName(r.month)}</span>, sort: (r) => r.month },
    { head: "Сигналов", cell: (r) => r.signals, sort: (r) => r.signals },
    { head: "Закрыто", cell: (r) => r.n, sort: (r) => r.n },
    { head: "Открыто", cell: (r) => r.open, sort: (r) => r.open },
    { head: "Винрейт", cell: (r) => winRate(r), sort: (r) => r.winRate },
    { head: "Сумма", cell: (r) => <span className={`font-medium ${tone(r.sum)}`}>{signed(r.sum, 1)}</span>, sort: (r) => r.sum },
    { head: "Среднее", cell: (r) => <span className={tone(r.avg)}>{signed(r.avg)}</span>, sort: (r) => r.avg },
    { head: "Лучшая", cell: (r) => signed(r.best), sort: (r) => r.best },
    { head: "Худшая", cell: (r) => signed(r.worst), sort: (r) => r.worst },
  ];

  // Owner 2026-11-14: every tile opens the history with its own filter and a title (as CAB).
  const openDay = (key: string) => go("history", { status: "closed", basis: "closed", from: dubaiDayStart(key), to: dubaiDayEnd(key), title: `Закрыто ${key.slice(8, 10)}.${key.slice(5, 7)}`, note: "сделки, закрытые в этот день (Дубай)" });
  const posCols: Col<Signal>[] = [
    { head: "#", cell: (s) => s.id, sort: (s) => s.id },
    { head: "Открыта", cell: (s) => time(s.detectedAt), sort: (s) => Date.parse(s.detectedAt) },
    { head: "Паттерн", cell: (s) => label(s.patternKey), sort: (s) => label(s.patternKey) },
    { head: "Напр.", cell: (s) => <Pill kind={s.direction === "long" ? "long" : "short"}>{dir(s.direction)}</Pill>, sort: (s) => s.direction },
    { head: "Вход", cell: (s) => price(s.entryPrice), sort: (s) => s.entryPrice },
    { head: "Закрыта", cell: (s) => (s.closedAt ? time(s.closedAt) : <span className="text-gold">открыта</span>), sort: (s) => (s.closedAt ? Date.parse(s.closedAt) : Infinity) },
    { head: "Активна", cell: (s) => (s.closedAt ? duration(heldMs(s)) : `${duration(heldMs(s))} (сейчас)`), sort: (s) => heldMs(s) },
    { head: "Итог", cell: (s) => (s.closedAt ? REASON[s.closeReason ?? ""] ?? "—" : "в сделке"), sort: (s) => s.closeReason ?? "" },
    { head: "Движение", cell: (s) => { const v = s.closedAt ? res(s) : liveMove(s, last); return <span className={`font-semibold ${tone(v)}`}>{signed(v)}</span>; }, sort: (s) => (s.closedAt ? res(s) : liveMove(s, last)) },
  ];

  return (
    <div className="space-y-4">
      <section className="hero relative overflow-hidden rounded-2xl border border-gold/30">
        {/* Owner 2026-11-14: the honey badger biting the snake — his face in view, on the right behind the text. */}
        <img src={asset("brand/hero-badger.webp")} alt="" className="absolute inset-y-0 right-0 h-full w-full object-cover object-[50%_18%] md:w-[62%]" />
        <div className="absolute inset-0 bg-gradient-to-r from-black via-black/75 to-transparent md:from-35% md:via-black/40 md:via-50% md:to-70%" />
        <div className="relative flex min-h-[240px] flex-col justify-end gap-3 p-6 md:min-h-[300px] md:w-3/5">
          <div className="flex items-center gap-2 text-gold"><Crown className="h-6 w-8" /><span className="text-xs uppercase tracking-[0.3em]">BTC-USDT · Long · Short</span></div>
          <h1><img src={asset("brand/wordmark.webp")} alt="Bitcoin Margin Master" className="h-28 w-auto max-w-full object-contain md:h-40" /></h1>
          <p className="text-xs uppercase tracking-[0.35em] text-gold/80">Discipline · Leverage · Freedom</p>
          <div className="flex flex-wrap items-end gap-6 pt-1">
            <div><div className="text-[10px] uppercase tracking-widest text-muted-foreground">BTC-USDT</div><div className="text-3xl font-semibold tabular-nums text-white">{price(last)}</div></div>
            <button type="button" onClick={() => go("positions")} className="-m-1 rounded-md p-1 text-left hover:bg-white/5"><div className="text-[10px] uppercase tracking-widest text-muted-foreground">{mode === "live" ? "Открыто в канале" : "Открыто в тени"}</div><div className={`text-xl font-semibold tabular-nums ${tone(openMove)}`}>{data.open.length} · {signed(openMove)}</div></button>
          </div>
        </div>
      </section>

      {period !== "all" && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gold/40 bg-gold/10 px-4 py-2 text-sm">
          <span>Статистика ниже — только за период: <b className="capitalize">{isMonth ? monthName(period) : `${period} дней`}</b> (по дате закрытия).</span>
          <button onClick={() => setPeriod("all")} className="rounded-md border border-gold/60 px-3 py-1 text-xs text-gold hover:bg-gold/15">Показать всё время</button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Сигналов сегодня" value={todayN} sub="открыто за день (Дубай)" onClick={() => go("history", { status: "all", basis: "detected", from: dubaiDayStart(today), sort: "Открыта", title: "Сигналы сегодня", note: "все сигналы, открытые сегодня (Дубай)" })} />
        <Tile label="Всего сигналов" value={allSignals.length} sub={`закрыто ${data.closed.length}`} onClick={() => go("history", { status: "all", sort: "Открыта", title: "Все сигналы", note: "открытые и закрытые" })} />
        <Tile label="Открыто сейчас" value={data.open.length} sub="все позиции" onClick={() => go("positions")} />
        <Tile label="Время в сделке" value={holds.length ? `${duration(holds[0]!)} – ${duration(holds.at(-1)!)}` : "—"} sub="от сигнала до закрытия" onClick={() => go("history", { sort: "Активна", title: "Время в сделке", note: "закрытые сделки, самые долгие сверху" })} />
      </div>

      <section className="gold-card p-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <button type="button" onClick={() => go("history", { title: "Все закрытые сделки", note: "из них складывается счётчик" })} className="-m-2 rounded-lg p-2 text-left hover:bg-gold/5">
            <p className="text-xs uppercase tracking-widest text-muted-foreground">Счётчик — чистое движение цены</p>
            <p className={`mt-1 text-4xl font-semibold tabular-nums ${tone(all.sum)}`}>{signed(all.sum, 2)}</p>
            <p className="mt-1 text-xs text-muted-foreground">{all.n} закрытых сделок · в среднем {signed(all.avg)} · без плеча и комиссий</p>
          </button>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {OUTCOMES.map((o) => { const sm = summarize(closed.filter((s) => s.closeReason === o.reason)); return (
              <button key={o.reason} onClick={() => go("history", { reason: o.reason, title: o.label, note: "закрытые сделки с этим итогом" })} className="rounded-lg border border-border px-3 py-2 text-left hover:border-gold/50">
                <div className={`text-xs ${o.tone}`}>{o.label}</div>
                <div className="text-lg font-semibold tabular-nums">{sm.n}</div>
                <div className={`text-xs tabular-nums ${tone(sm.sum)}`}>{signed(sm.sum, 1)}</div>
              </button>
            ); })}
          </div>
        </div>
      </section>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Винрейт" value={winRate(all)} sub="(цели + безубыток) / (цели + безубыток + стоп)" onClick={() => go("history", { reasons: ["take_profit", "breakeven", "stop"], title: "Винрейт", note: "сделки, из которых он считается: цели, безубыток, стоп" })} />
        <Tile label="В плюсе" value={all.wins} sub={`из ${all.n} закрытых`} onClick={() => go("history", { result: "win", sort: "Движение", title: "В плюсе", note: "закрытые сделки с итогом больше нуля" })} />
        <Tile label="Лучшая сделка" value={best ? signed(res(best)) : "—"} tone="text-emerald-400" sub={best ? `${label(best.patternKey)}` : "—"} onClick={() => go("history", { sort: "Движение", title: "Лучшие сделки", note: "закрытые, по итогу сверху вниз" })} />
        <Tile label="Средний пик" value={signed(avgPeak, 1)} sub={`до +1%: ${reached(1)} · до +2%: ${reached(2)} · до +5%: ${reached(5)}`} onClick={() => go("history", { sort: "Макс. в плюс", title: "Пик сделок", note: "закрытые, по максимальному ходу в плюс" })} />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {(["long", "short"] as const).map((d) => { const s = side(d); return (
          <Tile key={d} label={d === "long" ? "Лонги" : "Шорты"} value={signed(s.sum, 1)} tone={tone(s.sum)} sub={`${s.n} · винрейт ${winRate(s)}`} onClick={() => go("history", { direction: d, title: d === "long" ? "Лонги" : "Шорты", note: "закрытые сделки" })} />
        ); })}
        {(["scalp", "intraday", "swing"] as const).map((st) => { const s = style(st); return (
          <Tile key={st} label={STYLE_LABEL[st]} value={signed(s.sum, 1)} tone={tone(s.sum)} sub={`${s.n} · винрейт ${winRate(s)}`} onClick={() => go("history", { style: st, title: STYLE_LABEL[st], note: "закрытые сделки" })} />
        ); })}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Накопленное движение, %">
          {daily.length === 0 ? <p className="text-sm text-muted-foreground">Закрытых сделок за период нет.</p> : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={daily}>
                  <defs><linearGradient id="eq" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={GOLD} stopOpacity={0.45} /><stop offset="100%" stopColor={GOLD} stopOpacity={0} /></linearGradient></defs>
                  <CartesianGrid stroke="#2a2214" vertical={false} />
                  <XAxis dataKey="day" {...AXIS} minTickGap={24} />
                  <YAxis {...AXIS} unit="%" />
                  <ReferenceLine y={0} stroke="#5a4417" />
                  <Tooltip {...TIP} formatter={(v: number) => [`${v >= 0 ? "+" : ""}${v}%`, "Накоплено к концу дня"]} />
                  <Area type="stepAfter" dataKey="acc" stroke={GOLD} strokeWidth={2} fill="url(#eq)" isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
        <Card title="Движение по дням, % (Дубай)">
          {daily.length === 0 ? <p className="text-sm text-muted-foreground">Закрытых сделок за период нет.</p> : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={daily}>
                  <CartesianGrid stroke="#2a2214" vertical={false} />
                  <XAxis dataKey="day" {...AXIS} minTickGap={16} />
                  <YAxis {...AXIS} unit="%" />
                  <ReferenceLine y={0} stroke="#5a4417" />
                  <Tooltip {...TIP} formatter={(v: number, _n, item) => [`${v >= 0 ? "+" : ""}${v}% · закрыто ${(item?.payload as { n?: number })?.n ?? 0}`, "За день"]} />
                  <Bar dataKey="v" maxBarSize={28} radius={[3, 3, 0, 0]} isAnimationActive={false} cursor="pointer" onClick={(e: { payload?: { key?: string; n?: number } }) => { if (e?.payload?.key && e.payload.n) openDay(e.payload.key); }}>{daily.map((d, i) => <Cell key={i} fill={d.v >= 0 ? GOLD : "#e2445c"} />)}</Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      </div>
      <p className="-mt-2 text-xs text-muted-foreground">Оба графика — по дню закрытия сделки (Дубай), каждый день периода; день без закрытий = 0.</p>

      {/* Owner 2026-11-14: «Сколько держались» removed, the day archive takes the whole width. */}
      <DayArchive closed={data.closed} openDay={openDay} />

      <Card title="По месяцам открытия (Дубай)">
        <SortTable<MonthRow> cols={monthCols} rows={monthRows} rowKey={(r) => r.month} initial={{ col: "Месяц", desc: true }}
          onRow={(r) => setOpenMonth(openMonth === r.month ? null : r.month)} empty="Сигналов пока нет."
          card={(r) => (
            <div className="flex items-center justify-between">
              <div><div className="capitalize text-sm">{monthName(r.month)}</div><div className="text-[11px] text-muted-foreground">{r.signals} сигналов · закрыто {r.n} · открыто {r.open} · винрейт {winRate(r)}</div></div>
              <div className={`text-lg font-semibold tabular-nums ${tone(r.sum)}`}>{signed(r.sum, 1)}</div>
            </div>
          )} />
        <p className="mt-2 text-xs text-muted-foreground">Нажми на месяц — ниже откроется список всех позиций, открытых в этом месяце. Сумма, винрейт и среднее — по закрытым из них.</p>
        {shownMonth && (
          <div className="mt-4 border-t border-border/70 pt-3">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm capitalize text-gold">Позиции, открытые: {monthName(shownMonth.month)} · {shownMonth.signals}</h3>
              <button onClick={() => setOpenMonth(null)} className="text-xs text-muted-foreground hover:text-gold">Скрыть</button>
            </div>
            <SortTable<Signal> cols={posCols} rows={shownMonth.rows} rowKey={(s) => s.id} initial={{ col: "Открыта", desc: true }}
              card={(s) => { const v = s.closedAt ? res(s) : liveMove(s, last); return (
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-sm">{label(s.patternKey)}</div>
                    <div className="text-[11px] text-muted-foreground">{dir(s.direction)} · открыта {time(s.detectedAt)} · {s.closedAt ? `закрыта ${time(s.closedAt)} · была активна ${duration(heldMs(s))} · ${REASON[s.closeReason ?? ""] ?? "—"}` : `активна ${duration(heldMs(s))} (сейчас)`}</div>
                  </div>
                  <div className={`text-lg font-semibold tabular-nums ${tone(v)}`}>{signed(v)}</div>
                </div>
              ); }} />
          </div>
        )}
      </Card>
      <p className="text-center text-xs text-muted-foreground">Все результаты — чистое движение цены от входа в сторону сделки: без плеча и комиссий.</p>
    </div>
  );
}
