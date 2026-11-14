import { useEffect, useMemo, useState } from "react";
import { Bar, CartesianGrid, Cell, ComposedChart, Line, ReferenceArea, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { duration, getJson, price } from "../lib/api";
import { Card } from "./ui";

/**
 * Main BTC chart on «Рынок» (owner 2026-11-14): candles, the Auto Range Detector range on 4h and 1D (the level of the
 * deviation / breakout signals), the ABNeon 4H zones (bounce / Stealth levels) and the channel signals as arrows.
 * Bigger than the other charts; 15m · 3 days, 1h · 7 days, 4h · 90 days, 1D · 1 year. Data: /api/btc/chart (BingX, production only).
 * Owner 2026-11-14: every indicator of the table on the chart — EMA / MA / Bollinger over the price, RSI, Stoch RSI,
 * MACD, ADX, MFI, CMF in panes under it; each switched on / off with a chip (the choice is kept in the browser).
 */
type Tf = "15m" | "1h" | "4h" | "1d";
type Range = { tf: "4h" | "1d"; state: "active" | "unconfirmed" | "broken_wait" | "last"; top: number; bottom: number; from: number; note: string | null };
type Sig = { id: number; at: number; direction: string; label: string; entry: number; status: string; closeReason: string | null; pnlPricePct: number | null; closedAt?: number | null };
export type ChartData = {
  tf: Tf; dev: boolean; spanMs?: number;
  candles: Array<{ t: number; o: number; h: number; l: number; c: number } & Record<string, number | null>>;
  ranges: Range[]; zones: Array<{ top: number; bottom: number; count: number }>; zonesFrom?: number | null; signals: Sig[];
};
type Row = { i: number; t: number; o: number; h: number; l: number; c: number; hl: [number, number] } & Record<string, number | null | [number, number]>;

const GREEN = "#34d399", RED = "#f43f5e", GOLD = "#f2b10f", SKY = "#7dd3fc", MUTED = "#8a7d63";
const AXIS = { stroke: MUTED, fontSize: 10 };
const TF_LABEL: Record<Tf, string> = { "15m": "15m · 3 дня", "1h": "1h · 7 дней", "4h": "4h · 90 дней", "1d": "1D · год" };
const RANGE_COLOR: Record<Range["tf"], string> = { "4h": GOLD, "1d": SKY };
const STATE_RU: Record<Range["state"], string> = {
  active: "диапазон", unconfirmed: "диапазон (не подтверждён)", broken_wait: "пробит", last: "последний пробитый",
};
const when = (t: number, tf: Tf) => new Date(t).toLocaleString("ru-RU", { timeZone: "Asia/Dubai", day: "2-digit", month: "2-digit", ...(tf === "1d" ? {} : { hour: "2-digit", minute: "2-digit" }) });

// ── Indicators (owner 2026-11-14) ──
type Overlay = { id: string; label: string; key: string; color: string; dash?: string };
const OVERLAYS: Overlay[] = [
  { id: "ema9", label: "EMA 9", key: "ema9", color: "#fde68a" },
  { id: "ema21", label: "EMA 21", key: "ema21", color: "#f59e0b" },
  { id: "ema50", label: "EMA 50", key: "ema50", color: "#38bdf8" },
  { id: "ema200", label: "EMA 200", key: "ema200", color: "#e879f9" },
  { id: "sma20", label: "MA 20", key: "sma20", color: "#a3e635", dash: "4 3" },
  { id: "sma50", label: "MA 50", key: "sma50", color: "#22d3ee", dash: "4 3" },
  { id: "sma200", label: "MA 200", key: "sma200", color: "#fb7185", dash: "4 3" },
];
const PANES = [
  { id: "rsi", label: "RSI 14" }, { id: "stoch", label: "Stoch RSI" }, { id: "macd", label: "MACD" },
  { id: "adx", label: "ADX / DI" }, { id: "mfi", label: "MFI" }, { id: "cmf", label: "CMF" },
] as const;
type PaneId = (typeof PANES)[number]["id"];
const DEFAULT_ON = ["ema50", "ema200", "rsi"];
const STORE = "btc-chart-ind";
const loadOn = (): string[] => { try { const v = JSON.parse(localStorage.getItem(STORE) ?? "null"); return Array.isArray(v) ? v : DEFAULT_ON; } catch { return DEFAULT_ON; } };
const saveOn = (v: string[]) => { try { localStorage.setItem(STORE, JSON.stringify(v)); } catch { /* storage unavailable */ } };
const f1 = (v: unknown, d = 1) => (typeof v === "number" ? v.toFixed(d) : "—");

/** One candle: wick + body inside the bar's low…high box. */
function CandleShape(props: { x?: number; y?: number; width?: number; height?: number; payload?: Row }) {
  const { x = 0, y = 0, width = 0, height = 0, payload } = props;
  if (!payload) return null;
  const { o, h, l, c } = payload;
  const span = h - l;
  const yOf = (v: number) => (span > 0 ? y + ((h - v) / span) * height : y);
  const color = c >= o ? GREEN : RED;
  const cx = x + width / 2;
  const bw = Math.max(1, width * 0.7);
  const top = yOf(Math.max(o, c)), bot = yOf(Math.min(o, c));
  return (
    <g>
      <line x1={cx} x2={cx} y1={y} y2={y + height} stroke={color} strokeWidth={1} />
      <rect x={cx - bw / 2} y={top} width={bw} height={Math.max(1, bot - top)} fill={color} />
    </g>
  );
}

function Arrow({ cx = 0, cy = 0, long }: { cx?: number; cy?: number; long: boolean }) {
  const d = long ? `M${cx} ${cy + 6} l-5 9 h10 z` : `M${cx} ${cy - 6} l-5 -9 h10 z`;
  return <path d={d} fill={long ? GREEN : RED} stroke="#0b0906" strokeWidth={0.8} />;
}

/** One indicator pane under the price, on the same candles (cursor synced with the price chart). */
function Pane({ id, rows, tf }: { id: PaneId; rows: Row[]; tf: Tf }) {
  const lastRow = rows[rows.length - 1]!;
  const lines: Array<{ key: string; name: string; color: string }> =
    id === "rsi" ? [{ key: "rsi14", name: "RSI", color: GOLD }]
    : id === "stoch" ? [{ key: "stochK", name: "K", color: GOLD }, { key: "stochD", name: "D", color: SKY }]
    : id === "macd" ? [{ key: "macd", name: "MACD", color: GOLD }, { key: "macdSignal", name: "сигнал", color: SKY }]
    : id === "adx" ? [{ key: "adx", name: "ADX", color: GOLD }, { key: "plusDi", name: "+DI", color: GREEN }, { key: "minusDi", name: "−DI", color: RED }]
    : id === "mfi" ? [{ key: "futMfi", name: "фьюч", color: GOLD }, { key: "spotMfi", name: "спот", color: SKY }]
    : [{ key: "futCmf", name: "фьюч", color: GOLD }, { key: "spotCmf", name: "спот", color: SKY }];
  const title = PANES.find((p) => p.id === id)!.label;
  const digits = id === "cmf" ? 3 : 1;
  const refs = id === "rsi" || id === "mfi" ? [70, 30] : id === "stoch" ? [80, 20] : id === "adx" ? [25] : [0];
  const noVolume = (id === "mfi" || id === "cmf") && (tf === "15m" || tf === "1d");
  const hasData = rows.some((r) => lines.some((l) => typeof r[l.key] === "number"));
  return (
    <div className="mt-1 border-t border-border/50 pt-1">
      <div className="flex flex-wrap gap-x-3 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
        <span>{title}{id === "mfi" || id === "cmf" ? " · агрегированный объём CoinGlass" : ""}</span>
        {lines.map((l) => <span key={l.key} style={{ color: l.color }}>{l.name} {f1(lastRow[l.key], digits)}</span>)}
        {id === "macd" && <span>гист. {f1(lastRow.macdHist)}</span>}
      </div>
      {noVolume || !hasData ? (
        <p className="py-2 text-xs text-muted-foreground">{noVolume ? "MFI и CMF на агрегированном объёме есть только на 1h и 4h." : "Нет данных."}</p>
      ) : (
        <div className="h-24 md:h-28">
          <ResponsiveContainer>
            <ComposedChart data={rows} syncId="btcmain" margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid stroke="#2a2214" vertical={false} />
              <XAxis dataKey="i" type="number" domain={[-0.5, rows.length - 0.5]} hide />
              <YAxis {...AXIS} orientation="right" width={62} domain={id === "rsi" || id === "stoch" || id === "mfi" ? [0, 100] : ["auto", "auto"]} tickFormatter={(v: number) => (id === "cmf" ? v.toFixed(2) : v.toFixed(0))} />
              {refs.map((y) => <ReferenceLine key={y} y={y} stroke={MUTED} strokeDasharray="3 3" />)}
              {id === "macd" && (
                <Bar dataKey="macdHist" isAnimationActive={false}>
                  {rows.map((r, k) => <Cell key={k} fill={typeof r.macdHist === "number" && r.macdHist >= 0 ? GREEN : RED} fillOpacity={0.6} />)}
                </Bar>
              )}
              {lines.map((l) => <Line key={l.key} dataKey={l.key} stroke={l.color} strokeWidth={1.3} dot={false} connectNulls isAnimationActive={false} />)}
              <Tooltip cursor={{ stroke: MUTED, strokeDasharray: "3 3" }} content={({ active, payload }) => {
                const row = active && payload?.[0] ? (payload[0].payload as Row) : null;
                if (!row) return null;
                return (
                  <div className="rounded-lg border border-[#5a4417] bg-[#120f0a] px-2 py-1 text-[11px]">
                    <div className="text-[#d8c9a6]">{when(row.t, tf)}</div>
                    {lines.map((l) => <div key={l.key} style={{ color: l.color }}>{l.name} {f1(row[l.key], digits)}</div>)}
                    {id === "macd" && <div>гист. {f1(row.macdHist)}</div>}
                  </div>
                );
              }} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

/** The chart itself (separate so it renders from given data). */
export function ChartBody({ d, tf, on = DEFAULT_ON }: { d: ChartData; tf: Tf; on?: string[] }) {
  const view = useMemo(() => {
    const rows: Row[] = d.candles.map((k, i) => ({ i, ...k, hl: [k.l, k.h] }));
    const idxOf = (t: number) => {
      if (t < rows[0]!.t) return 0;
      for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.t <= t) return i;
      return 0;
    };
    // A signal in the still-forming candle sits on the last closed one.
    const sigs = d.signals.map((s) => ({ ...s, i: Math.min(rows.length - 1, idxOf(s.at)) }));
    const last = rows[rows.length - 1]!.c;
    let lo = Math.min(...rows.map((r) => r.l)), hi = Math.max(...rows.map((r) => r.h));
    // The ranges stay in view when they are near the price (within 12%); far ABNeon zones are clipped.
    for (const r of d.ranges) for (const v of [r.top, r.bottom]) if (Math.abs(v - last) / last < 0.12) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    // Switched-on lines stay in view while within 20% of the price (a far EMA 200 would squash the candles).
    const keys = [...OVERLAYS.filter((o) => on.includes(o.id)).map((o) => o.key), ...(on.includes("bb") ? ["bbUpper", "bbLower"] : [])];
    for (const r of rows) for (const k of keys) { const v = r[k]; if (typeof v === "number" && Math.abs(v - last) / last < 0.2) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
    const pad = (hi - lo) * 0.04;
    return { rows, sigs, domain: [lo - pad, hi + pad] as [number, number], idxOf };
  }, [d, on]);

  return (
        <>
          <div className="h-80 md:h-[460px]">
            <ResponsiveContainer>
              <ComposedChart data={view.rows} syncId="btcmain" margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="#2a2214" vertical={false} />
                <XAxis dataKey="i" type="number" domain={[-0.5, view.rows.length - 0.5]} {...AXIS} minTickGap={40}
                  tickFormatter={(i: number) => { const r = view.rows[Math.round(i)]; return r ? when(r.t, tf) : ""; }} />
                <YAxis {...AXIS} orientation="right" width={62} domain={view.domain} allowDataOverflow tickFormatter={(v: number) => price(v)} />
                {/* As her TradingView ABNeon: green under the price (support), red above (resistance), from 300 4H bars back. */}
                {d.zones.map((z, k) => {
                  const col = z.top < view.rows[view.rows.length - 1]!.c ? GREEN : RED;
                  const x1 = d.zonesFrom != null ? view.idxOf(d.zonesFrom) : 0;
                  return (
                    <ReferenceArea key={`z${k}`} x1={x1} x2={view.rows.length - 0.5} y1={z.bottom} y2={z.top} fill={col} fillOpacity={0.16} stroke={col} strokeOpacity={0.5} ifOverflow="hidden"
                      label={{ value: `ABNeon ${price(z.bottom)}–${price(z.top)} (${z.count})`, position: "insideLeft", fill: col, fontSize: 9 }} />
                  );
                })}
                {d.ranges.flatMap((r) => {
                  const x1 = view.idxOf(r.from), x2 = view.rows.length - 1;
                  const dash = r.state === "active" ? undefined : "6 4";
                  const op = r.state === "last" || r.state === "unconfirmed" ? 0.5 : 0.95;
                  const name = `Range ${r.tf === "1d" ? "1D" : "4h"}`;
                  return [
                    <ReferenceLine key={`${r.tf}t`} segment={[{ x: x1, y: r.top }, { x: x2, y: r.top }]} stroke={RANGE_COLOR[r.tf]} strokeWidth={1.6} strokeDasharray={dash} strokeOpacity={op} ifOverflow="hidden"
                      label={{ value: `${name} верх`, position: "insideTopLeft", fill: RANGE_COLOR[r.tf], fontSize: 10 }} />,
                    <ReferenceLine key={`${r.tf}b`} segment={[{ x: x1, y: r.bottom }, { x: x2, y: r.bottom }]} stroke={RANGE_COLOR[r.tf]} strokeWidth={1.6} strokeDasharray={dash} strokeOpacity={op} ifOverflow="hidden"
                      label={{ value: `${name} низ`, position: "insideBottomLeft", fill: RANGE_COLOR[r.tf], fontSize: 10 }} />,
                  ];
                })}
                {on.includes("bb") && <Line dataKey="bbUpper" stroke="#94a3b8" strokeDasharray="2 3" dot={false} connectNulls isAnimationActive={false} />}
                {on.includes("bb") && <Line dataKey="bbLower" stroke="#94a3b8" strokeDasharray="2 3" dot={false} connectNulls isAnimationActive={false} />}
                {OVERLAYS.filter((o) => on.includes(o.id)).map((o) => (
                  <Line key={o.id} dataKey={o.key} stroke={o.color} strokeWidth={1.3} strokeDasharray={o.dash} dot={false} connectNulls isAnimationActive={false} />
                ))}
                <Bar dataKey="hl" isAnimationActive={false} shape={(p: unknown) => <CandleShape {...(p as object)} />} />
                {view.sigs.map((s) => {
                  const r = view.rows[s.i]!;
                  const long = s.direction === "long";
                  return <ReferenceDot key={s.id} x={s.i} y={long ? r.l : r.h} r={0} ifOverflow="visible" shape={(p: { cx?: number; cy?: number }) => <Arrow cx={p.cx} cy={p.cy} long={long} />} />;
                })}
                <Tooltip cursor={{ stroke: MUTED, strokeDasharray: "3 3" }}
                  content={({ active, payload }) => {
                    const row = active && payload?.[0] ? (payload[0].payload as Row) : null;
                    if (!row) return null;
                    const here = view.sigs.filter((s) => s.i === row.i);
                    return (
                      <div className="rounded-lg border border-[#5a4417] bg-[#120f0a] px-3 py-2 text-xs">
                        <div className="text-[#d8c9a6]">{when(row.t, tf)}</div>
                        <div className="tabular-nums">O {price(row.o)} · H {price(row.h)} · L {price(row.l)} · C {price(row.c)}</div>
                        {OVERLAYS.filter((o) => on.includes(o.id)).map((o) => <div key={o.id} className="tabular-nums" style={{ color: o.color }}>{o.label} {price(row[o.key] as number | null)}</div>)}
                        {on.includes("bb") && <div className="tabular-nums text-slate-300">Боллинджер {price(row.bbLower as number | null)} – {price(row.bbUpper as number | null)}</div>}
                        {here.map((s) => (
                          <div key={s.id} className={s.direction === "long" ? "text-emerald-300" : "text-rose-300"}>
                            {s.direction === "long" ? "▲" : "▼"} {s.label} · вход {price(s.entry)}
                            {s.status === "closed" && s.pnlPricePct != null ? ` · ${s.pnlPricePct >= 0 ? "+" : ""}${s.pnlPricePct.toFixed(2)}%` : s.status === "open" ? " · открыт" : ""}
                            {/* Owner 2026-11-14: opening date and how long the signal was active (open: active now). */}
                            <div className="text-[#d8c9a6]">
                              открыт {when(s.at, "1h")} · {s.closedAt ? `был активен ${duration(s.closedAt - s.at)}` : `активен ${duration(Date.now() - s.at)}`}
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  }} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          {PANES.filter((p) => on.includes(p.id)).map((p) => <Pane key={p.id} id={p.id} rows={view.rows} tf={tf} />)}
          <div className="mt-2 space-y-0.5 text-xs text-muted-foreground">
            {d.ranges.map((r) => (
              <div key={r.tf}>
                <span style={{ color: RANGE_COLOR[r.tf] }}>Range {r.tf === "1d" ? "1D" : "4h"}</span> · {STATE_RU[r.state]} {price(r.bottom)} – {price(r.top)}
                {r.note && r.state === "broken_wait" ? ` · ${r.note}` : ""}
              </div>
            ))}
            {!d.ranges.length && <div>Range 4h / 1D: диапазона сейчас нет.</div>}
            <div>
              <span className="text-emerald-300">ABNeon</span>/<span className="text-rose-300">4H</span> · зоны {d.zones.length ? d.zones.map((z) => `${price(z.bottom)}–${price(z.top)}`).join(" · ") : "—"}
            </div>
            <div>
              Сплошная линия — подтверждённый диапазон (от него сигналы пробоя и девиации), пунктир — пробитый: возврат внутрь = девиация.
              Полосы ABNeon (4H, те же, по которым бот даёт отскок и Stealth): зелёные — ниже цены (поддержка), красные — выше (сопротивление). <span className="text-emerald-300">▲</span> лонг, <span className="text-rose-300">▼</span> шорт — сигналы канала. Свечи BingX, время Дубая.
            </div>
          </div>
        </>
  );
}

export function BtcMainChart() {
  const [tf, setTf] = useState<Tf>("4h");
  const [on, setOn] = useState<string[]>(loadOn);
  const toggle = (id: string) => setOn((cur) => { const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]; saveOn(next); return next; });
  const [d, setD] = useState<ChartData | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => getJson<ChartData>(`/api/btc/chart?tf=${tf}`).then((r) => { if (alive) { setD(r); setErr(null); } }).catch((e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    load();
    const id = setInterval(load, 5 * 60_000);
    return () => { alive = false; clearInterval(id); };
  }, [tf]);

  const switcher = (
    <div className="flex gap-1">
      {(["15m", "1h", "4h", "1d"] as Tf[]).map((k) => (
        <button key={k} type="button" onClick={() => setTf(k)}
          className={`rounded-md border px-2 py-0.5 text-xs ${tf === k ? "border-gold/70 bg-gold/15 text-gold" : "border-white/10 text-muted-foreground hover:text-foreground"}`}>
          {TF_LABEL[k]}
        </button>
      ))}
    </div>
  );

  return (
    <Card title="График BTC · уровни и сигналы" right={switcher}>
      {d?.dev ? (
        <p className="text-sm text-muted-foreground">График строится только в опубликованной версии (в dev бот не ходит на биржу).</p>
      ) : !d || d.tf !== tf || !d.candles.length ? (
        <p className="text-sm text-muted-foreground">{err ? `График недоступен: ${err}` : d?.tf === tf ? "Нет свечей." : "Загружаю график…"}</p>
      ) : (
        <>
          <div className="mb-2 flex flex-wrap gap-1">
            {[...OVERLAYS.map((o) => ({ id: o.id, label: o.label, color: o.color })), { id: "bb", label: "Боллинджер", color: "#94a3b8" }, ...PANES.map((p) => ({ id: p.id, label: p.label, color: GOLD }))].map((c) => {
              const active = on.includes(c.id);
              return (
                <button key={c.id} type="button" onClick={() => toggle(c.id)}
                  className={`rounded-full border px-2 py-0.5 text-[11px] ${active ? "bg-white/5" : "border-white/10 text-muted-foreground hover:text-foreground"}`}
                  style={active ? { borderColor: c.color, color: c.color } : undefined}>
                  {c.label}
                </button>
              );
            })}
          </div>
          <ChartBody d={d} tf={tf} on={on} />
        </>
      )}
    </Card>
  );
}
