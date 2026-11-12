import { useState } from "react";
import { STYLE_LABEL, dir, distPct, duration, heldMs, liveMove, price, signed, time, tone } from "../lib/api";
import { type Data, styleOf } from "../lib/data";
import { Card, Pill } from "../components/ui";
import { SignalDetail } from "../components/SignalDetail";

/** Open trades as cards: clean move now, distance to the stop and to the next target, held time. */
export function Positions({ data, label }: { data: Data; label: (k: string) => string }) {
  const [sel, setSel] = useState<number | null>(null);
  const last = data.status?.stream.lastPrice ?? null;
  const patterns = data.status?.patterns ?? [];
  const selected = data.open.find((s) => s.id === sel) ?? null;
  return (
    <div className="space-y-4">
      {data.open.length === 0 && <Card title="Открытые позиции"><p className="text-sm text-muted-foreground">Сейчас открытых позиций нет.</p></Card>}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {data.open.map((s) => {
          const move = liveMove(s, last);
          const next = s.targets.find((t) => !t.hitAt) ?? null;
          const toStop = distPct(s, last, s.stopPrice);
          const toTarget = next ? distPct(s, last, next.price) : null;
          return (
            <button key={s.id} onClick={() => setSel(s.id)} className="gold-card gold-hover p-4 text-left">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="text-sm font-medium text-foreground">{label(s.patternKey)}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    <Pill kind={s.direction === "long" ? "long" : "short"}>{dir(s.direction)}</Pill>
                    <Pill kind="gold">{STYLE_LABEL[styleOf(patterns, s.patternKey)]}</Pill>
                    {s.breakevenMoved && <Pill kind="good">стоп в Б/У</Pill>}
                  </div>
                </div>
                <div className={`text-2xl font-semibold tabular-nums ${tone(move)}`}>{signed(move)}</div>
              </div>
              <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                <div><div className="text-muted-foreground">Вход</div><div className="tabular-nums">{price(s.entryPrice)}</div></div>
                <div><div className="text-muted-foreground">Стоп</div><div className="tabular-nums">{price(s.stopPrice)}</div><div className="text-rose-300/80">до стопа {toStop == null ? "—" : `${Math.abs(toStop).toFixed(2)}%`}</div></div>
                <div><div className="text-muted-foreground">След. цель</div><div className="tabular-nums">{next ? price(next.price) : "—"}</div><div className="text-emerald-300/80">до цели {toTarget == null ? "—" : `${toTarget.toFixed(2)}%`}</div></div>
              </div>
              <div className="mt-3 flex items-center gap-1">
                {s.targets.map((t, i) => <span key={i} className={`h-1.5 flex-1 rounded-full ${t.hitAt ? "bg-gold" : "bg-white/10"}`} />)}
              </div>
              <div className="mt-2 flex justify-between text-[11px] text-muted-foreground">
                <span>открыта {time(s.detectedAt)}</span>
                <span>активна {duration(heldMs(s))}</span>
              </div>
            </button>
          );
        })}
      </div>
      <p className="text-center text-xs text-muted-foreground">Движение — чистое: от входа в сторону сделки, без плеча и комиссий. Нажми на карточку — путь цены, уровни, плечо и метрики на входе.</p>
      {selected && <SignalDetail s={selected} label={label(selected.patternKey)} onClose={() => setSel(null)} />}
    </div>
  );
}
