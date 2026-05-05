import { Layout } from "@/components/layout";
import {
  useGetLiquidationEvents,
  useGetLiquidationInfo,
  useGetLiquidationCoinalyze,
  useGetLiquidationMap,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, ResponsiveContainer, BarChart, Bar, Cell, XAxis, YAxis, ReferenceLine } from "recharts";
import { format } from "date-fns";
import { useState } from "react";

function fmt(v: number) {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtBtc(v: number) {
  if (v >= 1) return `${v.toFixed(2)} BTC`;
  return `${(v * 1000).toFixed(1)} mBTC`;
}

function LiqBar({ label, longUsd, shortUsd }: { label: string; longUsd: number; shortUsd: number }) {
  const total = longUsd + shortUsd;
  const longPct = total > 0 ? (longUsd / total) * 100 : 50;
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex justify-between text-[10px] text-muted-foreground mb-0.5">
        <span>{label}</span><span>{fmt(total)}</span>
      </div>
      <div className="flex h-4 rounded-none overflow-hidden gap-px">
        <div className="bg-green/70 flex items-center justify-center text-[9px] font-bold transition-all" style={{ width: `${longPct}%` }}>
          {longPct > 20 ? fmt(longUsd) : ""}
        </div>
        <div className="bg-red/70 flex items-center justify-center text-[9px] font-bold transition-all" style={{ width: `${100 - longPct}%` }}>
          {100 - longPct > 20 ? fmt(shortUsd) : ""}
        </div>
      </div>
      <div className="flex justify-between text-[9px]">
        <span className="text-green">Longs {longPct.toFixed(0)}%</span>
        <span className="text-red">Shorts {(100 - longPct).toFixed(0)}%</span>
      </div>
    </div>
  );
}

// Custom tooltip for the liquidation map
function MapTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: { price: number; longLiqUsd: number; shortLiqUsd: number } }> }) {
  if (!active || !payload?.length) return null;
  const d = payload[0]!.payload;
  const total = d.longLiqUsd + d.shortLiqUsd;
  return (
    <div style={{ background: 'var(--color-card)', border: '1px solid var(--color-border)', padding: '8px 12px', fontSize: 11 }}>
      <div className="font-mono font-bold mb-1">${d.price.toFixed(0)}</div>
      {d.longLiqUsd > 0 && <div className="text-red">🔴 Лонги: {fmt(d.longLiqUsd)}</div>}
      {d.shortLiqUsd > 0 && <div className="text-green">🟢 Шорты: {fmt(d.shortLiqUsd)}</div>}
      <div className="text-muted-foreground mt-1">Итого: {fmt(total)}</div>
    </div>
  );
}

export default function Liquidations() {
  const [histRange, setHistRange] = useState<"24h" | "2h">("24h");

  const { data: mapData } = useGetLiquidationMap({ query: { refetchInterval: 5 * 60 * 1000 } });
  const { data: events } = useGetLiquidationEvents({ query: { refetchInterval: 2000 } });
  const { data: info } = useGetLiquidationInfo({ query: { refetchInterval: 60000 } });
  const { data: coinalyze } = useGetLiquidationCoinalyze(
    { range: histRange },
    { query: { refetchInterval: histRange === "2h" ? 60000 : 5 * 60 * 1000 } }
  );

  const eventList = events?.events ?? [];
  const hasEvents = eventList.length > 0;

  const caCandles = coinalyze?.candles ?? [];
  const caChartData = caCandles.map(c => ({
    time: histRange === "2h"
      ? format(new Date(c.t * 1000), "HH:mm")
      : format(new Date(c.t * 1000), "dd MMM HH:mm"),
    longBtc: parseFloat(c.longBtc.toFixed(3)),
    shortBtc: -parseFloat(c.shortBtc.toFixed(3)),
  }));

  // Liquidation map — sorted by price, near current price only
  const currentPrice = mapData?.currentPrice ?? 0;
  const allBuckets = mapData?.buckets ?? [];

  // Show ±10% from current price
  const visibleBuckets = allBuckets
    .filter(b => b.price >= currentPrice * 0.90 && b.price <= currentPrice * 1.10)
    .sort((a, b) => a.price - b.price);

  // Find top clusters for annotation
  const topClusters = [...allBuckets]
    .sort((a, b) => b.totalUsd - a.totalUsd)
    .slice(0, 3);

  // Map chart: negative = long liq (below price, red = danger zone), positive = short liq (above, green = magnet)
  const mapChartData = visibleBuckets.map(b => ({
    price: b.price,
    priceLabel: `$${(b.price / 1000).toFixed(1)}k`,
    longLiqUsd: b.longLiqUsd,
    shortLiqUsd: b.shortLiqUsd,
    isCurrentPrice: Math.abs(b.price - currentPrice) < 150,
  }));

  return (
    <Layout>
      <div className="flex flex-col gap-2 h-full">

        {/* CoinGlass top bar */}
        {info && (
          <Card className="rounded-none border-border shrink-0">
            <CardHeader className="p-3 pb-1 border-b border-border/50">
              <CardTitle className="text-xs uppercase flex justify-between">
                <span>CoinGlass — Liquidation Volumes</span>
                <span className="text-muted-foreground font-normal text-[10px]">🟢 Longs &nbsp;🔴 Shorts</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="p-3 grid grid-cols-4 gap-4">
              <LiqBar label="1H" longUsd={info.longVolUsd1h ?? 0} shortUsd={info.shortVolUsd1h ?? 0} />
              <LiqBar label="4H" longUsd={info.longVolUsd4h ?? 0} shortUsd={info.shortVolUsd4h ?? 0} />
              <LiqBar label="12H" longUsd={info.longVolUsd12h ?? 0} shortUsd={info.shortVolUsd12h ?? 0} />
              <LiqBar label="24H" longUsd={info.longVolUsd24h ?? 0} shortUsd={info.shortVolUsd24h ?? 0} />
            </CardContent>
          </Card>
        )}

        <div className="grid grid-cols-12 gap-2 flex-1 min-h-0">

          {/* LEFT: Liquidation Map */}
          <div className="col-span-5 flex flex-col min-h-0">
            <Card className="rounded-none border-border flex-1 flex flex-col min-h-0">
              <CardHeader className="p-3 pb-0 border-b border-border/50 shrink-0">
                <CardTitle className="text-xs uppercase flex justify-between items-start">
                  <div>
                    <div>Карта ликвидаций ±10% (Coinalyze)</div>
                    {currentPrice > 0 && (
                      <div className="text-[10px] font-normal text-muted-foreground mt-0.5 normal-case">
                        Текущая цена <span className="text-foreground font-mono">${currentPrice.toFixed(0)}</span>
                        {topClusters[0] && (
                          <span> · Топ кластер: <span className="font-mono">${topClusters[0].price.toFixed(0)}</span> ({fmt(topClusters[0].totalUsd)})</span>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col gap-0.5 text-right shrink-0 ml-2">
                    <div className="flex items-center gap-1 justify-end"><span className="w-2 h-2 bg-green/70 inline-block" /> <span className="text-[9px] font-normal normal-case text-muted-foreground">Шорты (цена ↑)</span></div>
                    <div className="flex items-center gap-1 justify-end"><span className="w-2 h-2 bg-red/70 inline-block" /> <span className="text-[9px] font-normal normal-case text-muted-foreground">Лонги (цена ↓)</span></div>
                  </div>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0 flex-1 min-h-0">
                {mapChartData.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={mapChartData}
                      layout="vertical"
                      margin={{ top: 4, right: 8, left: 48, bottom: 4 }}
                      barCategoryGap={1}
                    >
                      <XAxis
                        type="number"
                        tick={{ fontSize: 8, fill: 'var(--color-muted-foreground)' }}
                        axisLine={false} tickLine={false}
                        tickFormatter={v => fmt(v)}
                      />
                      <YAxis
                        type="category" dataKey="priceLabel"
                        tick={{ fontSize: 8, fill: 'var(--color-muted-foreground)' }}
                        axisLine={false} tickLine={false}
                        width={46}
                      />
                      <Tooltip content={<MapTooltip />} />
                      <Bar dataKey="longLiqUsd" stackId="a" isAnimationActive={false} name="Лонги">
                        {mapChartData.map((entry, i) => (
                          <Cell
                            key={i}
                            fill={entry.isCurrentPrice ? '#ffffff' : 'var(--color-red)'}
                            fillOpacity={entry.isCurrentPrice ? 1 : 0.65}
                          />
                        ))}
                      </Bar>
                      <Bar dataKey="shortLiqUsd" stackId="a" isAnimationActive={false} name="Шорты">
                        {mapChartData.map((entry, i) => (
                          <Cell
                            key={i}
                            fill={entry.isCurrentPrice ? '#ffffff' : 'var(--color-green)'}
                            fillOpacity={entry.isCurrentPrice ? 0.3 : 0.65}
                          />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
                    Загрузка карты ликвидаций...
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* CENTER: Historical chart + live feed header */}
          <div className="col-span-4 flex flex-col gap-2 min-h-0">
            <Card className="rounded-none border-border flex-1 flex flex-col min-h-0">
              <CardHeader className="p-3 pb-0 border-b border-border/50 shrink-0">
                <CardTitle className="text-xs uppercase flex justify-between items-center">
                  <span>История ликвидаций (все биржи)</span>
                  <div className="flex gap-1">
                    {(["24h", "2h"] as const).map(r => (
                      <button key={r} onClick={() => setHistRange(r)}
                        className={`px-2 py-0.5 text-[9px] border ${histRange === r ? "border-primary text-primary" : "border-border text-muted-foreground"}`}>
                        {r === "24h" ? "24H" : "2H"}
                      </button>
                    ))}
                  </div>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0 flex-1 min-h-0">
                {caChartData.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={caChartData} margin={{ top: 8, right: 8, left: 4, bottom: 8 }}>
                      <XAxis dataKey="time" tick={{ fontSize: 7, fill: 'var(--color-muted-foreground)' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                      <YAxis tick={{ fontSize: 8, fill: 'var(--color-muted-foreground)' }} axisLine={false} tickLine={false} tickFormatter={v => `${Math.abs(v).toFixed(1)}`} />
                      <Tooltip
                        contentStyle={{ backgroundColor: 'var(--color-card)', border: '1px solid var(--color-border)', fontSize: 10 }}
                        formatter={(v: number, name: string) => [`${Math.abs(v).toFixed(3)} BTC`, name === "longBtc" ? "🟢 Лонги ликвидированы" : "🔴 Шорты ликвидированы"]}
                      />
                      <Bar dataKey="longBtc" fill="var(--color-green)" fillOpacity={0.75} isAnimationActive={false} />
                      <Bar dataKey="shortBtc" fill="var(--color-red)" fillOpacity={0.75} isAnimationActive={false} />
                    </BarChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-full flex items-center justify-center text-muted-foreground text-sm">Загрузка...</div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* RIGHT: Stats + live feed */}
          <div className="col-span-3 flex flex-col gap-2 min-h-0">
            {info && (
              <Card className="rounded-none border-border shrink-0">
                <CardContent className="p-3 space-y-1">
                  <div className="text-[10px] uppercase text-muted-foreground mb-2">24h (CoinGlass)</div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <div className="text-green font-bold font-mono text-sm">{fmt(info.longVolUsd24h ?? 0)}</div>
                      <div className="text-[10px] text-muted-foreground">Лонги ликв.</div>
                    </div>
                    <div>
                      <div className="text-red font-bold font-mono text-sm">{fmt(info.shortVolUsd24h ?? 0)}</div>
                      <div className="text-[10px] text-muted-foreground">Шорты ликв.</div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Top clusters annotation */}
            {topClusters.length > 0 && (
              <Card className="rounded-none border-border shrink-0">
                <CardContent className="p-3">
                  <div className="text-[10px] uppercase text-muted-foreground mb-2">Топ кластеры</div>
                  {topClusters.map((b, i) => {
                    const isAbove = b.price > currentPrice;
                    const isBelow = b.price < currentPrice;
                    return (
                      <div key={i} className="flex justify-between items-center py-1 border-b border-border/20 last:border-0">
                        <div>
                          <div className="font-mono text-xs font-bold">${b.price.toFixed(0)}</div>
                          <div className={`text-[9px] ${isAbove ? 'text-green' : isBelow ? 'text-red' : 'text-muted-foreground'}`}>
                            {isAbove ? `↑ +${((b.price / currentPrice - 1) * 100).toFixed(1)}%` : isBelow ? `↓ -${((1 - b.price / currentPrice) * 100).toFixed(1)}%` : 'текущая'}
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-xs font-bold font-mono">{fmt(b.totalUsd)}</div>
                          <div className="text-[9px] text-muted-foreground">
                            {b.longLiqUsd > b.shortLiqUsd ? <span className="text-red">Лонги</span> : <span className="text-green">Шорты</span>}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </CardContent>
              </Card>
            )}

            <Card className="rounded-none border-border flex-1 flex flex-col min-h-0">
              <CardHeader className="p-3 pb-0 border-b border-border/50 shrink-0">
                <CardTitle className="text-xs uppercase flex justify-between">
                  <span>Live (Bybit)</span>
                  <span className="text-muted-foreground font-normal">{eventList.length}</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0 flex-1 overflow-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-card border-b border-border/50 text-muted-foreground">
                    <tr>
                      <th className="p-1.5 font-normal text-left">Время</th>
                      <th className="p-1.5 font-normal text-left">Side</th>
                      <th className="p-1.5 font-normal text-right pr-2">Сумма</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!hasEvents ? (
                      <tr><td colSpan={3} className="p-6 text-center text-muted-foreground text-[10px]">Ждём ликвидаций...</td></tr>
                    ) : (
                      eventList.map((e, i) => (
                        <tr key={i} className={`border-b border-border/20 last:border-0 ${e.side === 'long' ? 'bg-green/5' : 'bg-red/5'}`}>
                          <td className="p-1.5 text-muted-foreground font-mono text-[10px]">{format(new Date(e.timestamp), 'HH:mm:ss')}</td>
                          <td className={`p-1.5 font-bold text-[10px] ${e.side === 'long' ? 'text-green' : 'text-red'}`}>{e.side.toUpperCase()}</td>
                          <td className={`p-1.5 pr-2 text-right font-bold font-mono text-[10px] ${e.side === 'long' ? 'text-green' : 'text-red'}`}>{fmt(e.valueUsd)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </Layout>
  );
}
