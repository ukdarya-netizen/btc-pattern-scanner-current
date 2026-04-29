import { Layout } from "@/components/layout";
import { useGetCurrentSignal } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function Signal() {
  const { data: signal } = useGetCurrentSignal({ query: { refetchInterval: 2000 } });

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

  return (
    <Layout>
      <div className="flex flex-col gap-2 h-full max-w-4xl mx-auto w-full">

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
              <div className="text-xs text-muted-foreground mt-1">
                Вход при |score| &gt; 0.35
              </div>
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

        <Card className="rounded-none border-border flex-1 min-h-0 flex flex-col">
          <CardHeader className="p-4 border-b border-border/50 flex-row items-center justify-between">
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
                  <th className="p-3 font-normal w-1/2">Описание</th>
                </tr>
              </thead>
              <tbody>
                {signal?.components.map((c, i) => (
                  <tr key={i} className="border-b border-border/20 hover:bg-accent/50">
                    <td className="p-3 font-bold whitespace-nowrap">{c.name}</td>
                    <td className="p-3">
                      <div className="flex items-center gap-2">
                        <span className={`w-12 text-right font-mono text-xs ${
                          c.score > 0 ? "text-green-400" : c.score < 0 ? "text-red-400" : "text-muted-foreground"
                        }`}>
                          {c.score >= 0 ? "+" : ""}{c.score.toFixed(2)}
                        </span>
                        <div className="w-20 h-2 bg-muted relative rounded-sm">
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
                    <td className="p-3 text-muted-foreground text-xs leading-relaxed">{c.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

      </div>
    </Layout>
  );
}
