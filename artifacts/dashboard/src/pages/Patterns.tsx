import { STYLE_LABEL, type Pattern, type Signal, type Style, dir, num, signed, tone } from "../lib/api";
import { type Data, type Filter, type Mode, type Period, type Tab, inPeriod, styleOf, summarize } from "../lib/data";
import { Card, type Col, Pill, SortTable } from "../components/ui";

const count = (xs: Signal[], reason: string) => xs.filter((s) => s.closeReason === reason).length;

/** Every pattern of the chosen mode with its results, grouped by style (scalp / intraday / swing); every column sorts. */
export function Patterns({ data, period, mode, go }: { data: Data; period: Period; mode: Mode; go: (t: Tab, f?: Partial<Filter>) => void }) {
  const all = data.status?.patterns ?? [];
  const patterns = all.filter((p) => (mode === "live") === p.live);
  const closed = inPeriod(data.closed, period);
  const xsOf = (p: Pattern) => closed.filter((s) => s.patternKey === p.key);
  const sm = (p: Pattern) => summarize(xsOf(p));
  const avg = (p: Pattern, f: (s: Signal) => number) => { const xs = xsOf(p); return xs.length ? xs.reduce((a, s) => a + f(s), 0) / xs.length : null; };
  const cols: Col<Pattern>[] = [
    { head: "Паттерн", cell: (p) => <span className="text-foreground">{p.label}</span>, sort: (p) => p.label },
    { head: "Напр.", cell: (p) => <Pill kind={p.direction === "long" ? "long" : "short"}>{dir(p.direction)}</Pill>, sort: (p) => p.direction },
    { head: "ТФ", cell: (p) => p.tf ?? "—", sort: (p) => p.tf ?? "" },
    { head: "Закрыто", cell: (p) => sm(p).n, sort: (p) => sm(p).n },
    { head: "Открыто", cell: (p) => data.open.filter((s) => s.patternKey === p.key).length, sort: (p) => data.open.filter((s) => s.patternKey === p.key).length },
    { head: "Винрейт", cell: (p) => { const w = sm(p).winRate; return w == null ? "—" : `${num(w, 0)}%`; }, sort: (p) => sm(p).winRate },
    { head: "Среднее", cell: (p) => <span className={tone(sm(p).avg)}>{signed(sm(p).avg)}</span>, sort: (p) => sm(p).avg },
    { head: "Сумма", cell: (p) => <span className={`font-medium ${tone(sm(p).sum)}`}>{signed(sm(p).sum, 1)}</span>, sort: (p) => sm(p).sum },
    { head: "Лучшая", cell: (p) => signed(sm(p).best), sort: (p) => sm(p).best },
    { head: "Худшая", cell: (p) => signed(sm(p).worst), sort: (p) => sm(p).worst },
    { head: "Цели", cell: (p) => count(xsOf(p), "take_profit"), sort: (p) => count(xsOf(p), "take_profit") },
    { head: "Стоп", cell: (p) => count(xsOf(p), "stop"), sort: (p) => count(xsOf(p), "stop") },
    { head: "Б/У", cell: (p) => count(xsOf(p), "breakeven"), sort: (p) => count(xsOf(p), "breakeven") },
    { head: "Время", cell: (p) => count(xsOf(p), "timeout"), sort: (p) => count(xsOf(p), "timeout") },
    { head: "Макс. в плюс", cell: (p) => signed(avg(p, (s) => s.mfePct)), sort: (p) => avg(p, (s) => s.mfePct) },
    { head: "Макс. в минус", cell: (p) => signed(avg(p, (s) => s.maePct)), sort: (p) => avg(p, (s) => s.maePct) },
  ];
  return (
    <div className="space-y-4">
      {(["scalp", "intraday", "swing"] as Style[]).map((st) => {
        const list = patterns.filter((p) => styleOf(all, p.key) === st);
        if (!list.length) return null;
        return (
          <Card key={st} title={`${STYLE_LABEL[st]} · ${list.length} паттернов`}>
            <SortTable<Pattern> cols={cols} rows={list} rowKey={(p) => p.key} initial={{ col: "Сумма", desc: true }}
              onRow={(p) => go("history", { pattern: p.key })}
              card={(p) => { const m = sm(p); return (
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-foreground">{p.label}</div>
                    <div className="mt-1 text-[11px] text-muted-foreground">{dir(p.direction)} · {p.tf} · закрыто {m.n} · винрейт {m.winRate == null ? "—" : `${num(m.winRate, 0)}%`} · среднее {signed(m.avg)}</div>
                  </div>
                  <div className={`text-lg font-semibold tabular-nums ${tone(m.sum)}`}>{signed(m.sum, 1)}</div>
                </div>
              ); }} />
          </Card>
        );
      })}
      {patterns.length === 0 && <Card title="Паттерны"><p className="text-sm text-muted-foreground">В этом режиме паттернов нет.</p></Card>}
      <p className="text-center text-xs text-muted-foreground">Сортировка — нажми на заголовок столбца. Нажми на паттерн — его сделки в истории. Среднее и сумма — чистое движение цены, без плеча и комиссий.</p>
    </div>
  );
}
