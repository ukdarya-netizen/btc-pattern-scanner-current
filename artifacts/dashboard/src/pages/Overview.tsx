import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { STYLE_LABEL, type Signal, type Style, asset, duration, heldMs, liveMove, num, price, signed, tone } from "../lib/api";
import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { type Data, type Filter, type Mode, NO_FILTER, type Period, type Tab, dubaiDayKey, dubaiMonth, inPeriod, monthName, res, styleOf, summarize } from "../lib/data";
import { Card, type Col, Crown, SortTable, Table, Tile } from "../components/ui";
import { MarketPanel } from "../components/MarketPanel";

const GOLD = "#f2b10f";
const AXIS = { stroke: "#8a7d63", fontSize: 11 };
const TIP = { contentStyle: { background: "#120f0a", border: "1px solid #5a4417", borderRadius: 8 }, labelStyle: { color: "#d8c9a6" } };
const dubaiDay = (iso: string) => new Date(iso).toLocaleDateString("ru-RU", { timeZone: "Asia/Dubai", day: "2-digit", month: "2-digit" });

/** Holding time buckets — the full spread, not a median (owner rule). */
const BUCKETS: Array<[string, number]> = [["до 4 ч", 4], ["4–12 ч", 12], ["12–24 ч", 24], ["1–3 д", 72], ["3–7 д", 168], ["больше 7 д", Infinity]];

const OUTCOMES: Array<{ reason: Filter["reason"]; label: string; tone: string }> = [
  { reason: "take_profit", label: "Цели", tone: "text-emerald-400" },
  { reason: "breakeven", label: "Безубыток", tone: "text-sky-300" },
  { reason: "stop", label: "Стоп", tone: "text-rose-400" },
  { reason: "timeout", label: "По времени", tone: "text-amber-300" },
];
const WEEK = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];

/** Month calendar of the daily result by close day (Dubai), as CAB «Архив статистики» / Nihilist «Архив по дням». */
function DayArchive({ closed }: { closed: Signal[] }) {
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
            <div key={key} className={`min-h-14 rounded-md border p-1 text-left ${xs.length ? (sum >= 0 ? "border-emerald-500/30 bg-emerald-500/5" : "border-rose-500/30 bg-rose-500/5") : "border-border/50"}`}>
              <div className="text-[10px] text-muted-foreground">{d}</div>
              {xs.length > 0 && <div className={`text-xs font-semibold tabular-nums ${tone(sum)}`}>{signed(sum, 1)}</div>}
              {xs.length > 0 && <div className="text-[10px] text-muted-foreground">{xs.length} сд.</div>}
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">За месяц: {ms.n} сделок · {signed(ms.sum, 1)} · винрейт {ms.winRate == null ? "—" : `${num(ms.winRate, 0)}%`}</p>
    </Card>
  );
}

type MonthRow = { month: string } & ReturnType<typeof summarize>;

export function Overview({ data, period, setPeriod, mode, go }: { data: Data; period: Period; setPeriod: (p: Period) => void; mode: Mode; go: (t: Tab, f?: Partial<Filter>) => void }) {
  const last = data.status?.stream.lastPrice ?? null;
  const patterns = data.status?.patterns ?? [];
  const closed = inPeriod(data.closed, period);
  const all = summarize(closed);
  const side = (d: string) => summarize(closed.filter((s) => s.direction === d));
  const style = (st: Style) => summarize(closed.filter((s) => styleOf(patterns, s.patternKey) === st));
  const openMove = data.open.map((s) => liveMove(s, last) ?? 0).reduce((a, b) => a + b, 0);

  const byClose = [...closed].filter((s) => s.closedAt).sort((a, b) => Date.parse(a.closedAt!) - Date.parse(b.closedAt!));
  let acc = 0;
  const equity = byClose.map((s) => ({ t: dubaiDay(s.closedAt!), v: Number((acc += res(s)).toFixed(2)) }));
  const dayMap = new Map<string, number>();
  for (const s of byClose) { const d = dubaiDay(s.closedAt!); dayMap.set(d, (dayMap.get(d) ?? 0) + res(s)); }
  const daily = [...dayMap].map(([day, v]) => ({ day, v: Number(v.toFixed(2)) }));

  const holds = closed.map((s) => heldMs(s)).sort((a, b) => a - b);
  const buckets = BUCKETS.map(([name, maxH], i) => {
    const minH = i ? BUCKETS[i - 1]![1] : 0;
    const sm = summarize(closed.filter((s) => { const h = heldMs(s) / 3_600_000; return h >= minH && h < maxH; }));
    return { name, ...sm };
  });
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
  // Statistics by month (all closed trades of the mode, Dubai months); a row sets the period.
  const months = new Map<string, Signal[]>();
  for (const s of data.closed) if (s.closedAt) { const k = dubaiMonth(s.closedAt); months.set(k, [...(months.get(k) ?? []), s]); }
  const monthRows: MonthRow[] = [...months].map(([month, xs]) => ({ month, ...summarize(xs) }));
  const monthCols: Col<MonthRow>[] = [
    { head: "Месяц", cell: (r) => <span className="capitalize text-foreground">{monthName(r.month)}</span>, sort: (r) => r.month },
    { head: "Сделок", cell: (r) => r.n, sort: (r) => r.n },
    { head: "Винрейт", cell: (r) => winRate(r), sort: (r) => r.winRate },
    { head: "Сумма", cell: (r) => <span className={`font-medium ${tone(r.sum)}`}>{signed(r.sum, 1)}</span>, sort: (r) => r.sum },
    { head: "Среднее", cell: (r) => <span className={tone(r.avg)}>{signed(r.avg)}</span>, sort: (r) => r.avg },
    { head: "Лучшая", cell: (r) => signed(r.best), sort: (r) => r.best },
    { head: "Худшая", cell: (r) => signed(r.worst), sort: (r) => r.worst },
  ];

  return (
    <div className="space-y-4">
      <MarketPanel />
      <section className="hero relative overflow-hidden rounded-2xl border border-gold/30">
        <img src={asset("brand/hero.webp")} alt="" className="absolute inset-0 h-full w-full object-cover object-[center_72%]" />
        <div className="absolute inset-0 bg-gradient-to-r from-black via-black/70 to-transparent" />
        <div className="relative flex min-h-[220px] flex-col justify-end gap-3 p-6 md:min-h-[260px] md:w-3/5">
          <div className="flex items-center gap-2 text-gold"><Crown className="h-6 w-8" /><span className="text-xs uppercase tracking-[0.3em]">BTC-USDT · Long · Short</span></div>
          <h1 className="brand-title text-4xl leading-none md:text-6xl">Bitcoin<br /><span className="text-3xl md:text-4xl">Margin Master</span></h1>
          <p className="text-xs uppercase tracking-[0.35em] text-gold/80">Discipline · Leverage · Freedom</p>
          <div className="flex flex-wrap items-end gap-6 pt-1">
            <div><div className="text-[10px] uppercase tracking-widest text-muted-foreground">BTC-USDT</div><div className="text-3xl font-semibold tabular-nums text-white">{price(last)}</div></div>
            <div><div className="text-[10px] uppercase tracking-widest text-muted-foreground">{mode === "live" ? "Открыто в канале" : "Открыто в тени"}</div><div className={`text-xl font-semibold tabular-nums ${tone(openMove)}`}>{data.open.length} · {signed(openMove)}</div></div>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Сигналов сегодня" value={todayN} sub="открыто за день (Дубай)" />
        <Tile label="Всего сигналов" value={allSignals.length} sub={`закрыто ${data.closed.length}`} />
        <Tile label="Открыто сейчас" value={data.open.length} sub="все позиции" onClick={() => go("positions")} />
        <Tile label="Время в сделке" value={holds.length ? `${duration(holds[0]!)} – ${duration(holds.at(-1)!)}` : "—"} sub="от сигнала до закрытия" />
      </div>

      <section className="gold-card p-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-widest text-muted-foreground">Счётчик — чистое движение цены</p>
            <p className={`mt-1 text-4xl font-semibold tabular-nums ${tone(all.sum)}`}>{signed(all.sum, 2)}</p>
            <p className="mt-1 text-xs text-muted-foreground">{all.n} закрытых сделок · в среднем {signed(all.avg)} · без плеча и комиссий</p>
          </div>
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            {OUTCOMES.map((o) => { const sm = summarize(closed.filter((s) => s.closeReason === o.reason)); return (
              <button key={o.reason} onClick={() => go("history", { reason: o.reason })} className="rounded-lg border border-border px-3 py-2 text-left hover:border-gold/50">
                <div className={`text-xs ${o.tone}`}>{o.label}</div>
                <div className="text-lg font-semibold tabular-nums">{sm.n}</div>
                <div className={`text-xs tabular-nums ${tone(sm.sum)}`}>{signed(sm.sum, 1)}</div>
              </button>
            ); })}
          </div>
        </div>
      </section>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Винрейт" value={winRate(all)} sub="(цели + безубыток) / (цели + безубыток + стоп)" onClick={() => go("history", { result: "win" })} />
        <Tile label="В плюсе" value={all.wins} sub={`из ${all.n} закрытых`} onClick={() => go("history", { result: "win" })} />
        <Tile label="Лучшая сделка" value={best ? signed(res(best)) : "—"} tone="text-emerald-400" sub={best ? `${label(best.patternKey)}` : "—"} />
        <Tile label="Средний пик" value={signed(avgPeak, 1)} sub={`до +1%: ${reached(1)} · до +2%: ${reached(2)} · до +5%: ${reached(5)}`} />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {(["long", "short"] as const).map((d) => { const s = side(d); return (
          <Tile key={d} label={d === "long" ? "Лонги" : "Шорты"} value={signed(s.sum, 1)} tone={tone(s.sum)} sub={`${s.n} · винрейт ${winRate(s)}`} onClick={() => go("history", { direction: d })} />
        ); })}
        {(["scalp", "intraday", "swing"] as const).map((st) => { const s = style(st); return (
          <Tile key={st} label={STYLE_LABEL[st]} value={signed(s.sum, 1)} tone={tone(s.sum)} sub={`${s.n} · винрейт ${winRate(s)}`} onClick={() => go("history", { style: st })} />
        ); })}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Накопленное движение, %">
          {equity.length === 0 ? <p className="text-sm text-muted-foreground">Закрытых сделок пока нет.</p> : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={equity}>
                  <defs><linearGradient id="eq" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={GOLD} stopOpacity={0.45} /><stop offset="100%" stopColor={GOLD} stopOpacity={0} /></linearGradient></defs>
                  <CartesianGrid stroke="#2a2214" vertical={false} />
                  <XAxis dataKey="t" {...AXIS} minTickGap={24} />
                  <YAxis {...AXIS} unit="%" />
                  <ReferenceLine y={0} stroke="#5a4417" />
                  <Tooltip {...TIP} formatter={(v: number) => [`${v >= 0 ? "+" : ""}${v}%`, "Накоплено"]} />
                  <Area type="monotone" dataKey="v" stroke={GOLD} strokeWidth={2} fill="url(#eq)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
        <Card title="Движение по дням, % (Дубай)">
          {daily.length === 0 ? <p className="text-sm text-muted-foreground">Закрытых сделок пока нет.</p> : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={daily}>
                  <CartesianGrid stroke="#2a2214" vertical={false} />
                  <XAxis dataKey="day" {...AXIS} />
                  <YAxis {...AXIS} unit="%" />
                  <Tooltip {...TIP} formatter={(v: number) => [`${v >= 0 ? "+" : ""}${v}%`, "За день"]} />
                  <Bar dataKey="v" radius={[3, 3, 0, 0]}>{daily.map((d) => <Cell key={d.day} fill={d.v >= 0 ? GOLD : "#e2445c"} />)}</Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Сколько держались">
          <p className="mb-2 text-xs text-muted-foreground">Разброс: {holds.length ? `${duration(holds[0]!)} … ${duration(holds.at(-1)!)}` : "—"}</p>
          <Table head={["Время в сделке", "Сделок", "Среднее движение", "Винрейт"]}
            rows={buckets.map((b) => [b.name, b.n, <span className={tone(b.avg)}>{signed(b.avg)}</span>, winRate(b)])} />
        </Card>
        <DayArchive closed={data.closed} />
      </div>

      <Card title="По месяцам (Дубай)">
        <SortTable<MonthRow> cols={monthCols} rows={monthRows} rowKey={(r) => r.month} initial={{ col: "Месяц", desc: true }}
          onRow={(r) => setPeriod(r.month)} empty="Закрытых сделок пока нет."
          card={(r) => (
            <div className="flex items-center justify-between">
              <div><div className="capitalize text-sm">{monthName(r.month)}</div><div className="text-[11px] text-muted-foreground">{r.n} сделок · винрейт {winRate(r)} · среднее {signed(r.avg)}</div></div>
              <div className={`text-lg font-semibold tabular-nums ${tone(r.sum)}`}>{signed(r.sum, 1)}</div>
            </div>
          )} />
        <p className="mt-2 text-xs text-muted-foreground">Нажми на месяц — вся статистика, история и паттерны переключатся на него.</p>
      </Card>
      <p className="text-center text-xs text-muted-foreground">Все результаты — чистое движение цены от входа в сторону сделки: без плеча и комиссий.</p>
    </div>
  );
}
