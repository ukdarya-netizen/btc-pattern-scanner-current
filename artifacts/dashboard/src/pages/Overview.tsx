import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { REASON, STYLE_LABEL, type Signal, type Style, asset, duration, heldMs, liveMove, num, price, signed, tone } from "../lib/api";
import { type Data, type Filter, type Mode, NO_FILTER, type Tab, inPeriod, res, styleOf, summarize } from "../lib/data";
import { Card, Crown, Table, Tile } from "../components/ui";

const GOLD = "#f2b10f";
const AXIS = { stroke: "#8a7d63", fontSize: 11 };
const TIP = { contentStyle: { background: "#120f0a", border: "1px solid #5a4417", borderRadius: 8 }, labelStyle: { color: "#d8c9a6" } };
const dubaiDay = (iso: string) => new Date(iso).toLocaleDateString("ru-RU", { timeZone: "Asia/Dubai", day: "2-digit", month: "2-digit" });

/** Holding time buckets — the full spread, not a median (owner rule). */
const BUCKETS: Array<[string, number]> = [["до 4 ч", 4], ["4–12 ч", 12], ["12–24 ч", 24], ["1–3 д", 72], ["3–7 д", 168], ["больше 7 д", Infinity]];

export function Overview({ data, days, mode, go }: { data: Data; days: number; mode: Mode; go: (t: Tab, f?: Partial<Filter>) => void }) {
  const last = data.status?.stream.lastPrice ?? null;
  const patterns = data.status?.patterns ?? [];
  const closed = inPeriod(data.closed, days);
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
  const reasons = new Map<string, Signal[]>();
  for (const s of closed) { const k = s.closeReason ?? "—"; reasons.set(k, [...(reasons.get(k) ?? []), s]); }
  const winRate = (s: { winRate: number | null }) => (s.winRate == null ? "—" : `${num(s.winRate, 0)}%`);

  return (
    <div className="space-y-4">
      <section className="hero relative overflow-hidden rounded-2xl border border-gold/30">
        <img src={asset("brand/hero.webp")} alt="" className="absolute inset-0 h-full w-full object-cover object-[center_72%]" />
        <div className="absolute inset-0 bg-gradient-to-r from-black via-black/70 to-transparent" />
        <div className="relative flex min-h-[220px] flex-col justify-end gap-3 p-6 md:min-h-[260px] md:w-3/5">
          <div className="flex items-center gap-2 text-gold"><Crown className="h-6 w-8" /><span className="text-xs uppercase tracking-[0.3em]">BTC Bullet</span></div>
          <h1 className="brand-title text-4xl leading-none md:text-6xl">Bitcoin<br /><span className="text-3xl md:text-4xl">Margin Master</span></h1>
          <p className="text-xs uppercase tracking-[0.35em] text-gold/80">Discipline · Leverage · Freedom</p>
          <div className="flex flex-wrap items-end gap-6 pt-1">
            <div><div className="text-[10px] uppercase tracking-widest text-muted-foreground">BTC-USDT</div><div className="text-3xl font-semibold tabular-nums text-white">{price(last)}</div></div>
            <div><div className="text-[10px] uppercase tracking-widest text-muted-foreground">{mode === "live" ? "Открыто в канале" : "Открыто в тени"}</div><div className={`text-xl font-semibold tabular-nums ${tone(openMove)}`}>{data.open.length} · {signed(openMove)}</div></div>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Сделок закрыто" value={all.n} sub={`в плюсе ${all.wins} · открыто ${data.open.length}`} onClick={() => go("history", NO_FILTER)} />
        <Tile label="Винрейт" value={winRate(all)} sub="закрытые с движением в плюс" onClick={() => go("history", { result: "win" })} />
        <Tile label="Движение, сумма" value={signed(all.sum, 1)} tone={tone(all.sum)} sub="сумма % по всем сделкам" />
        <Tile label="Движение, в среднем" value={signed(all.avg)} tone={tone(all.avg)} sub="на одну сделку" />
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
        <Card title="Как закрывались">
          <Table head={["Причина", "Сделок", "Среднее движение", "Сумма"]}
            rows={[...reasons].map(([k, xs]) => { const s = summarize(xs); return [REASON[k] ?? k, s.n, <span className={tone(s.avg)}>{signed(s.avg)}</span>, <span className={tone(s.sum)}>{signed(s.sum, 1)}</span>]; })} />
        </Card>
      </div>
      <p className="text-center text-xs text-muted-foreground">Все результаты — чистое движение цены от входа в сторону сделки: без плеча и комиссий.</p>
    </div>
  );
}
