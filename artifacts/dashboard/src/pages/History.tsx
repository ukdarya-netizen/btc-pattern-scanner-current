import { useState } from "react";
import { PROFILE, REASON, dir, duration, heldMs, num, price, signed, time, tone } from "../lib/api";
import { type Data, type Filter, NO_FILTER, applyFilter, inPeriod, summarize } from "../lib/data";
import { Card, Pill, Table } from "../components/ui";
import { SignalDetail } from "../components/SignalDetail";

const sel = "rounded-full border border-gold/30 bg-black/60 px-3 py-1 text-xs text-foreground focus:border-gold focus:outline-none";

/** Closed trades with filters (pattern, side, timeframe, channel / shadow, result) and the detail of one trade. */
export function History({ data, days, label, filter, setFilter }: { data: Data; days: number; label: (k: string) => string; filter: Filter; setFilter: (f: Filter) => void }) {
  const [open, setOpen] = useState<number | null>(null);
  const rows = applyFilter(inPeriod(data.closed, days), filter);
  const sm = summarize(rows);
  const holds = rows.map((s) => heldMs(s)).sort((a, b) => a - b);
  const patterns = [...new Set(data.closed.map((s) => s.patternKey))];
  const selected = rows.find((s) => s.id === open) ?? null;
  const set = (p: Partial<Filter>) => setFilter({ ...filter, ...p });
  return (
    <div className="space-y-4">
      <Card title="История сделок" right={
        <div className="flex flex-wrap gap-2">
          <select className={sel} value={filter.pattern} onChange={(e) => set({ pattern: e.target.value })}>
            <option value="">Все паттерны</option>
            {patterns.map((p) => <option key={p} value={p}>{label(p)}</option>)}
          </select>
          <select className={sel} value={filter.direction} onChange={(e) => set({ direction: e.target.value })}>
            <option value="">Лонг и шорт</option><option value="long">Лонги</option><option value="short">Шорты</option>
          </select>
          <select className={sel} value={filter.profile} onChange={(e) => set({ profile: e.target.value })}>
            <option value="">4H и 1D</option><option value="h4">4H · x20</option><option value="d1">1D · x10</option>
          </select>
          <select className={sel} value={filter.mode} onChange={(e) => set({ mode: e.target.value as Filter["mode"] })}>
            <option value="all">Канал и тень</option><option value="live">В канал</option><option value="shadow">Тень</option>
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
          <Pill kind={sm.sum >= 0 ? "good" : "bad"}>сумма к марже {signed(sm.sum, 1)}</Pill>
          <Pill>средняя {signed(sm.avg)}</Pill>
          <Pill>в сделке от {holds.length ? duration(holds[0]!) : "—"} до {holds.length ? duration(holds.at(-1)!) : "—"}</Pill>
        </div>
        <Table
          head={["#", "Закрыта", "Паттерн", "Напр.", "Тип", "Режим", "Вход", "Выход", "Итог", "Цена %", "К марже", "MFE", "MAE", "В сделке"]}
          rows={rows.map((s) => [
            s.id, time(s.closedAt), label(s.patternKey),
            <Pill kind={s.direction === "long" ? "long" : "short"}>{dir(s.direction)}</Pill>,
            PROFILE[s.profile] ?? s.profile, s.live ? "канал" : "тень", price(s.entryPrice), price(s.exitPrice ?? null),
            REASON[s.closeReason ?? ""] ?? s.closeReason ?? "—",
            <span className={tone(s.pnlPricePct)}>{signed(s.pnlPricePct, 3)}</span>,
            <span className={`font-medium ${tone(s.pnlMarginPct)}`}>{signed(s.pnlMarginPct)}</span>,
            signed(s.mfePct, 3), signed(s.maePct, 3), duration(heldMs(s)),
          ])}
          onRow={(i) => setOpen(open === rows[i]!.id ? null : rows[i]!.id)}
          empty="Под эти фильтры сделок нет."
        />
        <p className="mt-2 text-xs text-muted-foreground">«К марже» — с плечом и за вычетом тейкер-комиссий 0.05% на вход и выход. Нажми на строку — путь цены и метрики на входе.</p>
      </Card>
      {selected && <SignalDetail s={selected} label={label(selected.patternKey)} onClose={() => setOpen(null)} />}
    </div>
  );
}
