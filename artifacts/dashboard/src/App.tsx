import { useEffect, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type Status = {
  scanner: { lastCycleAt: string | null; lastCandleCloseAt: string | null; lastError: string | null; lastDurationMs: number | null; missingFlow: string[] };
  stream: { connected: boolean; lastTickAt: string | null; lastPrice: number | null };
  openSignals: number;
  patterns: Array<{ key: string; label: string; direction: string; profile: string; live: boolean }>;
};

type StatsRow = {
  patternKey: string; profile: string; direction: string; live: boolean;
  total: number; open: number; closed: number; wins: number; losses: number;
  winRatePct: number | null; avgPnlPricePct: number | null; avgPnlMarginPct: number | null;
  sumPnlMarginPct: number | null; avgMfePct: number | null; avgMaePct: number | null;
  takeProfit: number; stop: number; breakeven: number; timeout: number;
};

type Signal = {
  id: number; patternKey: string; direction: string; profile: string; leverage: number; live: boolean;
  status: string; entryPrice: number; stopPrice: number; liquidationPrice: number;
  targets: Array<{ price: number; fraction: number; hitAt: string | null }>;
  detectedAt: string; closedAt: string | null; closeReason: string | null;
  pnlPricePct: number | null; pnlMarginPct: number | null; mfePct: number; maePct: number;
  metrics: Metrics | null;
};

type ByTf = Record<string, number | null>;
type Metrics = {
  price: number;
  priceChangePct: ByTf; atrPct: ByTf; bingxVolumeMult: ByTf; futVolumeMult: ByTf; spotVolumeMult: ByTf;
  futVolumeUsd: ByTf; spotVolumeUsd: ByTf; oiUsd: number | null; oiChangePct: ByTf;
  futTakerNetPct: ByTf; spotTakerNetPct: ByTf; futCvdUsd: ByTf; spotCvdUsd: ByTf;
  spotCvdBullish: Record<string, boolean | null>; liqLongUsd: ByTf; liqShortUsd: ByTf;
  liqLongSpike1h: number | null; liqShortSpike1h: number | null; fundingRatePct: number | null;
  longShortRatio: number | null; longShortChangePct: ByTf; orderbookBidAskRatio: number | null;
  orderbookImbalancePct: number | null; whaleIndex: number | null; whaleIndexChange4h: number | null;
  whaleIndex4h?: number | null;
  context?: {
    heatmap: { below: Record<string, number>; above: Record<string, number>; topBelow: Array<{ price: number; distancePct: number; valueUsd: number }>; topAbove: Array<{ price: number; distancePct: number; valueUsd: number }>; aboveBelowRatio5pct: number | null } | null;
    hyperliquidWhales: { longCount: number; shortCount: number; longUsd: number; shortUsd: number; netUsd: number; avgLeverage: number | null; opened1hLongUsd: number; opened1hShortUsd: number } | null;
    exchangeBalance: { totalBtc: number; change1dBtc: number | null; change1dPct: number | null; change7dBtc: number | null; change7dPct: number | null } | null;
    dominance: { dominancePct: number; change24hPct: number | null; source: string } | null;
  } | null;
};

const TFS = ["5m", "15m", "30m", "1h", "3h", "4h", "24h"];
const usd = (v: number | null | undefined) => {
  if (v == null) return "—";
  const a = Math.abs(v);
  const t = a >= 1e9 ? `${(a / 1e9).toFixed(2)}B` : a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : `${(a / 1e3).toFixed(0)}K`;
  return `${v < 0 ? "−" : ""}$${t}`;
};
const mult = (v: number | null | undefined) => (v == null ? "—" : `${v.toFixed(2)}×`);

function MetricsGrid({ m }: { m: Metrics }) {
  const rows: Array<[string, ByTf | undefined, (v: number | null) => React.ReactNode]> = [
    ["Цена Δ", m.priceChangePct, (v) => <span className={tone(v)}>{signed(v)}</span>],
    ["OI Δ", m.oiChangePct, (v) => <span className={tone(v)}>{signed(v)}</span>],
    ["Тейкер фьюч (net)", m.futTakerNetPct, (v) => <span className={tone(v)}>{signed(v, 1)}</span>],
    ["Тейкер спот (net)", m.spotTakerNetPct, (v) => <span className={tone(v)}>{signed(v, 1)}</span>],
    ["CVD фьюч", m.futCvdUsd, (v) => <span className={tone(v)}>{usd(v)}</span>],
    ["CVD спот", m.spotCvdUsd, (v) => <span className={tone(v)}>{usd(v)}</span>],
    ["Объём фьюч ×", m.futVolumeMult, mult],
    ["Объём спот ×", m.spotVolumeMult, mult],
    ["Объём BingX ×", m.bingxVolumeMult, mult],
    ["Ликвидации лонгов", m.liqLongUsd, usd],
    ["Ликвидации шортов", m.liqShortUsd, usd],
    ["ATR", m.atrPct, (v) => (v == null ? "—" : `${v.toFixed(2)}%`)],
  ];
  const single: Array<[string, React.ReactNode]> = [
    ["Цена", price(m.price)],
    ["OI (все биржи)", usd(m.oiUsd)],
    ["Фандинг (OI-взвеш.)", m.fundingRatePct == null ? "—" : `${m.fundingRatePct.toFixed(4)}%`],
    ["Long/Short (Binance)", m.longShortRatio == null ? "—" : `${m.longShortRatio.toFixed(2)} · 1h ${signed(m.longShortChangePct?.["1h"])} · 4h ${signed(m.longShortChangePct?.["4h"])}`],
    ["Стакан ±1% bid/ask", m.orderbookBidAskRatio == null ? "—" : `${m.orderbookBidAskRatio.toFixed(2)} (${signed(m.orderbookImbalancePct, 1)})`],
    ["Whale Index", m.whaleIndex == null ? "—" : `${m.whaleIndex.toFixed(2)} · 4h ${m.whaleIndexChange4h == null ? "—" : (m.whaleIndexChange4h >= 0 ? "+" : "") + m.whaleIndexChange4h.toFixed(2)}`],
    ["Всплеск ликвидаций 1h", `лонги ${mult(m.liqLongSpike1h)} · шорты ${mult(m.liqShortSpike1h)}`],
    ["Объём 24h", `фьюч ${usd(m.futVolumeUsd?.["24h"])} · спот ${usd(m.spotVolumeUsd?.["24h"])}`],
    ["Whale Index 4h", m.whaleIndex4h == null ? "—" : m.whaleIndex4h.toFixed(2)],
    ["Доминация BTC", m.context?.dominance ? `${m.context.dominance.dominancePct.toFixed(2)}% · 24h ${m.context.dominance.change24hPct == null ? "—" : (m.context.dominance.change24hPct >= 0 ? "+" : "") + m.context.dominance.change24hPct.toFixed(2)}` : "—"],
    ["BTC на биржах", m.context?.exchangeBalance ? `${m.context.exchangeBalance.totalBtc.toLocaleString("ru-RU")} BTC · 1д ${m.context.exchangeBalance.change1dBtc == null ? "—" : m.context.exchangeBalance.change1dBtc.toLocaleString("ru-RU")} · 7д ${m.context.exchangeBalance.change7dBtc == null ? "—" : m.context.exchangeBalance.change7dBtc.toLocaleString("ru-RU")}` : "—"],
    ["Киты Hyperliquid", m.context?.hyperliquidWhales ? `лонг ${usd(m.context.hyperliquidWhales.longUsd)} (${m.context.hyperliquidWhales.longCount}) · шорт ${usd(m.context.hyperliquidWhales.shortUsd)} (${m.context.hyperliquidWhales.shortCount})` : "—"],
    ["Открыто китами за 1ч", m.context?.hyperliquidWhales ? `лонг ${usd(m.context.hyperliquidWhales.opened1hLongUsd)} · шорт ${usd(m.context.hyperliquidWhales.opened1hShortUsd)}` : "—"],
    ["Ликвидности выше/ниже (±5%)", m.context?.heatmap?.aboveBelowRatio5pct == null ? "—" : `${m.context.heatmap.aboveBelowRatio5pct.toFixed(2)}×`],
    ["Кластеры выше", m.context?.heatmap ? m.context.heatmap.topAbove.map((c) => `${price(c.price)} (+${c.distancePct.toFixed(2)}%)`).join(", ") || "—" : "—"],
    ["Кластеры ниже", m.context?.heatmap ? m.context.heatmap.topBelow.map((c) => `${price(c.price)} (${c.distancePct.toFixed(2)}%)`).join(", ") || "—" : "—"],
    ["Спот CVD бычий", ["15m", "30m", "1h", "4h"].map((tf) => `${tf} ${m.spotCvdBullish?.[tf] == null ? "—" : m.spotCvdBullish[tf] ? "да" : "нет"}`).join(" · ")],
  ];
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
        {single.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3 border-b border-border py-1">
            <span className="text-muted-foreground">{k}</span><span className="tabular-nums">{v}</span>
          </div>
        ))}
      </div>
      <Table
        head={["Метрика", ...TFS]}
        rows={rows.map(([label, values, render]) => [
          label, ...TFS.map((tf) => (values && tf in values ? render(values[tf] ?? null) : "")),
        ])}
      />
    </div>
  );
}

const PROFILE: Record<string, string> = { h4: "4 часа x20", d1: "1 день x10" };
const REASON: Record<string, string> = { take_profit: "Цели", stop: "Стоп", breakeven: "Безубыток", timeout: "Время" };
const TAKER_FEE = 0.0005;

const PIN_KEY = "btc-bullet-pin";
function storedPin(): string {
  try { return localStorage.getItem(PIN_KEY) ?? ""; } catch { return ""; }
}
function savePin(pin: string): void {
  try { localStorage.setItem(PIN_KEY, pin); } catch { /* private mode: PIN kept in memory only */ }
}
let memoryPin = storedPin();

class PinRequired extends Error {}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: memoryPin ? { "x-dashboard-pin": memoryPin } : {} });
  if (res.status === 401) throw new PinRequired("pin");
  if (res.status === 429) throw new Error("Слишком много неверных PIN — подождите 15 минут");
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return (await res.json()) as T;
}

type DailyRow = { day: string; profile: string; live: boolean; closed: number; wins: number; sumPnlMarginPct: number };
type OutcomeGroup = {
  patternKey: string; profile: string; direction: string; decision: string; reason: string;
  total: number; targetFirst: number; stopFirst: number; timeout: number; pending: number;
  targetFirstPct: number | null; avgMfePct: number | null; avgMaePct: number | null;
};
type Decision = { id: number; candleCloseAt: string; patternKey: string; direction: string; profile: string; decision: string; reasons: string[]; price: number | null };

function PinForm({ onSubmit, error }: { onSubmit: (pin: string) => void; error: string | null }) {
  const [pin, setPin] = useState("");
  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-4 font-sans text-foreground">
      <form className="w-full max-w-xs space-y-3 rounded-lg border border-border bg-card p-5"
        onSubmit={(e) => { e.preventDefault(); onSubmit(pin); }}>
        <h1 className="text-lg font-semibold">BTC Bullet</h1>
        <label className="block text-sm text-muted-foreground" htmlFor="pin">PIN дашборда</label>
        <input id="pin" type="password" inputMode="numeric" autoFocus value={pin} onChange={(e) => setPin(e.target.value)}
          className="w-full rounded-md border border-border bg-background px-3 py-2" />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button className="w-full rounded-md bg-primary px-3 py-2 text-primary-foreground">Войти</button>
      </form>
    </main>
  );
}

const num = (v: number | null | undefined, d = 2) => (v == null ? "—" : v.toFixed(d));
const signed = (v: number | null | undefined, d = 2) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`);
const tone = (v: number | null | undefined) => (v == null ? "" : v > 0 ? "text-emerald-400" : v < 0 ? "text-red-400" : "");
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString("ru-RU", { timeZone: "Asia/Dubai" }) : "—");
const price = (v: number) => (v >= 1000 ? v.toFixed(1) : v.toPrecision(6));
const dir = (d: string) => (d === "long" ? "Лонг" : "Шорт");

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-muted-foreground">
            {head.map((h) => <th key={h} className="whitespace-nowrap px-2 py-1 font-medium">{h}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-border">
              {r.map((c, j) => <td key={j} className="whitespace-nowrap px-2 py-1 tabular-nums">{c}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="px-2 py-3 text-sm text-muted-foreground">Пока пусто.</p>}
    </div>
  );
}

export default function App() {
  const [days, setDays] = useState<number>(0);
  const [status, setStatus] = useState<Status | null>(null);
  const [stats, setStats] = useState<StatsRow[]>([]);
  const [open, setOpen] = useState<Signal[]>([]);
  const [closed, setClosed] = useState<Signal[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [market, setMarket] = useState<{ candleCloseAt: string | null; metrics: Metrics | null } | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [needPin, setNeedPin] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [daily, setDaily] = useState<DailyRow[]>([]);
  const [outcomes, setOutcomes] = useState<OutcomeGroup[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [s, st, o, c, mk] = await Promise.all([
          getJson<Status>("/api/btc/status"),
          getJson<{ rows: StatsRow[] }>(`/api/btc/stats${days ? `?days=${days}` : ""}`),
          getJson<{ rows: Signal[] }>("/api/btc/signals?status=open&limit=100"),
          getJson<{ rows: Signal[] }>("/api/btc/signals?status=closed&limit=50"),
          getJson<{ candleCloseAt: string | null; metrics: Metrics | null }>("/api/btc/metrics"),
        ]);
        const [dl, oc, dc] = await Promise.all([
          getJson<{ rows: DailyRow[] }>("/api/btc/stats/daily?days=30"),
          getJson<{ groups: OutcomeGroup[] }>("/api/btc/decisions/outcomes?days=7"),
          getJson<{ rows: Decision[] }>("/api/btc/decisions?limit=100"),
        ]);
        if (!alive) return;
        setStatus(s); setStats(st.rows); setOpen(o.rows); setClosed(c.rows); setMarket(mk); setError(null);
        setDaily(dl.rows); setOutcomes(oc.groups); setDecisions(dc.rows); setNeedPin(false);
      } catch (err) {
        if (!alive) return;
        if (err instanceof PinRequired) { setNeedPin(true); return; }
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    const timer = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(timer); };
  }, [days, reloadKey]);

  const label = (key: string) => status?.patterns.find((p) => p.key === key)?.label ?? key;
  if (needPin) {
    return <PinForm error={pinError} onSubmit={(pin) => {
      memoryPin = pin; savePin(pin); setPinError(memoryPin ? "Проверяю…" : null); setReloadKey((k) => k + 1);
      setTimeout(() => setPinError("Неверный PIN"), 1500);
    }} />;
  }
  const dayMap = new Map<string, number>();
  for (const r of daily.filter((r) => r.live || !status?.patterns.some((p) => p.live))) {
    dayMap.set(r.day, (dayMap.get(r.day) ?? 0) + r.sumPnlMarginPct);
  }
  const dailySeries = [...dayMap].map(([day, pnl]) => ({ day: day.slice(5), pnl: Number(pnl.toFixed(2)) }));
  const last = status?.stream.lastPrice ?? null;

  return (
    <main className="mx-auto max-w-7xl space-y-4 bg-background p-4 font-sans text-foreground">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">BTC Bullet</h1>
          <p className="text-sm text-muted-foreground">Сигналы BTC-USDT · лонг и шорт · время Дубай</p>
        </div>
        <div className="flex gap-1">
          {[[0, "Всё время"], [30, "30 дней"], [7, "7 дней"]].map(([d, l]) => (
            <button key={d} onClick={() => setDays(d as number)}
              className={`rounded-md border border-border px-3 py-1 text-sm ${days === d ? "bg-primary text-primary-foreground" : ""}`}>
              {l}
            </button>
          ))}
        </div>
      </header>

      {error && <p className="rounded-md border border-red-500/40 p-3 text-sm text-red-400">Нет связи с API: {error}</p>}

      <Card title="Состояние">
        <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-5">
          <div><div className="text-muted-foreground">Цена</div><div className="text-lg">{last ? price(last) : "—"}</div></div>
          <div><div className="text-muted-foreground">Поток цены</div><div className={status?.stream.connected ? "text-emerald-400" : "text-red-400"}>{status?.stream.connected ? "на связи" : "нет связи"}</div></div>
          <div><div className="text-muted-foreground">Последняя свеча</div><div>{time(status?.scanner.lastCandleCloseAt ?? null)}</div></div>
          <div><div className="text-muted-foreground">Паттернов</div><div>{status?.patterns.length ?? 0} ({status?.patterns.filter((p) => p.live).length ?? 0} в канал)</div></div>
          <div><div className="text-muted-foreground">Нет данных</div><div className={status?.scanner.missingFlow.length ? "text-amber-400" : ""}>{status?.scanner.missingFlow.join(", ") || "—"}</div></div>
        </div>
        {status?.scanner.lastError && <p className="mt-2 text-sm text-amber-400">Цикл: {status.scanner.lastError}</p>}
      </Card>

      <Card title={`Рынок BTC · свеча ${time(market?.candleCloseAt ?? null)}`}>
        {market?.metrics ? <MetricsGrid m={market.metrics} /> : <p className="text-sm text-muted-foreground">Метрики появятся после первого цикла сканирования.</p>}
      </Card>

      <Card title="Результат по дням, % к марже (30 дней)">
        {dailySeries.length === 0 ? <p className="text-sm text-muted-foreground">Закрытых сделок пока нет.</p> : (
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={dailySeries}>
                <CartesianGrid stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="day" stroke="hsl(var(--muted-foreground))" fontSize={12} />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={12} />
                <Tooltip contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }} formatter={(v: number) => `${v >= 0 ? "+" : ""}${v}%`} />
                <Bar dataKey="pnl" name="Сумма к марже">
                  {dailySeries.map((d) => <Cell key={d.day} fill={d.pnl >= 0 ? "#34d399" : "#f87171"} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
        <p className="mt-2 text-xs text-muted-foreground">Пока в канал не публикуется ни один паттерн, график показывает теневые сделки.</p>
      </Card>

      <Card title="Статистика по паттернам">
        <Table
          head={["Паттерн", "Тип", "Напр.", "Режим", "Закрыто", "Открыто", "В плюс", "Винрейт", "Ср. к марже", "Сумма к марже", "Ср. цена", "Цели/Стоп/БУ/Время", "MFE", "MAE"]}
          rows={stats.map((r) => [
            label(r.patternKey), PROFILE[r.profile] ?? r.profile, dir(r.direction), r.live ? "канал" : "тень",
            r.closed, r.open, `${r.wins}/${r.closed}`, r.winRatePct == null ? "—" : `${num(r.winRatePct, 1)}%`,
            <span className={tone(r.avgPnlMarginPct)}>{signed(r.avgPnlMarginPct)}</span>,
            <span className={tone(r.sumPnlMarginPct)}>{signed(r.sumPnlMarginPct)}</span>,
            <span className={tone(r.avgPnlPricePct)}>{signed(r.avgPnlPricePct, 3)}</span>,
            `${r.takeProfit}/${r.stop}/${r.breakeven}/${r.timeout}`,
            signed(r.avgMfePct, 3), signed(r.avgMaePct, 3),
          ])}
        />
        <p className="mt-2 text-xs text-muted-foreground">«К марже» — с плечом и за вычетом тейкер-комиссий 0.05% на вход и выход. Безубыток с комиссиями — минус.</p>
      </Card>

      <Card title={`Открытые позиции (${open.length})`}>
        <Table
          head={["#", "Паттерн", "Тип", "Напр.", "Режим", "Вход", "Сейчас", "Цена %", "К марже", "Стоп", "Ликвид.", "Цели", "Открыта", ""]}
          rows={open.map((s) => {
            const sign = s.direction === "long" ? 1 : -1;
            const move = last ? (sign * (last - s.entryPrice) / s.entryPrice) * 100 : null;
            const margin = move == null ? null : s.leverage * (move - TAKER_FEE * (1 + (last ?? s.entryPrice) / s.entryPrice) * 100);
            return [
              s.id, label(s.patternKey), PROFILE[s.profile] ?? s.profile, dir(s.direction), s.live ? "канал" : "тень",
              price(s.entryPrice), last ? price(last) : "—",
              <span className={tone(move)}>{signed(move, 3)}</span>,
              <span className={tone(margin)}>{signed(margin)}</span>,
              price(s.stopPrice), price(s.liquidationPrice),
              `${s.targets.filter((t) => t.hitAt).length}/${s.targets.length}`,
              time(s.detectedAt),
              <button className="text-primary underline" onClick={() => setExpanded(expanded === s.id ? null : s.id)}>метрики</button>,
            ];
          })}
        />
      </Card>

      {expanded !== null && (() => {
        const signal = [...open, ...closed].find((x) => x.id === expanded);
        return signal?.metrics ? (
          <Card title={`Метрики на входе · сигнал #${signal.id} · ${time(signal.detectedAt)}`}>
            <MetricsGrid m={signal.metrics} />
          </Card>
        ) : null;
      })()}

      <Card title="Последние закрытые">
        <Table
          head={["#", "Паттерн", "Тип", "Напр.", "Режим", "Вход", "Итог", "Цена %", "К марже", "MFE", "MAE", "Закрыта", ""]}
          rows={closed.map((s) => [
            s.id, label(s.patternKey), PROFILE[s.profile] ?? s.profile, dir(s.direction), s.live ? "канал" : "тень",
            price(s.entryPrice), REASON[s.closeReason ?? ""] ?? s.closeReason ?? "—",
            <span className={tone(s.pnlPricePct)}>{signed(s.pnlPricePct, 3)}</span>,
            <span className={tone(s.pnlMarginPct)}>{signed(s.pnlMarginPct)}</span>,
            signed(s.mfePct, 3), signed(s.maePct, 3), time(s.closedAt),
            <button className="text-primary underline" onClick={() => setExpanded(expanded === s.id ? null : s.id)}>метрики</button>,
          ])}
        />
      </Card>
      <Card title="Исход решений паттернов за 7 дней (что раньше: цель 1 или стоп)">
        <Table
          head={["Паттерн", "Тип", "Напр.", "Решение", "Причина", "Всего", "Цель раньше", "Стоп раньше", "% целей", "Время вышло", "Ждём", "MFE", "MAE"]}
          rows={outcomes.map((g) => [
            label(g.patternKey), PROFILE[g.profile] ?? g.profile, dir(g.direction), g.decision, g.reason || "—",
            g.total, g.targetFirst, g.stopFirst, g.targetFirstPct == null ? "—" : `${num(g.targetFirstPct, 1)}%`,
            g.timeout, g.pending, signed(g.avgMfePct, 3), signed(g.avgMaePct, 3),
          ])}
        />
        <p className="mt-2 text-xs text-muted-foreground">По минутным свечам после решения, стоп и цель — значения типа сделки по умолчанию. Если в одной свече задеты оба — считается стоп.</p>
      </Card>

      <Card title="Журнал решений (последние 100)">
        <Table
          head={["Свеча", "Паттерн", "Тип", "Напр.", "Решение", "Причины", "Цена"]}
          rows={decisions.map((d) => [
            time(d.candleCloseAt), label(d.patternKey), PROFILE[d.profile] ?? d.profile, dir(d.direction),
            d.decision, (d.reasons ?? []).join(", "), d.price ? price(d.price) : "—",
          ])}
        />
      </Card>
    </main>
  );
}
