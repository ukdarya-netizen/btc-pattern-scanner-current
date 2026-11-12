import { PROFILE, dir, num, signed, tone } from "../lib/api";
import type { Data, Filter, Tab } from "../lib/data";
import { Card, Pill, Table } from "../components/ui";

const hold = (ms: number) => `${Math.round(ms / 86_400_000)} д`;

/** Statistics per pattern and the rules of every trade type (profile) with its patterns. */
export function Patterns({ data, label, go }: { data: Data; label: (k: string) => string; go: (t: Tab, f?: Partial<Filter>) => void }) {
  const profiles = Object.values(data.status?.profiles ?? {});
  const patterns = data.status?.patterns ?? [];
  return (
    <div className="space-y-4">
      <Card title="Статистика по паттернам">
        <Table
          head={["Паттерн", "Тип", "Напр.", "Режим", "Закрыто", "Открыто", "Винрейт", "Ср. к марже", "Сумма к марже", "Ср. цена", "Цели / Стоп / Б/У / Время", "MFE", "MAE"]}
          rows={data.stats.map((r) => [
            <span className="text-foreground">{label(r.patternKey)}</span>, PROFILE[r.profile] ?? r.profile,
            <Pill kind={r.direction === "long" ? "long" : "short"}>{dir(r.direction)}</Pill>, r.live ? "канал" : "тень",
            r.closed, r.open, r.winRatePct == null ? "—" : `${num(r.winRatePct, 1)}%`,
            <span className={tone(r.avgPnlMarginPct)}>{signed(r.avgPnlMarginPct)}</span>,
            <span className={`font-medium ${tone(r.sumPnlMarginPct)}`}>{signed(r.sumPnlMarginPct)}</span>,
            <span className={tone(r.avgPnlPricePct)}>{signed(r.avgPnlPricePct, 3)}</span>,
            `${r.takeProfit} / ${r.stop} / ${r.breakeven} / ${r.timeout}`, signed(r.avgMfePct, 3), signed(r.avgMaePct, 3),
          ])}
          onRow={(i) => go("history", { pattern: data.stats[i]!.patternKey, direction: data.stats[i]!.direction, profile: data.stats[i]!.profile })}
        />
        <p className="mt-2 text-xs text-muted-foreground">Нажми на строку — сделки этого паттерна в истории.</p>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        {profiles.map((p) => (
          <Card key={p.key} title={`${p.label} · ${p.timeframe.toUpperCase()} · плечо x${p.leverage}`}>
            <ul className="mb-3 space-y-1 text-sm">
              <li><span className="text-muted-foreground">Стоп:</span> от структуры сигнала (запасной — {p.defaultStopPct}%), всегда ближе ликвидации</li>
              <li><span className="text-muted-foreground">Цели:</span> {p.defaultTargets.map((t, i) => `цель ${i + 1} +${t.pct}% (${Math.round(t.fraction * 100)}%)`).join(" · ")} — запасные, если у сигнала нет своих</li>
              <li><span className="text-muted-foreground">Безубыток:</span> {p.breakevenAfterFirstTarget ? "после первой цели стоп в точку входа" : "нет"}</li>
              <li><span className="text-muted-foreground">Максимум в сделке:</span> {hold(p.maxHoldMs)}</li>
            </ul>
            <div className="flex flex-wrap gap-1.5">
              {patterns.filter((x) => x.profile === p.key).map((x) => (
                <button key={x.key} onClick={() => go("history", { pattern: x.key })}>
                  <Pill kind={x.direction === "long" ? "long" : "short"}>{x.label}{x.live ? " · канал" : " · тень"}</Pill>
                </button>
              ))}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
