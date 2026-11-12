import { time } from "../lib/api";
import type { Data } from "../lib/data";
import { Card } from "../components/ui";
import { MetricsGrid } from "../components/MetricsGrid";

/** The market as the patterns see it now, and the health of the scanner. */
export function Market({ data }: { data: Data }) {
  const st = data.status;
  return (
    <div className="space-y-4">
      <Card title="Состояние сканера">
        <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-5">
          <div><div className="text-muted-foreground">Поток цены</div><div className={st?.stream.connected ? "text-emerald-400" : "text-rose-400"}>{st?.stream.connected ? "на связи" : "нет связи"}</div></div>
          <div><div className="text-muted-foreground">Последняя свеча</div><div>{time(st?.scanner.lastCandleCloseAt)}</div></div>
          <div><div className="text-muted-foreground">Цикл</div><div>{st?.scanner.lastDurationMs == null ? "—" : `${(st.scanner.lastDurationMs / 1000).toFixed(1)} с`}</div></div>
          <div><div className="text-muted-foreground">Паттернов</div><div>{st?.patterns.length ?? 0} ({st?.patterns.filter((p) => p.live).length ?? 0} в канал)</div></div>
          <div><div className="text-muted-foreground">Нет данных</div><div className={st?.scanner.missingFlow.length ? "text-amber-400" : ""}>{st?.scanner.missingFlow.join(", ") || "—"}</div></div>
        </div>
        {st?.scanner.lastError && <p className="mt-2 text-sm text-amber-400">Цикл: {st.scanner.lastError}</p>}
      </Card>
      <Card title={`Рынок BTC · свеча ${time(data.market?.candleCloseAt)}`}>
        {data.market?.metrics ? <MetricsGrid m={data.market.metrics} /> : <p className="text-sm text-muted-foreground">Метрики появятся после первого цикла сканирования.</p>}
      </Card>
    </div>
  );
}
