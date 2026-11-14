import { type ReactNode, useState } from "react";
import { REASON, STYLE_LABEL, type Signal, dir, distPct, duration, heldMs, liveMove, price, signed, time, tone } from "../lib/api";
import { type Data, styleOf } from "../lib/data";
import { Card, type Col, Pill, SortTable, Tile } from "../components/ui";
import { SignalDetail } from "../components/SignalDetail";
import { METRIC_COLS, EntryLine } from "../components/metricCols";
import { BtcMainChart } from "../components/BtcMainChart";

/** Open trades: clean move now, distance to the stop and to the next target, time in the trade; every column sorts. */
export function Positions({ data, label, history }: { data: Data; label: (k: string) => string; history?: ReactNode }) {
  const [sel, setSel] = useState<number | null>(null);
  const last = data.status?.stream.lastPrice ?? null;
  const patterns = data.status?.patterns ?? [];
  const recent = [...data.closed].filter((s) => s.closedAt).sort((a, b) => Date.parse(b.closedAt!) - Date.parse(a.closedAt!)).slice(0, 5);
  const selectedAny = data.open.find((s) => s.id === sel) ?? data.closed.find((s) => s.id === sel) ?? null;
  const next = (s: Signal) => s.targets.find((t) => !t.hitAt) ?? null;
  const toStop = (s: Signal) => distPct(s, last, s.stopPrice);
  const toTarget = (s: Signal) => { const n = next(s); return n ? distPct(s, last, n.price) : null; };
  const moves = data.open.map((s) => liveMove(s, last) ?? 0);
  const sum = moves.reduce((a, b) => a + b, 0);
  // Owner 2026-11-14: price changes next to the price (15m, 1h, 4h, 24h) — the live price against the price that long
  // ago (reference = the last 5m cycle's price and its change over the window).
  const lm = data.status?.scanner.lastMetrics;
  const change = (w: string) => {
    const ch = lm?.priceChangePct?.[w];
    const ref = lm?.price && ch != null ? lm.price / (1 + ch / 100) : null;
    return last != null && ref ? ((last - ref) / ref) * 100 : ch ?? null;
  };
  const cols: Col<Signal>[] = [
    { head: "#", cell: (s) => s.id, sort: (s) => s.id },
    { head: "Открыта", cell: (s) => time(s.detectedAt), sort: (s) => Date.parse(s.detectedAt) },
    { head: "Паттерн", cell: (s) => label(s.patternKey), sort: (s) => label(s.patternKey) },
    { head: "Стиль", cell: (s) => STYLE_LABEL[styleOf(patterns, s.patternKey)], sort: (s) => STYLE_LABEL[styleOf(patterns, s.patternKey)] },
    { head: "Напр.", cell: (s) => <Pill kind={s.direction === "long" ? "long" : "short"}>{dir(s.direction)}</Pill>, sort: (s) => s.direction },
    { head: "Вход", cell: (s) => price(s.entryPrice), sort: (s) => s.entryPrice },
    { head: "Движение", cell: (s) => <span className={`font-semibold ${tone(liveMove(s, last))}`}>{signed(liveMove(s, last))}</span>, sort: (s) => liveMove(s, last) },
    { head: "Стоп", cell: (s) => <>{price(s.stopPrice)}{s.breakevenMoved ? <span className="ml-1 text-emerald-300">Б/У</span> : null}</>, sort: (s) => s.stopPrice },
    { head: "До стопа", cell: (s) => { const v = toStop(s); return <span className="text-rose-300/90">{v == null ? "—" : `${Math.abs(v).toFixed(2)}%`}</span>; }, sort: (s) => { const v = toStop(s); return v == null ? null : Math.abs(v); } },
    { head: "След. цель", cell: (s) => (next(s) ? price(next(s)!.price) : "—"), sort: (s) => next(s)?.price ?? null },
    { head: "До цели", cell: (s) => { const v = toTarget(s); return <span className="text-emerald-300/90">{v == null ? "—" : `${v.toFixed(2)}%`}</span>; }, sort: (s) => toTarget(s) },
    { head: "Цели", cell: (s) => `${s.targets.filter((t) => t.hitAt).length} / ${s.targets.length}`, sort: (s) => s.targets.filter((t) => t.hitAt).length },
    { head: "Активна", cell: (s) => duration(heldMs(s)), sort: (s) => heldMs(s) },
    // Entry metrics as CAB (owner only: users get none).
    ...(data.open.some((s) => s.metrics) ? METRIC_COLS : []),
  ];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Открыто" value={data.open.length} sub={`лонгов ${data.open.filter((s) => s.direction === "long").length} · шортов ${data.open.filter((s) => s.direction === "short").length}`} />
        <Tile label="Движение сейчас, сумма" value={signed(sum, 2)} tone={tone(sum)} sub="по всем открытым" />
        <Tile label="В плюсе / в минусе" value={`${moves.filter((m) => m > 0).length} / ${moves.filter((m) => m < 0).length}`} />
        <Tile label="Цена BTC" value={price(last)} sub={
          <span className="flex flex-wrap gap-x-2">
            {([["15m", "15м"], ["1h", "1ч"], ["4h", "4ч"], ["24h", "сутки"]] as const).map(([w, l]) => { const v = change(w); return <span key={w}>{l} <span className={tone(v)}>{signed(v)}</span></span>; })}
          </span>} />
      </div>
      {/* Owner 2026-11-14: the main BTC chart (levels and signals) here, under the tiles. */}
      <BtcMainChart />
      <Card title={`Открытые позиции · ${data.open.length}`}>
        <SortTable<Signal> cols={cols} rows={data.open} rowKey={(s) => s.id} initial={{ col: "Открыта", desc: true }}
          onRow={(s) => setSel(s.id)} empty="Сейчас открытых позиций нет."
          card={(s) => { const st = toStop(s), tg = toTarget(s), n = next(s); return (
            <>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-foreground">{label(s.patternKey)}</div>
                  <div className="mt-1 flex flex-wrap gap-1"><Pill kind={s.direction === "long" ? "long" : "short"}>{dir(s.direction)}</Pill><Pill kind="gold">{STYLE_LABEL[styleOf(patterns, s.patternKey)]}</Pill>{s.breakevenMoved && <Pill kind="good">стоп в Б/У</Pill>}</div>
                </div>
                <div className={`text-xl font-semibold tabular-nums ${tone(liveMove(s, last))}`}>{signed(liveMove(s, last))}</div>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
                <div><div className="text-muted-foreground">Вход</div><div className="tabular-nums">{price(s.entryPrice)}</div></div>
                <div><div className="text-muted-foreground">Стоп</div><div className="tabular-nums">{price(s.stopPrice)}</div><div className="text-rose-300/80">{st == null ? "—" : `${Math.abs(st).toFixed(2)}%`}</div></div>
                <div><div className="text-muted-foreground">След. цель</div><div className="tabular-nums">{n ? price(n.price) : "—"}</div><div className="text-emerald-300/80">{tg == null ? "—" : `${tg.toFixed(2)}%`}</div></div>
              </div>
              <EntryLine s={s} />
              <div className="mt-2 flex justify-between text-[11px] text-muted-foreground"><span>#{s.id} · открыта {time(s.detectedAt)}</span><span>активна {duration(heldMs(s))}</span></div>
            </>
          ); }} />
        <p className="mt-2 text-xs text-muted-foreground">Сортировка — нажми на заголовок столбца. Движение — чистое: от входа в сторону сделки, без плеча и комиссий. Нажми на строку — путь цены, уровни, плечо и метрики на входе.</p>
      </Card>
      {/* As CAB «Недавно закрытые»: the last 5 closed trades right under the open ones. */}
      <Card title="Недавно закрытые">
        {recent.length === 0 ? <p className="text-sm text-muted-foreground">Закрытых сделок пока нет.</p> : (
          <ul className="divide-y divide-border/70">
            {recent.map((s) => (
              <li key={s.id}>
                <button onClick={() => setSel(s.id)} className="flex w-full items-center justify-between gap-3 py-2 text-left hover:text-gold">
                  <span className="min-w-0">
                    <span className="block truncate text-sm">{label(s.patternKey)}</span>
                    <span className="text-[11px] text-muted-foreground">{dir(s.direction)} · {REASON[s.closeReason ?? ""] ?? "—"} · открыта {time(s.detectedAt)} · закрыта {time(s.closedAt)} · была активна {duration(heldMs(s))}</span>
                  </span>
                  <span className={`text-lg font-semibold tabular-nums ${tone(s.pnlPricePct)}`}>{signed(s.pnlPricePct)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {/* Owner 2026-11-14: the whole signal history right here, under the recently closed (as CAB). */}
      {history && <div id="history" className="scroll-mt-4">{history}</div>}
      {selectedAny && <SignalDetail s={selectedAny} label={label(selectedAny.patternKey)} onClose={() => setSel(null)} />}
    </div>
  );
}
