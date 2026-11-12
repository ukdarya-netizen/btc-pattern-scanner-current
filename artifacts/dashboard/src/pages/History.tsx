import { useState } from "react";
import { REASON, STYLE_LABEL, dir, duration, heldMs, num, price, signed, time, tone } from "../lib/api";
import { type Data, type Filter, NO_FILTER, applyFilter, inPeriod, styleOf, summarize } from "../lib/data";
import { Card, Pill, Table } from "../components/ui";
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
        <Table
          head={["#", "Закрыта", "Паттерн", "Стиль", "Напр.", "Вход", "Выход", "Итог", "Движение", "Макс. в плюс", "Макс. в минус", "В сделке"]}
          rows={rows.map((s) => [
            s.id, time(s.closedAt), label(s.patternKey), STYLE_LABEL[styleOf(patterns, s.patternKey)],
            <Pill kind={s.direction === "long" ? "long" : "short"}>{dir(s.direction)}</Pill>,
            price(s.entryPrice), price(s.exitPrice ?? null), REASON[s.closeReason ?? ""] ?? s.closeReason ?? "—",
            <span className={`font-medium ${tone(s.pnlPricePct)}`}>{signed(s.pnlPricePct)}</span>,
            signed(s.mfePct), signed(s.maePct), duration(heldMs(s)),
          ])}
          onRow={(i) => setOpen(rows[i]!.id)}
          empty="Под эти фильтры сделок нет."
        />
        <p className="mt-2 text-xs text-muted-foreground">Движение — чистое: от входа в сторону сделки, без плеча и комиссий; при частичных целях — взвешено по долям. Нажми на строку — путь цены и метрики на входе.</p>
      </Card>
      {selected && <SignalDetail s={selected} label={label(selected.patternKey)} onClose={() => setOpen(null)} />}
    </div>
  );
}
