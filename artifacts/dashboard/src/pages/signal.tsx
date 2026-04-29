import { Layout } from "@/components/layout";
import { useGetCurrentSignal } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function Signal() {
  const { data: signal } = useGetCurrentSignal({ query: { refetchInterval: 2000 } });

  return (
    <Layout>
      <div className="flex flex-col gap-2 h-full max-w-4xl mx-auto w-full">
        <Card className="rounded-none border-border shrink-0">
          <CardContent className="p-6 flex items-center justify-between">
            <div>
              <div className="text-sm text-muted-foreground uppercase mb-1">Composite Signal Score</div>
              <div className={`text-5xl font-bold tracking-tighter ${
                (signal?.score ?? 0) > 0.5 ? 'text-green' : (signal?.score ?? 0) < -0.5 ? 'text-red' : 'text-foreground'
              }`}>
                {(signal?.score ?? 0).toFixed(4)}
              </div>
            </div>
            <div className="text-right">
              <div className="text-sm text-muted-foreground uppercase mb-1">Direction & Confidence</div>
              <div className="text-2xl font-bold uppercase tracking-widest">{signal?.direction || 'NEUTRAL'}</div>
              <div className="text-muted-foreground">{(signal?.confidence ?? 0 * 100).toFixed(1)}% Conf</div>
            </div>
          </CardContent>
        </Card>

        <div className="grid grid-cols-3 gap-2 shrink-0">
          <Card className="rounded-none border-border">
            <CardContent className="p-4">
              <div className="text-xs text-muted-foreground uppercase mb-1">Suggested Leverage</div>
              <div className="text-xl font-bold">{signal?.suggestedLeverage}x</div>
            </CardContent>
          </Card>
          <Card className="rounded-none border-border">
            <CardContent className="p-4">
              <div className="text-xs text-muted-foreground uppercase mb-1">Suggested SL (from Entry)</div>
              <div className="text-xl font-bold">-{signal?.suggestedSl.toFixed(2)}%</div>
            </CardContent>
          </Card>
          <Card className="rounded-none border-border">
            <CardContent className="p-4">
              <div className="text-xs text-muted-foreground uppercase mb-1">Suggested TP (from Entry)</div>
              <div className="text-xl font-bold">+{signal?.suggestedTp.toFixed(2)}%</div>
            </CardContent>
          </Card>
        </div>

        <Card className="rounded-none border-border flex-1 min-h-0 flex flex-col">
          <CardHeader className="p-4 border-b border-border/50">
            <CardTitle className="text-sm uppercase">Signal Components Breakdown</CardTitle>
          </CardHeader>
          <CardContent className="p-0 overflow-auto flex-1">
            <table className="w-full text-left text-sm">
              <thead className="bg-card border-b border-border/50 text-muted-foreground sticky top-0">
                <tr>
                  <th className="p-4 font-normal">Component</th>
                  <th className="p-4 font-normal">Score (-1 to 1)</th>
                  <th className="p-4 font-normal">Weight</th>
                  <th className="p-4 font-normal w-1/2">Description</th>
                </tr>
              </thead>
              <tbody>
                {signal?.components.map((c, i) => (
                  <tr key={i} className="border-b border-border/20 hover:bg-accent/50">
                    <td className="p-4 font-bold">{c.name}</td>
                    <td className="p-4">
                      <div className="flex items-center gap-2">
                        <span className={`w-12 text-right ${c.score > 0 ? 'text-green' : c.score < 0 ? 'text-red' : 'text-foreground'}`}>
                          {c.score.toFixed(2)}
                        </span>
                        <div className="w-24 h-1.5 bg-muted relative">
                          <div 
                            className={`absolute top-0 h-full ${c.score >= 0 ? 'bg-green left-1/2' : 'bg-red right-1/2'}`}
                            style={{ width: `${Math.abs(c.score) * 50}%` }}
                          />
                          <div className="absolute top-0 bottom-0 w-[1px] bg-foreground left-1/2" />
                        </div>
                      </div>
                    </td>
                    <td className="p-4 text-muted-foreground">{(c.weight * 100).toFixed(0)}%</td>
                    <td className="p-4 text-muted-foreground text-xs">{c.description}</td>
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
