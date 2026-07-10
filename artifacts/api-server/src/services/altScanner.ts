import { logger } from "../lib/logger";
import { telegramService } from "./telegram";
import { dbService } from "./dbService";
import {
  fetchOiHist,
  fetchFuturesKlines,
  fetchSpotKlines,
  fetchTakerLongShortRatio,
  fetchFundingRate,
  type RawKline,
} from "./binanceData";

export const WATCHED_SYMBOLS = [
  "SOLUSDT", "XRPUSDT", "DOGEUSDT", "ADAUSDT", "AVAXUSDT",
  "LINKUSDT", "DOTUSDT", "LTCUSDT", "TRXUSDT", "NEARUSDT",
  "ARBUSDT", "OPUSDT", "APTUSDT", "SUIUSDT", "INJUSDT",
  "TIAUSDT", "RUNEUSDT", "ATOMUSDT", "FTMUSDT", "WIFUSDT",
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

function klineClose(k: RawKline): number { return Number(k[4]); }
function klineVolume(k: RawKline): number { return Number(k[5]); }
function klineTakerBuyQuote(k: RawKline): number { return Number(k[10]); }
function klineQuoteVolume(k: RawKline): number { return Number(k[7]); }

async function computeMetrics(symbol: string): Promise<CoinMetrics | null> {
  try {
    const [oiHist, futKlines5m, futKlines4h, spotKlines5m, spotKlines1h, spotKlines4h, taker5m, taker15m, funding] =
      await Promise.all([
        fetchOiHist(symbol, "5m", 289),
        fetchFuturesKlines(symbol, "5m", 289),
        fetchFuturesKlines(symbol, "4h", 9),
        fetchSpotKlines(symbol, "5m", 60),
        fetchSpotKlines(symbol, "1h", 5),
        fetchSpotKlines(symbol, "4h", 5),
        fetchTakerLongShortRatio(symbol, "5m", 3),
        fetchTakerLongShortRatio(symbol, "15m", 3),
        fetchFundingRate(symbol),
      ]);

    if (oiHist.length < 2 || futKlines5m.length < 2 || spotKlines5m.length < 2) {
      logger.warn({ symbol }, "altScanner: insufficient data, skipping cycle");
      return null;
    }

    const oiAt = (barsAgo: number): number => {
      const idx = oiHist.length - 1 - barsAgo;
      return idx >= 0 ? Number(oiHist[idx]!.sumOpenInterest) : Number(oiHist[0]!.sumOpenInterest);
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
      const idx = futKlines5m.length - 1 - barsAgo;
      return idx >= 0 ? klineClose(futKlines5m[idx]!) : klineClose(futKlines5m[0]!);
    };
    const priceLast = priceAt(0);
    const priceChange = {
      current: pctChange(priceAt(1), priceLast),
      h1: pctChange(priceAt(12), priceLast),
      h3: pctChange(priceAt(36), priceLast),
      h4: pctChange(priceAt(48), priceLast),
      h24: pctChange(priceAt(288), priceLast),
    };

    const recentFutVols = futKlines5m.slice(-20).map(klineVolume);
    const lastFutVol = recentFutVols[recentFutVols.length - 1] ?? 0;
    const avgFutVol = sum(recentFutVols.slice(0, -1)) / Math.max(1, recentFutVols.length - 1);
    const volMult = avgFutVol > 0 ? lastFutVol / avgFutVol : 0;

    const fut4hVols = futKlines4h.map(klineVolume);
    const lastFut4hVol = fut4hVols[fut4hVols.length - 1] ?? 0;
    const avgFut4hVol = sum(fut4hVols.slice(0, -1)) / Math.max(1, fut4hVols.length - 1);
    const volMult4h = avgFut4hVol > 0 ? lastFut4hVol / avgFut4hVol : 0;

    const recentSpotVols = spotKlines5m.slice(-20).map(klineVolume);
    const lastSpotVol = recentSpotVols[recentSpotVols.length - 1] ?? 0;
    const avgSpotVol = sum(recentSpotVols.slice(0, -1)) / Math.max(1, recentSpotVols.length - 1);
    const spotVolMult = avgSpotVol > 0 ? lastSpotVol / avgSpotVol : 0;

    const cvdOverWindow = (klines: RawKline[], bars: number): number => {
      const slice = klines.slice(-bars);
      return sum(slice.map((k) => klineTakerBuyQuote(k) - (klineQuoteVolume(k) - klineTakerBuyQuote(k))));
    };

    const spotCvd: CvdFlags = {
      m5: cvdOverWindow(spotKlines5m, 1) > 0,
      m15: cvdOverWindow(spotKlines5m, 3) > 0,
      h1: cvdOverWindow(spotKlines1h, 1) > 0,
      h4: cvdOverWindow(spotKlines4h, 1) > 0,
    };

    const delta1h = cvdOverWindow(spotKlines1h, 1);
    const vol1h = sum(spotKlines1h.slice(-1).map(klineQuoteVolume));
    const cvdStrength1h = vol1h > 0 ? Math.abs(delta1h) / vol1h : 0;
    const cvdDelta4h = cvdOverWindow(spotKlines4h, 1);

    const takerLatest = (points: { buyVol: string; sellVol: string }[]): number => {
      const p = points[points.length - 1];
      if (!p) return 0;
      const buy = Number(p.buyVol);
      const sell = Number(p.sellVol);
      const total = buy + sell;
      return total > 0 ? ((buy - sell) / total) * 100 : 0;
    };
    const takerNetBuyPct = takerLatest(taker5m);
    const takerNetBuyPct15m = takerLatest(taker15m);

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

class AltScanner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private prevCycle = new Map<string, PrevCycle>();
  private streaks = new Map<string, number>(); // key: `${symbol}:${patternId}`
  private firedEpisode = new Map<string, boolean>(); // key: `${symbol}:${patternId}` - avoid re-firing every cycle
  private latestMetrics = new Map<string, CoinMetrics>();
  private recentHits: PatternHit[] = [];

  start() {
    if (this.timer) return;
    void this.runCycle();
    this.timer = setInterval(() => void this.runCycle(), CYCLE_MS);
    logger.info({ symbols: WATCHED_SYMBOLS.length, cycleMs: CYCLE_MS }, "AltScanner started");
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
    for (const symbol of WATCHED_SYMBOLS) {
      try {
        await this.processSymbol(symbol);
      } catch (e) {
        logger.warn({ symbol, err: (e as Error).message }, "AltScanner: symbol processing failed");
      }
    }
    logger.info("AltScanner: cycle done");
  }

  private async processSymbol(symbol: string) {
    const m = await computeMetrics(symbol);
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
      void dbService.savePatternSignal(hit);

      if (pattern.id === "liquidation_cascade") cascadePhase1Active = false;
    }

    this.prevCycle.set(symbol, {
      oi30m: m.oiChange.m30,
      oi4h: m.oiChange.h4,
      spotVolMult: m.spotVolMult,
      cascadePhase1Active,
    });
  }
}

export const altScanner = new AltScanner();
