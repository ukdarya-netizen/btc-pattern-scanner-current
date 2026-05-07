/**
 * FractalService — DTW-based fractal pattern matching on 1D + 4H candles.
 *
 * Algorithm per spec:
 *  1. Fetch 1D history (CryptoCompare, 2013→now) and 4H history (Bybit REST)
 *  2. For each timeframe, slide a window of PATTERN_LEN candles over history,
 *     compute similarity_score = DTW price component (0.7) + Pearson volume (0.3)
 *  3. Collect top-N matches, derive probability, expected SL/TP, win-rate
 *  4. Compute combined fractal signal: direction + overall_signal_score
 *  5. Result exposed via getFractalSignal() — used by signalTracker as gate
 */

import { logger } from "../lib/logger";
import { aggregator } from "./exchanges/aggregator";

// ─── Tunable constants ────────────────────────────────────────────────────────
const PATTERN_LEN_1D = 50;          // candles in pattern window for 1D
const PATTERN_LEN_4H = 60;          // candles in pattern window for 4H
const FORWARD_LEN_1D = 7;           // candles ahead to evaluate outcome (1D → 7 days)
const FORWARD_LEN_4H = 12;          // candles ahead to evaluate outcome (4H → 2 days)
const TOP_N = 20;                   // top matches to collect per timeframe
const MIN_SIMILARITY = 0.55;        // discard matches below this score
const WEIGHT_PRICE = 0.7;           // DTW price weight in similarity_score
const WEIGHT_VOLUME = 0.3;          // Pearson volume weight
const WIN_TP_PCT = 0.015;           // ≥1.5% move = "TP hit" in historical analysis
const WIN_SL_PCT = 0.008;           // ≥0.8% adverse = "SL hit"

// Refresh intervals
const REFRESH_1D_MS = 6 * 60 * 60 * 1000;   // 6 h
const REFRESH_4H_MS = 4 * 60 * 60 * 1000;   // 4 h

// Minimum overall_signal_score to be a valid gate-pass
export const FRACTAL_MIN_SIGNAL_SCORE = 0.45;

// ─── Types ────────────────────────────────────────────────────────────────────
export interface OhlcvCandle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface HistoricalPerformanceEntry {
  outcome: "profit" | "loss" | "neutral";
  pnl_pct: number;
  duration_candles: number;
  sl_pct: number;
  tp_pct: number;
}

export interface FractalSignal {
  pattern_id: string;
  match_date: string;
  timeframe: "1D" | "4H";
  similarity_score: number;
  confirmation_score: number;
  overall_signal_score: number;
  direction: "long" | "short" | "neutral";
  expected_price_change_pct: number;
  probability: number;
  suggested_sl_pct: number;
  suggested_tp_pct: number;
  historical_matches_count: number;
  historical_performance: HistoricalPerformanceEntry[];
  valid: boolean;
  reason: string;
  updatedAt: string;
}

// ─── DTW (simplified, sakoe-chiba band) ─────────────────────────────────────
function dtw(a: number[], b: number[], band = 10): number {
  const n = a.length;
  const m = b.length;
  const INF = 1e9;
  // Use Float64Array for performance
  const dp = new Float64Array(n * m).fill(INF);
  const idx = (i: number, j: number) => i * m + j;
  dp[idx(0, 0)] = Math.abs(a[0] - b[0]);
  for (let i = 1; i < n; i++) {
    if (Math.abs(i - 0) > band) continue;
    dp[idx(i, 0)] = dp[idx(i - 1, 0)] + Math.abs(a[i] - b[0]);
  }
  for (let j = 1; j < m; j++) {
    if (Math.abs(0 - j) > band) continue;
    dp[idx(0, j)] = dp[idx(0, j - 1)] + Math.abs(a[0] - b[j]);
  }
  for (let i = 1; i < n; i++) {
    for (let j = Math.max(1, i - band); j <= Math.min(m - 1, i + band); j++) {
      const cost = Math.abs(a[i] - b[j]);
      dp[idx(i, j)] = cost + Math.min(
        dp[idx(i - 1, j)],
        dp[idx(i, j - 1)],
        dp[idx(i - 1, j - 1)]
      );
    }
  }
  return dp[idx(n - 1, m - 1)];
}

function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  let sumA = 0, sumB = 0;
  for (let i = 0; i < n; i++) { sumA += a[i]; sumB += b[i]; }
  const mA = sumA / n, mB = sumB / n;
  let num = 0, dA = 0, dB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - mA, db = b[i] - mB;
    num += da * db; dA += da * da; dB += db * db;
  }
  const denom = Math.sqrt(dA * dB);
  return denom < 1e-10 ? 0 : num / denom;
}

// Normalize price sequence: pct change from first bar
function normPrice(candles: OhlcvCandle[]): { close: number[]; high: number[]; low: number[] } {
  const base = candles[0].close;
  return {
    close: candles.map(c => (c.close - base) / base),
    high:  candles.map(c => (c.high  - base) / base),
    low:   candles.map(c => (c.low   - base) / base),
  };
}

// Normalize volume: ratio to mean
function normVolume(candles: OhlcvCandle[]): number[] {
  const vols = candles.map(c => c.volume);
  const mean = vols.reduce((s, v) => s + v, 0) / vols.length;
  if (mean === 0) return vols.map(() => 1);
  return vols.map(v => v / mean);
}

// Compute similarity_score between two windows
function similarity(curr: OhlcvCandle[], hist: OhlcvCandle[]): number {
  const cn = normPrice(curr);
  const hn = normPrice(hist);
  const n = curr.length;

  // Max possible DTW for normalization (worst case two flat opposite series)
  const maxDtw = n * 2.0;

  const dClose = dtw(cn.close, hn.close);
  const dHigh  = dtw(cn.high,  hn.high);
  const dLow   = dtw(cn.low,   hn.low);
  const dtwAvg = (dClose + dHigh + dLow) / 3;
  const priceSim = Math.max(0, 1 - dtwAvg / maxDtw);

  const volSim = Math.max(0, (pearson(normVolume(curr), normVolume(hist)) + 1) / 2);

  return priceSim * WEIGHT_PRICE + volSim * WEIGHT_VOLUME;
}

// ─── Fetch helpers ────────────────────────────────────────────────────────────
async function fetch1DCandles(): Promise<OhlcvCandle[]> {
  // CryptoCompare: free, 2000 days from 2019
  const url = "https://min-api.cryptocompare.com/data/v2/histoday?fsym=BTC&tsym=USD&limit=2000&toTs=-1";
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json() as {
      Response: string;
      Data: { Data: { time: number; open: number; high: number; low: number; close: number; volumefrom: number }[] };
    };
    if (json.Response !== "Success") throw new Error(`CC error: ${json.Response}`);
    const rows = json.Data.Data;
    return rows
      .filter(r => r.close > 0)
      .map(r => ({
        ts: r.time * 1000,
        open: r.open, high: r.high, low: r.low, close: r.close,
        volume: r.volumefrom,
      }));
  } catch (e) {
    logger.warn({ err: e }, "FractalService: CryptoCompare 1D fetch failed, using Bybit");
  }
  // Bybit fallback
  const klines = await aggregator.fetchDailyKlines(500);
  return klines.map(k => ({ ...k, volume: 0 }));
}

async function fetch4HCandles(): Promise<OhlcvCandle[]> {
  // BingX public REST — works from Replit (no API key needed for klines)
  // interval: 4h, limit: 1000
  try {
    const url = "https://open-api.bingx.com/openApi/swap/v3/quote/klines?symbol=BTC-USDT&interval=4h&limit=1000";
    const resp = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json() as {
      code: number;
      data: { time: number; open: string; high: string; low: string; close: string; volume: string }[];
    };
    if (json.code !== 0) throw new Error(`BingX code ${json.code}`);
    return json.data
      .map(r => ({
        ts:     r.time,
        open:   parseFloat(r.open),
        high:   parseFloat(r.high),
        low:    parseFloat(r.low),
        close:  parseFloat(r.close),
        volume: parseFloat(r.volume),
      }))
      .filter(c => c.close > 0)
      .sort((a, b) => a.ts - b.ts); // oldest first
  } catch (e) {
    logger.warn({ err: e }, "FractalService: BingX 4H fetch failed");
  }

  // Fallback: CryptoCompare 4H (histohour * 4)
  try {
    const url = "https://min-api.cryptocompare.com/data/v2/histohour?fsym=BTC&tsym=USD&limit=2000&aggregate=4&toTs=-1";
    const resp = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json = await resp.json() as {
      Response: string;
      Data: { Data: { time: number; open: number; high: number; low: number; close: number; volumefrom: number }[] };
    };
    if (json.Response !== "Success") throw new Error(`CC error`);
    return json.Data.Data
      .filter(r => r.close > 0)
      .map(r => ({
        ts: r.time * 1000,
        open: r.open, high: r.high, low: r.low, close: r.close,
        volume: r.volumefrom,
      }));
  } catch (e) {
    logger.warn({ err: e }, "FractalService: 4H all sources failed");
    return [];
  }
}

// ─── Core matching ────────────────────────────────────────────────────────────
interface MatchEntry {
  startIdx: number;
  simScore: number;
  forwardPct: number;
  slHit: boolean;
  tpHit: boolean;
  suggestedSl: number;
  suggestedTp: number;
}

function runPatternMatch(
  candles: OhlcvCandle[],
  patLen: number,
  fwdLen: number,
): MatchEntry[] {
  const total = candles.length;
  if (total < patLen + fwdLen + 10) return [];

  const current = candles.slice(total - patLen - 1, total - 1); // last patLen completed candles

  const results: MatchEntry[] = [];

  for (let i = 0; i <= total - patLen - fwdLen - 1; i++) {
    const hist = candles.slice(i, i + patLen);
    const sim = similarity(current, hist);
    if (sim < MIN_SIMILARITY) continue;

    const fwd = candles.slice(i + patLen, i + patLen + fwdLen);
    if (fwd.length < fwdLen) continue;

    const entryPrice = hist[hist.length - 1].close;
    const maxUp   = Math.max(...fwd.map(c => c.high));
    const maxDown = Math.min(...fwd.map(c => c.low));
    const finalClose = fwd[fwd.length - 1].close;

    const upPct   = (maxUp   - entryPrice) / entryPrice;
    const downPct = (entryPrice - maxDown) / entryPrice;
    const forwardPct = (finalClose - entryPrice) / entryPrice * 100;

    // Did it hit TP or SL?
    const tpHit = upPct >= WIN_TP_PCT || (forwardPct < 0 && downPct >= WIN_TP_PCT);
    const slHit = downPct >= WIN_SL_PCT || (forwardPct > 0 && upPct >= WIN_SL_PCT);

    results.push({
      startIdx: i,
      simScore: sim,
      forwardPct,
      slHit,
      tpHit,
      suggestedSl: Math.min(downPct, WIN_SL_PCT + 0.005),
      suggestedTp: Math.min(upPct, WIN_TP_PCT + 0.02),
    });
  }

  results.sort((a, b) => b.simScore - a.simScore);
  return results.slice(0, TOP_N);
}

// ─── Build FractalSignal from matches ─────────────────────────────────────────
function buildSignal(
  matches: MatchEntry[],
  candles: OhlcvCandle[],
  patLen: number,
  timeframe: "1D" | "4H",
  confirmationScore: number,
): FractalSignal {
  const now = new Date().toISOString();
  const empty: FractalSignal = {
    pattern_id: `frac-${Date.now()}`,
    match_date: now,
    timeframe,
    similarity_score: 0,
    confirmation_score: confirmationScore,
    overall_signal_score: 0,
    direction: "neutral",
    expected_price_change_pct: 0,
    probability: 0,
    suggested_sl_pct: 0,
    suggested_tp_pct: 0,
    historical_matches_count: 0,
    historical_performance: [],
    valid: false,
    reason: "Нет совпадений с нужной схожестью",
    updatedAt: now,
  };

  if (matches.length === 0) return empty;

  const avgSim = matches.reduce((s, m) => s + m.simScore, 0) / matches.length;

  // Direction: weighted by simScore and forwardPct
  const weightedDir = matches.reduce((s, m) => {
    const dir = m.forwardPct > 0 ? 1 : m.forwardPct < 0 ? -1 : 0;
    return s + dir * m.simScore;
  }, 0);
  const totalWeight = matches.reduce((s, m) => s + m.simScore, 0);
  const dirScore = totalWeight > 0 ? weightedDir / totalWeight : 0;
  const direction: "long" | "short" | "neutral" =
    dirScore > 0.1 ? "long" : dirScore < -0.1 ? "short" : "neutral";

  if (direction === "neutral") {
    return { ...empty, similarity_score: avgSim, historical_matches_count: matches.length, reason: "Направление нейтральное (разброс исторических аналогов)" };
  }

  // Stats
  const positiveMatches = direction === "long"
    ? matches.filter(m => m.forwardPct > 0)
    : matches.filter(m => m.forwardPct < 0);

  const probability = positiveMatches.length / matches.length;

  const avgForward = matches.reduce((s, m) => s + m.forwardPct, 0) / matches.length;
  const avgSlPct   = matches.reduce((s, m) => s + m.suggestedSl, 0) / matches.length;
  const avgTpPct   = matches.reduce((s, m) => s + m.suggestedTp, 0) / matches.length;

  // R:R check
  const rr = avgSlPct > 0 ? avgTpPct / avgSlPct : 0;
  if (rr < 1.5) {
    return { ...empty, similarity_score: avgSim, historical_matches_count: matches.length,
      reason: `R:R слишком низкий (${rr.toFixed(2)} < 1.5)` };
  }

  const historical_performance: HistoricalPerformanceEntry[] = matches.map(m => ({
    outcome: m.forwardPct > 0 ? (m.tpHit ? "profit" : "neutral") : "loss",
    pnl_pct: parseFloat(m.forwardPct.toFixed(3)),
    duration_candles: 0,
    sl_pct: parseFloat((m.suggestedSl * 100).toFixed(3)),
    tp_pct: parseFloat((m.suggestedTp * 100).toFixed(3)),
  }));

  const similarity_score = parseFloat(avgSim.toFixed(4));
  const overall_signal_score = parseFloat(
    (similarity_score * 0.6 + confirmationScore * 0.4).toFixed(4)
  );

  const startCandle = candles[candles.length - patLen - 1];
  const matchDate = startCandle ? new Date(startCandle.ts).toISOString() : now;

  return {
    pattern_id: `frac-${timeframe}-${Date.now().toString(36)}`,
    match_date: matchDate,
    timeframe,
    similarity_score,
    confirmation_score: parseFloat(confirmationScore.toFixed(4)),
    overall_signal_score,
    direction,
    expected_price_change_pct: parseFloat(Math.abs(avgForward).toFixed(3)),
    probability: parseFloat(probability.toFixed(4)),
    suggested_sl_pct: parseFloat((avgSlPct * 100).toFixed(3)),
    suggested_tp_pct: parseFloat((avgTpPct * 100).toFixed(3)),
    historical_matches_count: matches.length,
    historical_performance,
    valid: overall_signal_score >= FRACTAL_MIN_SIGNAL_SCORE && probability >= 0.55,
    reason: overall_signal_score >= FRACTAL_MIN_SIGNAL_SCORE && probability >= 0.55
      ? `${direction.toUpperCase()} — ${matches.length} аналогов, win-rate ${(probability * 100).toFixed(0)}%`
      : `overall_score ${overall_signal_score.toFixed(2)} < ${FRACTAL_MIN_SIGNAL_SCORE} или win-rate ${(probability * 100).toFixed(0)}% < 55%`,
    updatedAt: now,
  };
}

// ─── Service ───────────────────────────────────────────────────────────────────
class FractalService {
  private candles1D: OhlcvCandle[] = [];
  private candles4H: OhlcvCandle[] = [];
  private signal1D: FractalSignal | null = null;
  private signal4H: FractalSignal | null = null;
  private combined: FractalSignal | null = null;
  private timer1D: ReturnType<typeof setInterval> | null = null;
  private timer4H: ReturnType<typeof setInterval> | null = null;
  private ready = false;

  async start() {
    // Initial load — run both in parallel
    await Promise.allSettled([
      this.refresh1D(),
      this.refresh4H(),
    ]);
    this.buildCombined();
    this.ready = true;

    this.timer1D = setInterval(() => void this.refresh1D().then(() => this.buildCombined()), REFRESH_1D_MS);
    this.timer4H = setInterval(() => void this.refresh4H().then(() => this.buildCombined()), REFRESH_4H_MS);

    logger.info({
      candles1D: this.candles1D.length,
      candles4H: this.candles4H.length,
      valid: this.combined?.valid,
      direction: this.combined?.direction,
      score: this.combined?.overall_signal_score,
    }, "FractalService started");
  }

  stop() {
    if (this.timer1D) clearInterval(this.timer1D);
    if (this.timer4H) clearInterval(this.timer4H);
  }

  private async refresh1D() {
    try {
      const candles = await fetch1DCandles();
      if (candles.length >= PATTERN_LEN_1D + FORWARD_LEN_1D + 10) {
        this.candles1D = candles;
        const matches = runPatternMatch(this.candles1D, PATTERN_LEN_1D, FORWARD_LEN_1D);
        // confirmation score: use cvd alignment from live data (best effort)
        const confScore = this.computeConfirmation();
        this.signal1D = buildSignal(matches, this.candles1D, PATTERN_LEN_1D, "1D", confScore);
        logger.info({
          candles: this.candles1D.length,
          matches: matches.length,
          direction: this.signal1D.direction,
          score: this.signal1D.overall_signal_score,
          valid: this.signal1D.valid,
        }, "FractalService: 1D pattern updated");
      }
    } catch (e) {
      logger.warn({ err: e }, "FractalService: 1D refresh error");
    }
  }

  private async refresh4H() {
    try {
      const candles = await fetch4HCandles();
      if (candles.length >= PATTERN_LEN_4H + FORWARD_LEN_4H + 10) {
        this.candles4H = candles;
        const matches = runPatternMatch(this.candles4H, PATTERN_LEN_4H, FORWARD_LEN_4H);
        const confScore = this.computeConfirmation();
        this.signal4H = buildSignal(matches, this.candles4H, PATTERN_LEN_4H, "4H", confScore);
        logger.info({
          candles: this.candles4H.length,
          matches: matches.length,
          direction: this.signal4H.direction,
          score: this.signal4H.overall_signal_score,
          valid: this.signal4H.valid,
        }, "FractalService: 4H pattern updated");
      }
    } catch (e) {
      logger.warn({ err: e }, "FractalService: 4H refresh error");
    }
  }

  /**
   * Compute a simple confirmation score from live CVD and orderbook data.
   * Returns 0.5 (neutral) if data not yet available.
   */
  private computeConfirmation(): number {
    try {
      const { cvdService } = require("./cvd") as { cvdService: { getAlignment(): { score: number } } };
      const { aggregator: agg } = require("./exchanges/aggregator") as { aggregator: { getAggregatedOrderbook(): { avgImbalance: number } | null } };

      const cvdScore = cvdService.getAlignment().score; // -1..+1
      const ob = agg.getAggregatedOrderbook();
      const obImbalance = ob ? ob.avgImbalance : 0.5; // 0..1, 0.5 = neutral

      // Normalize: cvd → 0..1, imbalance already 0..1
      const cvdNorm = (cvdScore + 1) / 2;
      const combined = cvdNorm * 0.6 + obImbalance * 0.4;
      return parseFloat(Math.max(0, Math.min(1, combined)).toFixed(4));
    } catch {
      return 0.5;
    }
  }

  /**
   * Combine 1D and 4H signals. Both must point in same direction for full validity.
   * If only one timeframe is valid, allow it through with lower score.
   */
  private buildCombined() {
    const s1 = this.signal1D;
    const s4 = this.signal4H;
    const now = new Date().toISOString();

    if (!s1 && !s4) {
      this.combined = null;
      return;
    }

    // Both valid and agree
    if (s1?.valid && s4?.valid && s1.direction === s4.direction) {
      const overallScore = (s1.overall_signal_score + s4.overall_signal_score) / 2;
      this.combined = {
        ...s1,
        timeframe: "1D", // dominant
        overall_signal_score: parseFloat(overallScore.toFixed(4)),
        similarity_score: parseFloat(((s1.similarity_score + s4.similarity_score) / 2).toFixed(4)),
        probability: parseFloat(((s1.probability + s4.probability) / 2).toFixed(4)),
        historical_matches_count: s1.historical_matches_count + s4.historical_matches_count,
        valid: overallScore >= FRACTAL_MIN_SIGNAL_SCORE,
        reason: `1D+4H согласованы: ${s1.direction.toUpperCase()} — score ${overallScore.toFixed(2)}`,
        updatedAt: now,
      };
      return;
    }

    // 1D and 4H disagree or only one valid — use whichever has higher score
    const best = (s1?.overall_signal_score ?? 0) >= (s4?.overall_signal_score ?? 0) ? s1 : s4;
    if (!best) { this.combined = null; return; }

    // Single-timeframe: apply a 20% score penalty
    const penalized = parseFloat((best.overall_signal_score * 0.8).toFixed(4));
    this.combined = {
      ...best,
      overall_signal_score: penalized,
      valid: best.valid && penalized >= FRACTAL_MIN_SIGNAL_SCORE,
      reason: best.valid
        ? `${best.timeframe} только (второй TF не подтверждает): score ${penalized.toFixed(2)}`
        : best.reason,
      updatedAt: now,
    };
  }

  // ─── Public API ─────────────────────────────────────────────────────────────
  isReady(): boolean { return this.ready; }

  getFractalSignal(): FractalSignal | null { return this.combined; }
  getSignal1D(): FractalSignal | null { return this.signal1D; }
  getSignal4H(): FractalSignal | null { return this.signal4H; }

  /**
   * Gate check used by signalTracker.
   * Returns { pass, direction } — direction must match the signal engine direction.
   */
  gateCheck(engineDirection: "long" | "short"): { pass: boolean; reason: string; score: number } {
    if (!this.ready) {
      return { pass: false, reason: "Фрактальный анализ ещё загружается", score: 0 };
    }
    const sig = this.combined;
    if (!sig) {
      return { pass: false, reason: "Нет фрактального сигнала", score: 0 };
    }
    if (!sig.valid) {
      return { pass: false, reason: `Фрактал невалиден: ${sig.reason}`, score: sig.overall_signal_score };
    }
    if (sig.direction !== engineDirection) {
      return {
        pass: false,
        reason: `Фрактал (${sig.direction}) ≠ сигнал движка (${engineDirection})`,
        score: sig.overall_signal_score,
      };
    }
    return {
      pass: true,
      reason: sig.reason,
      score: sig.overall_signal_score,
    };
  }
}

export const fractalService = new FractalService();
