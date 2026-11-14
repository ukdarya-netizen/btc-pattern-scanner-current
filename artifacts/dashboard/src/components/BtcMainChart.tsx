import { useEffect, useMemo, useState } from "react";
import { Bar, CartesianGrid, ComposedChart, ReferenceArea, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { getJson, price } from "../lib/api";
import { Card } from "./ui";

/**
 * Main BTC chart on «Рынок» (owner 2026-11-14): candles, the Auto Range Detector range on 4h and 1D (the level of the
 * deviation / breakout signals), the ABNeon 4H zones (bounce / Stealth levels) and the channel signals as arrows.
 * Bigger than the other charts; 1h · 7 days, 4h · 90 days, 1D · 1 year. Data: /api/btc/chart (BingX, production only).
 */
type Tf = "1h" | "4h" | "1d";
type Range = { tf: "4h" | "1d"; state: "active" | "unconfirmed" | "broken_wait" | "last"; top: number; bottom: number; from: number; note: string | null };
type Sig = { id: number; at: number; direction: string; label: string; entry: number; status: string; closeReason: string | null; pnlPricePct: number | null };
export type ChartData = {
  tf: Tf; dev: boolean; spanMs?: number;
  candles: Array<{ t: number; o: number; h: number; l: number; c: number }>;
  ranges: Range[]; zones: Array<{ top: number; bottom: number; count: number }>; signals: Sig[];
};
type Row = { i: number; t: number; o: number; h: number; l: number; c: number; hl: [number, number] };

const GREEN = "#34d399", RED = "#f43f5e", GOLD = "#f2b10f", SKY = "#7dd3fc", NEON = "#c084fc", MUTED = "#8a7d63";
const AXIS = { stroke: MUTED, fontSize: 10 };
const TF_LABEL: Record<Tf, string> = { "1h": "1h · 7 дней", "4h": "4h · 90 дней", "1d": "1D · год" };
const RANGE_COLOR: Record<Range["tf"], string> = { "4h": GOLD, "1d": SKY };
const STATE_RU: Record<Range["state"], string> = {
  active: "диапазон", unconfirmed: "диапазон (не подтверждён)", broken_wait: "пробит", last: "последний пробитый",
};
const when = (t: number, tf: Tf) => new Date(t).toLocaleString("ru-RU", { timeZone: "Asia/Dubai", day: "2-digit", month: "2-digit", ...(tf === "1d" ? {} : { hour: "2-digit", minute: "2-digit" }) });

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

/** The chart itself (separate so it renders from given data). */
export function ChartBody({ d, tf }: { d: ChartData; tf: Tf }) {
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
    const pad = (hi - lo) * 0.04;
    return { rows, sigs, domain: [lo - pad, hi + pad] as [number, number], idxOf };
  }, [d]);

  return (
        <>
          <div className="h-80 md:h-[460px]">
            <ResponsiveContainer>
              <ComposedChart data={view.rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="#2a2214" vertical={false} />
                <XAxis dataKey="i" type="number" domain={[-0.5, view.rows.length - 0.5]} {...AXIS} minTickGap={40}
                  tickFormatter={(i: number) => { const r = view.rows[Math.round(i)]; return r ? when(r.t, tf) : ""; }} />
                <YAxis {...AXIS} orientation="right" width={62} domain={view.domain} allowDataOverflow tickFormatter={(v: number) => price(v)} />
                {d.zones.map((z, k) => (
                  <ReferenceArea key={`z${k}`} y1={z.bottom} y2={z.top} fill={NEON} fillOpacity={0.13} stroke={NEON} strokeOpacity={0.35} ifOverflow="hidden" />
                ))}
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
                        {here.map((s) => (
                          <div key={s.id} className={s.direction === "long" ? "text-emerald-300" : "text-rose-300"}>
                            {s.direction === "long" ? "▲" : "▼"} {s.label} · вход {price(s.entry)}
                            {s.status === "closed" && s.pnlPricePct != null ? ` · ${s.pnlPricePct >= 0 ? "+" : ""}${s.pnlPricePct.toFixed(2)}%` : s.status === "open" ? " · открыт" : ""}
                          </div>
                        ))}
                      </div>
                    );
                  }} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-2 space-y-0.5 text-xs text-muted-foreground">
            {d.ranges.map((r) => (
              <div key={r.tf}>
                <span style={{ color: RANGE_COLOR[r.tf] }}>Range {r.tf === "1d" ? "1D" : "4h"}</span> · {STATE_RU[r.state]} {price(r.bottom)} – {price(r.top)}
                {r.note && r.state === "broken_wait" ? ` · ${r.note}` : ""}
              </div>
            ))}
            {!d.ranges.length && <div>Range 4h / 1D: диапазона сейчас нет.</div>}
            <div>
              <span style={{ color: NEON }}>ABNeon 4H</span> · зоны {d.zones.length ? d.zones.map((z) => `${price(z.bottom)}–${price(z.top)}`).join(" · ") : "—"}
            </div>
            <div>
              Сплошная линия — подтверждённый диапазон (от него сигналы пробоя и девиации), пунктир — пробитый: возврат внутрь = девиация.
              Фиолетовые полосы — уровни ABNeon (отскок и Stealth). <span className="text-emerald-300">▲</span> лонг, <span className="text-rose-300">▼</span> шорт — сигналы канала. Свечи BingX, время Дубая.
            </div>
          </div>
        </>
  );
}

export function BtcMainChart() {
  const [tf, setTf] = useState<Tf>("4h");
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
      {(["1h", "4h", "1d"] as Tf[]).map((k) => (
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
        <ChartBody d={d} tf={tf} />
      )}
    </Card>
  );
}
