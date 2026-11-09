/**
 * Smart Money for BTC (owner 2026-11-09: the Crypto Nihilist method, live at once, both sides).
 * The SMC engine and the setup are ported 1:1 from Crypto Nihilist (engine/smc/): an active order block on
 * 4h / 1D (LuxAlgo internal or swing), a closed 30m / 1h bar trades into it, then an internal CHoCH on that
 * timeframe within 12 bars → signal on the CHoCH bar. Stop: below the reaction low − 0.1 × ATR(14) of the
 * structure timeframe, then BTC_STOP_EXTRA_PCT further (Nihilist's 3% is for altcoins; at x20 BTC allows at most
 * ~3.7% — scaled to BTC volatility). Targets 1.5R and 3R (50/50), break-even after the first (owner 2026-11-09);
 * the structure levels Nihilist computes are recorded, not traded. Order block 4h → x20 (h4), 1D → x10 (d1);
 * the liquidation guard applies. Nihilist's long entry filter (stop ≥ 7%, block ≥ 4% of price, ATR 1H ≥ 1.2%)
 * is altcoin-sized and would stop every BTC signal: its values are recorded, not applied.
 * One move = one signal per side (Nihilist rule): when several combos fire on the same bar, the highest
 * priority opens (1d_1h, 1d_30m, 4h_1h, 4h_30m), the others are recorded as duplicates.
 */
import type { Direction, ProfileKey } from "../config/profiles";
import type { Pattern, PatternResult } from "./patterns";
import type { Snapshot } from "./snapshot";
import { INTERVAL_MS, fromBtc, to30m, type Candle } from "./smc/candles";
import { evaluateSetups, type HtfInterval, type LtfInterval, type SetupRejection, type SetupSignal } from "./smc/setups";

export const BTC_STOP_EXTRA_PCT = 0.3;
export const SMC_TARGETS_R = [1.5, 3] as const;
export const LTF_WINDOW = 400;
const COMBOS: Array<{ htf: HtfInterval; ltf: LtfInterval }> = [
  { htf: "1d", ltf: "1h" }, { htf: "1d", ltf: "30m" }, { htf: "4h", ltf: "1h" }, { htf: "4h", ltf: "30m" },
];
const PROFILE: Record<HtfInterval, ProfileKey> = { "4h": "h4", "1d": "d1" };

type ComboResult = { signals: SetupSignal[]; rejections: SetupRejection[]; closeAt: number };
type BarResult = Map<string, ComboResult>;
const cache = new WeakMap<Snapshot, BarResult>();

function ltfSeries(snapshot: Snapshot, ltf: LtfInterval): Candle[] {
  const cs = ltf === "30m" ? to30m(snapshot.candles["15m"]) : snapshot.candles["1h"];
  return fromBtc(cs).slice(-LTF_WINDOW);
}

/** Every combo whose structure timeframe closed on this snapshot, evaluated once per snapshot. */
function evaluateBar(snapshot: Snapshot): BarResult {
  const known = cache.get(snapshot);
  if (known) return known;
  const out: BarResult = new Map();
  for (const { htf, ltf } of COMBOS) {
    const ltfCandles = ltfSeries(snapshot, ltf);
    const last = ltfCandles.at(-1);
    if (!last) continue;
    const closeAt = last.t + INTERVAL_MS[ltf];
    const res = evaluateSetups({
      htf, ltf, htfCandles: fromBtc(snapshot.candles[htf]), ltfCandles,
      options: { stopExtraPct: BTC_STOP_EXTRA_PCT },
    });
    out.set(`${htf}_${ltf}`, { signals: res.signals.filter((s) => s.signalAt === closeAt), rejections: res.rejections.filter((x) => x.signalAt === closeAt), closeAt });
  }
  cache.set(snapshot, out);
  return out;
}

const r = (x: number | null | undefined, d = 4) => (x === null || x === undefined || !Number.isFinite(x) ? null : Number(x.toFixed(d)));

function signalDetail(s: SetupSignal) {
  const blockAgeH = (s.signalAt - s.block.time) / 3_600_000;
  const blockSizePct = ((s.block.top - s.block.bottom) / s.block.top) * 100;
  return {
    method: "smart_money", setup: s.setup, htf: s.htf, ltf: s.ltf,
    barTime: new Date(s.barTime).toISOString(), signalAt: new Date(s.signalAt).toISOString(),
    entryAtSignal: s.entry, stopTa: s.stop, riskPct: s.riskPct,
    structureTp1: s.tp1, structureTp2: s.tp2, structureRr1: s.rr1, structureRr2: s.rr2, structureTargetsSource: s.targetsSource,
    block: { id: s.block.id, scope: s.block.scope, top: s.block.top, bottom: s.block.bottom, time: new Date(s.block.time).toISOString(), createdAt: new Date(s.block.createdAt).toISOString() },
    blockAgeH: r(blockAgeH, 1), blockSizePct: r(blockSizePct, 3),
    firstTouchAt: new Date(s.firstTouchAt).toISOString(), lastTouchAt: new Date(s.lastTouchAt).toISOString(),
    extreme: s.extreme, chochLevel: s.chochLevel, htfSwingTrend: s.htfSwingTrend, htfInternalTrend: s.htfInternalTrend,
    ltfAtr: s.ltfAtr, ob: s.ob, smc: s.smc,
    /** Nihilist's altcoin long filter, recorded only (not applied to BTC). */
    nihilistLongFilter: s.side === "long" ? { stopGe7pct: s.riskPct >= 7, blockLe300h: blockAgeH <= 300, blockGe4pct: blockSizePct >= 4 } : null,
    stopExtraPct: BTC_STOP_EXTRA_PCT,
  };
}

export function evaluateSmc(snapshot: Snapshot, htf: HtfInterval, ltf: LtfInterval, direction: Direction): PatternResult {
  if (snapshot.candles[htf].length < 200) return { fires: false, reasons: [`${htf}_history:no_data`] };
  const bar = evaluateBar(snapshot);
  const mine = bar.get(`${htf}_${ltf}`);
  if (!mine) return { fires: false, reasons: [`${ltf}_candles:no_data`] };
  const sig = mine.signals.find((s) => s.side === direction);
  if (!sig) {
    const rej = mine.rejections.filter((x) => x.side === direction);
    return rej.length
      ? { fires: false, reasons: rej.map((x) => x.reason), detail: { method: "smart_money", rejections: rej } }
      : { fires: false, reasons: ["no_choch_from_block"] };
  }
  // One move = one signal per side: the highest-priority combo that fired on this bar opens.
  const fired = COMBOS.map(({ htf: h, ltf: l }) => ({ key: `${h}_${l}`, s: bar.get(`${h}_${l}`)?.signals.find((x) => x.side === direction) }))
    .filter((x) => x.s);
  const main = fired[0]!;
  const detail = { ...signalDetail(sig), confluence: fired.map((x) => x.key) };
  if (main.key !== `${htf}_${ltf}`) return { fires: false, reasons: [`duplicate_same_move:${main.key}`], detail };
  const dir = direction === "long" ? 1 : -1;
  const risk = (sig.entry - sig.stop) * dir;
  const levels = { stop: sig.stop, targets: SMC_TARGETS_R.map((k) => ({ price: sig.entry + dir * k * risk, fraction: 0.5 })) };
  return { fires: true, reasons: ["ok"], levels, detail: { ...detail, levels } };
}

export const SMC_PATTERNS: Pattern[] = COMBOS.flatMap(({ htf, ltf }) => (["long", "short"] as const).map((direction): Pattern => ({
  key: `smc_${htf}_${ltf}_${direction}`,
  label: `Smart Money: ордер-блок ${htf === "1d" ? "1D" : "4h"} + слом ${ltf} · ${direction === "long" ? "лонг" : "шорт"}`,
  direction,
  profile: PROFILE[htf],
  live: true,
  evalTf: ltf,
  evaluate: (snapshot) => evaluateSmc(snapshot, htf, ltf, direction),
})));
