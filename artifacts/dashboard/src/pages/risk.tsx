import { Layout } from "@/components/layout";
import { useGetRiskStats, useGetPositions } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { format } from "date-fns";

export default function Risk() {
  const { data: stats } = useGetRiskStats({ query: { refetchInterval: 5000 } });
  const { data: positions } = useGetPositions({ query: { refetchInterval: 2000 } });

  const statBoxes = [
    { label: "Daily P&L", value: `$${stats?.dailyPnl?.toFixed(2) || '0.00'}`, color: (stats?.dailyPnl ?? 0) >= 0 ? 'text-green' : 'text-red' },
    { label: "Daily P&L %", value: `${stats?.dailyPnlPct?.toFixed(2) || '0.00'}%`, color: (stats?.dailyPnlPct ?? 0) >= 0 ? 'text-green' : 'text-red' },
    { label: "Max Drawdown", value: `${stats?.maxDrawdown?.toFixed(2) || '0.00'}%`, color: 'text-red' },
    { label: "Win Rate", value: `${stats?.winRate?.toFixed(1) || '0.0'}%`, color: 'text-foreground' },
    { label: "Total Trades", value: stats?.totalTrades || 0, color: 'text-foreground' },
    { label: "W/L Ratio", value: `${stats?.winningTrades || 0} / ${stats?.losingTrades || 0}`, color: 'text-foreground' },
    { label: "Avg Win", value: `$${stats?.avgWin?.toFixed(2) || '0.00'}`, color: 'text-green' },
    { label: "Avg Loss", value: `$${stats?.avgLoss?.toFixed(2) || '0.00'}`, color: 'text-red' },
    { label: "Sharpe (Intraday)", value: stats?.sharpeIntraday?.toFixed(2) || '0.00', color: 'text-primary' },
  ];

  return (
    <Layout>
      <div className="flex flex-col gap-2 h-full">
        <div className="grid grid-cols-9 gap-2 shrink-0">
          {statBoxes.map((s, i) => (
            <Card key={i} className="rounded-none border-border">
              <CardContent className="p-3">
                <div className="text-[10px] uppercase text-muted-foreground mb-1 whitespace-nowrap overflow-hidden text-ellipsis">{s.label}</div>
                <div className={`font-bold ${s.color}`}>{s.value}</div>
              </CardContent>
            </Card>
          ))}
        </div>

        <Card className="rounded-none border-border flex-1 flex flex-col min-h-0">
          <CardHeader className="p-3 border-b border-border/50">
            <CardTitle className="text-xs uppercase">Open Positions</CardTitle>
          </CardHeader>
          <CardContent className="p-0 flex-1 overflow-auto">
            <table className="w-full text-right text-xs">
              <thead className="sticky top-0 bg-card border-b border-border/50 text-muted-foreground">
                <tr>
                  <th className="p-3 font-normal text-left">Symbol</th>
                  <th className="p-3 font-normal text-left">Side</th>
                  <th className="p-3 font-normal">Size</th>
                  <th className="p-3 font-normal">Entry</th>
                  <th className="p-3 font-normal">Mark</th>
                  <th className="p-3 font-normal">Liq/SL</th>
                  <th className="p-3 font-normal">TP</th>
                  <th className="p-3 font-normal text-right">P&L</th>
                </tr>
              </thead>
              <tbody>
                {(!positions?.positions || positions.positions.length === 0) ? (
                  <tr>
                    <td colSpan={8} className="p-8 text-center text-muted-foreground">No open positions</td>
                  </tr>
                ) : (
                  positions.positions.map(p => (
                    <tr key={p.id} className="hover:bg-accent/50 border-b border-border/20 last:border-0">
                      <td className="p-3 text-left font-bold">{p.symbol} <span className="text-muted-foreground font-normal ml-1">{p.leverage}x</span></td>
                      <td className={`p-3 text-left font-bold ${p.side === 'long' ? 'text-green' : 'text-red'}`}>{p.side.toUpperCase()}</td>
                      <td className="p-3">{p.size.toFixed(4)}</td>
                      <td className="p-3">{p.entryPrice.toFixed(2)}</td>
                      <td className="p-3">{p.currentPrice.toFixed(2)}</td>
                      <td className="p-3 text-muted-foreground">{p.stopLoss?.toFixed(2) || '---'}</td>
                      <td className="p-3 text-muted-foreground">{p.takeProfit?.toFixed(2) || '---'}</td>
                      <td className={`p-3 font-bold text-right ${p.pnl >= 0 ? 'text-green' : 'text-red'}`}>
                        {p.pnl >= 0 ? '+' : ''}{p.pnl.toFixed(2)} ({p.pnlPct.toFixed(2)}%)
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
