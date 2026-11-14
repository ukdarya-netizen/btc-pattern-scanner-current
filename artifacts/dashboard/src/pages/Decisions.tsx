import { useState } from "react";
import { type Decision, type OutcomeGroup, dir, getJson, num, price, time } from "../lib/api";
import type { Data } from "../lib/data";
import { Card, Pill, Table } from "../components/ui";

const DEC: Record<string, string> = { fired: "сигнал", rejected: "отклонён", suppressed: "подавлен" };
const keyOf = (g: OutcomeGroup) => [g.patternKey, g.profile, g.direction, g.decision, g.reason].join("|");

/**
 * «Решения» (owner 2026-11-13: its own tab; the market lives on «Рынок»): pattern decisions and their outcomes.
 * Owner 2026-11-14: the date and time of the rejections — first / last in the table, and a click on a row lists every
 * decision of that row (date, time, price, all reasons) from the journal of the last 7 days.
 */
export function Decisions({ data, label }: { data: Data; label: (k: string) => string }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [items, setItems] = useState<Decision[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const groups = [...data.outcomes].sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? ""));
  const open = (g: OutcomeGroup) => {
    const k = keyOf(g);
    if (openKey === k) { setOpenKey(null); return; }
    setOpenKey(k); setItems(null); setErr(null);
    const since = Date.now() - 7 * 86_400_000;
    getJson<{ rows: Decision[] }>(`/api/btc/decisions?pattern=${encodeURIComponent(g.patternKey)}&decision=${encodeURIComponent(g.decision)}&limit=2000`)
      .then((r) => setItems(r.rows.filter((d) => d.direction === g.direction && d.profile === g.profile && String((d.reasons ?? [])[0] ?? "") === g.reason && Date.parse(d.candleCloseAt) >= since)))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  };
  const shown = groups.find((g) => keyOf(g) === openKey) ?? null;
  return (
    <div className="space-y-4">
      <Card title="Решения паттернов за 7 дней · что раньше: цель 1 или стоп">
        <Table
          head={["Паттерн", "Напр.", "Решение", "Причина", "Всего", "Первое", "Последнее", "Цель раньше", "Стоп раньше", "% целей", "Ждём"]}
          onRow={(i) => open(groups[i]!)}
          rows={groups.map((g) => [
            label(g.patternKey), dir(g.direction), <Pill kind={g.decision === "fired" ? "gold" : "muted"}>{DEC[g.decision] ?? g.decision}</Pill>, g.reason || "—",
            g.total, <span className="whitespace-nowrap">{time(g.firstAt)}</span>, <span className="whitespace-nowrap">{time(g.lastAt)}</span>,
            g.targetFirst, g.stopFirst, g.targetFirstPct == null ? "—" : `${num(g.targetFirstPct, 1)}%`, g.pending,
          ])}
        />
        <p className="mt-2 text-xs text-muted-foreground">Время — Дубай, закрытие свечи решения. Нажми на строку — список всех решений этой строки с датой и временем.</p>
        {shown && (
          <div className="mt-4 border-t border-border/70 pt-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-sm text-gold">{label(shown.patternKey)} · {dir(shown.direction)} · {DEC[shown.decision] ?? shown.decision}{shown.reason ? ` · ${shown.reason}` : ""}</h3>
              <button onClick={() => setOpenKey(null)} className="text-xs text-muted-foreground hover:text-gold">Скрыть</button>
            </div>
            {err ? <p className="text-sm text-rose-300">Не загрузилось: {err}</p> : !items ? <p className="text-sm text-muted-foreground">Загружаю…</p> : (
              <Table head={["Дата и время", "Цена", "Все причины"]} empty="Нет решений за 7 дней."
                rows={items.map((d) => [<span className="whitespace-nowrap">{time(d.candleCloseAt)}</span>, d.price ? price(d.price) : "—", <span className="text-muted-foreground">{(d.reasons ?? []).join(", ")}</span>])} />
            )}
          </div>
        )}
      </Card>
      <Card title="Журнал решений · последние 100">
        <Table
          head={["Дата и время", "Паттерн", "Напр.", "Решение", "Причины", "Цена"]}
          rows={data.decisions.map((d) => [
            <span className="whitespace-nowrap">{time(d.candleCloseAt)}</span>, label(d.patternKey), dir(d.direction), DEC[d.decision] ?? d.decision,
            <span className="text-muted-foreground">{(d.reasons ?? []).join(", ")}</span>, d.price ? price(d.price) : "—",
          ])}
        />
      </Card>
    </div>
  );
}
