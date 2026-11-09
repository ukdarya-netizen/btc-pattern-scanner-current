/**
 * Crypto Nihilist setup: SMC order block on the higher timeframe (4h / 1D)
 * + internal change of character (CHoCH) on the lower timeframe (30m / 1h).
 *
 * Long (short is the mirror):
 *  1. The HTF has an active bullish order block (LuxAlgo internal or swing
 *     OB, not mitigated as of the last CLOSED HTF bar).
 *  2. A closed LTF bar trades into the block: low <= block top while the
 *     low stays >= block bottom. A low below the bottom breaks the block
 *     for this setup.
 *  3. Within `touchWindowBars` LTF bars after the last bar inside the block,
 *     the LTF internal structure flips up (bullish CHoCH, close above the
 *     last internal high) -> signal on that bar.
 *  Stop: below the lowest low since the first touch (the reaction low)
 *  minus 0.1 x ATR(14) of the LTF ("extreme" mode) or below the block
 *  bottom ("ob" mode), then 3% further (stopExtraPct, short: 3% higher). Targets: the nearest unbroken HTF pivot high above
 *  the entry (TP1) and the next one (TP2). Without any unbroken high above
 *  (price discovery): TP1 = 2R, TP2 = 3R.
 *  One trade per order block per setup.
 */
import { INTERVAL_MS, type Candle, type Interval } from "./candles";
import { SmcEngine, type OrderBlock, type PivotPoint, type SmcSnapshot } from "./smc";

export type Side = "long" | "short";
export type HtfInterval = "4h" | "1d";
export type LtfInterval = "30m" | "1h";

export type SetupOptions = {
  touchWindowBars: number;
  stopMode: "extreme" | "ob";
  stopAtrBuffer: number;
  minRr: number;
  maxRiskPct: number;
  /** Which HTF order blocks to trade. */
  blockScopes: Array<"internal" | "swing">;
  /** Research only: a block may give another signal after a new touch (live: one trade per block). */
  reuseBlocks: boolean;
  /** Extra room beyond the TA stop, % of the stop price (owner 2026-10-25: 3). */
  stopExtraPct: number;
  /**
   * Minimum strength of the order block: how far (in HTF ATR) the close of
   * the bar that broke structure went beyond the block. null = no filter
   * (the value is still measured and recorded on every signal).
   */
  minObDisplacementAtr: number | null;
};

export const DEFAULT_SETUP_OPTIONS: SetupOptions = {
  touchWindowBars: 12,
  stopMode: "extreme",
  stopAtrBuffer: 0.1,
  // No take profit (owner 2026-11-02): the "TP1 closer than 1R" rejection is off;
  // signals pass if the other filters pass. 0 = never rejects.
  minRr: 0,
  maxRiskPct: 20,
  blockScopes: ["internal", "swing"],
  reuseBlocks: false,
  stopExtraPct: 3,
  minObDisplacementAtr: null,
};

export type SetupSignal = {
  setup: string;
  htf: HtfInterval;
  ltf: LtfInterval;
  side: Side;
  /** LTF bar open time of the CHoCH bar. */
  barTime: number;
  /** LTF bar close time = moment the signal is known. */
  signalAt: number;
  entry: number;
  stop: number;
  tp1: number;
  tp2: number;
  riskPct: number;
  rr1: number;
  rr2: number;
  targetsSource: "structure" | "r_multiple";
  block: OrderBlock;
  firstTouchAt: number;
  lastTouchAt: number;
  extreme: number;
  chochLevel: number;
  htfSwingTrend: number;
  htfInternalTrend: number;
  ltfAtr: number;
  /** Order-block strength (see obStrength). */
  ob: ObStrength;
  /** Classic SMC conditions at the signal (research only; never filters signals). */
  smc: SmcChecks;
};

/**
 * Classic SMC rules the setup does not require (owner 2026-11-04: checked on the strategy report).
 * Each is known at the signal (no lookahead); null = could not be measured.
 */
export type SmcChecks = {
  /** HTF swing structure (50) in the trade's direction. */
  trendSwing: boolean | null;
  /** HTF internal structure (5) in the trade's direction. */
  trendInternal: boolean | null;
  /** Long: entry in the lower half (discount) of the HTF range (LuxAlgo trailing top/bottom); short: upper half (premium). */
  discount: boolean | null;
  /** Liquidity sweep in the block: the reaction made an LTF internal swing low (short: high), then took it out before the structure break. */
  sweep: boolean | null;
  /** Fair value gap (HTF imbalance) between the order-block candle and the structure break, in the break's direction. */
  fvg: boolean | null;
  /** Fresh block: the signal comes from the first return of price into the block since the structure break. */
  fresh: boolean | null;
};

export type ObStrength = {
  /** Close of the structure-break bar beyond the block, in HTF ATR(14). */
  displacementAtr: number | null;
  /** HTF bars from the block candle to the structure break. */
  breakBars: number | null;
  /** Block height in HTF ATR(14). */
  heightAtr: number | null;
  /** How deep price went into the block before the signal, % of its height. */
  penetrationPct: number | null;
};

export type SetupRejection = {
  setup: string;
  side: Side;
  barTime: number;
  signalAt: number;
  reason: string;
  blockId: string;
  details: Record<string, number | string | null>;
};

/** A block price is reacting from now: waiting for the LTF structure break. */
export type SetupCandidate = {
  setup: string; side: Side; blockId: string; blockTop: number; blockBottom: number; blockScope: string;
  firstTouchAt: number; lastTouchAt: number; extreme: number | null; lastClose: number; barsSinceTouch: number;
};

export function setupName(htf: HtfInterval, ltf: LtfInterval, side: Side): string {
  return `${htf}_${ltf}_${side}`;
}

type Zone = {
  block: OrderBlock;
  side: Side;
  firstTouchIndex: number | null;
  firstTouchAt: number | null;
  lastTouchIndex: number | null;
  lastTouchAt: number | null;
  extreme: number | null;
  /** Open time of the LTF bar that set the extreme. */
  extremeAt: number | null;
  /** Separate returns into the block (touches more than touchWindowBars apart) and the start of the latest one. */
  episodes: number;
  episodeAt: number | null;
  broken: boolean;
  used: boolean;
};

type HtfState = { closeAt: number; index: number; snapshot: SmcSnapshot };

/** Wilder ATR(14) values per bar (null until seeded). */
export function atrSeries(candles: Candle[], length = 14): Array<number | null> {
  const out: Array<number | null> = [];
  let sum = 0;
  let atr: number | null = null;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const p = i > 0 ? candles[i - 1] : null;
    const tr = p ? Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)) : c.h - c.l;
    if (atr === null) {
      sum += tr;
      if (i + 1 === length) atr = sum / length;
    } else {
      atr = (atr * (length - 1) + tr) / length;
    }
    out.push(atr);
  }
  return out;
}

/** HTF pivot levels still unbroken at `uptoIndex` (no later HTF bar traded through them). */
export function unbrokenLevels(
  pivots: PivotPoint[], htf: Candle[], uptoIndex: number, side: Side,
): number[] {
  const levels: number[] = [];
  const indexByTime = new Map<number, number>();
  for (let i = 0; i <= uptoIndex; i++) indexByTime.set(htf[i].t, i);
  const seen = new Set<number>();
  for (const p of pivots) {
    const start = indexByTime.get(p.time);
    if (start === undefined || seen.has(p.level)) continue;
    let broken = false;
    for (let i = start + 1; i <= uptoIndex; i++) {
      if (side === "long" ? htf[i].h > p.level : htf[i].l < p.level) { broken = true; break; }
    }
    if (!broken) { levels.push(p.level); seen.add(p.level); }
  }
  return levels.sort((a, b) => (side === "long" ? a - b : b - a));
}

export type EvaluateInput = {
  htf: HtfInterval;
  ltf: LtfInterval;
  htfCandles: Candle[];
  ltfCandles: Candle[];
  sides?: Side[];
  options?: Partial<SetupOptions>;
};

/**
 * Walks the LTF series bar by bar; at every LTF bar only HTF information
 * from HTF bars already closed is used (no lookahead).
 */
export function evaluateSetups(input: EvaluateInput): { signals: SetupSignal[]; rejections: SetupRejection[]; candidates: SetupCandidate[] } {
  const options = { ...DEFAULT_SETUP_OPTIONS, ...(input.options ?? {}) };
  const sides = input.sides ?? ["long", "short"];
  const htfSpan = INTERVAL_MS[input.htf as Interval];
  const ltfSpan = INTERVAL_MS[input.ltf as Interval];
  const { htfCandles, ltfCandles } = input;
  const signals: SetupSignal[] = [];
  const rejections: SetupRejection[] = [];
  if (!htfCandles.length || !ltfCandles.length) return { signals, rejections, candidates: [] };

  // HTF snapshots only where the LTF series needs them.
  const firstNeeded = ltfCandles[0].t - htfSpan;
  const htfEngine = new SmcEngine();
  const htfStates: HtfState[] = [];
  htfCandles.forEach((candle, index) => {
    htfEngine.push(candle);
    const closeAt = candle.t + htfSpan;
    if (closeAt >= firstNeeded) htfStates.push({ closeAt, index, snapshot: htfEngine.snapshot() });
  });

  const ltfEngine = new SmcEngine();
  const atr = atrSeries(ltfCandles);
  const htfAtr = atrSeries(htfCandles);
  const htfIndex = new Map(htfCandles.map((c, i) => [c.t, i]));
  const obStrength = (block: OrderBlock, extreme: number | null): ObStrength => {
    const obIdx = htfIndex.get(block.time);
    const brIdx = htfIndex.get(block.createdAt);
    const a = brIdx === undefined ? null : htfAtr[brIdx];
    const height = block.top - block.bottom;
    const breakClose = brIdx === undefined ? null : htfCandles[brIdx].c;
    const disp = a && breakClose !== null
      ? (block.bias === 1 ? breakClose - block.top : block.bottom - breakClose) / a : null;
    const pen = extreme !== null && height > 0
      ? (block.bias === 1 ? (block.top - extreme) / height : (extreme - block.bottom) / height) * 100 : null;
    return {
      displacementAtr: disp === null ? null : round(disp, 3),
      breakBars: obIdx !== undefined && brIdx !== undefined ? brIdx - obIdx : null,
      heightAtr: a ? round(height / a, 3) : null,
      penetrationPct: pen === null ? null : round(Math.max(0, pen), 1),
    };
  };
  const ltfStart = ltfCandles[0]!.t;
  const smcChecks = (
    block: OrderBlock, side: Side, entry: number, extreme: number,
    touch: { firstTouchAt: number | null; extremeAt: number; episodes: number; episodeAt: number },
    snap: SmcSnapshot, htfUpto: number,
  ): SmcChecks => {
    const dir = side === "long" ? 1 : -1;
    const top = snap.trailingTop, bottom = snap.trailingBottom;
    const eq = top !== null && bottom !== null && top > bottom ? (top + bottom) / 2 : null;
    // Sweep inside the reaction: an LTF internal swing low (short: high) formed in this return into
    // the block and confirmed before the extreme, then taken out by the extreme.
    const ltfSnap = ltfEngine.snapshot();
    const swept = (side === "long" ? ltfSnap.pivotLows : ltfSnap.pivotHighs).some((p) =>
      p.scope === "internal" && p.time >= touch.episodeAt && p.confirmedAt < touch.extremeAt &&
      (dir === 1 ? extreme < p.level : extreme > p.level));
    const obIdx = htfIndex.get(block.time);
    const brIdx = htfIndex.get(block.createdAt);
    let fvg: boolean | null = null;
    let fresh: boolean | null = null;
    if (obIdx !== undefined && brIdx !== undefined) {
      fvg = false;
      for (let i = obIdx + 1; i < brIdx; i++) {
        const a = htfCandles[i - 1]!, c = htfCandles[i + 1]!;
        if (dir === 1 ? a.h < c.l : a.l > c.h) { fvg = true; break; }
      }
      // Fresh: this is the first return into the block. Before the LTF series starts the HTF bars
      // tell (closed bars after the break); within it, the separate returns counted on the LTF.
      fresh = touch.episodes === 1;
      const until = Math.min(touch.firstTouchAt ?? Infinity, ltfStart);
      for (let k = brIdx + 1; fresh && k <= htfUpto && htfCandles[k]!.t + htfSpan <= until; k++) {
        if (dir === 1 ? htfCandles[k]!.l <= block.top : htfCandles[k]!.h >= block.bottom) fresh = false;
      }
    }
    return {
      trendSwing: snap.swingTrend === 0 ? null : snap.swingTrend === dir,
      trendInternal: snap.internalTrend === 0 ? null : snap.internalTrend === dir,
      discount: eq === null ? null : dir === 1 ? entry < eq : entry > eq,
      sweep: swept,
      fvg, fresh,
    };
  };
  const zones = new Map<string, Zone>();
  let htfPointer = -1;

  for (let j = 0; j < ltfCandles.length; j++) {
    const bar = ltfCandles[j];
    const closeAt = bar.t + ltfSpan;
    const events = ltfEngine.push(bar);
    while (htfPointer + 1 < htfStates.length && htfStates[htfPointer + 1].closeAt <= closeAt) htfPointer++;
    if (htfPointer < 0) continue;
    const htfState = htfStates[htfPointer];
    const snap = htfState.snapshot;

    // Active HTF blocks as of the last closed HTF bar.
    const active = new Map<string, OrderBlock>();
    for (const block of [...snap.internalOrderBlocks, ...snap.swingOrderBlocks]) {
      if (!options.blockScopes.includes(block.scope)) continue;
      if (block.createdAt + htfSpan > closeAt) continue;
      const side: Side = block.bias === 1 ? "long" : "short";
      if (!sides.includes(side)) continue;
      active.set(block.id, block);
    }
    for (const [id, zone] of zones) if (!active.has(id) && !zone.used) zones.delete(id);
    for (const [id, block] of active) {
      if (!zones.has(id)) {
        zones.set(id, {
          block, side: block.bias === 1 ? "long" : "short",
          firstTouchIndex: null, firstTouchAt: null, lastTouchIndex: null, lastTouchAt: null,
          extreme: null, extremeAt: null, episodes: 0, episodeAt: null, broken: false, used: false,
        });
      }
    }

    // Touches on this LTF bar.
    const touch = (zone: Zone, j: number, t: number) => {
      if (zone.firstTouchIndex === null) { zone.firstTouchIndex = j; zone.firstTouchAt = t; }
      if (zone.lastTouchIndex === null || j - zone.lastTouchIndex > options.touchWindowBars) { zone.episodes += 1; zone.episodeAt = t; }
      zone.lastTouchIndex = j; zone.lastTouchAt = t;
    };
    for (const zone of zones.values()) {
      if (zone.broken || zone.used) continue;
      const b = zone.block;
      if (zone.side === "long") {
        if (bar.l < b.bottom) { zone.broken = true; continue; }
        if (bar.l <= b.top) touch(zone, j, bar.t);
        if (zone.firstTouchIndex !== null && (zone.extreme === null || bar.l < zone.extreme)) { zone.extreme = bar.l; zone.extremeAt = bar.t; }
      } else {
        if (bar.h > b.top) { zone.broken = true; continue; }
        if (bar.h >= b.bottom) touch(zone, j, bar.t);
        if (zone.firstTouchIndex !== null && (zone.extreme === null || bar.h > zone.extreme)) { zone.extreme = bar.h; zone.extremeAt = bar.t; }
      }
    }

    for (const event of events) {
      if (event.scope !== "internal" || event.kind !== "CHOCH") continue;
      const side: Side = event.dir === 1 ? "long" : "short";
      if (!sides.includes(side)) continue;
      const candidates = [...zones.values()].filter((z) =>
        z.side === side && !z.broken && !z.used && z.lastTouchIndex !== null &&
        j - z.lastTouchIndex <= options.touchWindowBars);
      if (!candidates.length) continue;
      // The block price reacted from most recently; ties -> the one nearest to price.
      candidates.sort((a, b) => (b.lastTouchIndex! - a.lastTouchIndex!) ||
        (side === "long" ? b.block.top - a.block.top : a.block.bottom - b.block.bottom));
      const zone = candidates[0];
      const touched = {
        extreme: zone.extreme, firstTouchAt: zone.firstTouchAt, lastTouchAt: zone.lastTouchAt,
        extremeAt: zone.extremeAt as number, episodes: zone.episodes, episodeAt: zone.episodeAt as number,
      };
      if (options.reuseBlocks) {
        // The next signal from this block needs a fresh touch after this one.
        zone.firstTouchIndex = null; zone.firstTouchAt = null;
        zone.lastTouchIndex = null; zone.lastTouchAt = null; zone.extreme = null;
        zone.extremeAt = null; zone.episodes = 0; zone.episodeAt = null;
      } else {
        zone.used = true;
      }
      const setup = setupName(input.htf, input.ltf, side);
      const ltfAtr = atr[j] ?? (bar.h - bar.l);
      const entry = bar.c;
      const reject = (reason: string, details: Record<string, number | string | null> = {}) => {
        rejections.push({ setup, side, barTime: bar.t, signalAt: closeAt, reason, blockId: zone.block.id, details });
      };
      const extreme = touched.extreme as number;
      let stop: number;
      if (side === "long") {
        const base = options.stopMode === "ob" ? Math.min(zone.block.bottom, extreme) : extreme;
        stop = (base - options.stopAtrBuffer * ltfAtr) * (1 - options.stopExtraPct / 100);
      } else {
        const base = options.stopMode === "ob" ? Math.max(zone.block.top, extreme) : extreme;
        stop = (base + options.stopAtrBuffer * ltfAtr) * (1 + options.stopExtraPct / 100);
      }
      const risk = side === "long" ? entry - stop : stop - entry;
      if (!(risk > 0) || stop <= 0) { reject("stop_not_behind_entry", { entry, stop }); continue; }
      const riskPct = (risk / entry) * 100;
      if (riskPct > options.maxRiskPct) { reject("risk_too_large", { riskPct: round(riskPct, 2), entry, stop }); continue; }

      const levelsSource = side === "long" ? snap.pivotHighs : snap.pivotLows;
      const levels = unbrokenLevels(levelsSource, htfCandles, htfState.index, side)
        .filter((level) => (side === "long" ? level > entry : level < entry));
      let tp1: number;
      let tp2: number;
      let targetsSource: "structure" | "r_multiple" = "structure";
      const dir = side === "long" ? 1 : -1;
      if (!levels.length) {
        targetsSource = "r_multiple";
        tp1 = entry + dir * 2 * risk;
        tp2 = entry + dir * 3 * risk;
      } else {
        tp1 = levels[0];
        tp2 = levels.length > 1 ? levels[1] : entry + dir * 2 * Math.abs(tp1 - entry);
      }
      const rr1 = Math.abs(tp1 - entry) / risk;
      const rr2 = Math.abs(tp2 - entry) / risk;
      if (rr1 < options.minRr) { reject("rr_too_low", { rr1: round(rr1, 2), tp1, entry, stop }); continue; }
      const ob = obStrength(zone.block, extreme);
      const smc = smcChecks(zone.block, side, entry, extreme, touched, snap, htfState.index);
      if (options.minObDisplacementAtr !== null &&
          (ob.displacementAtr === null || ob.displacementAtr < options.minObDisplacementAtr)) {
        reject("ob_too_weak", { obDisplacementAtr: ob.displacementAtr, min: options.minObDisplacementAtr, entry, stop });
        continue;
      }

      signals.push({
        setup, htf: input.htf, ltf: input.ltf, side,
        barTime: bar.t, signalAt: closeAt, entry, stop, tp1, tp2,
        riskPct: round(riskPct, 3), rr1: round(rr1, 3), rr2: round(rr2, 3), targetsSource,
        block: zone.block,
        firstTouchAt: touched.firstTouchAt as number,
        lastTouchAt: touched.lastTouchAt as number,
        extreme, chochLevel: event.level,
        htfSwingTrend: snap.swingTrend, htfInternalTrend: snap.internalTrend,
        ltfAtr, ob, smc,
      });
    }
  }
  const last = ltfCandles.length - 1;
  const candidates: SetupCandidate[] = [];
  for (const zone of zones.values()) {
    if (zone.broken || zone.used || zone.lastTouchIndex === null) continue;
    if (last - zone.lastTouchIndex > options.touchWindowBars) continue;
    candidates.push({
      setup: setupName(input.htf, input.ltf, zone.side), side: zone.side, blockId: zone.block.id,
      blockTop: zone.block.top, blockBottom: zone.block.bottom, blockScope: zone.block.scope,
      firstTouchAt: zone.firstTouchAt as number, lastTouchAt: zone.lastTouchAt as number,
      extreme: zone.extreme, lastClose: ltfCandles[last].c, barsSinceTouch: last - zone.lastTouchIndex,
    });
  }
  return { signals, rejections, candidates };
}

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}
