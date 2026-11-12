import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { REASON, asset, dir, duration, heldMs, liveResult, num, price, signed, tone } from "../lib/api";
import { type Data, type Filter, NO_FILTER, type Tab, inPeriod, summarize } from "../lib/data";
import { Card, Crown, Table, Tile } from "../components/ui";

const GOLD = "#f2b10f";
const AXIS = { stroke: "#8a7d63", fontSize: 11 };
const TIP = { contentStyle: { background: "#120f0a", border: "1px solid #5a4417", borderRadius: 8 }, labelStyle: { color: "#d8c9a6" } };

/** Holding time buckets — the full spread, not a median (owner rule). */
const BUCKETS: Array<[string, number]> = [["до 4 ч", 4], ["4–12 ч", 12], ["12–24 ч", 24], ["1–3 д", 72], ["3–7 д", 168], ["больше 7 д", Infinity]];

export function Overview({ data, days, label, go }: { data: Data; days: number; label: (k: string) => string; go: (t: Tab, f?: Partial<Filter>) => void }) {
  const last = data.status?.stream.lastPrice ?? null;
  const closed = inPeriod(data.closed, days);
  const all = summarize(closed);
  const longs = summarize(closed.filter((s) => s.direction === "long"));
  const shorts = summarize(closed.filter((s) => s.direction === "short"));
  const h4 = summarize(closed.filter((s) => s.profile === "h4"));
  const d1 = summarize(closed.filter((s) => s.profile === "d1"));
  const openNow = data.open.map((s) => liveResult(s, last).margin ?? 0);
  const openSum = openNow.reduce((a, b) => a + b, 0);

  // Equity curve: cumulative result to margin over closed trades in closing order.
  let acc = 0;
  const equity = [...closed].filter((s) => s.closedAt).sort((a, b) => Date.parse(a.closedAt!) - Date.parse(b.closedAt!))
    .map((s) => ({ t: new Date(s.closedAt!).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" }), v: Number((acc += s.pnlMarginPct ?? 0).toFixed(2)) }));

  const dayMap = new Map<string, number>();
  for (const r of data.daily) dayMap.set(r.day, (dayMap.get(r.day) ?? 0) + r.sumPnlMarginPct);
  const daily = [...dayMap].sort().map(([day, pnl]) => ({ day: day.slice(5), pnl: Number(pnl.toFixed(2)) }));

  const buckets = BUCKETS.map(([name, maxH], i) => {
    const minH = i ? BUCKETS[i - 1]![1] : 0;
    const xs = closed.filter((s) => { const h = heldMs(s) / 3_600_000; return h >= minH && h < maxH; });
    const sm = summarize(xs);
    return { name, n: xs.length, avg: sm.avg, winRate: sm.winRate };
  });
  const holds = closed.map((s) => heldMs(s)).sort((a, b) => a - b);

  const reasons = new Map<string, { n: number; sum: number }>();
  for (const s of closed) { const k = s.closeReason ?? "—"; const r = reasons.get(k) ?? { n: 0, sum: 0 }; r.n++; r.sum += s.pnlMarginPct ?? 0; reasons.set(k, r); }

  const byPattern = new Map<string, ReturnType<typeof summarize>>();
  for (const key of new Set(closed.map((s) => s.patternKey))) byPattern.set(key, summarize(closed.filter((s) => s.patternKey === key)));
  const top = [...byPattern].sort((a, b) => b[1].sum - a[1].sum);

  return (
    <div className="space-y-4">
      <section className="hero relative overflow-hidden rounded-2xl border border-gold/30">
        <img src={asset("brand/hero.webp")} alt="" className="absolute inset-0 h-full w-full object-cover object-[center_72%]" />
        <div className="absolute inset-0 bg-gradient-to-r from-black via-black/70 to-transparent" />
        <div className="relative flex min-h-[220px] flex-col justify-end gap-3 p-6 md:min-h-[280px] md:w-3/5">
          <div className="flex items-center gap-2 text-gold"><Crown className="h-6 w-8" /><span className="text-xs uppercase tracking-[0.3em]">BTC Bullet</span></div>
          <h1 className="brand-title text-4xl leading-none md:text-6xl">Bitcoin<br /><span className="text-white/90 text-3xl md:text-4xl">Margin Master</span></h1>
          <p className="text-xs uppercase tracking-[0.35em] text-gold/80">Discipline · Leverage · Freedom</p>
          <div className="flex flex-wrap items-end gap-6 pt-2">
            <div><div className="text-[10px] uppercase tracking-widest text-muted-foreground">BTC-USDT</div><div className="text-3xl font-semibold tabular-nums text-white">{price(last)}</div></div>
            <div><div className="text-[10px] uppercase tracking-widest text-muted-foreground">Открыто сейчас</div><div className={`text-xl font-semibold tabular-nums ${tone(openSum)}`}>{data.open.length} · {signed(openSum)}</div></div>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <Tile label="Активных" value={data.open.length} sub="все открытые" onClick={() => go("positions")} />
        <Tile label="Закрыто" value={all.n} sub={`в плюсе ${all.wins}`} onClick={() => go("history", NO_FILTER)} />
        <Tile label="Винрейт" value={all.winRate == null ? "—" : `${num(all.winRate, 0)}%`} sub="закрытые в плюсе" onClick={() => go("history", { result: "win" })} />
        <Tile label="Сумма к марже" value={signed(all.sum, 1)} tone={tone(all.sum)} sub={`средняя ${signed(all.avg)}`} />
        <Tile label="Лонги" value={signed(longs.sum, 1)} tone={tone(longs.sum)} sub={`${longs.n} · винрейт ${longs.winRate == null ? "—" : num(longs.winRate, 0) + "%"}`} onClick={() => go("history", { direction: "long" })} />
        <Tile label="Шорты" value={signed(shorts.sum, 1)} tone={tone(shorts.sum)} sub={`${shorts.n} · винрейт ${shorts.winRate == null ? "—" : num(shorts.winRate, 0) + "%"}`} onClick={() => go("history", { direction: "short" })} />
        <Tile label="4H · x20" value={signed(h4.sum, 1)} tone={tone(h4.sum)} sub={`${h4.n} сделок`} onClick={() => go("history", { profile: "h4" })} />
        <Tile label="1D · x10" value={signed(d1.sum, 1)} tone={tone(d1.sum)} sub={`${d1.n} сделок`} onClick={() => go("history", { profile: "d1" })} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Кривая результата, % к марже">
          {equity.length === 0 ? <p className="text-sm text-muted-foreground">Закрытых сделок пока нет.</p> : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={equity}>
                  <defs><linearGradient id="eq" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={GOLD} stopOpacity={0.45} /><stop offset="100%" stopColor={GOLD} stopOpacity={0} /></linearGradient></defs>
                  <CartesianGrid stroke="#2a2214" vertical={false} />
                  <XAxis dataKey="t" {...AXIS} minTickGap={24} />
                  <YAxis {...AXIS} />
                  <ReferenceLine y={0} stroke="#5a4417" />
                  <Tooltip {...TIP} formatter={(v: number) => [`${v >= 0 ? "+" : ""}${v}%`, "Итог"]} />
                  <Area type="monotone" dataKey="v" stroke={GOLD} strokeWidth={2} fill="url(#eq)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
        <Card title="По дням, % к марже (30 дней)">
          {daily.length === 0 ? <p className="text-sm text-muted-foreground">Закрытых сделок пока нет.</p> : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={daily}>
                  <CartesianGrid stroke="#2a2214" vertical={false} />
                  <XAxis dataKey="day" {...AXIS} />
                  <YAxis {...AXIS} />
                  <Tooltip {...TIP} formatter={(v: number) => [`${v >= 0 ? "+" : ""}${v}%`, "Сумма"]} />
                  <Bar dataKey="pnl" radius={[3, 3, 0, 0]}>{daily.map((d) => <Cell key={d.day} fill={d.pnl >= 0 ? GOLD : "#e2445c"} />)}</Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Сколько держались">
          <p className="mb-2 text-xs text-muted-foreground">Разброс: {holds.length ? `${duration(holds[0]!)} … ${duration(holds.at(-1)!)}` : "—"}</p>
          <Table head={["Время в сделке", "Сделок", "Средний итог", "Винрейт"]}
            rows={buckets.map((b) => [b.name, b.n, <span className={tone(b.avg)}>{signed(b.avg)}</span>, b.winRate == null ? "—" : `${num(b.winRate, 0)}%`])} />
        </Card>
        <Card title="Как закрывались">
          <Table head={["Причина", "Сделок", "Сумма к марже"]}
            rows={[...reasons].map(([k, r]) => [REASON[k] ?? k, r.n, <span className={tone(r.sum)}>{signed(r.sum, 1)}</span>])} />
        </Card>
        <Card title="Паттерны">
          <Table head={["Паттерн", "Сделок", "Винрейт", "Сумма"]}
            rows={top.map(([k, s]) => [<span className="text-foreground">{label(k)}</span>, s.n, s.winRate == null ? "—" : `${num(s.winRate, 0)}%`, <span className={tone(s.sum)}>{signed(s.sum, 1)}</span>])}
            onRow={(i) => go("history", { pattern: top[i]![0] })} />
        </Card>
      </div>

      {data.open.length > 0 && (
        <Card title="Открытые сейчас" right={<button className="text-xs text-gold hover:underline" onClick={() => go("positions")}>все позиции →</button>}>
          <Table head={["Паттерн", "Напр.", "Вход", "К марже", "Держится"]}
            rows={data.open.slice(0, 6).map((s) => { const r = liveResult(s, last); return [label(s.patternKey), dir(s.direction), price(s.entryPrice), <span className={tone(r.margin)}>{signed(r.margin)}</span>, duration(heldMs(s))]; })}
            onRow={() => go("positions")} />
        </Card>
      )}
    </div>
  );
}
