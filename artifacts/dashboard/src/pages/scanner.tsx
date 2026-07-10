import { Layout } from "@/components/layout";
import {
  useGetScannerMetrics,
  useGetScannerHits,
  useGetScannerSignals,
  useGetScannerOpenPositions,
  useGetScannerOverallStats,
  useGetScannerPatternStats,
  useGetScannerApiStatus,
} from "@workspace/api-client-react";
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
  const { data: openPositions } = useGetScannerOpenPositions({ query: { refetchInterval: 5000 } } as any);
  const { data: overallStats } = useGetScannerOverallStats({ query: { refetchInterval: 15000 } } as any);
  const { data: patternStats } = useGetScannerPatternStats({ query: { refetchInterval: 15000 } } as any);
  const { data: apiStatus } = useGetScannerApiStatus({ query: { refetchInterval: 10000 } } as any);

  return (
    <Layout>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-2">
        <Card className="xl:col-span-3">
          <CardHeader>
            <CardTitle>Статус API</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {(apiStatus ?? []).map((s) => (
                <div key={s.name} className="flex items-center gap-2 border border-border/50 rounded p-2">
                  <span
                    className={`inline-block w-2.5 h-2.5 rounded-full shrink-0 ${
                      s.ok ? "bg-green" : "bg-red"
                    }`}
                  />
                  <div className="min-w-0">
                    <div className="font-bold truncate">{s.label}</div>
                    <div className={`text-xs truncate ${s.ok ? "text-green" : "text-red"}`}>
                      {s.ok ? "работает" : "не работает"} · {s.message}
                    </div>
                  </div>
                </div>
              ))}
              {(!apiStatus || apiStatus.length === 0) && (
                <div className="text-muted-foreground text-center py-4 col-span-full">Проверка API...</div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="xl:col-span-3">
          <CardHeader>
            <CardTitle>Общая статистика по сигналам</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 text-center">
              <div>
                <div className="text-2xl font-bold">{overallStats?.total ?? "-"}</div>
                <div className="text-muted-foreground text-xs">Всего сигналов</div>
              </div>
              <div>
                <div className="text-2xl font-bold">{overallStats?.open ?? "-"}</div>
                <div className="text-muted-foreground text-xs">Открытых</div>
              </div>
              <div>
                <div className="text-2xl font-bold">{overallStats?.closed ?? "-"}</div>
                <div className="text-muted-foreground text-xs">Закрытых</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-green">{overallStats?.wins ?? "-"}</div>
                <div className="text-muted-foreground text-xs">Прибыльных</div>
              </div>
              <div>
                <div className="text-2xl font-bold text-red">{overallStats?.losses ?? "-"}</div>
                <div className="text-muted-foreground text-xs">Убыточных</div>
              </div>
              <div>
                <div className="text-2xl font-bold">
                  {overallStats?.winRate !== undefined ? `${overallStats.winRate.toFixed(1)}%` : "-"}
                </div>
                <div className="text-muted-foreground text-xs">Win-rate</div>
              </div>
              <div>
                <div
                  className={`text-2xl font-bold ${
                    (overallStats?.avgPnlPct ?? 0) >= 0 ? "text-green" : "text-red"
                  }`}
                >
                  {overallStats?.avgPnlPct !== undefined ? pct(overallStats.avgPnlPct) : "-"}
                </div>
                <div className="text-muted-foreground text-xs">Средний PnL</div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="xl:col-span-3">
          <CardHeader>
            <CardTitle>Статистика по паттернам</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="pr-3 py-1">Паттерн</th>
                  <th className="pr-3">Всего</th>
                  <th className="pr-3">Закрыто</th>
                  <th className="pr-3">Прибыльных</th>
                  <th className="pr-3">Win-rate</th>
                  <th className="pr-3">Средний PnL</th>
                </tr>
              </thead>
              <tbody>
                {(patternStats ?? []).map((p) => (
                  <tr key={p.pattern} className="border-t border-border/50">
                    <td className="pr-3 py-1 font-bold">{p.pattern}</td>
                    <td className="pr-3">{p.total}</td>
                    <td className="pr-3">{p.closed}</td>
                    <td className="pr-3">{p.wins}</td>
                    <td className="pr-3">{p.winRate.toFixed(1)}%</td>
                    <td className={`pr-3 ${p.avgPnlPct >= 0 ? "text-green" : "text-red"}`}>{pct(p.avgPnlPct)}</td>
                  </tr>
                ))}
                {(!patternStats || patternStats.length === 0) && (
                  <tr>
                    <td colSpan={6} className="py-4 text-center text-muted-foreground">
                      Пока нет статистики по паттернам
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <Card className="xl:col-span-3">
          <CardHeader>
            <CardTitle>Открытые позиции</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="pr-3 py-1">Символ</th>
                  <th className="pr-3">Паттерн</th>
                  <th className="pr-3">Цена входа</th>
                  <th className="pr-3">Текущая цена</th>
                  <th className="pr-3">PnL (нереализ.)</th>
                  <th className="pr-3">Циклов удержания</th>
                </tr>
              </thead>
              <tbody>
                {(openPositions ?? []).map((p) => (
                  <tr key={p.id} className="border-t border-border/50">
                    <td className="pr-3 py-1 font-bold">{p.symbol}</td>
                    <td className="pr-3">{p.pattern}</td>
                    <td className="pr-3">{p.entryPrice}</td>
                    <td className="pr-3">{p.currentPrice}</td>
                    <td className={`pr-3 ${p.unrealizedPnlPct >= 0 ? "text-green" : "text-red"}`}>
                      {pct(p.unrealizedPnlPct)}
                    </td>
                    <td className="pr-3">{p.cyclesHeld}</td>
                  </tr>
                ))}
                {(!openPositions || openPositions.length === 0) && (
                  <tr>
                    <td colSpan={6} className="py-4 text-center text-muted-foreground">
                      Нет открытых позиций
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </CardContent>
        </Card>

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
