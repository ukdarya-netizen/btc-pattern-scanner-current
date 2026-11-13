/**
 * ABNeon and Stealth for BTC (owner 2026-11-12: "все паттерны из CAB, адаптировать под биток"; owner 2026-11-13: published
 * to the channel like every other pattern — she wants to see how they work). The levels are CAB's ABNeon 4H zones (neonZones.ts, the owner's indicator).
 * Volume is Lucy's VSA (owner's indicator: 20-bar Welkin, grey under the 120-bar average; CoinGlass aggregated
 * futures + spot) on the trading timeframe. Every distance is sized by BTC's own ATR, not by altcoin percentages
 * (BTC moves 3–5× less than an altcoin): the touch band, the sweep allowance and the stop buffer.
 *
 * Trading styles by timeframe (owner): 15m = скальп, 1h = интрадей, 4h = свинг. 4H zones → profile h4 (x20,
 * the liquidation guard caps the stop).
 *
 * ABNeon bounce — a support bounce by the trading rules, both sides (a short is the mirror at resistance):
 *   test: within the last W bars (15m: 8, 1h: 6, 4h: 2) the lowest low reached a zone — from 1 × ATR(4H) below its
 *     bottom (a liquidity sweep is allowed) up to its top + 0.25 × ATR(4H);
 *   reaction: the bar that just closed is the FIRST green bar after that low closing at or above the zone bottom;
 *   void: a 4H close under the zone bottom since the test;
 *   volume: the test bar or the reaction bar not grey by Lucy's VSA rule;
 *   stop: below the test low (or the zone bottom, the lower) − 0.2 × ATR of the trading timeframe;
 *   targets: the next zones above (bottom of each), 50 / 50; without a zone above — 1.5R and 3R; B.U. after the first.
 * Stealth (ABNeon level breakout), both sides: the bar that just closed opened at or under a zone top and closed above
 *   it on bright Lucy volume (O / M / W); stop below the zone bottom (or the bar low, the lower) − 0.2 × ATR(tf);
 *   targets: the next zones above, as the bounce. A short is the mirror below a zone bottom.
 */
import type { Direction } from "../config/profiles";
import type { Candle } from "../market/bingx";
import type { LucyTf } from "../market/lucyVolume";
import type { Pattern, PatternResult } from "./patterns";
import type { Snapshot } from "./snapshot";
import { computeZones, lucyColour, wilderAtr, type Zone } from "./neonZones";

export const NEON_TFS = ["15m", "1h", "4h"] as const;
type Tf = (typeof NEON_TFS)[number];
const STYLE: Record<Tf, string> = { "15m": "скальп 15m", "1h": "интрадей 1h", "4h": "свинг 4h" };
const TEST_BARS: Record<Tf, number> = { "15m": 8, "1h": 6, "4h": 2 };
const TOUCH_ATR4 = 0.25, SWEEP_ATR4 = 1, STOP_ATR_TF = 0.2;
const H4 = 14_400_000;
const BRIGHT = new Set(["O", "M", "W"]);

const zoneCache = new WeakMap<Snapshot, { zones: Zone[]; atr4: number | null }>();
function zonesOf(s: Snapshot): { zones: Zone[]; atr4: number | null } {
  const known = zoneCache.get(s);
  if (known) return known;
  const h4 = s.candles["4h"].slice(-640);
  const out = { zones: h4.length >= 200 ? computeZones(h4) : [], atr4: wilderAtr(h4) };
  zoneCache.set(s, out);
  return out;
}

const r = (x: number | null | undefined, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? null : Number(x.toFixed(d)));
const zoneOut = (z: Zone) => ({ top: r(z.top), bottom: r(z.bottom), count: z.count });

/** Lucy's VSA colours of the trading timeframe's candles (base-unit volume = USD / close). */
function colours(s: Snapshot, tf: Tf, cs: Candle[]): (i: number) => string | null {
  const usd = s.lucy?.[tf as LucyTf] ?? null;
  const vol = cs.map((c) => { const v = usd?.get(c.time); return v != null && c.close > 0 ? v / c.close : NaN; });
  return (i) => (usd ? lucyColour(vol, i) : null);
}

/** Targets: the next zones beyond the entry (their near edge), 50 / 50; otherwise 1.5R / 3R. */
function targetsFor(direction: Direction, entry: number, stop: number, zones: Zone[]) {
  const dir = direction === "long" ? 1 : -1;
  const ahead = zones.map((z) => (direction === "long" ? z.bottom : z.top))
    .filter((p) => (p - entry) * dir > 0).sort((a, b) => (a - b) * dir);
  const risk = Math.abs(entry - stop);
  const t1 = ahead[0] ?? entry + dir * 1.5 * risk;
  const t2 = ahead[1] ?? (ahead[0] !== undefined ? entry + dir * 2 * Math.abs(t1 - entry) : entry + dir * 3 * risk);
  return { targets: [{ price: t1, fraction: 0.5 }, { price: t2, fraction: 0.5 }], source: ahead.length ? "zones" : "r_multiple", rr1: risk > 0 ? Math.abs(t1 - entry) / risk : null };
}

export function evaluateBounce(s: Snapshot, tf: Tf, direction: Direction): PatternResult {
  const cs = s.candles[tf];
  const { zones, atr4 } = zonesOf(s);
  if (zones.length === 0 || atr4 === null) return { fires: false, reasons: ["zones:no_data"] };
  if (cs.length < 140) return { fires: false, reasons: [`${tf}_history:no_data`] };
  const i = cs.length - 1, bar = cs[i]!, long = direction === "long";
  // The test: the extreme of the last W bars.
  let x = i;
  for (let k = i - TEST_BARS[tf] + 1; k <= i; k++) if (long ? cs[k]!.low < cs[x]!.low : cs[k]!.high > cs[x]!.high) x = k;
  const ext = long ? cs[x]!.low : cs[x]!.high;
  const touched = zones.filter((z) => long
    ? ext >= z.bottom - SWEEP_ATR4 * atr4 && ext <= z.top + TOUCH_ATR4 * atr4
    : ext <= z.top + SWEEP_ATR4 * atr4 && ext >= z.bottom - TOUCH_ATR4 * atr4);
  if (!touched.length) return { fires: false, reasons: ["no_zone_test"] };
  const zone = touched.sort((a, b) => (long ? b.top - a.top : a.bottom - b.bottom))[0]!;
  const reacts = (c: Candle) => (long ? c.close > c.open && c.close >= zone.bottom : c.close < c.open && c.close <= zone.top);
  if (!reacts(bar)) return { fires: false, reasons: ["no_reaction_bar"], detail: { method: "abneon_bounce", tf, zone: zoneOut(zone) } };
  for (let k = x; k < i; k++) if (reacts(cs[k]!)) return { fires: false, reasons: ["not_first_reaction"], detail: { method: "abneon_bounce", tf, zone: zoneOut(zone) } };
  const testH4 = Math.floor(cs[x]!.time / H4) * H4;
  if (s.candles["4h"].some((c) => c.time >= testH4 && (long ? c.close < zone.bottom : c.close > zone.top))) {
    return { fires: false, reasons: ["4h_close_through_zone"], detail: { method: "abneon_bounce", tf, zone: zoneOut(zone) } };
  }
  const colourAt = colours(s, tf, cs);
  const cTest = colourAt(x), cBar = colourAt(i);
  const detail: Record<string, unknown> = {
    method: "abneon_bounce", style: STYLE[tf], tf, zone: zoneOut(zone), testAt: new Date(cs[x]!.time).toISOString(), testExtreme: ext,
    sweep: long ? ext < zone.bottom : ext > zone.top, lucyTest: cTest, lucyReaction: cBar, atr4h: r(atr4),
  };
  if (cTest === null && cBar === null) return { fires: false, reasons: ["lucy_volume:no_data"], detail };
  if ((cTest ?? "N") === "N" && (cBar ?? "N") === "N") return { fires: false, reasons: ["lucy_volume_grey"], detail };
  const atrTf = wilderAtr(cs.slice(-200)) ?? 0;
  const stop = long ? Math.min(ext, zone.bottom) - STOP_ATR_TF * atrTf : Math.max(ext, zone.top) + STOP_ATR_TF * atrTf;
  const t = targetsFor(direction, bar.close, stop, zones);
  const levels = { stop, targets: t.targets };
  return { fires: true, reasons: ["ok"], levels, detail: { ...detail, atrTf: r(atrTf), targetsSource: t.source, rr1: r(t.rr1), levels } };
}

export function evaluateBreakout(s: Snapshot, tf: Tf, direction: Direction): PatternResult {
  const cs = s.candles[tf];
  const { zones } = zonesOf(s);
  if (zones.length === 0) return { fires: false, reasons: ["zones:no_data"] };
  if (cs.length < 140) return { fires: false, reasons: [`${tf}_history:no_data`] };
  const i = cs.length - 1, bar = cs[i]!, long = direction === "long";
  const crossed = zones.filter((z) => (long ? bar.open <= z.top && bar.close > z.top : bar.open >= z.bottom && bar.close < z.bottom));
  if (!crossed.length) return { fires: false, reasons: ["no_level_crossed"] };
  const zone = crossed.sort((a, b) => (long ? b.top - a.top : a.bottom - b.bottom))[0]!;
  const colour = colours(s, tf, cs)(i);
  const detail: Record<string, unknown> = { method: "stealth_breakout", style: STYLE[tf], tf, zone: zoneOut(zone), lucy: colour };
  if (colour === null) return { fires: false, reasons: ["lucy_volume:no_data"], detail };
  if (!BRIGHT.has(colour)) return { fires: false, reasons: [`lucy_volume_not_bright_${colour}`], detail };
  const atrTf = wilderAtr(cs.slice(-200)) ?? 0;
  const stop = long ? Math.min(bar.low, zone.bottom) - STOP_ATR_TF * atrTf : Math.max(bar.high, zone.top) + STOP_ATR_TF * atrTf;
  const t = targetsFor(direction, bar.close, stop, zones.filter((z) => z !== zone));
  const levels = { stop, targets: t.targets };
  return { fires: true, reasons: ["ok"], levels, detail: { ...detail, atrTf: r(atrTf), targetsSource: t.source, rr1: r(t.rr1), levels } };
}

const side = (d: Direction) => (d === "long" ? "лонг" : "шорт");
export const NEON_PATTERNS: Pattern[] = NEON_TFS.flatMap((tf) => (["long", "short"] as const).flatMap((direction): Pattern[] => [
  {
    key: `neon_bounce_${tf}_${direction}`,
    label: `ABNeon отскок · ${STYLE[tf]} · ${side(direction)}`,
    direction, profile: "h4", live: true, // owner 2026-11-13: to the channel — she wants to see how they work
    ...(tf === "4h" ? {} : { evalTf: tf }),
    evaluate: (s) => evaluateBounce(s, tf, direction),
  },
  {
    key: `neon_breakout_${tf}_${direction}`,
    label: `Stealth пробой уровня · ${STYLE[tf]} · ${side(direction)}`,
    direction, profile: "h4", live: true, // owner 2026-11-13: to the channel — she wants to see how they work
    ...(tf === "4h" ? {} : { evalTf: tf }),
    evaluate: (s) => evaluateBreakout(s, tf, direction),
  },
]));
