/**
 * Volume study at the entry of every BTC signal (owner 2026-11-09: the full Nihilist / CAB set, all methods):
 * Wyckoff phase (CAB rules), the owner's VSA Wyckoff Volume / Welkin colours of the 48 hourly bars before the
 * entry, Elliott count of the move into the entry, and the full ICT reading on 15m and 1H with the method's
 * level (Smart Money: the order block; cascade: the cascade extreme; range: the range bounds). BingX BTC-USDT
 * candles and volume (as the owner reads them on TradingView); shorts are mirrored so every reading is "in the
 * trade's direction". Pure modules ported 1:1 from Crypto Nihilist (market/study/). Observation only. Never throws.
 */
import type { Candle } from "../market/bingx";
import { computeWyckoff } from "../market/study/wyckoff";
import { colorWindow } from "../market/study/volume-colors";
import { countDeclineWaves } from "../market/study/elliott";
import { ictReading, ictSessionReading, mirrorIct, type IctBar } from "../market/study/ict";

const H1 = 3_600_000, M15 = 15 * 60_000;
const toIct = (cs: Candle[]): IctBar[] => cs.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }));

/** The method's level for ICT: [top, bottom] in real prices (null = none). */
export function levelOf(detail: Record<string, unknown> | undefined): { top: number; bottom: number; touchAt: number | null } | null {
  const d = (detail ?? {}) as Record<string, any>;
  if (d.block && d.block.top > 0 && d.block.bottom > 0) return { top: d.block.top, bottom: d.block.bottom, touchAt: Date.parse(d.firstTouchAt) || null };
  if (Number.isFinite(d.cascadeExtreme)) return { top: d.cascadeExtreme, bottom: d.cascadeExtreme, touchAt: Date.parse(d.spikeAt) || null };
  if (d.event && d.event.top > 0 && d.event.bottom > 0) return { top: d.event.top, bottom: d.event.bottom, touchAt: null };
  return null;
}

export function entryStudy(c1h: Candle[], c15: Candle[], direction: "long" | "short", at: number, detail?: Record<string, unknown>) {
  try {
    const short = direction === "short";
    const level = levelOf(detail);
    const lt = level ? (short ? -level.bottom : level.top) : null;
    const lb = level ? (short ? -level.top : level.bottom) : null;
    const out: Record<string, unknown> = { version: 1, source: "bingx_btc_usdt", mirroredForShort: short };
    // Wyckoff, colours, Elliott on the last closed 1H bar.
    const entry1h = Math.floor(at / H1) * H1 - H1;
    let b1 = toIct(c1h);
    if (short) b1 = mirrorIct(b1);
    const ohlc = b1.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close }));
    const vol = new Map(b1.map((b) => [b.time, b.volume]));
    const bars = new Map(ohlc.map((b) => [b.time, b]));
    if (bars.has(entry1h)) {
      const w = computeWyckoff(ohlc, vol, entry1h);
      const counts: Record<string, number> = {};
      for (const e of w.events) counts[e.type] = (counts[e.type] ?? 0) + 1;
      out.wyckoff = { phase: w.phase, entryPositionInRange: w.entryPositionInRange, rangeHeightPct: w.rangeHeightPct, counts };
      out.colors = colorWindow(ohlc.map((b) => b.time), (t) => vol.get(t) ?? null, entry1h, (t) => bars.get(t));
      out.elliott = countDeclineWaves(ohlc, ohlc.findIndex((b) => b.time === entry1h));
    } else out.wyckoff = { reason: "no 1H entry candle" };
    // ICT on 1H and 15m, window from the method's touch (else 24 / 48 bars).
    for (const [key, cs, ms, defWindow] of [["h1", c1h, H1, 24], ["m15", c15, M15, 48]] as const) {
      let b = toIct(cs);
      if (short) b = mirrorIct(b);
      const e = b.findIndex((x) => x.time === Math.floor(at / ms) * ms - ms);
      if (e < 0) { out[`ict_${key}`] = { reason: "no entry candle" }; continue; }
      let w0 = e - defWindow + 1;
      if (level?.touchAt) { const i = b.findIndex((x) => x.time + ms > level.touchAt!); if (i >= 0 && i <= e) w0 = i; }
      out[`ict_${key}`] = { ...ictReading(b, e, { w0, levelTop: lt, levelBottom: lb }), ...ictSessionReading(b, e, { levelTop: lt, barMs: ms }) };
    }
    return out;
  } catch (err) {
    return { error: String(err).slice(0, 160) };
  }
}
