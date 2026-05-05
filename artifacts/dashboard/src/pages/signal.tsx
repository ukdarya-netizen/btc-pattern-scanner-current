import { Layout } from "@/components/layout";
import { useGetCurrentSignal, useGetPatternResult } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LineChart, Line, ResponsiveContainer, Tooltip, ReferenceLine, XAxis } from "recharts";

function MiniReturnChart({
  current,
  historical,
  forward,
}: {
  current: number[];
  historical: number[];
  forward: number[];
}) {
  const data = current.map((v, i) => ({
    day: i - current.length + 1,
    current: parseFloat((v * 100).toFixed(3)),
    historical: parseFloat((historical[i] * 100).toFixed(3)),
  }));
  const fwdData = forward.map((v, i) => ({
    day: i + 1,
    forward: parseFloat((v * 100).toFixed(3)),
  }));

  return (
    <div className="flex gap-1 h-12">
      <div className="flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 2, right: 2, left: 0, bottom: 2 }}>
            <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" />
            <Line type="monotone" dataKey="current" stroke="#60a5fa" strokeWidth={1.5} dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="historical" stroke="#a78bfa" strokeWidth={1} dot={false} strokeDasharray="3 2" isAnimationActive={false} />
            <Tooltip
              contentStyle={{ backgroundColor: '#1a1a2e', border: '1px solid #333', fontSize: '10px', padding: '2px 6px' }}
              formatter={(v: number) => [`${v}%`, ""]}
              labelFormatter={l => `День ${l}`}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <div className="w-16 border-l border-border/30">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={fwdData} margin={{ top: 2, right: 2, left: 2, bottom: 2 }}>
            <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" />
            <Line
              type="monotone"
              dataKey="forward"
              stroke={fwdData.reduce((s, d) => s + d.forward, 0) >= 0 ? "#4ade80" : "#f87171"}
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export default function Signal() {
  const { data: signal } = useGetCurrentSignal({ query: { refetchInterval: 2000 } });
  const { data: pattern } = useGetPatternResult({ query: { refetchInterval: 30000 } });

  const price = signal
    ? ((signal.suggestedSl + signal.suggestedTp) / 2)
    : 0;

  const slPct = signal && price > 0
    ? Math.abs((signal.suggestedSl - price) / price * 100).toFixed(3)
    : "—";
  const tpPct = signal && price > 0
    ? Math.abs((signal.suggestedTp - price) / price * 100).toFixed(3)
    : "—";

  const atrLabel = signal && signal.atrPct > 0
    ? `${signal.atrPct.toFixed(3)}% → ${signal.suggestedLeverage}x плечо`
    : "накапливается...";

  const vwapDiff = signal && signal.vwap > 0 && price > 0
    ? ((price - signal.vwap) / signal.vwap * 100)
    : null;

  const patternLoading = !pattern || (pattern as { loading?: boolean }).loading;

  return (
    <Layout>
      <div className="flex flex-col gap-2 h-full max-w-5xl mx-auto w-full">

        {/* Score header */}
        <Card className="rounded-none border-border shrink-0">
          <CardContent className="p-6 flex items-center justify-between">
            <div>
              <div className="text-xs text-muted-foreground uppercase mb-1">Composite Score</div>
              <div className={`text-5xl font-bold tracking-tighter ${
                (signal?.score ?? 0) > 0.25 ? "text-green-400" :
                (signal?.score ?? 0) < -0.25 ? "text-red-400" : "text-foreground"
              }`}>
                {(signal?.score ?? 0) >= 0 ? "+" : ""}{(signal?.score ?? 0).toFixed(4)}
              </div>
              <div className="text-xs text-muted-foreground mt-1">Вход при |score| &gt; 0.35</div>
            </div>
            <div className="text-right">
              <div className="text-xs text-muted-foreground uppercase mb-1">Направление</div>
              <div className={`text-2xl font-bold uppercase tracking-widest ${
                signal?.direction === "long" ? "text-green-400" :
                signal?.direction === "short" ? "text-red-400" : "text-muted-foreground"
              }`}>
                {signal?.direction === "long" ? "▲ LONG" :
                 signal?.direction === "short" ? "▼ SHORT" : "— НЕЙТРАЛЬНО"}
              </div>
              <div className="text-muted-foreground text-sm mt-1">
                Уверенность: {((signal?.confidence ?? 0) * 100).toFixed(1)}%
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Metrics row */}
        <div className="grid grid-cols-5 gap-2 shrink-0">
          <Card className="rounded-none border-border">
            <CardContent className="p-3">
              <div className="text-xs text-muted-foreground uppercase mb-1">Плечо</div>
              <div className="text-lg font-bold">{signal?.suggestedLeverage ?? "—"}x</div>
              <div className="text-xs text-muted-foreground">ATR-адаптив</div>
            </CardContent>
          </Card>
          <Card className="rounded-none border-border">
            <CardContent className="p-3">
              <div className="text-xs text-muted-foreground uppercase mb-1">Stop Loss</div>
              <div className="text-lg font-bold text-red-400">${signal?.suggestedSl.toFixed(1) ?? "—"}</div>
              <div className="text-xs text-muted-foreground">-{slPct}%</div>
            </CardContent>
          </Card>
          <Card className="rounded-none border-border">
            <CardContent className="p-3">
              <div className="text-xs text-muted-foreground uppercase mb-1">Take Profit</div>
              <div className="text-lg font-bold text-green-400">${signal?.suggestedTp.toFixed(1) ?? "—"}</div>
              <div className="text-xs text-muted-foreground">+{tpPct}%</div>
            </CardContent>
          </Card>
          <Card className="rounded-none border-border">
            <CardContent className="p-3">
              <div className="text-xs text-muted-foreground uppercase mb-1">ATR (14)</div>
              <div className="text-lg font-bold">{signal?.atrPct && signal.atrPct > 0 ? `${signal.atrPct.toFixed(3)}%` : "—"}</div>
              <div className="text-xs text-muted-foreground">волатильность</div>
            </CardContent>
          </Card>
          <Card className="rounded-none border-border">
            <CardContent className="p-3">
              <div className="text-xs text-muted-foreground uppercase mb-1">VWAP дня</div>
              <div className="text-lg font-bold">{signal?.vwap && signal.vwap > 0 ? `$${signal.vwap.toFixed(1)}` : "—"}</div>
              <div className={`text-xs ${vwapDiff !== null ? (vwapDiff >= 0 ? "text-green-400" : "text-red-400") : "text-muted-foreground"}`}>
                {vwapDiff !== null ? `${vwapDiff >= 0 ? "+" : ""}${vwapDiff.toFixed(3)}%` : "—"}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="flex gap-2 flex-1 min-h-0">

          {/* Left: Signal Components */}
          <Card className="rounded-none border-border flex flex-col min-h-0 flex-1">
            <CardHeader className="p-4 border-b border-border/50 flex-row items-center justify-between shrink-0">
              <CardTitle className="text-sm uppercase">Компоненты сигнала</CardTitle>
              <div className="text-xs text-muted-foreground">ATR: {atrLabel}</div>
            </CardHeader>
            <CardContent className="p-0 overflow-auto flex-1">
              <table className="w-full text-left text-sm">
                <thead className="bg-card border-b border-border/50 text-muted-foreground sticky top-0">
                  <tr>
                    <th className="p-3 font-normal">Компонент</th>
                    <th className="p-3 font-normal">Score</th>
                    <th className="p-3 font-normal">Вес</th>
                    <th className="p-3 font-normal">Описание</th>
                  </tr>
                </thead>
                <tbody>
                  {signal?.components.map((c, i) => (
                    <tr key={i} className="border-b border-border/20 hover:bg-accent/50">
                      <td className="p-3 font-bold whitespace-nowrap text-xs">{c.name}</td>
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <span className={`w-12 text-right font-mono text-xs ${
                            c.score > 0 ? "text-green-400" : c.score < 0 ? "text-red-400" : "text-muted-foreground"
                          }`}>
                            {c.score >= 0 ? "+" : ""}{c.score.toFixed(2)}
                          </span>
                          <div className="w-16 h-2 bg-muted relative rounded-sm">
                            <div
                              className={`absolute top-0 h-full rounded-sm ${c.score >= 0 ? "bg-green-500 left-1/2" : "bg-red-500 right-1/2"}`}
                              style={{ width: `${Math.abs(c.score) * 50}%` }}
                            />
                            <div className="absolute top-0 bottom-0 w-[1px] bg-foreground/40 left-1/2" />
                          </div>
                        </div>
                      </td>
                      <td className="p-3 text-muted-foreground font-mono text-xs">
                        {c.weight > 0 ? `${(c.weight * 100).toFixed(0)}%` : <span className="text-muted-foreground/40">—</span>}
                      </td>
                      <td className="p-3 text-muted-foreground text-xs leading-relaxed max-w-xs">{c.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>

          {/* Right: Pattern Matching */}
          <Card className="rounded-none border-border flex flex-col min-h-0" style={{ width: '380px', minWidth: '380px' }}>
            <CardHeader className="p-4 border-b border-border/50 shrink-0">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm uppercase">Historical Pattern Match</CardTitle>
                {!patternLoading && pattern && (
                  <div className={`text-xs font-bold px-2 py-0.5 rounded-sm ${
                    pattern.signal > 0.1 ? "bg-green-500/20 text-green-400" :
                    pattern.signal < -0.1 ? "bg-red-500/20 text-red-400" :
                    "bg-muted text-muted-foreground"
                  }`}>
                    {pattern.signal >= 0 ? "+" : ""}{(pattern.signal * 100).toFixed(1)}% signal
                  </div>
                )}
              </div>
              {!patternLoading && pattern && (
                <div className="text-xs text-muted-foreground mt-1 flex gap-3">
                  <span className="text-green-400">▲ {pattern.bullishMatches} бычьих</span>
                  <span className="text-red-400">▼ {pattern.bearishMatches} медвежьих</span>
                  <span className="text-muted-foreground">из {pattern.topMatches.length} совпадений</span>
                </div>
              )}
            </CardHeader>
            <CardContent className="p-0 overflow-auto flex-1">
              {patternLoading ? (
                <div className="h-full flex items-center justify-center text-muted-foreground text-xs">
                  <div className="text-center">
                    <div className="text-2xl mb-2">📊</div>
                    <div>Загрузка исторических данных...</div>
                    <div className="text-muted-foreground/60 mt-1">Быть готово через ~10 секунд</div>
                  </div>
                </div>
              ) : (
                <div className="divide-y divide-border/20">
                  {pattern?.topMatches.slice(0, 8).map((m, i) => (
                    <div key={i} className="p-3 hover:bg-accent/30">
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-muted-foreground font-mono">#{i + 1}</span>
                          <span className="text-xs font-bold">{m.startDate}</span>
                          <span className="text-muted-foreground text-[10px]">→ {m.endDate}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-muted-foreground">
                            r={( m.similarity * 100).toFixed(1)}%
                          </span>
                          <span className={`text-xs font-bold font-mono ${
                            m.forwardPct > 0.5 ? "text-green-400" :
                            m.forwardPct < -0.5 ? "text-red-400" :
                            "text-muted-foreground"
                          }`}>
                            {m.forwardPct >= 0 ? "+" : ""}{m.forwardPct.toFixed(2)}%
                          </span>
                          <span className={`text-[9px] px-1 py-0.5 rounded-sm font-bold ${
                            m.outcome === "bullish" ? "bg-green-500/20 text-green-400" :
                            m.outcome === "bearish" ? "bg-red-500/20 text-red-400" :
                            "bg-muted text-muted-foreground"
                          }`}>
                            {m.outcome === "bullish" ? "▲" : m.outcome === "bearish" ? "▼" : "—"}
                          </span>
                        </div>
                      </div>
                      <MiniReturnChart
                        current={m.currentReturns}
                        historical={m.historicalReturns}
                        forward={m.forwardReturns}
                      />
                      <div className="flex gap-3 mt-1 text-[9px] text-muted-foreground/60">
                        <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-blue-400 inline-block" /> текущий</span>
                        <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-purple-400 inline-block border-dashed" /> исторический</span>
                        <span className="flex items-center gap-1"><span className="w-3 h-0.5 bg-green-400 inline-block" /> прогноз 3д</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </Layout>
  );
}
