import { PROFILE, dir, num, price, signed, time } from "../lib/api";
import type { Data } from "../lib/data";
import { Card, Pill, Table } from "../components/ui";

const DEC: Record<string, string> = { fired: "сигнал", rejected: "отклонён", suppressed: "подавлен" };

/** What the patterns decided (opened / rejected and why) and how each group played out afterwards. */
export function Decisions({ data, label }: { data: Data; label: (k: string) => string }) {
  return (
    <div className="space-y-4">
      <Card title="Исход решений за 7 дней · что раньше: цель 1 или стоп">
        <Table
          head={["Паттерн", "Тип", "Напр.", "Решение", "Причина", "Всего", "Цель раньше", "Стоп раньше", "% целей", "Время вышло", "Ждём", "MFE", "MAE"]}
          rows={data.outcomes.map((g) => [
            label(g.patternKey), PROFILE[g.profile] ?? g.profile, dir(g.direction),
            <Pill kind={g.decision === "fired" ? "gold" : "muted"}>{DEC[g.decision] ?? g.decision}</Pill>, g.reason || "—",
            g.total, g.targetFirst, g.stopFirst, g.targetFirstPct == null ? "—" : `${num(g.targetFirstPct, 1)}%`,
            g.timeout, g.pending, signed(g.avgMfePct, 3), signed(g.avgMaePct, 3),
          ])}
        />
        <p className="mt-2 text-xs text-muted-foreground">По минутным свечам после решения; стоп и цель — значения типа сделки по умолчанию. Если в одной свече задеты оба — считается стоп.</p>
      </Card>
      <Card title="Журнал решений · последние 100">
        <Table
          head={["Свеча", "Паттерн", "Тип", "Напр.", "Решение", "Причины", "Цена"]}
          rows={data.decisions.map((d) => [
            time(d.candleCloseAt), label(d.patternKey), PROFILE[d.profile] ?? d.profile, dir(d.direction),
            DEC[d.decision] ?? d.decision, <span className="text-muted-foreground">{(d.reasons ?? []).join(", ")}</span>, d.price ? price(d.price) : "—",
          ])}
        />
      </Card>
    </div>
  );
}
