import { useState } from "react";
import { Layout } from "@/components/layout";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  BarChart, Bar, Cell, ResponsiveContainer, XAxis, YAxis, Tooltip,
  ReferenceLine, LineChart, Line,
} from "recharts";
import { format, formatDuration, intervalToDuration } from "date-fns";

type Period = "24h" | "7d" | "30d" | "all";

interface StatsData {
  period: string;
  from: string;
  to: string;
  stats: {
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnl: number;
    avgPnl: number;
    bestTrade: number;
    worstTrade: number;
    longTrades: number;
    shortTrades: number;
    grossProfit: number;
    grossLoss: number;
    profitFactor: number;
  };
  byReason: Record<string, { count: number; pnl: number }>;
  trades: Array<{
    id: string;
    symbol: string;
    side: string;
    exchange: string;
    entryPrice: number;
    exitPrice: number;
    size: number;
    leverage: number;
    pnl: number;
    pnlPct: number;
    openedAt: string;
    closedAt: string;
    closeReason: string;
  }>;
  activeSignal: {
    side: string;
    type: string;
    entryPrice: number;
    stopLoss: number;
    takeProfit: number;
    leverage: number;
    openedAt: string;
  } | null;
}

function fmtDuration(openedAt: string, closedAt: string): string {
  const ms = new Date(closedAt).getTime() - new Date(openedAt).getTime();
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m`;
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}

const PERIOD_LABELS: Record<Period, string> = {
  "24h": "24h",
  "7d": "7 days",
  "30d": "30 days",
  "all": "All Time",
};

export default function Statistics() {
  const [period, setPeriod] = useState<Period>("all");

  const { data, isLoading } = useQuery<StatsData>({
    queryKey: ["history-stats", period],
    queryFn: () =>
      fetch(`/api/history/stats?period=${period}`).then(r => r.json()),
    refetchInterval: 15000,
  });

  const stats = data?.stats;
  const trades = data?.trades ?? [];

  // Build cumulative P&L chart (trades sorted oldest → newest)
  const sortedTrades = [...trades].sort(
    (a, b) => new Date(a.closedAt).getTime() - new Date(b.closedAt).getTime()
  );
  let cumPnl = 0;
  const cumData = sortedTrades.map((t, i) => {
    cumPnl += t.pnl;
    return { i: i + 1, pnl: t.pnl, cum: cumPnl, side: t.side };
  });

  const kpi = [
    { label: "Total Trades", value: stats?.totalTrades ?? 0, unit: "", color: "text-foreground" },
    { label: "Win Rate", value: stats ? (stats.winRate * 100).toFixed(1) : "—", unit: "%", color: (stats?.winRate ?? 0) >= 0.5 ? "text-green" : "text-red" },
    { label: "Total P&L", value: stats ? (stats.totalPnl >= 0 ? "+" : "") + stats.totalPnl.toFixed(2) : "—", unit: "$", color: (stats?.totalPnl ?? 0) >= 0 ? "text-green" : "text-red", prefix: true },
    { label: "Avg P&L", value: stats ? (stats.avgPnl >= 0 ? "+" : "") + stats.avgPnl.toFixed(2) : "—", unit: "$", color: (stats?.avgPnl ?? 0) >= 0 ? "text-green" : "text-red", prefix: true },
    { label: "Best Trade", value: stats ? "+" + stats.bestTrade.toFixed(2) : "—", unit: "$", color: "text-green", prefix: true },
    { label: "Worst Trade", value: stats ? stats.worstTrade.toFixed(2) : "—", unit: "$", color: "text-red", prefix: true },
    { label: "Profit Factor", value: stats ? (stats.profitFactor >= 9999 ? "∞" : stats.profitFactor.toFixed(2)) : "—", unit: "x", color: (stats?.profitFactor ?? 0) >= 1.5 ? "text-green" : (stats?.profitFactor ?? 0) >= 1 ? "text-yellow-400" : "text-red" },
    { label: "W / L", value: stats ? `${stats.wins} / ${stats.losses}` : "—", unit: "", color: "text-foreground" },
    { label: "Long / Short", value: stats ? `${stats.longTrades} / ${stats.shortTrades}` : "—", unit: "", color: "text-foreground" },
    { label: "Gross Profit", value: stats ? "+" + stats.grossProfit.toFixed(2) : "—", unit: "$", color: "text-green", prefix: true },
    { label: "Gross Loss", value: stats ? stats.grossLoss.toFixed(2) : "—", unit: "$", color: "text-red", prefix: true },
  ];

  const reasonColors: Record<string, string> = {
    tp: "text-green",
    sl: "text-red",
    signal: "text-yellow-400",
    manual: "text-muted-foreground",
  };

  const reasonLabels: Record<string, string> = {
    tp: "TP Hit 🎯",
    sl: "SL Hit 🛑",
    signal: "Reversal ↩️",
    manual: "Manual",
  };

  return (
    <Layout>
      <div className="flex flex-col gap-2 h-full">
        {/* Header + Period tabs */}
        <div className="flex items-center justify-between shrink-0">
          <div className="text-xs uppercase text-muted-foreground tracking-widest">Signal Statistics</div>
          <div className="flex gap-1">
            {(["24h", "7d", "30d", "all"] as Period[]).map(p => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`px-3 py-1 text-xs border rounded-none transition-colors ${
                  period === p
                    ? "bg-primary text-background border-primary font-bold"
                    : "border-border text-muted-foreground hover:text-foreground hover:border-foreground"
                }`}
              >
                {PERIOD_LABELS[p]}
              </button>
            ))}
          </div>
        </div>

        {/* Active signal banner */}
        {data?.activeSignal && (
          <div className={`px-4 py-2 flex items-center gap-4 text-xs border shrink-0 ${
            data.activeSignal.side === "long"
              ? "bg-green/10 border-green/30 text-green"
              : "bg-red/10 border-red/30 text-red"
          }`}>
            <span className="font-bold uppercase animate-pulse">● ACTIVE SIGNAL</span>
            <span>{data.activeSignal.side.toUpperCase()} @ ${data.activeSignal.entryPrice.toFixed(1)}</span>
            <span className="text-muted-foreground">SL ${data.activeSignal.stopLoss.toFixed(1)}</span>
            <span className="text-muted-foreground">TP ${data.activeSignal.takeProfit.toFixed(1)}</span>
            <span className="text-muted-foreground">{data.activeSignal.leverage}x</span>
            <span className="text-muted-foreground ml-auto">
              Opened {format(new Date(data.activeSignal.openedAt), "HH:mm:ss")}
            </span>
          </div>
        )}

        {/* KPI grid */}
        <div className="grid grid-cols-11 gap-2 shrink-0">
          {kpi.map((k, i) => (
            <Card key={i} className="rounded-none border-border">
              <CardContent className="p-3">
                <div className="text-[10px] uppercase text-muted-foreground mb-1 whitespace-nowrap overflow-hidden">{k.label}</div>
                <div className={`font-bold font-mono text-sm ${k.color}`}>
                  {isLoading ? "…" : k.prefix ? k.value : `${k.value}${k.unit}`}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="grid grid-cols-12 gap-2 flex-1 min-h-0">
          {/* Left: charts */}
          <div className="col-span-8 flex flex-col gap-2 min-h-0">
            {/* Cumulative P&L chart */}
            <Card className="rounded-none border-border shrink-0">
              <CardHeader className="p-3 pb-0 border-b border-border/50">
                <CardTitle className="text-xs uppercase flex justify-between">
                  <span>Cumulative P&L</span>
                  <span className={`font-mono text-sm ${(stats?.totalPnl ?? 0) >= 0 ? "text-green" : "text-red"}`}>
                    {stats ? `${stats.totalPnl >= 0 ? "+" : ""}$${stats.totalPnl.toFixed(2)}` : ""}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {cumData.length === 0 ? (
                  <div className="h-28 flex items-center justify-center text-muted-foreground text-xs">
                    {isLoading ? "Loading…" : "No closed signals in this period"}
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={130}>
                    <LineChart data={cumData} margin={{ top: 8, right: 12, left: -10, bottom: 0 }}>
                      <XAxis dataKey="i" tick={{ fontSize: 9, fill: "var(--color-muted-foreground)" }} axisLine={false} tickLine={false} />
                      <YAxis
                        tick={{ fontSize: 9, fill: "var(--color-muted-foreground)" }}
                        axisLine={false} tickLine={false}
                        tickFormatter={v => `$${v.toFixed(0)}`}
                      />
                      <ReferenceLine y={0} stroke="var(--color-border)" />
                      <Tooltip
                        contentStyle={{ backgroundColor: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: 0, fontSize: 11 }}
                        formatter={(v: number, name: string) => [`$${v.toFixed(2)}`, name === "cum" ? "Cumulative" : "Trade P&L"]}
                        labelFormatter={l => `Trade #${l}`}
                      />
                      <Line type="monotone" dataKey="cum" stroke="var(--color-primary)" strokeWidth={2} dot={false} isAnimationActive={false} name="cum" />
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            {/* Per-trade P&L bars */}
            <Card className="rounded-none border-border shrink-0">
              <CardHeader className="p-3 pb-0 border-b border-border/50">
                <CardTitle className="text-xs uppercase">Per-Trade P&L</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {cumData.length === 0 ? (
                  <div className="h-20 flex items-center justify-center text-muted-foreground text-xs">No data</div>
                ) : (
                  <ResponsiveContainer width="100%" height={110}>
                    <BarChart data={cumData} margin={{ top: 6, right: 12, left: -10, bottom: 0 }}>
                      <XAxis dataKey="i" tick={{ fontSize: 9, fill: "var(--color-muted-foreground)" }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fontSize: 9, fill: "var(--color-muted-foreground)" }} axisLine={false} tickLine={false} tickFormatter={v => `$${v.toFixed(0)}`} />
                      <ReferenceLine y={0} stroke="var(--color-border)" />
                      <Tooltip
                        contentStyle={{ backgroundColor: "var(--color-card)", border: "1px solid var(--color-border)", borderRadius: 0, fontSize: 11 }}
                        formatter={(v: number) => [`$${v.toFixed(2)}`, "P&L"]}
                        labelFormatter={l => `Trade #${l}`}
                      />
                      <Bar dataKey="pnl" radius={0} isAnimationActive={false}>
                        {cumData.map((entry, i) => (
                          <Cell key={i} fill={entry.pnl >= 0 ? "var(--color-green)" : "var(--color-red)"} fillOpacity={0.85} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            {/* Trade table */}
            <Card className="rounded-none border-border flex flex-col flex-1 min-h-0">
              <CardHeader className="p-3 pb-0 border-b border-border/50 shrink-0">
                <CardTitle className="text-xs uppercase flex justify-between">
                  <span>Signal History</span>
                  <span className="text-muted-foreground font-normal">{trades.length} signals</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0 flex-1 overflow-auto">
                <table className="w-full text-right text-xs">
                  <thead className="sticky top-0 bg-card border-b border-border/50 text-muted-foreground">
                    <tr>
                      <th className="p-2 font-normal text-left">Date</th>
                      <th className="p-2 font-normal text-left">Side</th>
                      <th className="p-2 font-normal">Entry</th>
                      <th className="p-2 font-normal">Exit</th>
                      <th className="p-2 font-normal">Δ%</th>
                      <th className="p-2 font-normal">Lev</th>
                      <th className="p-2 font-normal">Duration</th>
                      <th className="p-2 font-normal">Reason</th>
                      <th className="p-2 font-normal pr-3">P&L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trades.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="p-8 text-center text-muted-foreground">
                          {isLoading ? "Loading…" : "No signals in this period"}
                        </td>
                      </tr>
                    ) : (
                      [...trades]
                        .sort((a, b) => new Date(b.closedAt).getTime() - new Date(a.closedAt).getTime())
                        .map((t, i) => {
                          const priceDelta = ((t.exitPrice - t.entryPrice) / t.entryPrice * 100) * (t.side === "short" ? -1 : 1);
                          return (
                            <tr key={t.id ?? i} className="hover:bg-accent/50 border-b border-border/20 last:border-0">
                              <td className="p-2 pl-3 text-left text-muted-foreground font-mono whitespace-nowrap">
                                {format(new Date(t.closedAt), "MM/dd HH:mm")}
                              </td>
                              <td className={`p-2 text-left font-bold ${t.side === "long" ? "text-green" : "text-red"}`}>
                                {t.side.toUpperCase()}
                              </td>
                              <td className="p-2 font-mono">{t.entryPrice.toFixed(1)}</td>
                              <td className="p-2 font-mono">{t.exitPrice.toFixed(1)}</td>
                              <td className={`p-2 font-mono ${priceDelta >= 0 ? "text-green" : "text-red"}`}>
                                {priceDelta >= 0 ? "+" : ""}{priceDelta.toFixed(2)}%
                              </td>
                              <td className="p-2 text-muted-foreground">{t.leverage}x</td>
                              <td className="p-2 text-muted-foreground font-mono">
                                {t.openedAt ? fmtDuration(t.openedAt, t.closedAt) : "—"}
                              </td>
                              <td className={`p-2 uppercase text-[10px] ${reasonColors[t.closeReason] ?? "text-muted-foreground"}`}>
                                {reasonLabels[t.closeReason] ?? t.closeReason}
                              </td>
                              <td className={`p-2 pr-3 font-bold font-mono ${t.pnl >= 0 ? "text-green" : "text-red"}`}>
                                {t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)}
                              </td>
                            </tr>
                          );
                        })
                    )}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </div>

          {/* Right: breakdown */}
          <div className="col-span-4 flex flex-col gap-2 min-h-0">
            {/* Close reason breakdown */}
            <Card className="rounded-none border-border shrink-0">
              <CardHeader className="p-3 pb-1 border-b border-border/50">
                <CardTitle className="text-xs uppercase">Close Reasons</CardTitle>
              </CardHeader>
              <CardContent className="p-3 space-y-2">
                {Object.entries(data?.byReason ?? {}).length === 0 ? (
                  <div className="text-muted-foreground text-xs">No data</div>
                ) : (
                  Object.entries(data?.byReason ?? {})
                    .sort((a, b) => b[1].count - a[1].count)
                    .map(([reason, info]) => (
                      <div key={reason} className="flex justify-between items-center text-xs">
                        <span className={reasonColors[reason] ?? "text-muted-foreground"}>
                          {reasonLabels[reason] ?? reason}
                        </span>
                        <div className="flex gap-3 items-center">
                          <span className="text-muted-foreground">{info.count}x</span>
                          <span className={`font-mono font-bold ${info.pnl >= 0 ? "text-green" : "text-red"}`}>
                            {info.pnl >= 0 ? "+" : ""}${info.pnl.toFixed(2)}
                          </span>
                        </div>
                      </div>
                    ))
                )}
              </CardContent>
            </Card>

            {/* Win/Loss analysis */}
            <Card className="rounded-none border-border shrink-0">
              <CardHeader className="p-3 pb-1 border-b border-border/50">
                <CardTitle className="text-xs uppercase">Win / Loss Analysis</CardTitle>
              </CardHeader>
              <CardContent className="p-3 space-y-2 text-xs">
                {[
                  { label: "Winners", value: stats?.wins ?? 0, total: stats?.totalTrades ?? 0, color: "bg-green" },
                  { label: "Losers", value: stats?.losses ?? 0, total: stats?.totalTrades ?? 0, color: "bg-red" },
                ].map(row => (
                  <div key={row.label}>
                    <div className="flex justify-between mb-1">
                      <span className="text-muted-foreground">{row.label}</span>
                      <span className="font-mono">{row.value} / {row.total}</span>
                    </div>
                    <div className="h-1.5 bg-border rounded-none overflow-hidden">
                      <div
                        className={`h-full ${row.color} opacity-70`}
                        style={{ width: row.total > 0 ? `${(row.value / row.total) * 100}%` : "0%" }}
                      />
                    </div>
                  </div>
                ))}

                <div className="pt-2 border-t border-border/30 space-y-1.5">
                  {[
                    { label: "Gross Profit", value: `+$${stats?.grossProfit?.toFixed(2) ?? "0.00"}`, color: "text-green" },
                    { label: "Gross Loss", value: `$${stats?.grossLoss?.toFixed(2) ?? "0.00"}`, color: "text-red" },
                    { label: "Profit Factor", value: stats?.profitFactor != null ? (stats.profitFactor >= 9999 ? "∞" : `${stats.profitFactor.toFixed(2)}x`) : "—", color: (stats?.profitFactor ?? 0) >= 1 ? "text-green" : "text-red" },
                  ].map(row => (
                    <div key={row.label} className="flex justify-between">
                      <span className="text-muted-foreground">{row.label}</span>
                      <span className={`font-mono font-bold ${row.color}`}>{isLoading ? "…" : row.value}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            {/* Direction breakdown */}
            <Card className="rounded-none border-border shrink-0">
              <CardHeader className="p-3 pb-1 border-b border-border/50">
                <CardTitle className="text-xs uppercase">Direction Breakdown</CardTitle>
              </CardHeader>
              <CardContent className="p-3 space-y-2 text-xs">
                {["long", "short"].map(dir => {
                  const dirTrades = trades.filter(t => t.side === dir);
                  const dirWins = dirTrades.filter(t => t.pnl > 0).length;
                  const dirPnl = dirTrades.reduce((s, t) => s + t.pnl, 0);
                  return (
                    <div key={dir} className="flex justify-between items-center">
                      <span className={dir === "long" ? "text-green font-bold" : "text-red font-bold"}>
                        {dir.toUpperCase()}
                      </span>
                      <div className="flex gap-3 text-right">
                        <span className="text-muted-foreground">{dirTrades.length} signals</span>
                        <span className="text-muted-foreground">{dirTrades.length > 0 ? Math.round(dirWins / dirTrades.length * 100) : 0}% WR</span>
                        <span className={`font-mono font-bold ${dirPnl >= 0 ? "text-green" : "text-red"}`}>
                          {dirPnl >= 0 ? "+" : ""}${dirPnl.toFixed(2)}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>

            {/* Recent signals list (compact) */}
            <Card className="rounded-none border-border flex flex-col flex-1 min-h-0">
              <CardHeader className="p-3 pb-0 border-b border-border/50 shrink-0">
                <CardTitle className="text-xs uppercase">Last 5 Signals</CardTitle>
              </CardHeader>
              <CardContent className="p-3 flex-1 overflow-auto space-y-2">
                {trades.length === 0 ? (
                  <div className="text-muted-foreground text-xs">No signals yet</div>
                ) : (
                  [...trades]
                    .sort((a, b) => new Date(b.closedAt).getTime() - new Date(a.closedAt).getTime())
                    .slice(0, 5)
                    .map((t, i) => (
                      <div key={t.id ?? i} className="border border-border/30 p-2 text-xs space-y-1">
                        <div className="flex justify-between">
                          <span className={`font-bold ${t.side === "long" ? "text-green" : "text-red"}`}>
                            {t.side.toUpperCase()}
                          </span>
                          <span className={`font-mono font-bold ${t.pnl >= 0 ? "text-green" : "text-red"}`}>
                            {t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(2)}
                          </span>
                        </div>
                        <div className="flex justify-between text-muted-foreground">
                          <span>${t.entryPrice.toFixed(1)} → ${t.exitPrice.toFixed(1)}</span>
                          <span className={reasonColors[t.closeReason] ?? "text-muted-foreground"}>
                            {reasonLabels[t.closeReason] ?? t.closeReason}
                          </span>
                        </div>
                        <div className="text-[10px] text-muted-foreground">
                          {format(new Date(t.closedAt), "MM/dd HH:mm")} · {t.leverage}x · {fmtDuration(t.openedAt, t.closedAt)}
                        </div>
                      </div>
                    ))
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </Layout>
  );
}
