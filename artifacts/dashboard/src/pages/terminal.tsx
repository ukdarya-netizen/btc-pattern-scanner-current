import { useState } from "react";
import { Layout } from "@/components/layout";
import { 
  useGetTicker, 
  useGetOrderbook, 
  useGetRecentTrades, 
  useGetCvd, 
  useGetCurrentSignal,
  useGetBotState,
  useStartBot,
  useStopBot,
  useGetExchangeStatus
} from "@workspace/api-client-react";
import { LineChart, Line, ResponsiveContainer, YAxis, Tooltip } from "recharts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { format } from "date-fns";

const EXCHANGE_COLORS: Record<string, string> = {
  Bybit: "#f7931a",
  BingX: "#2ecc71",
  OKX: "#3498db",
};

export default function Terminal() {
  const { data: ticker } = useGetTicker({ query: { refetchInterval: 1000 } });
  const { data: orderbook } = useGetOrderbook({ query: { refetchInterval: 500 } });
  const { data: trades } = useGetRecentTrades({ query: { refetchInterval: 1000 } });
  const { data: cvd } = useGetCvd({ query: { refetchInterval: 2000 } });
  const { data: signal } = useGetCurrentSignal({ query: { refetchInterval: 2000 } });
  const { data: botState } = useGetBotState({ query: { refetchInterval: 2000 } });
  const { data: exchangeStatus } = useGetExchangeStatus({ query: { refetchInterval: 5000 } });
  
  const startBot = useStartBot();
  const stopBot = useStopBot();

  const [mode, setMode] = useState<"paper" | "live">("paper");
  const [leverage, setLeverage] = useState("10");
  const [riskPct, setRiskPct] = useState("1");

  const handleStart = () => {
    startBot.mutate({ data: { mode, maxLeverage: Number(leverage), riskPct: Number(riskPct) } });
  };

  const handleStop = () => {
    stopBot.mutate({});
  };

  const isUp = (ticker?.priceChange24h ?? 0) >= 0;

  return (
    <Layout>
      <div className="grid grid-cols-12 gap-2 h-full">
        {/* Left Column: Ticker & Controls */}
        <div className="col-span-3 flex flex-col gap-2">
          <Card className="rounded-none border-border">
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-muted-foreground font-mono">BTC/USDT PERP</span>
                <div className="flex items-center gap-1.5">
                  {exchangeStatus?.exchanges.map(ex => (
                    <div key={ex.name} className="flex items-center gap-0.5" title={`${ex.name}: ${ex.connected ? 'connected' : 'offline'} ${ex.price ? `$${ex.price.toFixed(0)}` : ''}`}>
                      <div className="w-1.5 h-1.5 rounded-full" style={{
                        backgroundColor: ex.connected ? (EXCHANGE_COLORS[ex.name] ?? '#fff') : '#444',
                        boxShadow: ex.connected ? `0 0 4px ${EXCHANGE_COLORS[ex.name] ?? '#fff'}` : 'none'
                      }} />
                      <span className="text-[9px] text-muted-foreground">{ex.name.slice(0, 3)}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="text-3xl font-bold mb-1 tracking-tighter" style={{ color: isUp ? 'var(--color-green)' : 'var(--color-red)' }}>
                {ticker?.price?.toFixed(2) || '---'}
              </div>
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>24h Change</span>
                <span style={{ color: isUp ? 'var(--color-green)' : 'var(--color-red)' }}>
                  {ticker?.priceChange24h?.toFixed(2)} ({ticker?.priceChangePct24h?.toFixed(2)}%)
                </span>
              </div>
              <div className="flex justify-between text-xs text-muted-foreground mt-1">
                <span>24h Vol</span>
                <span>{ticker?.volume24h?.toFixed(2)}</span>
              </div>
              <div className="flex justify-between text-xs text-muted-foreground mt-1">
                <span>24h H/L</span>
                <span>{ticker?.high24h?.toFixed(1)} / {ticker?.low24h?.toFixed(1)}</span>
              </div>
              {exchangeStatus && (
                <div className="mt-2 pt-2 border-t border-border/30 space-y-0.5">
                  {exchangeStatus.exchanges.filter(e => e.connected && e.price).map(ex => (
                    <div key={ex.name} className="flex justify-between text-[10px]">
                      <span style={{ color: EXCHANGE_COLORS[ex.name] ?? '#aaa' }}>{ex.name}</span>
                      <span className="text-muted-foreground font-mono">${ex.price?.toFixed(1)}</span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="rounded-none border-border flex-1 flex flex-col min-h-0">
            <CardHeader className="p-3 pb-0 border-b border-border/50">
              <CardTitle className="text-xs uppercase">Bot Controls</CardTitle>
            </CardHeader>
            <CardContent className="p-4 flex flex-col gap-4">
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Mode</Label>
                <Select value={mode} onValueChange={(v: "paper"|"live") => setMode(v)} disabled={botState?.running}>
                  <SelectTrigger className="rounded-none h-8 text-xs border-border">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="rounded-none border-border">
                    <SelectItem value="paper">Paper Trading</SelectItem>
                    <SelectItem value="live" className="text-red">Live Trading</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Max Leverage (x)</Label>
                <Input 
                  type="number" 
                  value={leverage} 
                  onChange={e => setLeverage(e.target.value)}
                  disabled={botState?.running}
                  className="rounded-none h-8 text-xs border-border"
                />
              </div>

              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Risk Per Trade (%)</Label>
                <Input 
                  type="number" 
                  value={riskPct} 
                  onChange={e => setRiskPct(e.target.value)}
                  disabled={botState?.running}
                  className="rounded-none h-8 text-xs border-border"
                />
              </div>

              <div className="mt-auto pt-4">
                {botState?.running ? (
                  <Button onClick={handleStop} variant="destructive" className="w-full rounded-none font-bold">
                    STOP BOT
                  </Button>
                ) : (
                  <Button onClick={handleStart} className="w-full rounded-none font-bold bg-green hover:bg-green/80 text-black">
                    START BOT
                  </Button>
                )}
              </div>

              {botState?.running && (
                <div className="text-[10px] text-muted-foreground space-y-0.5">
                  <div className="flex justify-between">
                    <span>Mode</span>
                    <span className={botState.mode === "live" ? "text-red font-bold" : "text-green"}>{botState.mode?.toUpperCase()}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Trades</span>
                    <span>{botState.tradesExecuted}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Daily P&L</span>
                    <span style={{ color: (botState.dailyPnl ?? 0) >= 0 ? 'var(--color-green)' : 'var(--color-red)' }}>
                      ${botState.dailyPnl?.toFixed(2)}
                    </span>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
          
          <Card className="rounded-none border-border h-48 shrink-0 flex flex-col">
            <CardHeader className="p-3 pb-0 border-b border-border/50">
              <CardTitle className="text-xs uppercase">Signal Gauge</CardTitle>
            </CardHeader>
            <CardContent className="p-4 flex-1 flex flex-col items-center justify-center">
              <div className="text-center w-full">
                <div className={`text-4xl font-bold tracking-tighter ${
                  (signal?.score ?? 0) > 0.25 ? 'text-green' : (signal?.score ?? 0) < -0.25 ? 'text-red' : 'text-muted-foreground'
                }`}>
                  {(signal?.score ?? 0).toFixed(2)}
                </div>
                <div className="text-xs uppercase mt-2 font-bold tracking-widest text-muted-foreground">
                  {signal?.direction || 'NEUTRAL'}
                </div>
                <div className="w-full h-2 bg-muted mt-4 relative">
                  <div 
                    className={`absolute top-0 h-full transition-all duration-300 ${(signal?.score ?? 0) >= 0 ? 'bg-green left-1/2' : 'bg-red right-1/2'}`}
                    style={{ width: `${Math.abs(signal?.score ?? 0) * 50}%` }}
                  />
                  <div className="absolute top-[-4px] bottom-[-4px] w-[2px] bg-foreground left-1/2 -ml-[1px]" />
                </div>
                <div className="text-[10px] text-muted-foreground mt-2">
                  Confidence: {((signal?.confidence ?? 0) * 100).toFixed(0)}% | Lev: {signal?.suggestedLeverage}x
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Middle Column: Charts & Trades */}
        <div className="col-span-6 flex flex-col gap-2">
          <Card className="rounded-none border-border flex-[2] flex flex-col min-h-0">
            <CardHeader className="p-3 pb-0 border-b border-border/50 flex flex-row items-center justify-between">
              <CardTitle className="text-xs uppercase">CVD Delta</CardTitle>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground">
                  CVD: <span className={`font-mono ${(cvd?.currentCvd ?? 0) >= 0 ? 'text-green' : 'text-red'}`}>
                    {(cvd?.currentCvd ?? 0).toFixed(2)}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">
                  Trend: <span className="text-foreground">{cvd?.trend || '---'}</span>
                </span>
              </div>
            </CardHeader>
            <CardContent className="p-0 flex-1 min-h-0 relative">
              {cvd?.points && (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={cvd.points} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                    <YAxis domain={['auto', 'auto']} tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }} axisLine={false} tickLine={false} />
                    <Tooltip 
                      contentStyle={{ backgroundColor: 'var(--color-card)', border: '1px solid var(--color-border)', borderRadius: 0, fontSize: '12px' }}
                      labelFormatter={(l: string) => format(new Date(l), 'HH:mm:ss')}
                    />
                    <Line type="monotone" dataKey="cvd" stroke="var(--color-primary)" strokeWidth={2} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </CardContent>
          </Card>

          <Card className="rounded-none border-border flex-1 flex flex-col min-h-0">
            <CardHeader className="p-3 pb-0 border-b border-border/50">
              <CardTitle className="text-xs uppercase">Recent Trades</CardTitle>
            </CardHeader>
            <CardContent className="p-0 flex-1 overflow-auto">
              <table className="w-full text-right text-xs">
                <thead className="sticky top-0 bg-card border-b border-border/50 text-muted-foreground">
                  <tr>
                    <th className="p-2 font-normal text-left">Time</th>
                    <th className="p-2 font-normal text-left">Exch</th>
                    <th className="p-2 font-normal">Price</th>
                    <th className="p-2 font-normal">Size</th>
                  </tr>
                </thead>
                <tbody>
                  {trades?.trades?.slice(0, 30).map((t, i) => (
                    <tr key={i} className="hover:bg-accent/50">
                      <td className="p-1 pl-2 text-left text-muted-foreground font-mono">{format(new Date(t.timestamp), 'HH:mm:ss')}</td>
                      <td className="p-1 text-left" style={{ color: EXCHANGE_COLORS[(t as { exchange?: string }).exchange ?? ''] ?? '#777', fontSize: '10px' }}>
                        {(t as { exchange?: string }).exchange?.slice(0, 3) ?? '---'}
                      </td>
                      <td className={`p-1 font-medium font-mono ${t.side === 'buy' ? 'text-green' : 'text-red'}`}>{t.price.toFixed(1)}</td>
                      <td className="p-1 pr-2 font-mono">{t.size.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </div>

        {/* Right Column: Orderbook */}
        <Card className="col-span-3 rounded-none border-border flex flex-col min-h-0">
          <CardHeader className="p-3 pb-0 border-b border-border/50">
            <CardTitle className="text-xs uppercase flex justify-between">
              <span>Orderbook</span>
              <span className="text-muted-foreground font-normal">Spr: {orderbook?.spread?.toFixed(1)}</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0 flex-1 flex flex-col min-h-0 overflow-hidden">
            <div className="flex-1 overflow-hidden flex flex-col justify-end text-xs">
              <div className="flex-col-reverse flex">
                {orderbook?.asks.slice().reverse().map((ask, i) => {
                  const maxAsk = Math.max(...(orderbook.asks.map(a => a.total) || [1]));
                  const width = `${(ask.total / maxAsk) * 100}%`;
                  return (
                    <div key={`ask-${i}`} className="flex justify-between px-2 py-[2px] relative group hover:bg-accent/50">
                      <div className="absolute right-0 top-0 bottom-0 bg-red/10 z-0" style={{ width }} />
                      <span className="text-red z-10 font-medium font-mono">{ask.price.toFixed(1)}</span>
                      <span className="z-10 font-mono">{ask.size.toFixed(3)}</span>
                    </div>
                  );
                })}
              </div>
            </div>
            
            <div className="py-2 border-y border-border/50 text-center font-bold text-sm" style={{ color: isUp ? 'var(--color-green)' : 'var(--color-red)' }}>
              {ticker?.price?.toFixed(1)}
            </div>

            <div className="flex-1 overflow-hidden text-xs">
              {orderbook?.bids.map((bid, i) => {
                const maxBid = Math.max(...(orderbook.bids.map(b => b.total) || [1]));
                const width = `${(bid.total / maxBid) * 100}%`;
                return (
                  <div key={`bid-${i}`} className="flex justify-between px-2 py-[2px] relative group hover:bg-accent/50">
                    <div className="absolute right-0 top-0 bottom-0 bg-green/10 z-0" style={{ width }} />
                    <span className="text-green z-10 font-medium font-mono">{bid.price.toFixed(1)}</span>
                    <span className="z-10 font-mono">{bid.size.toFixed(3)}</span>
                  </div>
                );
              })}
            </div>

            {orderbook?.imbalance !== undefined && (
              <div className="border-t border-border/30 p-2 text-[10px] text-muted-foreground flex justify-between">
                <span>Imbalance</span>
                <span style={{ color: orderbook.imbalance > 0 ? 'var(--color-green)' : 'var(--color-red)' }}>
                  {(orderbook.imbalance * 100).toFixed(1)}%
                </span>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
