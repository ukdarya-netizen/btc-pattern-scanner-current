import { Layout } from "@/components/layout";
import {
  useGetRiskStats, useGetPositions,
  useGetTradeHistory, useGetPnlChart, useGetAccountBalance
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AreaChart, Area, ResponsiveContainer, YAxis, XAxis, Tooltip, ReferenceLine } from "recharts";
import { format } from "date-fns";

function CircuitBreakerBadge({ tripped, cooldownUntil }: { tripped: boolean; cooldownUntil?: string | null }) {
  if (!tripped) {
    return (
      <div className="flex items-center gap-1.5">
        <div className="w-2 h-2 rounded-full bg-green animate-pulse" />
        <span className="text-xs text-green font-mono">ARMED</span>
      </div>
    );
  }
  const remaining = cooldownUntil
    ? Math.max(0, Math.round((new Date(cooldownUntil).getTime() - Date.now()) / 60000))
    : 0;
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-2 h-2 rounded-full bg-red" />
      <span className="text-xs text-red font-mono">TRIPPED — cooldown {remaining}m</span>
    </div>
  );
}

export default function Risk() {
  const { data: stats } = useGetRiskStats({ query: { refetchInterval: 5000 } });
  const { data: positions } = useGetPositions({ query: { refetchInterval: 2000 } });
  const { data: history } = useGetTradeHistory({ query: { refetchInterval: 10000 } });
  const { data: pnlChart } = useGetPnlChart({ query: { refetchInterval: 30000 } });
  const { data: balance } = useGetAccountBalance({ query: { refetchInterval: 30000 } });

  const statBoxes = [
    { label: "Balance", value: `$${balance?.total?.toFixed(2) ?? '---'}`, color: 'text-foreground' },
    { label: "Daily P&L", value: `$${stats?.dailyPnl?.toFixed(2) || '0.00'}`, color: (stats?.dailyPnl ?? 0) >= 0 ? 'text-green' : 'text-red' },
    { label: "Daily %", value: `${((stats?.dailyPnlPct ?? 0) * 100).toFixed(2)}%`, color: (stats?.dailyPnlPct ?? 0) >= 0 ? 'text-green' : 'text-red' },
    { label: "Drawdown", value: `${((stats?.maxDrawdown ?? 0) * 100).toFixed(2)}%`, color: 'text-red' },
    { label: "Win Rate", value: `${((stats?.winRate ?? 0) * 100).toFixed(1)}%`, color: 'text-foreground' },
    { label: "Trades", value: stats?.totalTrades || 0, color: 'text-foreground' },
    { label: "W / L", value: `${stats?.winningTrades || 0} / ${stats?.losingTrades || 0}`, color: 'text-foreground' },
    { label: "Avg Win", value: `$${stats?.avgWin?.toFixed(2) || '0.00'}`, color: 'text-green' },
    { label: "Avg Loss", value: `$${stats?.avgLoss?.toFixed(2) || '0.00'}`, color: 'text-red' },
    { label: "Sharpe", value: stats?.sharpeIntraday?.toFixed(2) || '0.00', color: 'text-primary' },
  ];

  const chartData = pnlChart?.points ?? [];
  const hasChartData = chartData.length > 0;
  const minEquity = hasChartData ? Math.min(...chartData.map(p => p.equity)) : 0;
  const maxEquity = hasChartData ? Math.max(...chartData.map(p => p.equity)) : 10000;

  return (
    <Layout>
      <div className="flex flex-col gap-2 h-full">
        {/* Stats Row */}
        <div className="grid grid-cols-10 gap-2 shrink-0">
          {statBoxes.map((s, i) => (
            <Card key={i} className="rounded-none border-border">
              <CardContent className="p-3">
                <div className="text-[10px] uppercase text-muted-foreground mb-1 whitespace-nowrap overflow-hidden">{s.label}</div>
                <div className={`font-bold font-mono text-sm ${s.color}`}>{s.value}</div>
              </CardContent>
            </Card>
          ))}
        </div>

        <div className="grid grid-cols-12 gap-2 flex-1 min-h-0">
          {/* Left: P&L Chart + Positions */}
          <div className="col-span-8 flex flex-col gap-2 min-h-0">
            {/* Equity Curve */}
            <Card className="rounded-none border-border flex flex-col" style={{ height: '220px' }}>
              <CardHeader className="p-3 pb-0 border-b border-border/50 flex flex-row items-center justify-between shrink-0">
                <CardTitle className="text-xs uppercase">Equity Curve</CardTitle>
                <div className="flex items-center gap-4">
                  <CircuitBreakerBadge
                    tripped={stats?.circuitBreakerTripped ?? false}
                    cooldownUntil={stats?.cooldownUntil}
                  />
                  <span className="text-[10px] text-muted-foreground">24h</span>
                </div>
              </CardHeader>
              <CardContent className="p-0 flex-1 min-h-0">
                {hasChartData ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
                      <defs>
                        <linearGradient id="equityGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="var(--color-green)" stopOpacity={0.3} />
                          <stop offset="95%" stopColor="var(--color-green)" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <XAxis
                        dataKey="ts"
                        tick={{ fontSize: 9, fill: 'var(--color-muted-foreground)' }}
                        axisLine={false} tickLine={false}
                        tickFormatter={v => format(new Date(v), 'HH:mm')}
                        interval="preserveStartEnd"
                      />
                      <YAxis
                        domain={[minEquity * 0.999, maxEquity * 1.001]}
                        tick={{ fontSize: 9, fill: 'var(--color-muted-foreground)' }}
                        axisLine={false} tickLine={false}
                        tickFormatter={v => `$${v.toFixed(0)}`}
                      />
                      <Tooltip
                        contentStyle={{ backgroundColor: 'var(--color-card)', border: '1px solid var(--color-border)', borderRadius: 0, fontSize: '11px' }}
                        labelFormatter={l => format(new Date(String(l)), 'HH:mm:ss')}
                        formatter={(v: number) => [`$${v.toFixed(2)}`, 'Equity']}
                      />
                      <ReferenceLine y={balance?.total ?? 10000} stroke="var(--color-muted-foreground)" strokeDasharray="3 3" />
                      <Area
                        type="monotone" dataKey="equity"
                        stroke="var(--color-green)" strokeWidth={2}
                        fill="url(#equityGradient)" dot={false} isAnimationActive={false}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="h-full flex items-center justify-center text-muted-foreground text-sm">
                    Start the bot to see your equity curve
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Open Positions */}
            <Card className="rounded-none border-border flex flex-col min-h-0 flex-1">
              <CardHeader className="p-3 pb-0 border-b border-border/50 shrink-0">
                <CardTitle className="text-xs uppercase flex justify-between">
                  <span>Open Positions</span>
                  <span className="text-muted-foreground font-normal">
                    {positions?.positions?.length ?? 0} active
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0 flex-1 overflow-auto">
                <table className="w-full text-right text-xs">
                  <thead className="sticky top-0 bg-card border-b border-border/50 text-muted-foreground">
                    <tr>
                      <th className="p-2 font-normal text-left">Symbol</th>
                      <th className="p-2 font-normal text-left">Side</th>
                      <th className="p-2 font-normal">Size</th>
                      <th className="p-2 font-normal">Entry</th>
                      <th className="p-2 font-normal">Mark</th>
                      <th className="p-2 font-normal">SL</th>
                      <th className="p-2 font-normal">TP</th>
                      <th className="p-2 font-normal">Opened</th>
                      <th className="p-2 font-normal pr-3">P&L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(!positions?.positions || positions.positions.length === 0) ? (
                      <tr>
                        <td colSpan={9} className="p-8 text-center text-muted-foreground">No open positions</td>
                      </tr>
                    ) : (
                      positions.positions.map(p => (
                        <tr key={p.id} className="hover:bg-accent/50 border-b border-border/20 last:border-0">
                          <td className="p-2 pl-3 text-left font-bold">{p.symbol} <span className="text-muted-foreground font-normal">{p.leverage}x</span></td>
                          <td className={`p-2 text-left font-bold ${p.side === 'long' ? 'text-green' : 'text-red'}`}>{p.side.toUpperCase()}</td>
                          <td className="p-2 font-mono">{p.size.toFixed(4)}</td>
                          <td className="p-2 font-mono">{p.entryPrice.toFixed(2)}</td>
                          <td className="p-2 font-mono">{p.currentPrice.toFixed(2)}</td>
                          <td className="p-2 text-muted-foreground font-mono">{p.stopLoss?.toFixed(2) || '---'}</td>
                          <td className="p-2 text-muted-foreground font-mono">{p.takeProfit?.toFixed(2) || '---'}</td>
                          <td className="p-2 text-muted-foreground font-mono">{format(new Date(p.openedAt), 'HH:mm:ss')}</td>
                          <td className={`p-2 pr-3 font-bold ${p.pnl >= 0 ? 'text-green' : 'text-red'}`}>
                            {p.pnl >= 0 ? '+' : ''}{p.pnl.toFixed(2)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </div>

          {/* Right: Balance + Trade History */}
          <div className="col-span-4 flex flex-col gap-2 min-h-0">
            {/* Balance Card */}
            <Card className="rounded-none border-border shrink-0">
              <CardHeader className="p-3 pb-1 border-b border-border/50">
                <CardTitle className="text-xs uppercase">Account Balance</CardTitle>
              </CardHeader>
              <CardContent className="p-3">
                <div className="text-2xl font-bold font-mono mb-1">
                  ${balance?.total?.toFixed(2) ?? '---'}
                  <span className="text-xs text-muted-foreground ml-2 font-normal">USDT</span>
                </div>
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Available</span>
                  <span className="font-mono">${balance?.available?.toFixed(2) ?? '---'}</span>
                </div>
                {balance?.byExchange && Object.keys(balance.byExchange).length > 0 && (
                  <div className="mt-2 pt-2 border-t border-border/30 space-y-0.5">
                    {Object.entries(balance.byExchange).map(([name, b]) => (
                      <div key={name} className="flex justify-between text-[10px]">
                        <span className="text-muted-foreground">{name}</span>
                        <span className="font-mono">${(b as { total: number }).total?.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Daily DB stats */}
            {history?.stats && (
              <Card className="rounded-none border-border shrink-0">
                <CardContent className="p-3">
                  <div className="text-[10px] uppercase text-muted-foreground mb-2">Today from DB</div>
                  <div className="grid grid-cols-3 gap-2 text-center text-xs">
                    <div>
                      <div className="font-bold font-mono">{history.stats.totalTrades}</div>
                      <div className="text-muted-foreground text-[10px]">Trades</div>
                    </div>
                    <div>
                      <div className="font-bold font-mono">{history.stats.wins}</div>
                      <div className="text-muted-foreground text-[10px]">Wins</div>
                    </div>
                    <div>
                      <div className={`font-bold font-mono ${(history.stats.totalPnl ?? 0) >= 0 ? 'text-green' : 'text-red'}`}>
                        ${(history.stats.totalPnl ?? 0).toFixed(2)}
                      </div>
                      <div className="text-muted-foreground text-[10px]">P&L</div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Trade History */}
            <Card className="rounded-none border-border flex flex-col min-h-0 flex-1">
              <CardHeader className="p-3 pb-0 border-b border-border/50 shrink-0">
                <CardTitle className="text-xs uppercase flex justify-between">
                  <span>Trade History</span>
                  <span className="text-muted-foreground font-normal">{history?.trades?.length ?? 0} trades</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0 flex-1 overflow-auto">
                <table className="w-full text-right text-xs">
                  <thead className="sticky top-0 bg-card border-b border-border/50 text-muted-foreground">
                    <tr>
                      <th className="p-2 font-normal text-left">Time</th>
                      <th className="p-2 font-normal text-left">Side</th>
                      <th className="p-2 font-normal">Entry</th>
                      <th className="p-2 font-normal">Exit</th>
                      <th className="p-2 font-normal">Reason</th>
                      <th className="p-2 font-normal pr-3">P&L</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(!history?.trades || history.trades.length === 0) ? (
                      <tr>
                        <td colSpan={6} className="p-8 text-center text-muted-foreground">No closed trades yet</td>
                      </tr>
                    ) : (
                      history.trades.map((t, i) => (
                        <tr key={i} className="hover:bg-accent/50 border-b border-border/20 last:border-0">
                          <td className="p-2 pl-3 text-left text-muted-foreground font-mono">
                            {format(new Date(t.closedAt), 'HH:mm:ss')}
                          </td>
                          <td className={`p-2 text-left font-bold ${t.side === 'long' ? 'text-green' : 'text-red'}`}>
                            {t.side.toUpperCase()}
                          </td>
                          <td className="p-2 font-mono">{t.entryPrice.toFixed(1)}</td>
                          <td className="p-2 font-mono">{t.exitPrice.toFixed(1)}</td>
                          <td className="p-2 text-muted-foreground uppercase text-[10px]">{t.closeReason}</td>
                          <td className={`p-2 pr-3 font-bold font-mono ${t.pnl >= 0 ? 'text-green' : 'text-red'}`}>
                            {t.pnl >= 0 ? '+' : ''}{t.pnl.toFixed(2)}
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
