import { useState } from "react";
import { REASON, STYLE_LABEL, type Signal, dir, duration, heldMs, num, price, signed, time, tone } from "../lib/api";
import { type Data, type Filter, NO_FILTER, applyFilter, inPeriod, styleOf, summarize } from "../lib/data";
import { Card, type Col, Pill, SortTable } from "../components/ui";
import { SignalDetail } from "../components/SignalDetail";

const sel = "rounded-full border border-gold/30 bg-black/60 px-3 py-1 text-xs text-foreground focus:border-gold focus:outline-none";

/** Closed trades with filters (pattern, side, style, result) and the detail of one trade. */
export function History({ data, days, label, filter, setFilter }: { data: Data; days: number; label: (k: string) => string; filter: Filter; setFilter: (f: Filter) => void }) {
  const [open, setOpen] = useState<number | null>(null);
  const patterns = data.status?.patterns ?? [];
  const rows = applyFilter(inPeriod(data.closed, days), filter, patterns);
  const sm = summarize(rows);
  const holds = rows.map((s) => heldMs(s)).sort((a, b) => a - b);
  const keys = [...new Set(data.closed.map((s) => s.patternKey))];
  const selected = rows.find((s) => s.id === open) ?? null;
  const set = (p: Partial<Filter>) => setFilter({ ...filter, ...p });
  const cols: Col<Signal>[] = [
    { head: "#", cell: (s) => s.id, sort: (s) => s.id },
    { head: "Открыта", cell: (s) => time(s.detectedAt), sort: (s) => Date.parse(s.detectedAt) },
    { head: "Закрыта", cell: (s) => time(s.closedAt), sort: (s) => (s.closedAt ? Date.parse(s.closedAt) : null) },
    { head: "Паттерн", cell: (s) => label(s.patternKey), sort: (s) => label(s.patternKey) },
    { head: "Стиль", cell: (s) => STYLE_LABEL[styleOf(patterns, s.patternKey)], sort: (s) => STYLE_LABEL[styleOf(patterns, s.patternKey)] },
    { head: "Напр.", cell: (s) => <Pill kind={s.direction === "long" ? "long" : "short"}>{dir(s.direction)}</Pill>, sort: (s) => s.direction },
    { head: "Вход", cell: (s) => price(s.entryPrice), sort: (s) => s.entryPrice },
    { head: "Выход", cell: (s) => price(s.exitPrice ?? null), sort: (s) => s.exitPrice ?? null },
    { head: "Итог", cell: (s) => REASON[s.closeReason ?? ""] ?? s.closeReason ?? "—", sort: (s) => REASON[s.closeReason ?? ""] ?? s.closeReason ?? "" },
    { head: "Движение", cell: (s) => <span className={`font-medium ${tone(s.pnlPricePct)}`}>{signed(s.pnlPricePct)}</span>, sort: (s) => s.pnlPricePct },
    { head: "Макс. в плюс", cell: (s) => signed(s.mfePct), sort: (s) => s.mfePct },
    { head: "Макс. в минус", cell: (s) => signed(s.maePct), sort: (s) => s.maePct },
    { head: "В сделке", cell: (s) => duration(heldMs(s)), sort: (s) => heldMs(s) },
  ];
  return (
    <div className="space-y-4">
      <Card title="История сделок" right={
        <div className="flex flex-wrap gap-2">
          <select className={sel} value={filter.pattern} onChange={(e) => set({ pattern: e.target.value })}>
            <option value="">Все паттерны</option>
            {keys.map((p) => <option key={p} value={p}>{label(p)}</option>)}
          </select>
          <select className={sel} value={filter.direction} onChange={(e) => set({ direction: e.target.value })}>
            <option value="">Лонг и шорт</option><option value="long">Лонги</option><option value="short">Шорты</option>
          </select>
          <select className={sel} value={filter.style} onChange={(e) => set({ style: e.target.value as Filter["style"] })}>
            <option value="">Все стили</option><option value="scalp">Скальп</option><option value="intraday">Интрадей</option><option value="swing">Свинг</option>
          </select>
          <select className={sel} value={filter.result} onChange={(e) => set({ result: e.target.value as Filter["result"] })}>
            <option value="all">Любой итог</option><option value="win">В плюсе</option><option value="loss">В минусе</option><option value="flat">Ноль</option>
          </select>
          <button className="text-xs text-muted-foreground hover:text-gold" onClick={() => setFilter(NO_FILTER)}>сбросить</button>
        </div>
      }>
        <div className="mb-3 flex flex-wrap gap-2 text-xs">
          <Pill kind="gold">сделок {sm.n}</Pill>
          <Pill>винрейт {sm.winRate == null ? "—" : `${num(sm.winRate, 0)}%`}</Pill>
          <Pill kind={sm.sum >= 0 ? "good" : "bad"}>сумма {signed(sm.sum, 1)}</Pill>
          <Pill>в среднем {signed(sm.avg)}</Pill>
          <Pill>в сделке от {holds.length ? duration(holds[0]!) : "—"} до {holds.length ? duration(holds.at(-1)!) : "—"}</Pill>
        </div>
        <SortTable<Signal>
          cols={cols}
          rows={rows}
          rowKey={(s) => s.id}
          initial={{ col: "Закрыта", desc: true }}
          onRow={(s) => setOpen(s.id)}
          empty="Под эти фильтры сделок нет."
          card={(s) => (
            <>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-foreground">{label(s.patternKey)}</div>
                  <div className="mt-1 flex flex-wrap gap-1"><Pill kind={s.direction === "long" ? "long" : "short"}>{dir(s.direction)}</Pill><Pill kind="gold">{STYLE_LABEL[styleOf(patterns, s.patternKey)]}</Pill><Pill>{REASON[s.closeReason ?? ""] ?? s.closeReason ?? "—"}</Pill></div>
                </div>
                <div className={`text-xl font-semibold tabular-nums ${tone(s.pnlPricePct)}`}>{signed(s.pnlPricePct)}</div>
              </div>
              <div className="mt-2 flex justify-between text-[11px] text-muted-foreground">
                <span>#{s.id} · {time(s.detectedAt)} → {time(s.closedAt)}</span><span>{duration(heldMs(s))}</span>
              </div>
            </>
          )}
        />
        <p className="mt-2 text-xs text-muted-foreground">Движение — чистое: от входа в сторону сделки, без плеча и комиссий; при частичных целях — взвешено по долям. Сортировка — нажми на заголовок столбца. Нажми на строку — путь цены и метрики на входе.</p>
      </Card>
      {selected && <SignalDetail s={selected} label={label(selected.patternKey)} onClose={() => setOpen(null)} />}
    </div>
  );
}
