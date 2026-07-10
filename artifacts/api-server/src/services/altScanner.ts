import { logger } from "../lib/logger";
import { telegramService } from "./telegram";
import { dbService } from "./dbService";
import {
  fetchOiHistoryBatch,
  fetchFuturesOhlcvBatch,
  fetchSpotOhlcvBatch,
  fetchFundingRateBatch,
  type OiHistBar,
  type OhlcvBar,
} from "./coinalyzeData";

export const WATCHED_SYMBOLS = [
  "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT",
  "LINKUSDT", "DOTUSDT", "LTCUSDT", "TRXUSDT", "NEARUSDT",
  "ARBUSDT", "OPUSDT", "APTUSDT", "SUIUSDT", "INJUSDT",
  "TIAUSDT", "RUNEUSDT", "ATOMUSDT", "SEIUSDT", "WIFUSDT",
];

const CYCLE_MS = 5 * 60_000;

export interface CvdFlags { m5: boolean; m15: boolean; h1: boolean; h4: boolean }

export interface CoinMetrics {
  symbol: string;
  price: number;
  priceChange: { current: number; h1: number; h3: number; h4: number; h24: number };
  oiChange: { m5: number; m15: number; m30: number; h1: number; h4: number; h24: number };
  volMult: number;
  volMult4h: number;
  spotVolMult: number;
  takerNetBuyPct: number;
  takerNetBuyPct15m: number;
  takerDominance: "buy" | "sell";
  spotCvd: CvdFlags;
  cvdStrength1h: number;
  cvdDelta4h: number;
  fundingRate: number;
  updatedAt: number;
}

export interface PatternHit {
  pattern: string;
  symbol: string;
  direction: "LONG";
  reason: string;
  metrics: CoinMetrics;
  cycleCount: number;
}

interface PrevCycle {
  oi30m: number;
  oi4h: number;
  spotVolMult: number;
  cascadePhase1Active: boolean;
}

function pctChange(from: number, to: number): number {
  if (!from) return 0;
  return ((to - from) / from) * 100;
}

function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0);
}

function ohlcvClose(bar: OhlcvBar): number { return bar.c; }
function ohlcvVolume(bar: OhlcvBar): number { return bar.v; }
function ohlcvBuyVolume(bar: OhlcvBar): number { return bar.bv; }

interface SymbolCycleData {
  oiHist: OiHistBar[];
  futOhlcv: OhlcvBar[];
  spotOhlcv: OhlcvBar[];
  funding: number | null;
}

function computeMetricsFromData(symbol: string, data: SymbolCycleData): CoinMetrics | null {
  try {
    const { oiHist, futOhlcv, spotOhlcv, funding } = data;

    if (oiHist.length < 2 || futOhlcv.length < 2 || spotOhlcv.length < 2) {
      logger.warn({ symbol }, "altScanner: insufficient data, skipping cycle");
      return null;
    }

    const oiAt = (barsAgo: number): number => {
      const idx = oiHist.length - 1 - barsAgo;
      return idx >= 0 ? oiHist[idx]!.c : oiHist[0]!.c;
    };
    const oiLast = oiAt(0);
    const oiChange = {
      m5: pctChange(oiAt(1), oiLast),
      m15: pctChange(oiAt(3), oiLast),
      m30: pctChange(oiAt(6), oiLast),
      h1: pctChange(oiAt(12), oiLast),
      h4: pctChange(oiAt(48), oiLast),
      h24: pctChange(oiAt(288), oiLast),
    };

    const priceAt = (barsAgo: number): number => {
      const idx = futOhlcv.length - 1 - barsAgo;
      return idx >= 0 ? ohlcvClose(futOhlcv[idx]!) : ohlcvClose(futOhlcv[0]!);
    };
    const priceLast = priceAt(0);
    const priceChange = {
      current: pctChange(priceAt(1), priceLast),
      h1: pctChange(priceAt(12), priceLast),
      h3: pctChange(priceAt(36), priceLast),
      h4: pctChange(priceAt(48), priceLast),
      h24: pctChange(priceAt(288), priceLast),
    };

    const recentFutVols = futOhlcv.slice(-20).map(ohlcvVolume);
    const lastFutVol = recentFutVols[recentFutVols.length - 1] ?? 0;
    const avgFutVol = sum(recentFutVols.slice(0, -1)) / Math.max(1, recentFutVols.length - 1);
    const volMult = avgFutVol > 0 ? lastFutVol / avgFutVol : 0;

    // 4h volume multiplier: last 48 bars (4h) vs average of the preceding 4h blocks in the 24h window.
    const fut4hBlocks: number[] = [];
    for (let i = futOhlcv.length; i > 0; i -= 48) {
      const start = Math.max(0, i - 48);
      fut4hBlocks.push(sum(futOhlcv.slice(start, i).map(ohlcvVolume)));
    }
    const lastFut4hVol = fut4hBlocks[0] ?? 0;
    const priorFut4hBlocks = fut4hBlocks.slice(1);
    const avgFut4hVol = sum(priorFut4hBlocks) / Math.max(1, priorFut4hBlocks.length);
    const volMult4h = avgFut4hVol > 0 ? lastFut4hVol / avgFut4hVol : 0;

    const recentSpotVols = spotOhlcv.slice(-20).map(ohlcvVolume);
    const lastSpotVol = recentSpotVols[recentSpotVols.length - 1] ?? 0;
    const avgSpotVol = sum(recentSpotVols.slice(0, -1)) / Math.max(1, recentSpotVols.length - 1);
    const spotVolMult = avgSpotVol > 0 ? lastSpotVol / avgSpotVol : 0;

    // CVD delta over a window: sum(buyVol - sellVol) = sum(2*buyVol - totalVol) across the last `bars` candles.
    const cvdOverWindow = (bars: OhlcvBar[], count: number): number => {
      const slice = bars.slice(-count);
      return sum(slice.map((b) => 2 * ohlcvBuyVolume(b) - ohlcvVolume(b)));
    };

    const spotCvd: CvdFlags = {
      m5: cvdOverWindow(spotOhlcv, 1) > 0,
      m15: cvdOverWindow(spotOhlcv, 3) > 0,
      h1: cvdOverWindow(spotOhlcv, 12) > 0,
      h4: cvdOverWindow(spotOhlcv, 48) > 0,
    };

    const delta1h = cvdOverWindow(spotOhlcv, 12);
    const vol1h = sum(spotOhlcv.slice(-12).map(ohlcvVolume));
    const cvdStrength1h = vol1h > 0 ? Math.abs(delta1h) / vol1h : 0;
    const cvdDelta4h = cvdOverWindow(spotOhlcv, 48);

    const takerNetBuyPctOverWindow = (bars: OhlcvBar[], count: number): number => {
      const slice = bars.slice(-count);
      const buy = sum(slice.map(ohlcvBuyVolume));
      const total = sum(slice.map(ohlcvVolume));
      const sell = total - buy;
      return total > 0 ? ((buy - sell) / total) * 100 : 0;
    };
    const takerNetBuyPct = takerNetBuyPctOverWindow(futOhlcv, 1);
    const takerNetBuyPct15m = takerNetBuyPctOverWindow(futOhlcv, 3);

    return {
      symbol,
      price: priceLast,
      priceChange,
      oiChange,
      volMult,
      volMult4h,
      spotVolMult,
      takerNetBuyPct,
      takerNetBuyPct15m,
      takerDominance: takerNetBuyPct >= 0 ? "buy" : "sell",
      spotCvd,
      cvdStrength1h,
      cvdDelta4h,
      fundingRate: funding ?? 0,
      updatedAt: Date.now(),
    };
  } catch (e) {
    logger.warn({ symbol, err: (e as Error).message }, "altScanner: computeMetrics failed");
    return null;
  }
}

function cvdCount(flags: CvdFlags, keys: (keyof CvdFlags)[]): number {
  return keys.filter((k) => flags[k]).length;
}

// Each checker returns the base condition (everything except any cycleCount requirement).
// The engine tracks a per-symbol/per-pattern streak of consecutive cycles the base condition holds,
// and gates firing on cycleCount separately.
type BaseCheck = (m: CoinMetrics, prev: PrevCycle | undefined) => { pass: boolean; reason: string };

interface PatternDef {
  id: string;
  requiredCycles: number; // 1 = no streak requirement
  check: BaseCheck;
}

const PATTERNS: PatternDef[] = [
  {
    id: "dip_accumulation",
    requiredCycles: 1,
    check: (m) => ({
      pass: m.oiChange.h1 >= 8 && m.priceChange.current >= -3 && m.priceChange.current <= -0.5 && m.volMult >= 2,
      reason: `OI1h=${m.oiChange.h1.toFixed(2)}% price=${m.priceChange.current.toFixed(2)}% volMult=${m.volMult.toFixed(2)}x`,
    }),
  },
  {
    id: "4h_momentum",
    requiredCycles: 1,
    check: (m) => {
      const baseTrend =
        m.priceChange.h4 >= 3 &&
        m.priceChange.current > -2 &&
        m.priceChange.h3 <= 8 &&
        m.oiChange.m5 > 0 && m.oiChange.m30 > 0 && m.oiChange.h4 > 0 && m.oiChange.h24 > 0;
      const early = m.volMult4h >= 0.8 && (m.spotCvd.m5 || m.spotCvd.m15);
      const standard = m.volMult4h >= 1.2 && m.oiChange.h1 >= 1;
      return {
        pass: baseTrend && (early || standard),
        reason: `price4h=${m.priceChange.h4.toFixed(2)}% volMult4h=${m.volMult4h.toFixed(2)}x OI1h=${m.oiChange.h1.toFixed(2)}%`,
      };
    },
  },
  {
    id: "quiet_oi_accumulation",
    requiredCycles: 3,
    check: (m) => ({
      pass:
        m.oiChange.m30 >= 0.2 && m.oiChange.h1 >= 0.5 &&
        m.priceChange.current >= -1 && m.priceChange.current <= 3 &&
        (m.takerDominance === "buy" || m.spotCvd.m15 || m.spotCvd.h1) &&
        m.spotVolMult >= 0.8 && m.spotVolMult <= 1.8 &&
        m.priceChange.h24 <= 40 && m.priceChange.h3 <= 6,
      reason: `OI30m=${m.oiChange.m30.toFixed(2)}% OI1h=${m.oiChange.h1.toFixed(2)}% spotVolMult=${m.spotVolMult.toFixed(2)}x`,
    }),
  },
  {
    id: "volume_taker",
    requiredCycles: 1,
    check: (m) => {
      const base =
        m.spotVolMult >= 1.5 && m.takerNetBuyPct >= 8 &&
        m.priceChange.current >= 2 && m.priceChange.h3 <= 10 && m.priceChange.h24 <= 40 &&
        (m.spotCvd.m15 || m.spotCvd.h1);
      return { pass: base, reason: `spotVolMult=${m.spotVolMult.toFixed(2)}x taker=${m.takerNetBuyPct.toFixed(1)}%` };
    },
  },
  {
    id: "spot_absorption",
    requiredCycles: 1,
    check: (m) => ({
      pass:
        cvdCount(m.spotCvd, ["m5", "m15"]) >= 1 && (m.spotCvd.m5 || m.spotCvd.m15) &&
        m.priceChange.current >= 1 && m.priceChange.current <= 15 &&
        m.spotVolMult >= 1.3 && m.oiChange.m5 < 3,
      reason: `price=${m.priceChange.current.toFixed(2)}% spotVolMult=${m.spotVolMult.toFixed(2)}x OI5m=${m.oiChange.m5.toFixed(2)}%`,
    }),
  },
  {
    id: "flush_reversal",
    requiredCycles: 1,
    check: (m, prev) => {
      if (!prev) return { pass: false, reason: "no previous cycle data" };
      const pass =
        prev.oi30m <= -0.3 && m.oiChange.m30 >= 1.5 &&
        prev.spotVolMult >= 3 && m.fundingRate <= 0;
      return { pass, reason: `prevOI30m=${prev.oi30m.toFixed(2)}% OI30m=${m.oiChange.m30.toFixed(2)}% funding=${(m.fundingRate * 100).toFixed(4)}%` };
    },
  },
  {
    id: "oi1h_breakout",
    requiredCycles: 1,
    check: (m) => ({
      pass:
        m.oiChange.h1 >= 2 && m.spotVolMult >= 2 &&
        m.priceChange.current >= -1 && m.priceChange.current <= 3 &&
        (m.spotCvd.h1 && m.spotCvd.h4) &&
        m.priceChange.h3 <= 6 && m.priceChange.h24 <= 40,
      reason: `OI1h=${m.oiChange.h1.toFixed(2)}% spotVolMult=${m.spotVolMult.toFixed(2)}x`,
    }),
  },
  {
    id: "spot_momentum_reversal",
    requiredCycles: 3,
    check: (m) => ({
      pass:
        m.priceChange.current >= 1 &&
        cvdCount(m.spotCvd, ["m5", "m15", "h1", "h4"]) === 4 &&
        m.takerDominance === "sell" &&
        m.spotVolMult >= 1.5 && m.priceChange.h24 <= 40 && m.priceChange.h3 <= 6,
      reason: `price=${m.priceChange.current.toFixed(2)}% taker=${m.takerDominance} spotVolMult=${m.spotVolMult.toFixed(2)}x`,
    }),
  },
  {
    id: "spot_oi4h_build",
    requiredCycles: 3,
    check: (m) => ({
      pass:
        m.oiChange.h4 >= 1.2 && m.oiChange.m30 >= 0.5 && m.oiChange.h1 >= 1 &&
        m.spotCvd.h1 && m.spotCvd.h4 && m.takerDominance !== "sell" &&
        m.spotVolMult >= 1 && m.priceChange.current >= -2 && m.priceChange.current <= 3,
      reason: `OI4h=${m.oiChange.h4.toFixed(2)}% OI1h=${m.oiChange.h1.toFixed(2)}%`,
    }),
  },
  {
    id: "liquidation_cascade",
    requiredCycles: 1,
    check: (m, prev) => {
      const phase1WasActive = !!prev && prev.cascadePhase1Active;
      const phase2 =
        m.priceChange.current >= 2 &&
        cvdCount(m.spotCvd, ["m5", "m15", "h1"]) === 3 &&
        m.oiChange.m30 >= 0 && m.takerDominance === "buy" && m.priceChange.h24 >= -50;
      return {
        pass: !!phase1WasActive && phase2,
        reason: `price=${m.priceChange.current.toFixed(2)}% dominance=${m.takerDominance} phase1seen=${!!phase1WasActive}`,
      };
    },
  },
  {
    id: "spot_taker_lead",
    requiredCycles: 2,
    check: (m) => ({
      pass:
        (m.spotCvd.m5 || (m.spotCvd.m15 && m.spotCvd.h1)) &&
        m.cvdStrength1h > 0.08 && m.spotCvd.h4 && m.cvdDelta4h > 5000 &&
        m.takerNetBuyPct15m > 3 && m.takerDominance !== "sell" &&
        m.priceChange.current >= 0.3 && m.priceChange.current <= 6 &&
        m.priceChange.h3 <= 8 && m.priceChange.h24 <= 40 && m.spotVolMult >= 1.2,
      reason: `cvdStrength1h=${m.cvdStrength1h.toFixed(3)} cvdDelta4h=${m.cvdDelta4h.toFixed(0)} taker15m=${m.takerNetBuyPct15m.toFixed(1)}%`,
    }),
  },
  {
    id: "spot_divergence",
    requiredCycles: 3,
    check: (m) => ({
      pass:
        m.priceChange.current >= -3 && m.priceChange.current <= 1 &&
        m.oiChange.m30 >= 0.3 && m.priceChange.h24 <= 40 && m.priceChange.h3 <= 8,
      reason: `price=${m.priceChange.current.toFixed(2)}% OI30m=${m.oiChange.m30.toFixed(2)}%`,
    }),
  },
  {
    id: "accumulation_breakout",
    requiredCycles: 3,
    check: (m) => ({
      pass:
        m.priceChange.h24 >= 8 && m.priceChange.h24 <= 40 &&
        (m.oiChange.h1 >= 3 || m.oiChange.h4 >= 5) &&
        m.priceChange.h1 >= -10,
      reason: `price24h=${m.priceChange.h24.toFixed(2)}% OI1h=${m.oiChange.h1.toFixed(2)}% OI4h=${m.oiChange.h4.toFixed(2)}%`,
    }),
  },
];

// volume_taker has an OR-branch: (cycleCount>=2 OR spotVolMult>=4x). Handled specially below.
const VOLUME_TAKER_ID = "volume_taker";

// open position management: no auto-trading, this is purely for dashboard/stat purposes
// 3 take-profit levels, each closing 1/3 of the position; stop loss starts at -10% and
// moves to breakeven (entry price) once the +10% level is hit.
const TP_LEVELS = [5, 10, 15];
const TP_FRACTION = 1 / TP_LEVELS.length;
const BREAKEVEN_TRIGGER_PCT = 10;
const INITIAL_STOP_PCT = -10.0;
const MAX_HOLD_CYCLES = 48; // ~4h at 5min cycles

interface OpenPosition {
  id: number;
  symbol: string;
  pattern: string;
  entryPrice: number;
  cyclesHeld: number;
  tpHits: boolean[]; // parallel to TP_LEVELS
  stopThreshold: number; // negative pct; moves to 0 (breakeven) once +10% is hit
  realizedPnlPct: number; // weighted pnl from partial TP closes already taken
  remainingFraction: number; // fraction of position still open (starts at 1)
}

export interface OpenPositionView {
  id: number;
  symbol: string;
  pattern: string;
  entryPrice: number;
  cyclesHeld: number;
  currentPrice: number;
  unrealizedPnlPct: number;
  tpHits: boolean[];
  stopThreshold: number;
}

class AltScanner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private prevCycle = new Map<string, PrevCycle>();
  private streaks = new Map<string, number>(); // key: `${symbol}:${patternId}`
  private firedEpisode = new Map<string, boolean>(); // key: `${symbol}:${patternId}` - avoid re-firing every cycle
  private latestMetrics = new Map<string, CoinMetrics>();
  private recentHits: PatternHit[] = [];
  private openPositions = new Map<number, OpenPosition>();

  start() {
    if (this.timer) return;
    void this.hydrateOpenPositions().then(() => this.runCycle());
    this.timer = setInterval(() => void this.runCycle(), CYCLE_MS);
    logger.info({ symbols: WATCHED_SYMBOLS.length, cycleMs: CYCLE_MS }, "AltScanner started");
  }

  private async hydrateOpenPositions() {
    const rows = await dbService.getOpenSignals();
    for (const row of rows) {
      this.openPositions.set(row.id, {
        id: row.id,
        symbol: row.symbol,
        pattern: row.pattern,
        entryPrice: Number(row.price),
        cyclesHeld: 0,
        tpHits: TP_LEVELS.map(() => false),
        stopThreshold: INITIAL_STOP_PCT,
        realizedPnlPct: 0,
        remainingFraction: 1,
      });
    }
    logger.info({ count: this.openPositions.size }, "AltScanner: hydrated open positions from DB");
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getLatestMetrics(): CoinMetrics[] {
    return WATCHED_SYMBOLS.map((s) => this.latestMetrics.get(s)).filter((m): m is CoinMetrics => !!m);
  }

  getStreak(symbol: string, patternId: string): number {
    return this.streaks.get(`${symbol}:${patternId}`) ?? 0;
  }

  getRecentHits(): PatternHit[] {
    return this.recentHits.slice(-100);
  }

  private streakKey(symbol: string, patternId: string): string {
    return `${symbol}:${patternId}`;
  }

  private async runCycle() {
    logger.info("AltScanner: cycle start");
    const oiHistBySymbol = await fetchOiHistoryBatch(WATCHED_SYMBOLS);
    const futOhlcvBySymbol = await fetchFuturesOhlcvBatch(WATCHED_SYMBOLS);
    const spotOhlcvBySymbol = await fetchSpotOhlcvBatch(WATCHED_SYMBOLS);
    const fundingBySymbol = await fetchFundingRateBatch(WATCHED_SYMBOLS);

    for (const symbol of WATCHED_SYMBOLS) {
      try {
        const data: SymbolCycleData = {
          oiHist: oiHistBySymbol.get(symbol) ?? [],
          futOhlcv: futOhlcvBySymbol.get(symbol) ?? [],
          spotOhlcv: spotOhlcvBySymbol.get(symbol) ?? [],
          funding: fundingBySymbol.get(symbol) ?? null,
        };
        this.processSymbol(symbol, data);
      } catch (e) {
        logger.warn({ symbol, err: (e as Error).message }, "AltScanner: symbol processing failed");
      }
    }
    logger.info("AltScanner: cycle done");
  }

  private processSymbol(symbol: string, data: SymbolCycleData) {
    const m = computeMetricsFromData(symbol, data);
    if (!m) return;
    this.latestMetrics.set(symbol, m);

    const prev = this.prevCycle.get(symbol);

    // cascade phase1 detection (independent of pattern streaks) — sticky until phase2 fires
    const phase1Now = m.priceChange.h1 <= -8 && m.priceChange.h1 >= -15 && m.oiChange.h1 <= -8 && m.volMult >= 5;
    let cascadePhase1Active = phase1Now || (prev?.cascadePhase1Active ?? false);

    for (const pattern of PATTERNS) {
      const { pass, reason } = pattern.check(m, prev);
      const key = this.streakKey(symbol, pattern.id);
      const currentStreak = pass ? (this.streaks.get(key) ?? 0) + 1 : 0;
      this.streaks.set(key, currentStreak);
      if (!pass) {
        this.firedEpisode.set(key, false);
        continue;
      }

      let cycleCountOk = currentStreak >= pattern.requiredCycles;
      if (pattern.id === VOLUME_TAKER_ID) {
        cycleCountOk = currentStreak >= 2 || m.spotVolMult >= 4;
      }
      if (!cycleCountOk) continue;

      const alreadyFired = this.firedEpisode.get(key) === true;
      if (alreadyFired) continue;

      this.firedEpisode.set(key, true);
      const hit: PatternHit = {
        pattern: pattern.id,
        symbol,
        direction: "LONG",
        reason,
        metrics: m,
        cycleCount: currentStreak,
      };
      this.recentHits.push(hit);
      if (this.recentHits.length > 200) this.recentHits = this.recentHits.slice(-200);

      logger.info({ symbol, pattern: pattern.id, reason }, "AltScanner: pattern fired");
      telegramService.publishPatternSignal(hit);
      void dbService.savePatternSignal(hit).then((id) => {
        if (id !== null) {
          this.openPositions.set(id, {
            id,
            symbol,
            pattern: pattern.id,
            entryPrice: m.price,
            cyclesHeld: 0,
            tpHits: TP_LEVELS.map(() => false),
            stopThreshold: INITIAL_STOP_PCT,
            realizedPnlPct: 0,
            remainingFraction: 1,
          });
        }
      });

      if (pattern.id === "liquidation_cascade") cascadePhase1Active = false;
    }

    this.prevCycle.set(symbol, {
      oi30m: m.oiChange.m30,
      oi4h: m.oiChange.h4,
      spotVolMult: m.spotVolMult,
      cascadePhase1Active,
    });

    this.checkOpenPositions(symbol, m.price);
  }

  private checkOpenPositions(symbol: string, currentPrice: number) {
    for (const pos of this.openPositions.values()) {
      if (pos.symbol !== symbol) continue;
      pos.cyclesHeld += 1;
      const pnlPct = pctChange(pos.entryPrice, currentPrice);

      // Partial take-profits: each level closes 1/3 of the position, once.
      for (let i = 0; i < TP_LEVELS.length; i++) {
        if (!pos.tpHits[i] && pnlPct >= TP_LEVELS[i]!) {
          pos.tpHits[i] = true;
          pos.realizedPnlPct += TP_FRACTION * TP_LEVELS[i]!;
          pos.remainingFraction = Math.max(0, pos.remainingFraction - TP_FRACTION);
          if (TP_LEVELS[i]! >= BREAKEVEN_TRIGGER_PCT) {
            pos.stopThreshold = 0; // move stop-loss to breakeven (entry price)
          }
          logger.info(
            { symbol, pattern: pos.pattern, level: TP_LEVELS[i], remainingFraction: pos.remainingFraction },
            "AltScanner: partial take-profit hit",
          );
        }
      }

      const allTpHit = pos.remainingFraction <= 0;
      const hitSl = !allTpHit && pnlPct <= pos.stopThreshold;
      const timedOut = !allTpHit && pos.cyclesHeld >= MAX_HOLD_CYCLES;

      if (allTpHit || hitSl || timedOut) {
        const finalPnlPct = allTpHit ? pos.realizedPnlPct : pos.realizedPnlPct + pos.remainingFraction * pnlPct;
        this.openPositions.delete(pos.id);
        void dbService.closeSignal(pos.id, currentPrice, finalPnlPct);
        logger.info(
          {
            symbol,
            pattern: pos.pattern,
            pnlPct: finalPnlPct,
            reason: allTpHit ? "all_take_profits" : hitSl ? "stop_loss" : "timeout",
          },
          "AltScanner: position closed",
        );
      }
    }
  }

  getOpenPositions(): OpenPositionView[] {
    return Array.from(this.openPositions.values()).map((p) => {
      const currentPrice = this.latestMetrics.get(p.symbol)?.price ?? p.entryPrice;
      const livePnlPct = pctChange(p.entryPrice, currentPrice);
      return {
        id: p.id,
        symbol: p.symbol,
        pattern: p.pattern,
        entryPrice: p.entryPrice,
        cyclesHeld: p.cyclesHeld,
        currentPrice,
        unrealizedPnlPct: p.realizedPnlPct + p.remainingFraction * livePnlPct,
        tpHits: p.tpHits,
        stopThreshold: p.stopThreshold,
      };
    });
  }
}

export const altScanner = new AltScanner();
