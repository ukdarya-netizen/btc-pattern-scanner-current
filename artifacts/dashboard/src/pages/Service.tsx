import { dir, num, price, time } from "../lib/api";
import type { Data } from "../lib/data";
import { Card, Pill, Table } from "../components/ui";
import { MetricsGrid } from "../components/MetricsGrid";

const DEC: Record<string, string> = { fired: "сигнал", rejected: "отклонён", suppressed: "подавлен" };

/** Service page: the scanner's health, the market as the patterns see it, and the decisions journal. */
export function Service({ data, label }: { data: Data; label: (k: string) => string }) {
  const st = data.status;
  return (
    <div className="space-y-4">
      <Card title="Состояние сканера">
        <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-5">
          <div><div className="text-muted-foreground">Поток цены</div><div className={st?.stream.connected ? "text-emerald-400" : "text-rose-400"}>{st?.stream.connected ? "на связи" : "нет связи"}</div></div>
          <div><div className="text-muted-foreground">Последняя свеча</div><div>{time(st?.scanner.lastCandleCloseAt)}</div></div>
          <div><div className="text-muted-foreground">Цикл</div><div>{st?.scanner.lastDurationMs == null ? "—" : `${(st.scanner.lastDurationMs / 1000).toFixed(1)} с`}</div></div>
          <div><div className="text-muted-foreground">Паттернов</div><div>{st?.patterns.length ?? 0} · в канал {st?.patterns.filter((p) => p.live).length ?? 0}</div></div>
          <div><div className="text-muted-foreground">Нет данных</div><div className={st?.scanner.missingFlow.length ? "text-amber-400" : ""}>{st?.scanner.missingFlow.join(", ") || "—"}</div></div>
        </div>
        {st?.scanner.lastError && <p className="mt-2 text-sm text-amber-400">Цикл: {st.scanner.lastError}</p>}
      </Card>
      <Card title={`Рынок BTC · свеча ${time(data.market?.candleCloseAt)}`}>
        {data.market?.metrics ? <MetricsGrid m={data.market.metrics} /> : <p className="text-sm text-muted-foreground">Метрики появятся после первого цикла.</p>}
      </Card>
      <Card title="Решения паттернов за 7 дней · что раньше: цель 1 или стоп">
        <Table
          head={["Паттерн", "Напр.", "Решение", "Причина", "Всего", "Цель раньше", "Стоп раньше", "% целей", "Ждём"]}
          rows={data.outcomes.map((g) => [
            label(g.patternKey), dir(g.direction), <Pill kind={g.decision === "fired" ? "gold" : "muted"}>{DEC[g.decision] ?? g.decision}</Pill>, g.reason || "—",
            g.total, g.targetFirst, g.stopFirst, g.targetFirstPct == null ? "—" : `${num(g.targetFirstPct, 1)}%`, g.pending,
          ])}
        />
      </Card>
      <Card title="Журнал решений · последние 100">
        <Table
          head={["Свеча", "Паттерн", "Напр.", "Решение", "Причины", "Цена"]}
          rows={data.decisions.map((d) => [
            time(d.candleCloseAt), label(d.patternKey), dir(d.direction), DEC[d.decision] ?? d.decision,
            <span className="text-muted-foreground">{(d.reasons ?? []).join(", ")}</span>, d.price ? price(d.price) : "—",
          ])}
        />
      </Card>
    </div>
  );
}
