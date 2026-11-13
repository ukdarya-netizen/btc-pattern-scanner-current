import { useEffect, useState, type ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis, Area, AreaChart, Legend } from "recharts";
import { type Metrics, getJson, num, price, signed, tone, usd } from "../lib/api";
import { Card } from "./ui";
import { getLang } from "../lib/i18n";

/**
 * Owner 2026-11-12: the market on the dashboard — everything of the morning Market update (Fear / Greed,
 * liquidations 24h, price and its 24h change) plus funding (BingX 8h and CoinGlass OI-weighted), Whale Index, OI,
 * CVD, takers, crowd, order book, RSI; the full version with 48 h charts (one point per hour) and 30 days of
 * Fear / Greed. Refreshed every minute; the data is the scanner's last 5m cycle.
 */
type Hour = {
  t: string; price: number; oiUsd: number | null; fundingBingxPct: number | null; fundingCgPct: number | null;
  whaleIndex: number | null; liqLongUsd: number | null; liqShortUsd: number | null;
  futCvdUsd: number | null; spotCvdUsd: number | null; futTakerNetPct: number | null; spotTakerNetPct: number | null; rsi1h: number | null;
};
type Market = {
  candleCloseAt: string | null; metrics: Metrics | null;
  fearGreed: { value: number; prev: number | null; label: string } | null;
  fearGreedHistory: Array<{ t: number; v: number }>;
  hours: Hour[];
};

const GOLD = "#f2b10f", GREEN = "#34d399", RED = "#f43f5e", SKY = "#7dd3fc", MUTED = "#8a7d63";
const AXIS = { stroke: MUTED, fontSize: 10 };
const TIP = { contentStyle: { background: "#120f0a", border: "1px solid #5a4417", borderRadius: 8, fontSize: 12 }, labelStyle: { color: "#d8c9a6" } };
const hh = (iso: string) => new Date(iso).toLocaleString("ru-RU", { timeZone: "Asia/Dubai", day: "2-digit", hour: "2-digit", minute: "2-digit" });
const FG_RU: Record<string, string> = { "Extreme Fear": "Экстремальный страх", Fear: "Страх", Neutral: "Нейтрально", Greed: "Жадность", "Extreme Greed": "Экстремальная жадность" };
const fgColor = (v: number) => (v < 20 ? "#e11d48" : v < 40 ? "#fb923c" : v < 60 ? "#facc15" : v < 80 ? "#84cc16" : "#22c55e");
const fund = (v: number | null | undefined) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(4)}%`);
const fundNote = (v: number | null | undefined) => (v == null ? "" : v <= -0.05 ? "шорты в ловушке" : v <= -0.01 ? "шорты платят" : v >= 0.1 ? "лонги перегреты" : v >= 0.02 ? "лонги платят" : "нейтрально");

/** Semicircle gauge 0–100 in the five Fear / Greed bands. */
function Gauge({ value }: { value: number }) {
  const a = (v: number) => Math.PI * (1 - v / 100);
  const pt = (v: number, r: number) => [60 + r * Math.cos(a(v)), 60 - r * Math.sin(a(v))] as const;
  const arc = (from: number, to: number) => { const [x1, y1] = pt(from, 48), [x2, y2] = pt(to, 48); return `M${x1} ${y1} A48 48 0 0 1 ${x2} ${y2}`; };
  const [nx, ny] = pt(value, 40);
  return (
    <svg viewBox="0 0 120 68" className="h-20 w-36" aria-hidden>
      {[[0, 20], [20, 40], [40, 60], [60, 80], [80, 100]].map(([f, t]) => <path key={f} d={arc(f! + 0.8, t! - 0.8)} stroke={fgColor((f! + t!) / 2)} strokeWidth="9" fill="none" opacity="0.85" />)}
      <line x1="60" y1="60" x2={nx} y2={ny} stroke="#f5ecd6" strokeWidth="2.5" strokeLinecap="round" />
      <circle cx="60" cy="60" r="4" fill="#f5ecd6" />
    </svg>
  );
}

function Stat({ label, children, sub }: { label: string; children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="gold-card p-3">
      <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{children}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}

function Chart({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="gold-card p-3">
      <div className="mb-1 text-[10px] uppercase tracking-[0.16em] text-muted-foreground">{title}</div>
      <div className="h-40">{children}</div>
    </div>
  );
}

export function MarketPanel({ full = false }: { full?: boolean }) {
  const [d, setD] = useState<Market | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => getJson<Market>("/api/btc/market").then((r) => { if (alive) { setD(r); setErr(null); } }).catch((e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    load();
    const id = setInterval(load, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  if (!d) return <Card title="Рынок BTC"><p className="text-sm text-muted-foreground">{err ? `Рынок недоступен: ${err}` : "Загружаю рынок…"}</p></Card>;
  const m = d.metrics;
  const fg = d.fearGreed;
  const liqL = m?.liqLongUsd?.["24h"] ?? null, liqS = m?.liqShortUsd?.["24h"] ?? null;
  const liqT = (liqL ?? 0) + (liqS ?? 0);
  const crowd = m?.longShortRatio == null ? null : (m.longShortRatio / (1 + m.longShortRatio)) * 100;
  const ind = (tf: string, k: string) => m?.indicators?.[tf]?.[k] ?? null;
  const nextFund = m?.nextFundingAt ? Math.max(0, m.nextFundingAt - Date.now()) : null;
  const rows = d.hours.map((h) => ({ ...h, label: hh(h.t) }));
  const fgRows = d.fearGreedHistory.map((p) => ({ label: new Date(p.t).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" }), v: p.v }));
  const usdTick = (v: number) => usd(v);

  return (
    <Card title={<>Рынок BTC · {d.candleCloseAt ? hh(d.candleCloseAt) : "—"}</>}>
      {/* The morning Market update set */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="gold-card flex items-center gap-3 p-3">
          {fg ? <Gauge value={fg.value} /> : null}
          <div>
            <div className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">Сентимент · Fear / Greed</div>
            <div className="mt-1 text-3xl font-semibold tabular-nums" style={{ color: fg ? fgColor(fg.value) : undefined }}>{fg ? fg.value : "—"}</div>
            <div className="text-xs text-muted-foreground">{fg ? (getLang() === "en" ? fg.label : `${fg.label} · ${FG_RU[fg.label] ?? ""}`) : "нет данных CoinGlass"}{fg?.prev != null ? ` · вчера ${fg.prev}` : ""}</div>
          </div>
        </div>
        <Stat label="Цена BTC" sub={<>за сутки <span className={tone(m?.priceChangePct?.["24h"])}>{signed(m?.priceChangePct?.["24h"])}</span> · 1h <span className={tone(m?.priceChangePct?.["1h"])}>{signed(m?.priceChangePct?.["1h"])}</span></>}>
          <span className="text-2xl">{price(m?.price)}</span>
        </Stat>
        <Stat label="Ликвидации за сутки" sub={<>лонги <span className="text-rose-300">{usd(liqL)}</span> · шорты <span className="text-emerald-300">{usd(liqS)}</span></>}>
          <span className="text-2xl">{liqT ? usd(liqT) : "—"}</span>
          {liqT > 0 && (
            <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-white/10">
              <div className="bg-rose-500" style={{ width: `${((liqL ?? 0) / liqT) * 100}%` }} />
              <div className="bg-emerald-500" style={{ width: `${((liqS ?? 0) / liqT) * 100}%` }} />
            </div>
          )}
        </Stat>
        <Stat label="Фандинг (8ч)" sub={<>CoinGlass OI-взвеш. {fund(m?.fundingRatePct)}{nextFund != null ? ` · до выплаты ${Math.floor(nextFund / 3_600_000)}ч ${Math.floor((nextFund % 3_600_000) / 60_000)}м` : ""}</>}>
          <span className="text-2xl">BingX {fund(m?.fundingBingxPct)}</span>
          <div className="text-xs font-normal text-muted-foreground">{fundNote(m?.fundingBingxPct ?? m?.fundingRatePct)}</div>
        </Stat>
      </div>

      {/* Flows and positioning, as CAB */}
      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Whale Index" sub={`4h ${num(m?.whaleIndex4h, 1)} · Δ4h ${num(m?.whaleIndexChange4h, 1)}`}>
          <span className={m?.whaleIndex == null ? "" : m.whaleIndex >= 10 ? "text-emerald-400" : m.whaleIndex <= -10 ? "text-rose-400" : ""}>{num(m?.whaleIndex, 1)}</span>
        </Stat>
        <Stat label="Открытый интерес" sub={<>1h <span className={tone(m?.oiChangePct?.["1h"])}>{signed(m?.oiChangePct?.["1h"])}</span> · 4h <span className={tone(m?.oiChangePct?.["4h"])}>{signed(m?.oiChangePct?.["4h"])}</span> · 24h <span className={tone(m?.oiChangePct?.["24h"])}>{signed(m?.oiChangePct?.["24h"])}</span></>}>{usd(m?.oiUsd)}</Stat>
        <Stat label="CVD спот" sub={<>4h <span className={tone(m?.spotCvdUsd?.["4h"])}>{usd(m?.spotCvdUsd?.["4h"])}</span> · 24h <span className={tone(m?.spotCvdUsd?.["24h"])}>{usd(m?.spotCvdUsd?.["24h"])}</span></>}>
          <span className={tone(m?.spotCvdUsd?.["1h"])}>1h {usd(m?.spotCvdUsd?.["1h"])}</span>
        </Stat>
        <Stat label="CVD фьюч" sub={<>4h <span className={tone(m?.futCvdUsd?.["4h"])}>{usd(m?.futCvdUsd?.["4h"])}</span> · 24h <span className={tone(m?.futCvdUsd?.["24h"])}>{usd(m?.futCvdUsd?.["24h"])}</span></>}>
          <span className={tone(m?.futCvdUsd?.["1h"])}>1h {usd(m?.futCvdUsd?.["1h"])}</span>
        </Stat>
        <Stat label="Тейкеры 1h" sub={<>4h: фьюч <span className={tone(m?.futTakerNetPct?.["4h"])}>{signed(m?.futTakerNetPct?.["4h"], 1)}</span> · спот <span className={tone(m?.spotTakerNetPct?.["4h"])}>{signed(m?.spotTakerNetPct?.["4h"], 1)}</span></>}>
          <div className="text-sm">фьюч <span className={tone(m?.futTakerNetPct?.["1h"])}>{signed(m?.futTakerNetPct?.["1h"], 1)}</span></div>
          <div className="text-sm">спот <span className={tone(m?.spotTakerNetPct?.["1h"])}>{signed(m?.spotTakerNetPct?.["1h"], 1)}</span></div>
        </Stat>
        <Stat label="Толпа · стакан" sub={`RSI 1h ${num(ind("1h", "rsi14"), 0)} · 4h ${num(ind("4h", "rsi14"), 0)} · 1D ${num(ind("1d", "rsi14"), 0)}`}>
          <div className="text-sm">{crowd == null ? "—" : `${crowd.toFixed(0)}% в лонге (Binance)`}</div>
          <div className="text-sm">стакан bid/ask {num(m?.orderbookBidAskRatio, 2)}</div>
        </Stat>
      </div>

      {full && (
        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          <Chart title="Цена · 48 ч">
            <ResponsiveContainer><LineChart data={rows}><CartesianGrid stroke="#2a2214" vertical={false} /><XAxis dataKey="label" {...AXIS} minTickGap={40} /><YAxis {...AXIS} domain={["auto", "auto"]} width={58} tickFormatter={(v: number) => price(v)} /><Tooltip {...TIP} formatter={(v: number) => price(v)} /><Line dataKey="price" name="Цена" stroke={GOLD} dot={false} strokeWidth={2} /></LineChart></ResponsiveContainer>
          </Chart>
          <Chart title="Ликвидации по часам · лонги вниз, шорты вверх">
            <ResponsiveContainer><BarChart data={rows} stackOffset="sign"><CartesianGrid stroke="#2a2214" vertical={false} /><XAxis dataKey="label" {...AXIS} minTickGap={40} /><YAxis {...AXIS} width={58} tickFormatter={usdTick} /><Tooltip {...TIP} formatter={(v: number) => usd(Math.abs(v))} /><ReferenceLine y={0} stroke={MUTED} />
              <Bar dataKey="liqShortUsd" name="Шорты" stackId="l" fill={GREEN} /><Bar dataKey={(r: { liqLongUsd: number | null }) => (r.liqLongUsd == null ? null : -r.liqLongUsd)} name="Лонги" stackId="l" fill={RED} /></BarChart></ResponsiveContainer>
          </Chart>
          <Chart title="Фандинг, % за 8ч">
            <ResponsiveContainer><LineChart data={rows}><CartesianGrid stroke="#2a2214" vertical={false} /><XAxis dataKey="label" {...AXIS} minTickGap={40} /><YAxis {...AXIS} width={58} domain={[(lo: number) => Math.min(0, lo), (hi: number) => hi * 1.15]} tickFormatter={(v: number) => v.toFixed(4)} /><Tooltip {...TIP} formatter={(v: number) => fund(v)} /><ReferenceLine y={0.01} stroke={MUTED} strokeDasharray="3 3" /><Legend wrapperStyle={{ fontSize: 11 }} />
              <Line dataKey="fundingBingxPct" name="BingX" stroke={GOLD} dot={false} connectNulls /><Line dataKey="fundingCgPct" name="CoinGlass OI-взвеш." stroke={SKY} dot={false} connectNulls /></LineChart></ResponsiveContainer>
          </Chart>
          <Chart title="Открытый интерес (все биржи)">
            <ResponsiveContainer><AreaChart data={rows}><CartesianGrid stroke="#2a2214" vertical={false} /><XAxis dataKey="label" {...AXIS} minTickGap={40} /><YAxis {...AXIS} width={58} domain={["auto", "auto"]} tickFormatter={usdTick} /><Tooltip {...TIP} formatter={(v: number) => usd(v)} /><Area dataKey="oiUsd" name="OI" stroke={GOLD} fill={GOLD} fillOpacity={0.12} /></AreaChart></ResponsiveContainer>
          </Chart>
          <Chart title="CVD по часам: спот и фьюч">
            <ResponsiveContainer><BarChart data={rows}><CartesianGrid stroke="#2a2214" vertical={false} /><XAxis dataKey="label" {...AXIS} minTickGap={40} /><YAxis {...AXIS} width={58} tickFormatter={usdTick} /><Tooltip {...TIP} formatter={(v: number) => usd(v)} /><ReferenceLine y={0} stroke={MUTED} /><Legend wrapperStyle={{ fontSize: 11 }} />
              <Bar dataKey="spotCvdUsd" name="Спот" fill={SKY} /><Bar dataKey="futCvdUsd" name="Фьюч" fill={GOLD} /></BarChart></ResponsiveContainer>
          </Chart>
          <Chart title="Тейкеры net buy по часам, %">
            <ResponsiveContainer><LineChart data={rows}><CartesianGrid stroke="#2a2214" vertical={false} /><XAxis dataKey="label" {...AXIS} minTickGap={40} /><YAxis {...AXIS} width={40} /><Tooltip {...TIP} formatter={(v: number) => signed(v, 1)} /><ReferenceLine y={0} stroke={MUTED} /><Legend wrapperStyle={{ fontSize: 11 }} />
              <Line dataKey="futTakerNetPct" name="Фьюч" stroke={GOLD} dot={false} connectNulls /><Line dataKey="spotTakerNetPct" name="Спот" stroke={SKY} dot={false} connectNulls /></LineChart></ResponsiveContainer>
          </Chart>
          <Chart title="Whale Index и RSI 1h">
            <ResponsiveContainer><LineChart data={rows}><CartesianGrid stroke="#2a2214" vertical={false} /><XAxis dataKey="label" {...AXIS} minTickGap={40} /><YAxis yAxisId="wi" {...AXIS} width={40} /><YAxis yAxisId="rsi" orientation="right" {...AXIS} width={30} domain={[0, 100]} /><Tooltip {...TIP} formatter={(v: number) => num(v, 1)} /><ReferenceLine yAxisId="wi" y={0} stroke={MUTED} /><Legend wrapperStyle={{ fontSize: 11 }} />
              <Line yAxisId="wi" dataKey="whaleIndex" name="Whale Index" stroke={GOLD} dot={false} connectNulls /><Line yAxisId="rsi" dataKey="rsi1h" name="RSI 1h" stroke={SKY} dot={false} connectNulls /></LineChart></ResponsiveContainer>
          </Chart>
          <Chart title="Fear / Greed · 30 дней">
            <ResponsiveContainer><AreaChart data={fgRows}><CartesianGrid stroke="#2a2214" vertical={false} /><XAxis dataKey="label" {...AXIS} minTickGap={30} /><YAxis {...AXIS} width={30} domain={[0, 100]} /><Tooltip {...TIP} /><ReferenceLine y={50} stroke={MUTED} strokeDasharray="3 3" /><Area dataKey="v" name="Индекс" stroke={GOLD} fill={GOLD} fillOpacity={0.15} /></AreaChart></ResponsiveContainer>
          </Chart>
        </div>
      )}
      {full && <p className="mt-2 text-xs text-muted-foreground">Ликвидации, OI, CVD, тейкеры, Whale Index — CoinGlass, сумма по всем биржам; цена и RSI — BingX. Точка на графике — час (Дубай). Фандинг BingX пишется с 12.11, раньше точек нет.</p>}
    </Card>
  );
}
