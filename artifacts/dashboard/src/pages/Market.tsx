import { time } from "../lib/api";
import type { Data } from "../lib/data";
import { Card } from "../components/ui";
import { MarketPanel } from "../components/MarketPanel";
import { MetricsGrid } from "../components/MetricsGrid";

/**
 * «Рынок» (owner 2026-11-13: everything about the market on one tab — no market blocks on «Открытые позиции» or
 * «Обзор»): price, Fear / Greed, funding, OI, CVD / delta, takers, liquidations, Whale Index, dominance, S&P 500,
 * every chart with the BTC line; for the owner also the full metric set of the last 5m candle as the patterns see it.
 */
export function Market({ data, owner }: { data: Data; owner: boolean }) {
  return (
    <div className="space-y-4">
      <MarketPanel full />
      {owner && (
        <Card title={`Все метрики последней свечи 5m (как их видят паттерны) · ${time(data.market?.candleCloseAt)}`}>
          {data.market?.metrics ? <MetricsGrid m={data.market.metrics} /> : <p className="text-sm text-muted-foreground">Метрики появятся после первого цикла.</p>}
        </Card>
      )}
    </div>
  );
}
