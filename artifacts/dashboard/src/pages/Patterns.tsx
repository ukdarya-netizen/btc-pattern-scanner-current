import { STYLE_LABEL, type Signal, type Style, dir, num, signed, tone } from "../lib/api";
import { type Data, type Filter, type Mode, type Tab, inPeriod, styleOf, summarize } from "../lib/data";
import { Card, Pill, Table } from "../components/ui";

const count = (xs: Signal[], reason: string) => xs.filter((s) => s.closeReason === reason).length;

/** Every pattern of the chosen mode with its results, grouped by style (scalp / intraday / swing). */
export function Patterns({ data, days, mode, label, go }: { data: Data; days: number; mode: Mode; label: (k: string) => string; go: (t: Tab, f?: Partial<Filter>) => void }) {
  const patterns = (data.status?.patterns ?? []).filter((p) => (mode === "live") === p.live);
  const closed = inPeriod(data.closed, days);
  return (
    <div className="space-y-4">
      {(["scalp", "intraday", "swing"] as Style[]).map((st) => {
        const list = patterns.filter((p) => styleOf(patterns, p.key) === st);
        if (!list.length) return null;
        return (
          <Card key={st} title={`${STYLE_LABEL[st]} · ${list.length} паттернов`}>
            <Table
              head={["Паттерн", "Напр.", "Закрыто", "Открыто", "Винрейт", "Среднее движение", "Сумма", "Цели / Стоп / Б/У / Время", "Макс. в плюс", "Макс. в минус"]}
              rows={list.map((p) => {
                const xs = closed.filter((s) => s.patternKey === p.key);
                const sm = summarize(xs);
                const avg = (f: (s: Signal) => number) => (xs.length ? xs.reduce((a, s) => a + f(s), 0) / xs.length : null);
                return [
                  <span className="text-foreground">{p.label}</span>,
                  <Pill kind={p.direction === "long" ? "long" : "short"}>{dir(p.direction)}</Pill>,
                  sm.n, data.open.filter((s) => s.patternKey === p.key).length,
                  sm.winRate == null ? "—" : `${num(sm.winRate, 0)}%`,
                  <span className={tone(sm.avg)}>{signed(sm.avg)}</span>,
                  <span className={`font-medium ${tone(sm.sum)}`}>{signed(sm.sum, 1)}</span>,
                  `${count(xs, "take_profit")} / ${count(xs, "stop")} / ${count(xs, "breakeven")} / ${count(xs, "timeout")}`,
                  signed(avg((s) => s.mfePct)), signed(avg((s) => s.maePct)),
                ];
              })}
              onRow={(i) => go("history", { pattern: list[i]!.key })}
            />
          </Card>
        );
      })}
      {patterns.length === 0 && <Card title="Паттерны"><p className="text-sm text-muted-foreground">В этом режиме паттернов нет.</p></Card>}
      <p className="text-center text-xs text-muted-foreground">Нажми на паттерн — его сделки в истории. Движение — чистое, без плеча и комиссий. Сейчас показан режим «{mode === "live" ? "Канал" : "Тень"}».</p>
    </div>
  );
}
