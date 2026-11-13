import { dir, num, price, time } from "../lib/api";
import type { Data } from "../lib/data";
import { Card, Pill, Table } from "../components/ui";

const DEC: Record<string, string> = { fired: "сигнал", rejected: "отклонён", suppressed: "подавлен" };

/** «Решения» (owner 2026-11-13: its own tab; the market lives on «Рынок»): pattern decisions and their outcomes. */
export function Decisions({ data, label }: { data: Data; label: (k: string) => string }) {
  return (
    <div className="space-y-4">
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
