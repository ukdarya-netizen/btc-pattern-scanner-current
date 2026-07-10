import { Layout } from "@/components/layout";
import { useGetScannerMetrics, useGetScannerHits, useGetScannerSignals } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

function pct(n: number | undefined) {
  if (n === undefined || Number.isNaN(n)) return "-";
  const s = n.toFixed(2);
  return n > 0 ? `+${s}%` : `${s}%`;
}

export default function Scanner() {
  const { data: metrics } = useGetScannerMetrics({ query: { refetchInterval: 5000 } } as any);
  const { data: hits } = useGetScannerHits({ query: { refetchInterval: 5000 } } as any);
  const { data: signals } = useGetScannerSignals({ query: { refetchInterval: 15000 } } as any);

  return (
    <Layout>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-2">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle>Watchlist Metrics</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="pr-3 py-1">Symbol</th>
                  <th className="pr-3">Price</th>
                  <th className="pr-3">Δ price</th>
                  <th className="pr-3">OI Δ30m/1h/4h</th>
                  <th className="pr-3">Vol/Spot mult</th>
                  <th className="pr-3">Taker</th>
                  <th className="pr-3">Funding</th>
                </tr>
              </thead>
              <tbody>
                {(metrics ?? []).map((m) => (
                  <tr key={m.symbol} className="border-t border-border/50">
                    <td className="pr-3 py-1 font-bold">{m.symbol}</td>
                    <td className="pr-3">{m.price.toFixed(4)}</td>
                    <td className={`pr-3 ${m.priceChange.current >= 0 ? "text-green" : "text-red"}`}>
                      {pct(m.priceChange.current)}
                    </td>
                    <td className="pr-3">
                      {pct(m.oiChange.m30)} / {pct(m.oiChange.h1)} / {pct(m.oiChange.h4)}
                    </td>
                    <td className="pr-3">
                      {m.volMult.toFixed(2)}x / {m.spotVolMult.toFixed(2)}x
                    </td>
                    <td className={`pr-3 ${m.takerDominance === "buy" ? "text-green" : "text-red"}`}>
                      {m.takerNetBuyPct.toFixed(1)}%
                    </td>
                    <td className="pr-3">{(m.fundingRate * 100).toFixed(4)}%</td>
                  </tr>
                ))}
                {(!metrics || metrics.length === 0) && (
                  <tr>
                    <td colSpan={7} className="py-4 text-center text-muted-foreground">
                      Waiting for first scan cycle...
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent Pattern Hits (session)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 max-h-[70vh] overflow-y-auto">
            {(hits ?? []).slice().reverse().map((h, i) => (
              <div key={i} className="border border-border/50 rounded p-2">
                <div className="flex justify-between font-bold">
                  <span>{h.symbol}</span>
                  <span className="text-primary">{h.pattern}</span>
                </div>
                <div className="text-muted-foreground">{h.reason}</div>
              </div>
            ))}
            {(!hits || hits.length === 0) && (
              <div className="text-muted-foreground text-center py-4">No pattern hits yet this session</div>
            )}
          </CardContent>
        </Card>

        <Card className="xl:col-span-3">
          <CardHeader>
            <CardTitle>Persisted Signals (DB)</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="pr-3 py-1">Fired at</th>
                  <th className="pr-3">Symbol</th>
                  <th className="pr-3">Pattern</th>
                  <th className="pr-3">Price</th>
                  <th className="pr-3">Cycles</th>
                </tr>
              </thead>
              <tbody>
                {(signals ?? []).map((s) => (
                  <tr key={s.id} className="border-t border-border/50">
                    <td className="pr-3 py-1">{new Date(s.firedAt).toLocaleString()}</td>
                    <td className="pr-3 font-bold">{s.symbol}</td>
                    <td className="pr-3">{s.pattern}</td>
                    <td className="pr-3">{s.price}</td>
                    <td className="pr-3">{s.cycleCount}</td>
                  </tr>
                ))}
                {(!signals || signals.length === 0) && (
                  <tr>
                    <td colSpan={5} className="py-4 text-center text-muted-foreground">
                      No persisted signals yet
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
