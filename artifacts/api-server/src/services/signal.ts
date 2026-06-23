import { aggregator } from "./exchanges/aggregator";
import { taService } from "./taService";
import { coinalyzeService } from "./coinalyzeService";
import { coinglassService } from "./coinglassService";
import type { LiqHeatmapBucket } from "./coinglassService";
import type { LiqMapBucket } from "./coinalyzeService";
import { cvdService } from "./cvd";
import { logger } from "../lib/logger";
import { SignalBuffer } from "./bufferService";
import type { MarketSnapshot, EvalResult, LiqSignal, SignalType } from "./bufferService";
import { telegramService } from "./telegram";

// ─── Dashboard-compatible types ───────────────────────────────
export interface SignalComponent {
  name: string;
  score: number;
  weight: number;
  description: string;
}

export interface GateResult {
  name: string;
  passed: boolean;
  reason: string;
}

export interface SignalResult {
  score: number;
  direction: "long" | "short" | "neutral";
  confidence: number;
  components: SignalComponent[];
  gates: GateResult[];
  allGatesPassed: boolean;
  suggestedLeverage: number;
  suggestedSl: number;
  suggestedTp: number;
  slValid: boolean;
  tpValid: boolean;
  atrPct: number;
  vwap: number;
  updatedAt: string;
  tpSource?: string;
  slSource?: string;
}

// ─── Bucket type (unified) ─────────────────────────────────────
type Bucket = { price: number; longLiqUsd: number; shortLiqUsd: number; totalUsd: number };

// ─── Constants ────────────────────────────────────────────────
const MIN_SL_CLUSTER_USD  = 10_000_000;
const MAX_SL_RANGE_PCT    = 0.04;
const MIN_SL_DISTANCE_PCT = 0.004;
const MAX_SL_DISTANCE_PCT = 0.025;
const SL_CLUSTER_BUFFER   = 0.0008;

const MIN_TP_CLUSTER_USD  = 7_000_000;
const MAX_TP_RANGE_PCT    = 0.08;
const MIN_TP_DISTANCE_PCT = 0.006; // 0.6% min TP distance (was 1.5% — too strict)
const MIN_RR_RATIO        = 1.2;
const TP_CLUSTER_BUFFER   = 0.001;

const LIQ_MAP_ZONE_RANGE  = 0.03;  // ±3% of price
const LIQ_MAP_MIN_USD     = 5_000_000;
const OB_RANGE_PCT        = 0.005; // ±0.5%
const OB_LONG_THRESHOLD   = 0.55;
const OB_SHORT_THRESHOLD  = 0.45;

const LIQ_THRESHOLDS: Record<SignalType, number> = {
  scalp:    500_000,
  intraday: 2_000_000,
  swing:    10_000_000,
};

const SCAN_INTERVAL_MS  = 5  * 60 * 1000; // scan every 5 min

// ─── Liq buckets helper ───────────────────────────────────────
function getLiqBuckets(): Bucket[] {
  const cgHeatmap = coinglassService.getCachedHeatmap();
  if (cgHeatmap && cgHeatmap.buckets.length > 0) {
    return cgHeatmap.buckets as Bucket[];
  }
  const caMap = coinalyzeService.getCachedMap();
  if (caMap && caMap.buckets.length > 0) {
    return caMap.buckets.map((b: LiqMapBucket): Bucket => ({
      price: b.price,
      longLiqUsd: b.longLiqUsd,
      shortLiqUsd: b.shortLiqUsd,
      totalUsd: b.totalUsd,
    }));
  }
  return [];
}

// ─── SL from cluster ──────────────────────────────────────────
interface SlResult {
  price: number;
  source: string;
  valid: boolean;
  clusterUsd: number;
  distancePct: number;
}

function calcSlFromLiqMap(direction: "long" | "short", price: number, buckets: Bucket[]): SlResult {
  const invalid: SlResult = { price: 0, source: "нет кластера", valid: false, clusterUsd: 0, distancePct: 0 };
  if (buckets.length === 0) return invalid;

  if (direction === "long") {
    const candidates = buckets
      .filter(b => b.price < price && b.price >= price * (1 - MAX_SL_RANGE_PCT) && b.longLiqUsd >= MIN_SL_CLUSTER_USD)
      .sort((a, b) => b.price - a.price);
    const cluster = candidates[0];
    if (!cluster) return invalid;
    const slPrice = cluster.price * (1 + SL_CLUSTER_BUFFER);
    const distancePct = (price - slPrice) / price;
    if (distancePct < MIN_SL_DISTANCE_PCT) return { price: slPrice, source: "кластер слишком близко", valid: false, clusterUsd: cluster.longLiqUsd, distancePct };
    if (distancePct > MAX_SL_DISTANCE_PCT) return { price: slPrice, source: "кластер слишком далеко", valid: false, clusterUsd: cluster.longLiqUsd, distancePct };
    return { price: parseFloat(slPrice.toFixed(2)), source: `Над кластером лонгов $${cluster.price.toFixed(0)} (${(cluster.longLiqUsd / 1e6).toFixed(1)}M)`, valid: true, clusterUsd: cluster.longLiqUsd, distancePct };
  } else {
    const candidates = buckets
      .filter(b => b.price > price && b.price <= price * (1 + MAX_SL_RANGE_PCT) && b.shortLiqUsd >= MIN_SL_CLUSTER_USD)
      .sort((a, b) => a.price - b.price);
    const cluster = candidates[0];
    if (!cluster) return invalid;
    const slPrice = cluster.price * (1 - SL_CLUSTER_BUFFER);
    const distancePct = (slPrice - price) / price;
    if (distancePct < MIN_SL_DISTANCE_PCT) return { price: slPrice, source: "кластер слишком близко", valid: false, clusterUsd: cluster.shortLiqUsd, distancePct };
    if (distancePct > MAX_SL_DISTANCE_PCT) return { price: slPrice, source: "кластер слишком далеко", valid: false, clusterUsd: cluster.shortLiqUsd, distancePct };
    return { price: parseFloat(slPrice.toFixed(2)), source: `Под кластером шортов $${cluster.price.toFixed(0)} (${(cluster.shortLiqUsd / 1e6).toFixed(1)}M)`, valid: true, clusterUsd: cluster.shortLiqUsd, distancePct };
  }
}

// ─── TP from cluster ──────────────────────────────────────────
interface TpResult {
  price: number;
  source: string;
  valid: boolean;
  clusterUsd: number;
  distancePct: number;
  rr: number;
}

function calcTpFromLiqMap(direction: "long" | "short", price: number, buckets: Bucket[], slDistancePct: number): TpResult {
  const invalid: TpResult = { price: 0, source: "нет кластера", valid: false, clusterUsd: 0, distancePct: 0, rr: 0 };
  if (buckets.length === 0 || slDistancePct <= 0) return invalid;

  if (direction === "long") {
    const candidates = buckets
      .filter(b => b.price > price && b.price <= price * (1 + MAX_TP_RANGE_PCT) && b.shortLiqUsd >= MIN_TP_CLUSTER_USD)
      .sort((a, b) => a.price - b.price); // nearest first
    let lastResult: TpResult = invalid;
    for (const cluster of candidates) {
      const tpPrice = cluster.price * (1 - TP_CLUSTER_BUFFER);
      const distancePct = (tpPrice - price) / price;
      const rr = distancePct / slDistancePct;
      if (distancePct < MIN_TP_DISTANCE_PCT) {
        lastResult = { price: tpPrice, source: "TP кластер слишком близко", valid: false, clusterUsd: cluster.shortLiqUsd, distancePct, rr };
        continue; // too close — try next cluster further out
      }
      if (rr < MIN_RR_RATIO) {
        lastResult = { price: tpPrice, source: `R:R ${rr.toFixed(2)} < ${MIN_RR_RATIO}`, valid: false, clusterUsd: cluster.shortLiqUsd, distancePct, rr };
        continue; // R:R too low — try next cluster further out
      }
      return { price: parseFloat(tpPrice.toFixed(2)), source: `Кластер шортов $${cluster.price.toFixed(0)} (${(cluster.shortLiqUsd / 1e6).toFixed(1)}M) | R:R ${rr.toFixed(2)}`, valid: true, clusterUsd: cluster.shortLiqUsd, distancePct, rr };
    }
    return lastResult;
  } else {
    const candidates = buckets
      .filter(b => b.price < price && b.price >= price * (1 - MAX_TP_RANGE_PCT) && b.longLiqUsd >= MIN_TP_CLUSTER_USD)
      .sort((a, b) => b.price - a.price); // nearest first
    let lastResult: TpResult = invalid;
    for (const cluster of candidates) {
      const tpPrice = cluster.price * (1 + TP_CLUSTER_BUFFER);
      const distancePct = (price - tpPrice) / price;
      const rr = distancePct / slDistancePct;
      if (distancePct < MIN_TP_DISTANCE_PCT) {
        lastResult = { price: tpPrice, source: "TP кластер слишком близко", valid: false, clusterUsd: cluster.longLiqUsd, distancePct, rr };
        continue; // too close — try next cluster further out
      }
      if (rr < MIN_RR_RATIO) {
        lastResult = { price: tpPrice, source: `R:R ${rr.toFixed(2)} < ${MIN_RR_RATIO}`, valid: false, clusterUsd: cluster.longLiqUsd, distancePct, rr };
        continue; // R:R too low — try next cluster further out
      }
      return { price: parseFloat(tpPrice.toFixed(2)), source: `Кластер лонгов $${cluster.price.toFixed(0)} (${(cluster.longLiqUsd / 1e6).toFixed(1)}M) | R:R ${rr.toFixed(2)}`, valid: true, clusterUsd: cluster.longLiqUsd, distancePct, rr };
    }
    return lastResult;
  }
}

// ─── ATR from 1H candles ──────────────────────────────────────
function computeAtrPct(): number {
  const snap = taService.getSnapshot();
  if (!snap?.ready) return 0;
  const price = aggregator.getPrimaryPrice();
  if (price === 0) return 0;
  // Use 1H EMA spread as ATR proxy: (EMA21 - EMA200) / price as range indicator
  const atrAbsolute = Math.abs(snap.ema21_1h - snap.ema200_1h) * 0.1;
  return atrAbsolute > 0 ? (atrAbsolute / price) * 100 : 0;
}

// ─── Factor: Liq map near price ───────────────────────────────
// LONG  signal: short liq clusters ABOVE price dominate → price squeezed UP (short squeeze magnet)
// SHORT signal: long liq clusters BELOW price dominate  → price cascades DOWN (long cascade magnet)
// This matches SL/TP logic: TP for long = short cluster above, TP for short = long cluster below.
function getLiqMapSignal(price: number): { signal: LiqSignal; zonePrice: number; zoneUsd: number } {
  const buckets = getLiqBuckets();
  if (buckets.length === 0 || price === 0) return { signal: "", zonePrice: 0, zoneUsd: 0 };

  const lower = price * (1 - LIQ_MAP_ZONE_RANGE);
  const upper = price * (1 + LIQ_MAP_ZONE_RANGE);
  const nearby = buckets.filter(b => b.price >= lower && b.price <= upper);
  if (nearby.length === 0) return { signal: "", zonePrice: 0, zoneUsd: 0 };

  // Short liq clusters ABOVE price → shorts get squeezed → price goes UP → LONG
  const above = nearby.filter(b => b.price > price);
  const shortAbove = above.reduce((s, b) => s + b.shortLiqUsd, 0);

  // Long liq clusters BELOW price → longs cascade → price goes DOWN → SHORT
  const below = nearby.filter(b => b.price <= price);
  const longBelow = below.reduce((s, b) => s + b.longLiqUsd, 0);

  if (shortAbove >= LIQ_MAP_MIN_USD && shortAbove > longBelow) {
    const best = [...above].sort((a, b) => b.shortLiqUsd - a.shortLiqUsd)[0]!;
    return { signal: "LONG", zonePrice: best.price, zoneUsd: best.shortLiqUsd };
  }
  if (longBelow >= LIQ_MAP_MIN_USD && longBelow > shortAbove) {
    const best = [...below].sort((a, b) => b.longLiqUsd - a.longLiqUsd)[0]!;
    return { signal: "SHORT", zonePrice: best.price, zoneUsd: best.longLiqUsd };
  }
  return { signal: "", zonePrice: 0, zoneUsd: 0 };
}

// ─── Factor: Real liquidations ────────────────────────────────
function getRealLiqSignal(type: SignalType): { longUsd: number; shortUsd: number; signal: LiqSignal } {
  const threshold = LIQ_THRESHOLDS[type];

  let candles: Array<{ longUsd: number; shortUsd: number }>;
  let lookback: number;

  if (type === "swing") {
    candles  = coinalyzeService.getLatest24hCandles();
    lookback = candles.length;
  } else {
    candles  = coinalyzeService.getLatest2hCandles();
    lookback = type === "scalp" ? 3 : 12; // 3×5min=15m | 12×5min=1h
  }

  const recent   = candles.slice(-lookback);
  const longUsd  = recent.reduce((s, c) => s + c.longUsd,  0);
  const shortUsd = recent.reduce((s, c) => s + c.shortUsd, 0);

  let signal: LiqSignal = "";
  if (shortUsd >= threshold && shortUsd > longUsd) signal = "LONG";
  else if (longUsd >= threshold && longUsd > shortUsd) signal = "SHORT";

  return { longUsd, shortUsd, signal };
}

// ─── Factor: Order book imbalance ─────────────────────────────
function getObSignal(price: number): {
  imbalance: number; signal: LiqSignal;
  cgImbalance: number; cgSignal: LiqSignal;
} {
  // V4 cross-exchange aggregated OB (fallback values if unavailable)
  const cgOb = coinglassService.getAggOb();
  const cgImbalance = cgOb ? cgOb.imbalance : 0.5;
  const cgSignal: LiqSignal = cgOb
    ? (cgOb.imbalance > OB_LONG_THRESHOLD ? "LONG" : cgOb.imbalance < OB_SHORT_THRESHOLD ? "SHORT" : "")
    : "";

  // Local real-time OB from Bybit/BingX (±0.5% of price)
  const ob = aggregator.getAggregatedOrderbook();
  if (!ob || price === 0) {
    // No local OB — use V4 alone
    return { imbalance: cgImbalance, signal: cgSignal, cgImbalance, cgSignal };
  }

  const lower = price * (1 - OB_RANGE_PCT);
  const upper = price * (1 + OB_RANGE_PCT);

  const bidVol = ob.mergedBids.filter(l => l.price >= lower && l.price <= price).reduce((s, l) => s + l.size * l.price, 0);
  const askVol = ob.mergedAsks.filter(l => l.price >= price && l.price <= upper).reduce((s, l) => s + l.size * l.price, 0);

  const total = bidVol + askVol;
  if (total === 0) return { imbalance: cgImbalance, signal: cgSignal, cgImbalance, cgSignal };

  const localImbalance = bidVol / total;
  const localSignal: LiqSignal =
    localImbalance > OB_LONG_THRESHOLD  ? "LONG"  :
    localImbalance < OB_SHORT_THRESHOLD ? "SHORT" : "";

  // Conflict resolution:
  // - Both agree or one is neutral → use local (real-time)
  // - Active conflict (both have signals but opposite) → treat as neutral
  let finalSignal: LiqSignal;
  let finalImbalance: number;

  if (localSignal && cgSignal && localSignal !== cgSignal) {
    // Conflict: cross-exchange OB opposes local real-time OB → unreliable, go neutral
    finalSignal    = "";
    finalImbalance = (localImbalance + cgImbalance) / 2;
  } else if (!localSignal && cgSignal) {
    // Local neutral, but V4 has signal — use V4
    finalSignal    = cgSignal;
    finalImbalance = cgImbalance;
  } else {
    finalSignal    = localSignal;
    finalImbalance = localImbalance;
  }

  return { imbalance: finalImbalance, signal: finalSignal, cgImbalance, cgSignal };
}

// ─── Netflow thresholds ────────────────────────────────────────
// Ratio = net_flow / BTC market cap. ±0.15% is a meaningful imbalance.
const NETFLOW_THRESHOLD_15M = 0.0015; // ±0.15% market cap in 15m
const NETFLOW_THRESHOLD_1H  = 0.0020; // ±0.20% market cap in 1h
const NETFLOW_THRESHOLD_4H  = 0.0030; // ±0.30% market cap in 4h

// ─── Factor: CVD / Netflow per timeframe ──────────────────────
// Priority: V4 cross-exchange netflow → local CVD (fallback)
function getCvdSignal(type: SignalType): { delta: number; signal: LiqSignal; desc: string } {
  const arrow = (s: LiqSignal) => s === "LONG" ? "бычий" : s === "SHORT" ? "медвежий" : "нейтральный";

  const netflow = coinglassService.getNetflow();

  if (type === "scalp") {
    if (netflow) {
      const ratio   = netflow.netFlowRatio15m;
      const net15m  = netflow.netFlow15m;
      const signal: LiqSignal = ratio > NETFLOW_THRESHOLD_15M ? "LONG" : ratio < -NETFLOW_THRESHOLD_15M ? "SHORT" : "";
      const sign    = net15m >= 0 ? "+" : "";
      const netM    = (net15m / 1e6).toFixed(0);
      const ratStr  = (ratio * 100).toFixed(2);
      return { delta: net15m, signal, desc: `🌐 Netflow 15m: ${sign}$${netM}M (${ratStr}% mcap) — ${arrow(signal)}` };
    }
    // Fallback to local CVD
    const trend = cvdService.getTrend5m();
    const cvd   = cvdService.getCurrentCvd();
    const signal: LiqSignal = trend === "bullish" ? "LONG" : trend === "bearish" ? "SHORT" : "";
    const sign = cvd >= 0 ? "+" : "";
    return { delta: cvd, signal, desc: `📊 CVD 5m: δ${sign}${cvd.toFixed(2)} — ${arrow(signal)}` };
  }

  if (type === "intraday") {
    if (netflow) {
      const ratio  = netflow.netFlowRatio1h;
      const net1h  = netflow.netFlow1h;
      const signal: LiqSignal = ratio > NETFLOW_THRESHOLD_1H ? "LONG" : ratio < -NETFLOW_THRESHOLD_1H ? "SHORT" : "";
      const sign   = net1h >= 0 ? "+" : "";
      const netM   = (net1h / 1e6).toFixed(0);
      const ratStr = (ratio * 100).toFixed(2);
      return { delta: net1h, signal, desc: `🌐 Netflow 1h: ${sign}$${netM}M (${ratStr}% mcap) — ${arrow(signal)}` };
    }
    const r = taService.getCvdTrend("4h");
    const signal: LiqSignal = r.trend === "bullish" ? "LONG" : r.trend === "bearish" ? "SHORT" : "";
    return { delta: r.delta, signal, desc: `📊 CVD 4H: ${r.description} — ${arrow(signal)}` };
  }

  // swing
  if (netflow) {
    const ratio  = netflow.netFlowRatio4h;
    const net4h  = netflow.netFlow4h;
    const signal: LiqSignal = ratio > NETFLOW_THRESHOLD_4H ? "LONG" : ratio < -NETFLOW_THRESHOLD_4H ? "SHORT" : "";
    const sign   = net4h >= 0 ? "+" : "";
    const netM   = (net4h / 1e6).toFixed(0);
    const ratStr = (ratio * 100).toFixed(2);
    return { delta: net4h, signal, desc: `🌐 Netflow 4h: ${sign}$${netM}M (${ratStr}% mcap) — ${arrow(signal)}` };
  }
  const r = taService.getCvdTrend("1d");
  const signal: LiqSignal = r.trend === "bullish" ? "LONG" : r.trend === "bearish" ? "SHORT" : "";
  return { delta: r.delta, signal, desc: `📊 CVD 1D: ${r.description} — ${arrow(signal)}` };
}

// ─── Signal engine ────────────────────────────────────────────
type FiredCallback = (type: SignalType, direction: "LONG" | "SHORT", snap: MarketSnapshot, ev: EvalResult) => void;

class SignalEngine {
  readonly buffers = {
    scalp:    new SignalBuffer("scalp"),
    intraday: new SignalBuffer("intraday"),
    swing:    new SignalBuffer("swing"),
  };

  private lastEvals: Partial<Record<SignalType, EvalResult>>       = {};
  private lastSnaps: Partial<Record<SignalType, MarketSnapshot>>   = {};
  private fireCallbacks: FiredCallback[] = [];
  private scanHandle: ReturnType<typeof setInterval> | null = null;

  onFired(cb: FiredCallback): void {
    this.fireCallbacks.push(cb);
  }

  collectSnapshot(type: SignalType): MarketSnapshot {
    const price   = aggregator.getPrimaryPrice();
    const liqMap  = getLiqMapSignal(price);
    const liqReal = getRealLiqSignal(type);
    const ob      = getObSignal(price);
    const cvd     = getCvdSignal(type);

    // V4 netflow snapshot values
    const netflow = coinglassService.getNetflow();
    const netflowNet15m  = netflow?.netFlow15m  ?? 0;
    const netflowNet1h   = netflow?.netFlow1h   ?? 0;
    const netflowRatio15m = netflow?.netFlowRatio15m ?? 0;
    const netflowSignal: import("./bufferService").LiqSignal =
      netflow
        ? netflow.netFlowRatio15m > NETFLOW_THRESHOLD_15M ? "LONG"
          : netflow.netFlowRatio15m < -NETFLOW_THRESHOLD_15M ? "SHORT"
          : ""
        : "";

    // Likely direction from current votes (for SL/TP)
    const longVotes  = [liqMap.signal === "LONG",  ob.signal === "LONG",  cvd.signal === "LONG" ].filter(Boolean).length;
    const shortVotes = [liqMap.signal === "SHORT", ob.signal === "SHORT", cvd.signal === "SHORT"].filter(Boolean).length;
    const likelyDir: "long" | "short" | null =
      longVotes > shortVotes ? "long" : shortVotes > longVotes ? "short" : null;

    const buckets = getLiqBuckets();
    let sl = { price: 0, source: "нет кластера", valid: false, distancePct: 0 };
    let tp = { price: 0, source: "нет кластера", valid: false };

    if (likelyDir) {
      const slR = calcSlFromLiqMap(likelyDir, price, buckets);
      sl = { price: slR.price, source: slR.source, valid: slR.valid, distancePct: slR.distancePct };
      if (slR.valid) {
        const tpR = calcTpFromLiqMap(likelyDir, price, buckets, slR.distancePct);
        tp = { price: tpR.price, source: tpR.source, valid: tpR.valid };
      }
    }

    const ta    = taService.getSnapshot();
    const atrPct = computeAtrPct();
    const leverage = atrPct > 0 ? Math.min(25, Math.max(2, Math.floor(1.5 / atrPct))) : 5;

    return {
      ts: Date.now(),
      price,

      liqMapSignal:    liqMap.signal,
      liqMapZonePrice: liqMap.zonePrice,
      liqMapZoneUsd:   liqMap.zoneUsd,
      liqRealLongUsd:  liqReal.longUsd,
      liqRealShortUsd: liqReal.shortUsd,
      liqRealSignal:   liqReal.signal,

      obImbalance: ob.imbalance,
      obSignal:    ob.signal,
      cgObImbalance: ob.cgImbalance,
      cgObSignal:    ob.cgSignal,

      cvdDelta:  cvd.delta,
      cvdSignal: cvd.signal,
      cvdDesc:   cvd.desc,

      netflowNet15m,
      netflowNet1h,
      netflowRatio15m,
      netflowSignal,

      suggestedSl: sl.price,
      suggestedTp: tp.price,
      slSource:    sl.source,
      tpSource:    tp.source,
      slValid:     sl.valid,
      tpValid:     tp.valid,
      leverage,
      atrPct,
      vwap: ta?.vwap_1h ?? 0,
    };
  }

  async scan(): Promise<void> {
    for (const type of (["scalp", "intraday", "swing"] as const)) {
      try {
        const snap = this.collectSnapshot(type);
        this.buffers[type].update(snap);
        const ev = this.buffers[type].evaluate();
        this.lastEvals[type] = ev;
        this.lastSnaps[type] = snap;

        if (ev.shouldSignal && (ev.direction === "LONG" || ev.direction === "SHORT")) {
          for (const cb of this.fireCallbacks) {
            cb(type, ev.direction, snap, ev);
          }
          this.buffers[type].reset();
        }
      } catch (e) {
        logger.error({ type, err: e }, "Buffer scan error");
      }
      await new Promise(r => setTimeout(r, 500)); // small delay between types
    }

  }

  buildDebugMessage(): string {
    const timeStr = new Date().toLocaleTimeString("ru-RU", { timeZone: "Europe/Moscow", hour12: false }) + " МСК";
    const price   = aggregator.getPrimaryPrice();

    const TYPES: { type: SignalType; emoji: string; label: string }[] = [
      { type: "scalp",    emoji: "⚡", label: "SCALP (15m)"   },
      { type: "intraday", emoji: "🔥", label: "INTRADAY (4H)" },
      { type: "swing",    emoji: "🌊", label: "SWING (1D)"    },
    ];

    const fmtFactor = (f: LiqSignal) =>
      f === "LONG" ? "🟢 LONG" : f === "SHORT" ? "🔴 SHORT" : "⚪ —";

    const fmtUsd = (n: number) =>
      n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `$${(n / 1_000).toFixed(0)}K` : "$0";

    const lines: string[] = [
      `🔍 <b>Диагностика сканирования</b> · ${timeStr}`,
      `💰 BTC: <b>$${price.toFixed(0)}</b>`,
      `━━━━━━━━━━━━━━━━━━━`,
    ];

    for (const { type, emoji, label } of TYPES) {
      const snap = this.lastSnaps[type];
      const ev   = this.lastEvals[type];

      lines.push(`\n${emoji} <b>${label}</b>`);

      if (!snap || !ev) {
        lines.push(`  ⏳ Данных нет (ожидание первого скана)`);
        continue;
      }

      // Liq Map
      const mapStr = snap.liqMapSignal
        ? `${fmtFactor(snap.liqMapSignal)} зона ${fmtUsd(snap.liqMapZoneUsd)} @ $${snap.liqMapZonePrice.toFixed(0)}`
        : `⚪ — (нет зоны ≥$${(LIQ_MAP_MIN_USD / 1e6).toFixed(0)}M в ±3%)`;

      // Real liq
      const threshold = LIQ_THRESHOLDS[type];
      const realLong  = fmtUsd(snap.liqRealLongUsd);
      const realShort = fmtUsd(snap.liqRealShortUsd);
      const realStr   = snap.liqRealSignal
        ? `${fmtFactor(snap.liqRealSignal)} лонги:${realLong} шорты:${realShort}`
        : `⚪ — лонги:${realLong} шорты:${realShort} (порог ${fmtUsd(threshold)})`;

      // Liq factor combined
      let liqFactorStr: string;
      if (snap.liqMapSignal && snap.liqRealSignal) {
        if (snap.liqMapSignal === snap.liqRealSignal) {
          liqFactorStr = `✅ ${fmtFactor(ev.factorLiq)} (карта + реал совпали)`;
        } else {
          liqFactorStr = `❌ конфликт — карта:${snap.liqMapSignal} ≠ реал:${snap.liqRealSignal}`;
        }
      } else if (snap.liqRealSignal) {
        liqFactorStr = `⚠️ только реал: ${fmtFactor(snap.liqRealSignal)}`;
      } else {
        liqFactorStr = `❌ нет данных`;
      }

      // OB — local + V4 cross-exchange
      const bidPct   = (snap.obImbalance * 100).toFixed(1);
      const cgBidPct = (snap.cgObImbalance * 100).toFixed(1);
      const cgObLabel = snap.cgObSignal
        ? `V4:${fmtFactor(snap.cgObSignal)} ${cgBidPct}%`
        : `V4:⚪ ${cgBidPct}%`;
      let obStr: string;
      if (snap.obSignal) {
        obStr = `✅ ${fmtFactor(snap.obSignal)} local ${bidPct}% | ${cgObLabel}`;
      } else if (snap.cgObSignal && snap.cgObImbalance !== 0.5) {
        // V4 filled in when local was neutral
        obStr = `✅ ${fmtFactor(snap.cgObSignal)} (V4) ${cgBidPct}% | local нейтральный ${bidPct}%`;
      } else {
        obStr = `❌ нейтрально local ${bidPct}% | ${cgObLabel}`;
      }

      // Netflow (global CVD) — show separately if V4 available
      const nf = coinglassService.getNetflow();
      let nfStr: string;
      if (nf) {
        const n15 = (nf.netFlow15m / 1e6).toFixed(0);
        const n1h = (nf.netFlow1h  / 1e6).toFixed(0);
        const r15 = (nf.netFlowRatio15m * 100).toFixed(2);
        const sign15 = nf.netFlow15m >= 0 ? "+" : "";
        const sign1h = nf.netFlow1h  >= 0 ? "+" : "";
        const nfDir  = snap.netflowSignal ? fmtFactor(snap.netflowSignal) : "⚪ нейтральный";
        nfStr = `${nfDir} 15m:${sign15}$${n15}M (${r15}%) | 1h:${sign1h}$${n1h}M`;
      } else {
        nfStr = `нет V4 данных`;
      }

      // CVD (now = netflow when V4 available)
      const cvdStr = snap.cvdSignal
        ? `✅ ${fmtFactor(snap.cvdSignal)} ${snap.cvdDesc}`
        : `❌ нейтрально — ${snap.cvdDesc}`;

      // SL/TP
      const slStr = snap.slValid
        ? `✅ SL $${snap.suggestedSl.toFixed(0)} (${snap.slSource})`
        : `❌ SL: ${snap.slSource}`;
      const tpStr = snap.tpValid
        ? `✅ TP $${snap.suggestedTp.toFixed(0)} (${snap.tpSource})`
        : `❌ TP: ${snap.tpSource || "нет SL или кластера"}`;

      // Verdict — shows current confirmation state (0/2, 1/2, 2/2)
      let verdict: string;
      if (!ev.factorOb || !ev.factorCvd) {
        const missing = [ev.factorOb ? null : "📖OB", ev.factorCvd ? null : "📊CVD"].filter(Boolean).join(", ");
        verdict = `❌ нет данных (нет: ${missing})`;
      } else if (ev.factorOb !== ev.factorCvd) {
        verdict = `❌ OB/CVD расходятся: OB=${ev.factorOb} CVD=${ev.factorCvd}`;
      } else if (ev.factorLiq && ev.factorLiq !== ev.factorOb) {
        verdict = `🚫 заблок. liq: OB+CVD=${ev.factorOb}, но Liq=${ev.factorLiq}`;
      } else if (ev.shouldSignal) {
        const strength = ev.factorLiq === ev.factorOb ? "3/3" : "OB+CVD";
        verdict = snap.slValid && snap.tpValid
          ? `🔥 СИГНАЛ ${strength} (2/2 скана)! → ${ev.factorOb}`
          : `⚠️ ${strength} ${ev.factorOb} (2/2), но SL/TP невалидны`;
      } else if (ev.confirmationCount === 1 && ev.pendingDirection) {
        verdict = `⏳ 1/2 скана накоплено → ${ev.pendingDirection} (${ev.confirmationReason ?? "ждём следующего"})`;
      } else {
        verdict = `❌ нет сигнала`;
      }

      lines.push(
        `  💥 Liq: ${liqFactorStr}`,
        `      ↳ Карта: ${mapStr}`,
        `      ↳ Реал:  ${realStr}`,
        `  📖 OB:  ${obStr}`,
        `  🌐 NF:  ${nfStr}`,
        `  📊 CVD: ${cvdStr}`,
        `  📐 ${slStr}`,
        `  📐 ${tpStr}`,
        `  → ${verdict}`,
      );
    }

    lines.push(`━━━━━━━━━━━━━━━━━━━`);
    lines.push(`💡 /debug — запросить сейчас`);
    return lines.join("\n");
  }

  start(): void {
    if (this.scanHandle) return;
    void this.scan();
    this.scanHandle = setInterval(() => void this.scan(), SCAN_INTERVAL_MS);
    logger.info({ intervalMin: SCAN_INTERVAL_MS / 60000 }, "SignalEngine started — scanning all three buffers");
  }

  stop(): void {
    if (this.scanHandle) clearInterval(this.scanHandle);
    this.scanHandle = null;
  }

  // ─── Dashboard compute() ──────────────────────────────────────
  compute(): SignalResult {
    const snap = this.lastSnaps["intraday"];
    const ev   = this.lastEvals["intraday"];

    const defaultResult: SignalResult = {
      score: 0, direction: "neutral", confidence: 0,
      components: [], gates: [], allGatesPassed: false,
      suggestedLeverage: 5, suggestedSl: 0, suggestedTp: 0,
      slValid: false, tpValid: false, atrPct: 0, vwap: 0,
      updatedAt: new Date().toISOString(),
    };

    if (!snap || !ev) return defaultResult;

    const fSign = (f: LiqSignal) => f === "LONG" ? 1 : f === "SHORT" ? -1 : 0;

    const longVotes  = [ev.factorLiq, ev.factorOb, ev.factorCvd].filter(f => f === "LONG").length;
    const shortVotes = [ev.factorLiq, ev.factorOb, ev.factorCvd].filter(f => f === "SHORT").length;
    const score      = (longVotes - shortVotes) / 3;

    const direction: "long" | "short" | "neutral" =
      longVotes > shortVotes ? "long" :
      shortVotes > longVotes ? "short" : "neutral";

    const confidence = Math.max(longVotes, shortVotes) / 3;

    const gates: GateResult[] = [
      {
        name: "💥 Ликвидации (карта + реальные)",
        passed: ev.factorLiq !== "",
        reason: ev.descLiq || "нет совпадения зоны + реальных ликвидаций",
      },
      {
        name: "📖 Стакан (bid/ask дисбаланс)",
        passed: ev.factorOb !== "",
        reason: ev.descOb || "нейтральный дисбаланс (42–58%)",
      },
      {
        name: "📊 CVD 4H (intraday)",
        passed: ev.factorCvd !== "",
        reason: ev.descCvd || "нет чёткого направления CVD",
      },
    ];

    // Weighted components for intraday buffer
    const components: SignalComponent[] = [
      {
        name: "💥 Ликвидации",
        score: fSign(ev.factorLiq),
        weight: 0.40,
        description: ev.descLiq || "нет данных",
      },
      {
        name: "📖 Стакан",
        score: fSign(ev.factorOb),
        weight: 0.30,
        description: ev.descOb || "нейтрально",
      },
      {
        name: "📊 CVD 4H",
        score: fSign(ev.factorCvd),
        weight: 0.30,
        description: ev.descCvd || "нет данных",
      },
    ];

    // Display-only: scalp and swing buffer states
    const scalpEv = this.lastEvals["scalp"];
    const swingEv = this.lastEvals["swing"];

    if (scalpEv) {
      const sv = (fSign(scalpEv.factorLiq) + fSign(scalpEv.factorOb) + fSign(scalpEv.factorCvd)) / 3;
      const lbl = sv > 0.1 ? "🟢 бычий" : sv < -0.1 ? "🔴 медвежий" : "⚪ нейтральный";
      components.push({
        name: "⚡ Scalp (15m CVD)",
        score: 0, weight: 0,
        description: `Лик:${scalpEv.factorLiq || "—"} ОБ:${scalpEv.factorOb || "—"} CVD:${scalpEv.factorCvd || "—"} → ${lbl}`,
      });
    }

    if (swingEv) {
      const sv = (fSign(swingEv.factorLiq) + fSign(swingEv.factorOb) + fSign(swingEv.factorCvd)) / 3;
      const lbl = sv > 0.1 ? "🟢 бычий" : sv < -0.1 ? "🔴 медвежий" : "⚪ нейтральный";
      components.push({
        name: "🌊 Swing (1D CVD)",
        score: 0, weight: 0,
        description: `Лик:${swingEv.factorLiq || "—"} ОБ:${swingEv.factorOb || "—"} CVD:${swingEv.factorCvd || "—"} → ${lbl}`,
      });
    }

    return {
      score,
      direction,
      confidence,
      components,
      gates,
      allGatesPassed: ev.shouldSignal,
      suggestedLeverage: snap.leverage,
      suggestedSl: snap.suggestedSl,
      suggestedTp: snap.suggestedTp,
      slValid: snap.slValid,
      tpValid: snap.tpValid,
      atrPct: snap.atrPct,
      vwap: snap.vwap,
      updatedAt: new Date(snap.ts).toISOString(),
      slSource: snap.slSource,
      tpSource: snap.tpSource,
    };
  }
}

export const signalEngine = new SignalEngine();
