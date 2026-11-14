import { useState } from "react";
import { REASON, STYLE_LABEL, type Signal, dir, duration, heldMs, liveMove, num, price, signed, time, tone } from "../lib/api";
import { type Data, type Filter, NO_FILTER, type Period, applyFilter, inPeriod, styleOf, summarize } from "../lib/data";
import { Card, type Col, Pill, SortTable } from "../components/ui";
import { SignalDetail } from "../components/SignalDetail";
import { METRIC_COLS, EntryLine } from "../components/metricCols";

const sel = "rounded-full border border-gold/30 bg-black/60 px-3 py-1 text-xs text-foreground focus:border-gold focus:outline-none";

/** Closed trades with filters (pattern, side, style, result) and the detail of one trade. */
export function History({ data, period, label, filter, setFilter }: { data: Data; period: Period; label: (k: string) => string; filter: Filter; setFilter: (f: Filter) => void }) {
  const [open, setOpen] = useState<number | null>(null);
  const patterns = data.status?.patterns ?? [];
  // Owner 2026-11-14 (tiles clickable, as CAB): the status and a date window come from the tile; a date window overrides
  // the period; open trades show their live move.
  const last = data.status?.stream.lastPrice ?? null;
  const status = filter.status ?? "closed";
  const base = status === "open" ? data.open : status === "all" ? [...data.open, ...data.closed] : data.closed;
  const inP = filter.from || filter.to || status !== "closed" ? base : inPeriod(base, period);
  const rows = applyFilter(inP, filter, patterns);
  const move = (s: Signal) => (s.closedAt ? s.pnlPricePct : liveMove(s, last));
  // Outcome chips with counts (as Nihilist / CAB): counted with every other filter applied.
  const byReason = (r: Filter["reason"]) => applyFilter(inP, { ...filter, reason: r }, patterns);
  const sm = summarize(rows);
  const holds = rows.map((s) => heldMs(s)).sort((a, b) => a - b);
  const keys = [...new Set(data.closed.map((s) => s.patternKey))];
  const selected = rows.find((s) => s.id === open) ?? null;
  const set = (p: Partial<Filter>) => setFilter({ ...filter, ...p });
  const cols: Col<Signal>[] = [
    { head: "#", cell: (s) => s.id, sort: (s) => s.id },
    { head: "Открыта", cell: (s) => time(s.detectedAt), sort: (s) => Date.parse(s.detectedAt) },
    { head: "Закрыта", cell: (s) => (s.closedAt ? time(s.closedAt) : <span className="text-gold">открыта</span>), sort: (s) => (s.closedAt ? Date.parse(s.closedAt) : Infinity) },
    { head: "Паттерн", cell: (s) => label(s.patternKey), sort: (s) => label(s.patternKey) },
    { head: "Стиль", cell: (s) => STYLE_LABEL[styleOf(patterns, s.patternKey)], sort: (s) => STYLE_LABEL[styleOf(patterns, s.patternKey)] },
    { head: "Напр.", cell: (s) => <Pill kind={s.direction === "long" ? "long" : "short"}>{dir(s.direction)}</Pill>, sort: (s) => s.direction },
    { head: "Вход", cell: (s) => price(s.entryPrice), sort: (s) => s.entryPrice },
    { head: "Выход", cell: (s) => price(s.exitPrice ?? null), sort: (s) => s.exitPrice ?? null },
    { head: "Итог", cell: (s) => (s.closedAt ? REASON[s.closeReason ?? ""] ?? s.closeReason ?? "—" : "в сделке"), sort: (s) => (s.closedAt ? REASON[s.closeReason ?? ""] ?? s.closeReason ?? "" : "") },
    { head: "Движение", cell: (s) => <span className={`font-medium ${tone(move(s))}`}>{signed(move(s))}</span>, sort: (s) => move(s) },
    { head: "Макс. в плюс", cell: (s) => signed(s.mfePct), sort: (s) => s.mfePct },
    { head: "Макс. в минус", cell: (s) => signed(s.maePct), sort: (s) => s.maePct },
    { head: "Активна", cell: (s) => (s.closedAt ? duration(heldMs(s)) : `${duration(heldMs(s))} (сейчас)`), sort: (s) => heldMs(s) },
    // Entry metrics as CAB (owner only: users get none).
    ...(rows.some((s) => s.metrics) ? METRIC_COLS : []),
  ];
  return (
    <div className="space-y-4">
      {filter.title && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gold/40 bg-gold/10 px-4 py-2 text-sm">
          <span><b className="text-gold">{filter.title}</b>{filter.note ? <span className="text-muted-foreground"> — {filter.note}</span> : null} · {rows.length}</span>
          <button onClick={() => setFilter(NO_FILTER)} className="rounded-md border border-gold/60 px-3 py-1 text-xs text-gold hover:bg-gold/15">Вся история</button>
        </div>
      )}
      <Card title="История сигналов" right={
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
          {([["", "Все"], ["take_profit", "Цели"], ["breakeven", "Безубыток"], ["stop", "Стоп"], ["timeout", "По времени"]] as Array<[Filter["reason"], string]>).map(([r, l]) => {
            const xs = byReason(r);
            const on = filter.reason === r;
            return (
              <button key={r || "all"} onClick={() => set({ reason: r })}
                className={`rounded-full border px-3 py-1 ${on ? "border-gold bg-gold/15 text-gold" : "border-border text-muted-foreground hover:text-foreground"}`}>
                {l} · {xs.length}{r ? ` · ${signed(xs.reduce((a, s) => a + (s.pnlPricePct ?? 0), 0), 1)}` : ""}
              </button>
            );
          })}
        </div>
        <div className="mb-3 flex flex-wrap gap-2 text-xs">
          <Pill kind="gold">сделок {sm.n}</Pill>
          <Pill>винрейт {sm.winRate == null ? "—" : `${num(sm.winRate, 0)}%`}</Pill>
          <Pill>в плюсе {sm.wins}</Pill>
          <Pill kind={sm.sum >= 0 ? "good" : "bad"}>сумма {signed(sm.sum, 1)}</Pill>
          <Pill>в среднем {signed(sm.avg)}</Pill>
          <Pill>в сделке от {holds.length ? duration(holds[0]!) : "—"} до {holds.length ? duration(holds.at(-1)!) : "—"}</Pill>
        </div>
        <SortTable<Signal>
          cols={cols}
          rows={rows}
          rowKey={(s) => s.id}
          key={JSON.stringify(filter)}
          initial={{ col: filter.sort ?? (status === "closed" ? "Закрыта" : "Открыта"), desc: !filter.asc }}
          onRow={(s) => setOpen(s.id)}
          empty="Под эти фильтры сделок нет."
          card={(s) => (
            <>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-foreground">{label(s.patternKey)}</div>
                  <div className="mt-1 flex flex-wrap gap-1"><Pill kind={s.direction === "long" ? "long" : "short"}>{dir(s.direction)}</Pill><Pill kind="gold">{STYLE_LABEL[styleOf(patterns, s.patternKey)]}</Pill><Pill>{s.closedAt ? REASON[s.closeReason ?? ""] ?? s.closeReason ?? "—" : "в сделке"}</Pill></div>
                </div>
                <div className={`text-xl font-semibold tabular-nums ${tone(move(s))}`}>{signed(move(s))}</div>
              </div>
              <EntryLine s={s} />
              <div className="mt-2 flex justify-between text-[11px] text-muted-foreground">
                <span>#{s.id} · открыта {time(s.detectedAt)} → {s.closedAt ? `закрыта ${time(s.closedAt)}` : "в сделке"}</span><span>{s.closedAt ? "была активна" : "активна"} {duration(heldMs(s))}</span>
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
