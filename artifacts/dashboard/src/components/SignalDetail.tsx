import { useEffect, useState } from "react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { type Metrics, type PathPoint, type Signal, REASON, dir, duration, getJson, heldMs, num, price, signed, time, usd } from "../lib/api";
import { MetricsGrid } from "./MetricsGrid";
import { Card, Pill } from "./ui";

type AfterPoint = {
  label: string; at: string; closeReason: string; price: number; pctFromEntry: number; pctFromExit: number;
  bestPctSinceClose: number; worstPctSinceClose: number; targetsReached: Array<{ price: number; at: string | null }>;
  initialStopReached: string | null; market: Partial<Metrics>;
};
const AFTER_ORDER = ["1h", "4h", "12h", "24h", "48h", "72h", "5d", "7d"];
type TrajPoint = { label: string; at: string; elapsedMs: number; price: number; pctFromEntry: number; peakPct: number; worstPct: number; status: string; market: Partial<Metrics> };
const ORDER = (l: string) => (l === "close" ? 1e9 : l.endsWith("m") ? parseInt(l) : parseInt(l) * 60);

const pctOf = (s: Signal, level: number) => ((s.direction === "long" ? 1 : -1) * (level - s.entryPrice) / s.entryPrice) * 100;

/** One signal: the path from 6 h before the entry to the close (and after), the levels, and the metrics at the entry. */
export function SignalDetail({ s, label, onClose }: { s: Signal; label: string; onClose: () => void }) {
  const [points, setPoints] = useState<PathPoint[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [traj, setTraj] = useState<TrajPoint[]>([]);
  const [after, setAfter] = useState<AfterPoint[]>([]);
  useEffect(() => {
    let alive = true;
    setPoints(null); setErr(null); setTraj([]); setAfter([]);
    getJson<{ points: PathPoint[]; signal: Signal }>(`/api/btc/signals/${s.id}/path`)
      .then((r) => {
        if (!alive) return;
        setPoints(r.points);
        const t = (r.signal?.metrics as { trajectory?: Record<string, TrajPoint> } | null)?.trajectory ?? {};
        setTraj(Object.values(t).sort((a, b) => ORDER(a.label) - ORDER(b.label)));
        const a = (r.signal?.metrics as { afterClose?: Record<string, AfterPoint> } | null)?.afterClose ?? {};
        setAfter(Object.values(a).sort((x, y) => AFTER_ORDER.indexOf(x.label) - AFTER_ORDER.indexOf(y.label)));
      })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [s.id]);
  const series = (points ?? []).map((p) => ({
    t: new Date(p.at).toLocaleString("ru-RU", { timeZone: "Asia/Dubai", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }),
    before: p.phase === "before" ? p.pctFromEntry : null,
    open: p.phase === "open" ? p.pctFromEntry : null,
    after: p.phase === "after_close" ? p.pctFromEntry : null,
  }));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-30 overflow-y-auto bg-black/75 p-3 backdrop-blur-sm md:p-8" onClick={onClose}>
    <div className="mx-auto max-w-6xl" onClick={(e) => e.stopPropagation()}>
    <Card title={<>Сигнал #{s.id} · {label}</>} right={<button onClick={onClose} className="text-xs text-muted-foreground hover:text-gold">закрыть ✕</button>}>
      <div className="mb-3 flex flex-wrap gap-2 text-xs">
        <Pill kind={s.direction === "long" ? "long" : "short"}>{dir(s.direction)}</Pill>
        <Pill>{s.live ? "в канал" : "тень"}</Pill>
        <Pill kind="gold">плечо x{s.leverage}</Pill>
        <Pill>вход {price(s.entryPrice)} · {time(s.detectedAt)}</Pill>
        <Pill>стоп {price(s.initialStopPrice ?? s.stopPrice)} ({signed(pctOf(s, s.initialStopPrice ?? s.stopPrice))})</Pill>
        {s.targets.map((t, i) => <Pill key={i} kind={t.hitAt ? "good" : "muted"}>цель {i + 1}: {price(t.price)} ({signed(pctOf(s, t.price))}) · {Math.round(t.fraction * 100)}%{t.hitAt ? " ✓" : ""}</Pill>)}
        <Pill>ликвидация {price(s.liquidationPrice)}</Pill>
        {s.closedAt && <Pill kind={(s.pnlPricePct ?? 0) >= 0 ? "good" : "bad"}>{REASON[s.closeReason ?? ""] ?? s.closeReason} · движение {signed(s.pnlPricePct)}</Pill>}
        <Pill>в сделке {duration(heldMs(s))}</Pill>
      </div>
      <div className="h-64">
        {err ? <p className="text-sm text-rose-400">Путь недоступен: {err}</p> : !points ? <p className="text-sm text-muted-foreground">Загружаю путь…</p> : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={series}>
              <CartesianGrid stroke="#2a2214" vertical={false} />
              <XAxis dataKey="t" stroke="#8a7d63" fontSize={11} minTickGap={40} />
              <YAxis stroke="#8a7d63" fontSize={11} unit="%" />
              <Tooltip contentStyle={{ background: "#120f0a", border: "1px solid #5a4417", borderRadius: 8 }} formatter={(v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`} />
              <ReferenceLine y={0} stroke="#d8c9a6" strokeDasharray="4 4" label={{ value: "вход", fill: "#d8c9a6", fontSize: 10, position: "insideLeft" }} />
              <ReferenceLine y={pctOf(s, s.initialStopPrice ?? s.stopPrice)} stroke="#e2445c" strokeDasharray="4 4" label={{ value: "стоп", fill: "#e2445c", fontSize: 10, position: "insideLeft" }} />
              {s.targets.map((t, i) => <ReferenceLine key={i} y={pctOf(s, t.price)} stroke="#34d399" strokeDasharray="4 4" label={{ value: `цель ${i + 1}`, fill: "#34d399", fontSize: 10, position: "insideLeft" }} />)}
              <Line dataKey="before" stroke="#6b6250" dot={false} strokeWidth={1.5} connectNulls={false} name="до входа" />
              <Line dataKey="open" stroke="#f2b10f" dot={false} strokeWidth={2} connectNulls={false} name="в сделке" />
              <Line dataKey="after" stroke="#8a7d63" dot={false} strokeWidth={1.5} strokeDasharray="3 3" connectNulls={false} name="после закрытия" />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
      <p className="mb-3 mt-1 text-xs text-muted-foreground">Движение от входа в сторону сделки по 5-минутным снимкам: серым — 6 ч до входа, золотом — в сделке, пунктиром — 7 дней после закрытия.</p>
      {traj.length > 0 && (
        <div className="mb-4 overflow-x-auto">
          <div className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">Снимки сигнала (15m … 72h, далее раз в сутки, и на закрытии)</div>
          <table className="w-full text-xs tabular-nums">
            <thead><tr className="text-left text-muted-foreground">{["Точка", "Время", "Движение", "Пик", "Худшее", "OI 1h", "CVD спот 1h", "Тейкер фьюч 1h", "Fund% BingX", "WI", "RSI 1h", "MACD 1h", "Liq L/S 1h"].map((h) => <th key={h} className="whitespace-nowrap px-2 py-1 font-medium">{h}</th>)}</tr></thead>
            <tbody>{traj.map((p) => (
              <tr key={p.label} className="border-t border-border/60">
                <td className="px-2 py-1">{p.label === "close" ? "закрытие" : p.label}</td>
                <td className="px-2 py-1">{time(p.at)}</td>
                <td className="px-2 py-1">{signed(p.pctFromEntry)}</td>
                <td className="px-2 py-1">{signed(p.peakPct)}</td>
                <td className="px-2 py-1">{signed(p.worstPct)}</td>
                <td className="px-2 py-1">{signed(p.market.oiChangePct?.["1h"])}</td>
                <td className="px-2 py-1">{usd(p.market.spotCvdUsd?.["1h"])}</td>
                <td className="px-2 py-1">{signed(p.market.futTakerNetPct?.["1h"])}</td>
                <td className="px-2 py-1">{num(p.market.fundingBingxPct, 4)}</td>
                <td className="px-2 py-1">{num(p.market.whaleIndex, 1)}</td>
                <td className="px-2 py-1">{num(p.market.indicators?.["1h"]?.rsi14 ?? null, 1)}</td>
                <td className="px-2 py-1">{num(p.market.indicators?.["1h"]?.macdHist ?? null, 1)}</td>
                <td className="px-2 py-1">{usd(p.market.liqLongUsd?.["1h"])} / {usd(p.market.liqShortUsd?.["1h"])}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {after.length > 0 && (
        <div className="mb-4 overflow-x-auto">
          <div className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">После закрытия по стопу или в безубыток (1h … 7 дней)</div>
          <table className="w-full text-xs tabular-nums">
            <thead><tr className="text-left text-muted-foreground">{["Через", "Время", "Цена", "От входа", "От выхода", "Лучшее после закрытия", "Худшее после закрытия", "Цели после закрытия", "Стоп после закрытия", "OI 1h", "CVD спот 1h", "Тейкер фьюч 1h", "WI", "RSI 1h"].map((h) => <th key={h} className="whitespace-nowrap px-2 py-1 font-medium">{h}</th>)}</tr></thead>
            <tbody>{after.map((p) => (
              <tr key={p.label} className="border-t border-border/60">
                <td className="px-2 py-1">{p.label}</td>
                <td className="px-2 py-1">{time(p.at)}</td>
                <td className="px-2 py-1">{price(p.price)}</td>
                <td className="px-2 py-1">{signed(p.pctFromEntry)}</td>
                <td className="px-2 py-1">{signed(p.pctFromExit)}</td>
                <td className="px-2 py-1">{signed(p.bestPctSinceClose)}</td>
                <td className="px-2 py-1">{signed(p.worstPctSinceClose)}</td>
                <td className="px-2 py-1 whitespace-nowrap">{p.targetsReached.map((t, i) => `ц${i + 1} ${t.at ? `✓ ${time(t.at)}` : "—"}`).join(" · ")}</td>
                <td className="px-2 py-1 whitespace-nowrap">{p.initialStopReached ? `✓ ${time(p.initialStopReached)}` : "—"}</td>
                <td className="px-2 py-1">{signed(p.market.oiChangePct?.["1h"])}</td>
                <td className="px-2 py-1">{usd(p.market.spotCvdUsd?.["1h"])}</td>
                <td className="px-2 py-1">{signed(p.market.futTakerNetPct?.["1h"])}</td>
                <td className="px-2 py-1">{num(p.market.whaleIndex, 1)}</td>
                <td className="px-2 py-1">{num(p.market.indicators?.["1h"]?.rsi14 ?? null, 1)}</td>
              </tr>
            ))}</tbody>
          </table>
          <p className="mt-1 text-xs text-muted-foreground">«Лучшее / худшее» — от входа в сторону сделки, по 15-минутным свечам с момента закрытия. «Цели» и «стоп» — когда цена впервые дошла до них после закрытия (стоп — исходный).</p>
        </div>
      )}
      {s.metrics ? <MetricsGrid m={s.metrics} /> : <p className="text-sm text-muted-foreground">Метрики на входе не сохранены.</p>}
    </Card>
    </div>
    </div>
  );
}
