import { dir, num, price, time } from "../lib/api";
import type { Data } from "../lib/data";
import { Card, Pill, Table } from "../components/ui";
import { MetricsGrid } from "../components/MetricsGrid";

const DEC: Record<string, string> = { fired: "сигнал", rejected: "отклонён", suppressed: "подавлен" };

/** «Рынок и решения» (owner 2026-11-13, apart from Bot Health): the market as the patterns see it and the decisions journal. */
export function Service({ data, label }: { data: Data; label: (k: string) => string }) {
  const st = data.status;
  return (
    <div className="space-y-4">
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
