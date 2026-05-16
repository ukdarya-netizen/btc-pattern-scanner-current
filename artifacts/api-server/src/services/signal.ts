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
const MIN_TP_DISTANCE_PCT = 0.015;
const MIN_RR_RATIO        = 1.2;
const TP_CLUSTER_BUFFER   = 0.001;

const LIQ_MAP_ZONE_RANGE  = 0.03;  // ±3% of price
const LIQ_MAP_MIN_USD     = 5_000_000;
const OB_RANGE_PCT        = 0.005; // ±0.5%
const OB_LONG_THRESHOLD   = 0.58;
const OB_SHORT_THRESHOLD  = 0.42;

const LIQ_THRESHOLDS: Record<SignalType, number> = {
  scalp:    500_000,
  intraday: 2_000_000,
  swing:    10_000_000,
};

const SCAN_INTERVAL_MS = 15 * 60 * 1000; // scan every 15 min for all types

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
      .sort((a, b) => a.price - b.price);
    const cluster = candidates[0];
    if (!cluster) return invalid;
    const tpPrice = cluster.price * (1 - TP_CLUSTER_BUFFER);
    const distancePct = (tpPrice - price) / price;
    const rr = distancePct / slDistancePct;
    if (distancePct < MIN_TP_DISTANCE_PCT) return { price: tpPrice, source: "TP кластер слишком близко", valid: false, clusterUsd: cluster.shortLiqUsd, distancePct, rr };
    if (rr < MIN_RR_RATIO) return { price: tpPrice, source: `R:R ${rr.toFixed(2)} < ${MIN_RR_RATIO}`, valid: false, clusterUsd: cluster.shortLiqUsd, distancePct, rr };
    return { price: parseFloat(tpPrice.toFixed(2)), source: `Кластер шортов $${cluster.price.toFixed(0)} (${(cluster.shortLiqUsd / 1e6).toFixed(1)}M) | R:R ${rr.toFixed(2)}`, valid: true, clusterUsd: cluster.shortLiqUsd, distancePct, rr };
  } else {
    const candidates = buckets
      .filter(b => b.price < price && b.price >= price * (1 - MAX_TP_RANGE_PCT) && b.longLiqUsd >= MIN_TP_CLUSTER_USD)
      .sort((a, b) => b.price - a.price);
    const cluster = candidates[0];
    if (!cluster) return invalid;
    const tpPrice = cluster.price * (1 + TP_CLUSTER_BUFFER);
    const distancePct = (price - tpPrice) / price;
    const rr = distancePct / slDistancePct;
    if (distancePct < MIN_TP_DISTANCE_PCT) return { price: tpPrice, source: "TP кластер слишком близко", valid: false, clusterUsd: cluster.longLiqUsd, distancePct, rr };
    if (rr < MIN_RR_RATIO) return { price: tpPrice, source: `R:R ${rr.toFixed(2)} < ${MIN_RR_RATIO}`, valid: false, clusterUsd: cluster.longLiqUsd, distancePct, rr };
    return { price: parseFloat(tpPrice.toFixed(2)), source: `Кластер лонгов $${cluster.price.toFixed(0)} (${(cluster.longLiqUsd / 1e6).toFixed(1)}M) | R:R ${rr.toFixed(2)}`, valid: true, clusterUsd: cluster.longLiqUsd, distancePct, rr };
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
function getLiqMapSignal(price: number): { signal: LiqSignal; zonePrice: number; zoneUsd: number } {
  const buckets = getLiqBuckets();
  if (buckets.length === 0 || price === 0) return { signal: "", zonePrice: 0, zoneUsd: 0 };

  const lower = price * (1 - LIQ_MAP_ZONE_RANGE);
  const upper = price * (1 + LIQ_MAP_ZONE_RANGE);
  const nearby = buckets.filter(b => b.price >= lower && b.price <= upper);
  if (nearby.length === 0) return { signal: "", zonePrice: 0, zoneUsd: 0 };

  const totalShort = nearby.reduce((s, b) => s + b.shortLiqUsd, 0);
  const totalLong  = nearby.reduce((s, b) => s + b.longLiqUsd,  0);

  if (totalShort > totalLong && totalShort > LIQ_MAP_MIN_USD) {
    const best = [...nearby].sort((a, b) => b.shortLiqUsd - a.shortLiqUsd)[0]!;
    return { signal: "LONG", zonePrice: best.price, zoneUsd: best.shortLiqUsd };
  }
  if (totalLong > totalShort && totalLong > LIQ_MAP_MIN_USD) {
    const best = [...nearby].sort((a, b) => b.longLiqUsd - a.longLiqUsd)[0]!;
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
function getObSignal(price: number): { imbalance: number; signal: LiqSignal } {
  const ob = aggregator.getAggregatedOrderbook();
  if (!ob || price === 0) return { imbalance: 0.5, signal: "" };

  const lower = price * (1 - OB_RANGE_PCT);
  const upper = price * (1 + OB_RANGE_PCT);

  const bidVol = ob.mergedBids.filter(l => l.price >= lower && l.price <= price).reduce((s, l) => s + l.size * l.price, 0);
  const askVol = ob.mergedAsks.filter(l => l.price >= price && l.price <= upper).reduce((s, l) => s + l.size * l.price, 0);

  const total = bidVol + askVol;
  if (total === 0) return { imbalance: 0.5, signal: "" };

  const imbalance = bidVol / total;
  const signal: LiqSignal =
    imbalance > OB_LONG_THRESHOLD  ? "LONG"  :
    imbalance < OB_SHORT_THRESHOLD ? "SHORT" : "";

  return { imbalance, signal };
}

// ─── Factor: CVD per timeframe ────────────────────────────────
function getCvdSignal(type: SignalType): { delta: number; signal: LiqSignal; desc: string } {
  const arrow = (s: LiqSignal) => s === "LONG" ? "бычий" : s === "SHORT" ? "медвежий" : "нейтральный";

  if (type === "scalp") {
    const trend = cvdService.getTrend15m();
    const cvd   = cvdService.getCurrentCvd();
    const signal: LiqSignal = trend === "bullish" ? "LONG" : trend === "bearish" ? "SHORT" : "";
    const sign = cvd >= 0 ? "+" : "";
    return { delta: cvd, signal, desc: `📊 CVD 15m: δ${sign}${cvd.toFixed(2)} — ${arrow(signal)}` };
  }

  if (type === "intraday") {
    const r = taService.getCvdTrend("4h");
    const signal: LiqSignal = r.trend === "bullish" ? "LONG" : r.trend === "bearish" ? "SHORT" : "";
    return { delta: r.delta, signal, desc: `📊 CVD 4H: ${r.description} — ${arrow(signal)}` };
  }

  // swing
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

      cvdDelta:  cvd.delta,
      cvdSignal: cvd.signal,
      cvdDesc:   cvd.desc,

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
