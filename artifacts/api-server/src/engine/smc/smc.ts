/**
 * Port of "Smart Money Concepts [LuxAlgo]" (Pine v5), computed only on
 * closed bars, with the indicator's default settings:
 *   swing structure length 50, internal structure length 5,
 *   order blocks: ATR(200) volatility filter, High/Low mitigation,
 *   internal confluence filter off.
 *
 * Execution order per bar follows the script:
 *   trailing extremes -> swing pivots (50) -> internal pivots (5)
 *   -> internal BOS/CHoCH (+ internal OB) -> swing BOS/CHoCH (+ swing OB)
 *   -> internal OB mitigation -> swing OB mitigation.
 *
 * Both internal (shown on the chart by default) and swing order blocks are
 * kept; the setup layer decides which ones to trade.
 */
import type { Candle } from "./candles";

export type Bias = 1 | -1 | 0; // +1 bullish, -1 bearish, 0 none yet
export type Scope = "internal" | "swing";

export type OrderBlock = {
  id: string;
  scope: Scope;
  bias: 1 | -1;
  /** Raw values as the indicator stores them (inverted on high-volatility bars). */
  barHigh: number;
  barLow: number;
  /** Zone bounds: top >= bottom. */
  top: number;
  bottom: number;
  /** Open time of the order-block candle. */
  time: number;
  /** Open time of the bar whose close broke structure and created the block. */
  createdAt: number;
};

export type StructureEvent = {
  scope: Scope;
  dir: 1 | -1;
  kind: "BOS" | "CHOCH";
  /** Broken pivot level. */
  level: number;
  pivotTime: number;
  barTime: number;
  orderBlock: OrderBlock | null;
};

export type PivotPoint = {
  level: number; time: number; scope: Scope;
  /** Open time of the bar on which the pivot was confirmed (known after that bar closes). */
  confirmedAt: number;
};

type Pivot = {
  currentLevel: number | null;
  lastLevel: number | null;
  crossed: boolean;
  barTime: number;
  barIndex: number;
};

export type SmcSnapshot = {
  barTime: number | null;
  internalTrend: Bias;
  swingTrend: Bias;
  internalOrderBlocks: OrderBlock[];
  swingOrderBlocks: OrderBlock[];
  swingHigh: number | null;
  swingLow: number | null;
  internalHigh: number | null;
  internalLow: number | null;
  trailingTop: number | null;
  trailingBottom: number | null;
  /** Recent confirmed pivot highs/lows (both lengths), newest last. */
  pivotHighs: PivotPoint[];
  pivotLows: PivotPoint[];
};

export type SmcOptions = { swingLength?: number; internalLength?: number; atrLength?: number };

const MAX_BLOCKS = 100;
const MAX_PIVOTS = 300;

function newPivot(): Pivot {
  return { currentLevel: null, lastLevel: null, crossed: false, barTime: 0, barIndex: 0 };
}

/** Pine leg(size): 0 = bearish leg (a pivot high just confirmed), 1 = bullish leg. */
class LegTracker {
  leg = 0;
  prevLeg: number | null = null;
  constructor(readonly size: number) {}
  /** Returns the change of leg on this bar (Pine ta.change), null on the first bar. */
  update(highs: number[], lows: number[], index: number): number | null {
    const size = this.size;
    if (index >= size) {
      const pastHigh = highs[index - size];
      const pastLow = lows[index - size];
      let highest = -Infinity;
      let lowest = Infinity;
      for (let i = index - size + 1; i <= index; i++) {
        if (highs[i] > highest) highest = highs[i];
        if (lows[i] < lowest) lowest = lows[i];
      }
      if (pastHigh > highest) this.leg = 0;
      else if (pastLow < lowest) this.leg = 1;
    }
    const change = this.prevLeg === null ? null : this.leg - this.prevLeg;
    this.prevLeg = this.leg;
    return change;
  }
}

export class SmcEngine {
  private readonly swingLength: number;
  private readonly internalLength: number;
  private readonly atrLength: number;

  private readonly candles: Candle[] = [];
  private readonly highs: number[] = [];
  private readonly lows: number[] = [];
  private readonly parsedHighs: number[] = [];
  private readonly parsedLows: number[] = [];

  private trSum = 0;
  private trCount = 0;
  private atr: number | null = null;

  private readonly swingLeg: LegTracker;
  private readonly internalLeg: LegTracker;

  readonly swingHigh = newPivot();
  readonly swingLow = newPivot();
  readonly internalHigh = newPivot();
  readonly internalLow = newPivot();
  swingTrend: Bias = 0;
  internalTrend: Bias = 0;
  trailingTop: number | null = null;
  trailingBottom: number | null = null;

  private internalBlocks: OrderBlock[] = [];
  private swingBlocks: OrderBlock[] = [];
  private readonly pivotHighs: PivotPoint[] = [];
  private readonly pivotLows: PivotPoint[] = [];

  /** Previous-bar values of each crossover series (Pine call-site history). */
  private prevClose: number | null = null;
  private prevLevels: Record<string, number | null> = {
    internalBull: null, internalBear: null, swingBull: null, swingBear: null,
  };

  constructor(options: SmcOptions = {}) {
    this.swingLength = options.swingLength ?? 50;
    this.internalLength = options.internalLength ?? 5;
    this.atrLength = options.atrLength ?? 200;
    this.swingLeg = new LegTracker(this.swingLength);
    this.internalLeg = new LegTracker(this.internalLength);
  }

  get barCount(): number {
    return this.candles.length;
  }

  push(candle: Candle): StructureEvent[] {
    const index = this.candles.length;
    const prev = index > 0 ? this.candles[index - 1] : null;
    this.candles.push(candle);
    this.highs.push(candle.h);
    this.lows.push(candle.l);

    // ATR(200) = RMA of true range, seeded with the SMA of the first 200 values.
    const tr = prev
      ? Math.max(candle.h - candle.l, Math.abs(candle.h - prev.c), Math.abs(candle.l - prev.c))
      : candle.h - candle.l;
    if (this.atr === null) {
      this.trSum += tr;
      this.trCount += 1;
      if (this.trCount === this.atrLength) this.atr = this.trSum / this.atrLength;
    } else {
      this.atr = (this.atr * (this.atrLength - 1) + tr) / this.atrLength;
    }
    const highVolatility = this.atr !== null && candle.h - candle.l >= 2 * this.atr;
    this.parsedHighs.push(highVolatility ? candle.l : candle.h);
    this.parsedLows.push(highVolatility ? candle.h : candle.l);

    // Trailing extremes (stay null until the first swing pivot, as Pine na).
    if (this.trailingTop !== null) this.trailingTop = Math.max(candle.h, this.trailingTop);
    if (this.trailingBottom !== null) this.trailingBottom = Math.min(candle.l, this.trailingBottom);

    this.updateStructure(this.swingLeg, index, false);
    this.updateStructure(this.internalLeg, index, true);

    const events: StructureEvent[] = [];
    this.displayStructure(index, true, events);
    this.displayStructure(index, false, events);

    this.internalBlocks = this.mitigate(this.internalBlocks, candle);
    this.swingBlocks = this.mitigate(this.swingBlocks, candle);

    this.prevClose = candle.c;
    return events;
  }

  snapshot(): SmcSnapshot {
    const last = this.candles[this.candles.length - 1];
    return {
      barTime: last ? last.t : null,
      internalTrend: this.internalTrend,
      swingTrend: this.swingTrend,
      // Blocks are never mutated after creation: sharing them is safe and cheap.
      internalOrderBlocks: this.internalBlocks.slice(),
      swingOrderBlocks: this.swingBlocks.slice(),
      swingHigh: this.swingHigh.currentLevel,
      swingLow: this.swingLow.currentLevel,
      internalHigh: this.internalHigh.currentLevel,
      internalLow: this.internalLow.currentLevel,
      trailingTop: this.trailingTop,
      trailingBottom: this.trailingBottom,
      pivotHighs: this.pivotHighs.slice(),
      pivotLows: this.pivotLows.slice(),
    };
  }

  private updateStructure(legTracker: LegTracker, index: number, internal: boolean): void {
    const change = legTracker.update(this.highs, this.lows, index);
    if (change === null || change === 0) return;
    const size = legTracker.size;
    const pivotIndex = index - size;
    if (pivotIndex < 0) return;
    const pivotBar = this.candles[pivotIndex];
    const scope: Scope = internal ? "internal" : "swing";
    if (change === 1) {
      const p = internal ? this.internalLow : this.swingLow;
      p.lastLevel = p.currentLevel;
      p.currentLevel = pivotBar.l;
      p.crossed = false;
      p.barTime = pivotBar.t;
      p.barIndex = pivotIndex;
      if (!internal) this.trailingBottom = p.currentLevel;
      this.pivotLows.push({ level: pivotBar.l, time: pivotBar.t, scope, confirmedAt: this.candles[index].t });
      if (this.pivotLows.length > MAX_PIVOTS) this.pivotLows.shift();
    } else {
      const p = internal ? this.internalHigh : this.swingHigh;
      p.lastLevel = p.currentLevel;
      p.currentLevel = pivotBar.h;
      p.crossed = false;
      p.barTime = pivotBar.t;
      p.barIndex = pivotIndex;
      if (!internal) this.trailingTop = p.currentLevel;
      this.pivotHighs.push({ level: pivotBar.h, time: pivotBar.t, scope, confirmedAt: this.candles[index].t });
      if (this.pivotHighs.length > MAX_PIVOTS) this.pivotHighs.shift();
    }
  }

  private displayStructure(index: number, internal: boolean, events: StructureEvent[]): void {
    const candle = this.candles[index];
    const scope: Scope = internal ? "internal" : "swing";

    // Bullish break of the high pivot.
    {
      const p = internal ? this.internalHigh : this.swingHigh;
      const key = internal ? "internalBull" : "swingBull";
      const level = p.currentLevel;
      const prevLevel = this.prevLevels[key];
      this.prevLevels[key] = level;
      const crossover = level !== null && prevLevel !== null && this.prevClose !== null &&
        candle.c > level && this.prevClose <= prevLevel;
      const extra = internal ? this.internalHigh.currentLevel !== this.swingHigh.currentLevel : true;
      if (crossover && !p.crossed && extra) {
        const trend = internal ? this.internalTrend : this.swingTrend;
        const kind = trend === -1 ? "CHOCH" : "BOS";
        p.crossed = true;
        if (internal) this.internalTrend = 1; else this.swingTrend = 1;
        const block = this.storeOrderBlock(p, index, internal, 1);
        events.push({ scope, dir: 1, kind, level: level as number, pivotTime: p.barTime, barTime: candle.t, orderBlock: block });
      }
    }
    // Bearish break of the low pivot.
    {
      const p = internal ? this.internalLow : this.swingLow;
      const key = internal ? "internalBear" : "swingBear";
      const level = p.currentLevel;
      const prevLevel = this.prevLevels[key];
      this.prevLevels[key] = level;
      const crossunder = level !== null && prevLevel !== null && this.prevClose !== null &&
        candle.c < level && this.prevClose >= prevLevel;
      const extra = internal ? this.internalLow.currentLevel !== this.swingLow.currentLevel : true;
      if (crossunder && !p.crossed && extra) {
        const trend = internal ? this.internalTrend : this.swingTrend;
        const kind = trend === 1 ? "CHOCH" : "BOS";
        p.crossed = true;
        if (internal) this.internalTrend = -1; else this.swingTrend = -1;
        const block = this.storeOrderBlock(p, index, internal, -1);
        events.push({ scope, dir: -1, kind, level: level as number, pivotTime: p.barTime, barTime: candle.t, orderBlock: block });
      }
    }
  }

  /** storeOrdeBlock(): extreme parsed bar between the pivot and the breaking bar (exclusive). */
  private storeOrderBlock(p: Pivot, index: number, internal: boolean, bias: 1 | -1): OrderBlock | null {
    const from = p.barIndex;
    if (from >= index) return null;
    let pick = from;
    for (let i = from; i < index; i++) {
      if (bias === -1 ? this.parsedHighs[i] > this.parsedHighs[pick] : this.parsedLows[i] < this.parsedLows[pick]) {
        pick = i;
      }
    }
    const barHigh = this.parsedHighs[pick];
    const barLow = this.parsedLows[pick];
    const scope: Scope = internal ? "internal" : "swing";
    const block: OrderBlock = {
      id: `${scope}:${bias === 1 ? "bull" : "bear"}:${this.candles[pick].t}`,
      scope,
      bias,
      barHigh,
      barLow,
      top: Math.max(barHigh, barLow),
      bottom: Math.min(barHigh, barLow),
      time: this.candles[pick].t,
      createdAt: this.candles[index].t,
    };
    const list = internal ? this.internalBlocks : this.swingBlocks;
    if (list.length >= MAX_BLOCKS) list.pop();
    list.unshift(block);
    return block;
  }

  /** deleteOrderBlocks() with High/Low mitigation. */
  private mitigate(blocks: OrderBlock[], candle: Candle): OrderBlock[] {
    return blocks.filter((b) => !(
      (b.bias === -1 && candle.h > b.barHigh) ||
      (b.bias === 1 && candle.l < b.barLow)
    ));
  }
}

/** Runs the engine over a whole series; returns the events per bar index. */
export function runSmc(candles: Candle[], options?: SmcOptions): { engine: SmcEngine; events: StructureEvent[][] } {
  const engine = new SmcEngine(options);
  const events = candles.map((c) => engine.push(c));
  return { engine, events };
}
