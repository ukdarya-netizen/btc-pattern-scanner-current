import { Layout } from "@/components/layout";
import {
  useGetLiquidationHeatmap,
  useGetLiquidationEvents,
  useGetLiquidationInfo,
  useGetLiquidationCoinalyze,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
  ComposedChart, Area,
} from "recharts";
import { format } from "date-fns";
import { useState } from "react";

function fmt(v: number) {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtBtc(v: number) {
  if (v >= 1000) return `${(v / 1000).toFixed(1)}K BTC`;
  if (v >= 1) return `${v.toFixed(2)} BTC`;
  return `${(v * 1000).toFixed(1)} mBTC`;
}

function LiqBar({ label, longUsd, shortUsd }: { label: string; longUsd: number; shortUsd: number }) {
  const total = longUsd + shortUsd;
  const longPct = total > 0 ? (longUsd / total) * 100 : 50;
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex justify-between text-[10px] text-muted-foreground mb-0.5">
        <span>{label}</span>
        <span>{fmt(total)}</span>
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

export default function Liquidations() {
  const [range, setRange] = useState<"24h" | "2h">("24h");

  const { data: heatmap } = useGetLiquidationHeatmap({ query: { refetchInterval: 3000 } });
  const { data: events } = useGetLiquidationEvents({ query: { refetchInterval: 2000 } });
  const { data: info } = useGetLiquidationInfo({ query: { refetchInterval: 60000 } });
  const { data: coinalyze } = useGetLiquidationCoinalyze(
    { range },
    { query: { refetchInterval: range === "2h" ? 60000 : 5 * 60 * 1000 } }
  );

  const summary = heatmap?.summary;
  const eventList = events?.events ?? [];
  const hasEvents = eventList.length > 0;

  const caCandles = coinalyze?.candles ?? [];
  const caChartData = caCandles.map(c => ({
    time: range === "2h"
      ? format(new Date(c.t * 1000), "HH:mm")
      : format(new Date(c.t * 1000), "dd MMM HH:mm"),
    longBtc: parseFloat(c.longBtc.toFixed(3)),
    shortBtc: -parseFloat(c.shortBtc.toFixed(3)),
    longBtcRaw: c.longBtc,
    shortBtcRaw: c.shortBtc,
  }));

  const totalLongBtc = caCandles.reduce((s, c) => s + c.longBtc, 0);
  const totalShortBtc = caCandles.reduce((s, c) => s + c.shortBtc, 0);
  const dominancePct = totalLongBtc + totalShortBtc > 0
    ? (totalShortBtc / (totalLongBtc + totalShortBtc)) * 100
    : 50;

  return (
    <Layout>
      <div className="flex flex-col gap-2 h-full">

        {/* CoinGlass Summary Bars */}
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

          {/* Left: Coinalyze chart */}
          <div className="col-span-8 flex flex-col gap-2 min-h-0">

            {/* Live WS Summary */}
            {summary && (
              <div className="grid grid-cols-4 gap-2 shrink-0">
                {[
                  { label: "5m", data: summary.last5m },
                  { label: "15m", data: summary.last15m },
                  { label: "30m", data: summary.last30m },
                  { label: "1h", data: summary.last1h },
                ].map(({ label, data }) => {
                  const total = (data.longUsd ?? 0) + (data.shortUsd ?? 0);
                  const dominance = total > 0 ? ((data.longUsd ?? 0) / total) * 100 : 50;
                  return (
                    <Card key={label} className="rounded-none border-border">
                      <CardContent className="p-3">
                        <div className="text-[10px] text-muted-foreground uppercase mb-1">{label} (Bybit WS)</div>
                        <div className="font-bold font-mono">{fmt(total)}</div>
                        <div className={`text-[10px] mt-0.5 ${dominance > 50 ? 'text-green' : 'text-red'}`}>
                          {dominance > 50 ? `Longs ${dominance.toFixed(0)}%` : `Shorts ${(100 - dominance).toFixed(0)}%`} dominant
                        </div>
                        <div className="text-[9px] text-muted-foreground">{data.count ?? 0} events</div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}

            {/* Coinalyze Chart */}
            <Card className="rounded-none border-border flex-1 flex flex-col min-h-0">
              <CardHeader className="p-3 pb-0 border-b border-border/50 shrink-0">
                <CardTitle className="text-xs uppercase flex justify-between items-center">
                  <span>
                    Liquidations — All Exchanges (Coinalyze)
                    {caCandles.length > 0 && (
                      <span className="ml-3 font-normal text-muted-foreground normal-case">
                        <span className="text-green">{fmtBtc(totalLongBtc)} longs</span>
                        {" · "}
                        <span className="text-red">{fmtBtc(totalShortBtc)} shorts</span>
                        {" · "}
                        <span className={dominancePct > 50 ? "text-red" : "text-green"}>
                          {dominancePct > 50 ? `Shorts ${dominancePct.toFixed(0)}%` : `Longs ${(100 - dominancePct).toFixed(0)}%`} dominant
                        </span>
                      </span>
                    )}
                  </span>
                  <div className="flex gap-1">
                    {(["24h", "2h"] as const).map(r => (
                      <button
                        key={r}
                        onClick={() => setRange(r)}
                        className={`px-2 py-0.5 text-[10px] border ${range === r ? "border-primary text-primary" : "border-border text-muted-foreground"}`}
                      >
                        {r === "24h" ? "24H (1h bars)" : "2H (5m bars)"}
                      </button>
                    ))}
                  </div>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0 flex-1 min-h-0">
                {caChartData.length > 0 ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart
                      data={caChartData}
                      margin={{ top: 8, right: 16, left: 8, bottom: 8 }}
                    >
                      <XAxis
                        dataKey="time"
                        tick={{ fontSize: 8, fill: 'var(--color-muted-foreground)' }}
                        axisLine={false} tickLine={false}
                        interval="preserveStartEnd"
                      />
                      <YAxis
                        tick={{ fontSize: 9, fill: 'var(--color-muted-foreground)' }}
                        axisLine={false} tickLine={false}
                        tickFormatter={v => `${Math.abs(v).toFixed(1)}`}
                      />
                      <Tooltip
                        contentStyle={{ backgroundColor: 'var(--color-card)', border: '1px solid var(--color-border)', borderRadius: 0, fontSize: '11px' }}
                        formatter={(v: number, name: string) => {
                          const abs = Math.abs(v);
                          return [
                            `${abs.toFixed(3)} BTC`,
                            name === "longBtc" ? "🟢 Longs liquidated" : "🔴 Shorts liquidated"
                          ];
                        }}
                        labelFormatter={l => `Time: ${l}`}
                      />
                      <Legend
                        iconType="square"
                        wrapperStyle={{ fontSize: '10px', paddingTop: '4px' }}
                        formatter={(v) => v === "longBtc" ? "Longs Liquidated" : "Shorts Liquidated"}
                      />
                      <Bar dataKey="longBtc" fill="var(--color-green)" fillOpacity={0.75} isAnimationActive={false} />
                      <Bar dataKey="shortBtc" fill="var(--color-red)" fillOpacity={0.75} isAnimationActive={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-full flex flex-col items-center justify-center text-muted-foreground gap-2">
                    <div className="text-sm">Загрузка данных Coinalyze...</div>
                    <div className="text-[10px]">Агрегация по всем биржам</div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Right: Events feed + 24h stats */}
          <div className="col-span-4 flex flex-col gap-2 min-h-0">
            {info && (
              <Card className="rounded-none border-border shrink-0">
                <CardContent className="p-3 space-y-1">
                  <div className="text-[10px] uppercase text-muted-foreground mb-2">24h Total (CoinGlass)</div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <div className="text-green font-bold font-mono">{fmt(info.longVolUsd24h ?? 0)}</div>
                      <div className="text-[10px] text-muted-foreground">Longs liq'd</div>
                    </div>
                    <div>
                      <div className="text-red font-bold font-mono">{fmt(info.shortVolUsd24h ?? 0)}</div>
                      <div className="text-[10px] text-muted-foreground">Shorts liq'd</div>
                    </div>
                    <div>
                      <div className="font-bold font-mono">{(info.h24Amount ?? 0).toFixed(2)} BTC</div>
                      <div className="text-[10px] text-muted-foreground">Volume 24h</div>
                    </div>
                    <div>
                      <div className="font-bold font-mono">{fmt(info.h24TotalVolUsd ?? 0)}</div>
                      <div className="text-[10px] text-muted-foreground">Total USD 24h</div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            <Card className="rounded-none border-border flex-1 flex flex-col min-h-0">
              <CardHeader className="p-3 pb-0 border-b border-border/50 shrink-0">
                <CardTitle className="text-xs uppercase flex justify-between">
                  <span>Live Feed (Bybit)</span>
                  <span className="text-muted-foreground font-normal">{eventList.length} events</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0 flex-1 overflow-auto">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-card border-b border-border/50 text-muted-foreground">
                    <tr>
                      <th className="p-2 font-normal text-left">Time</th>
                      <th className="p-2 font-normal text-left">Side</th>
                      <th className="p-2 font-normal text-right">Price</th>
                      <th className="p-2 font-normal text-right">Size</th>
                      <th className="p-2 font-normal text-right pr-3">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {!hasEvents ? (
                      <tr>
                        <td colSpan={5} className="p-8 text-center text-muted-foreground">
                          Waiting for liquidations...
                        </td>
                      </tr>
                    ) : (
                      eventList.map((e, i) => (
                        <tr key={i} className={`border-b border-border/20 last:border-0 ${e.side === 'long' ? 'bg-green/5' : 'bg-red/5'}`}>
                          <td className="p-2 text-muted-foreground font-mono">
                            {format(new Date(e.timestamp), 'HH:mm:ss')}
                          </td>
                          <td className={`p-2 font-bold ${e.side === 'long' ? 'text-green' : 'text-red'}`}>
                            {e.side.toUpperCase()}
                          </td>
                          <td className="p-2 text-right font-mono">${e.price.toFixed(1)}</td>
                          <td className="p-2 text-right font-mono">{e.size.toFixed(4)}</td>
                          <td className={`p-2 pr-3 text-right font-bold font-mono ${e.side === 'long' ? 'text-green' : 'text-red'}`}>
                            {fmt(e.valueUsd)}
                          </td>
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
