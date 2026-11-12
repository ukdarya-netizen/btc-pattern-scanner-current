/**
 * ABNeon levels for BTC — ported 1:1 from CAB (stealth-abneon-detectors.ts, computeSupportZones / wilderAtr): pivot
 * highs and lows of 6 bars on the last 600 closed 4H candles, clustered in bins of 0.35 × ATR(14), the 6 strongest
 * clusters (suppression gap 1.2 × ATR), the same zones the owner's "Lucy's ABNeon" indicator draws.
 * And Lucy's VSA colour (owner's indicator): Welkin over 20 bars (population σ), grey under the 120-bar average.
 */
export type ZoneCandle = { time: number; open: number; high: number; low: number; close: number };
export type Zone = { center: number; top: number; bottom: number; count: number };

const SR_PIVOT_LENGTH = 6;
const SR_LOOKBACK = 600;
const SR_BIN_ATR = 0.35;
const SR_GAP_ATR = 1.2;
const SR_MAX_ZONES = 6;
const ATR_PERIOD = 14;

export function wilderAtr(candles: readonly ZoneCandle[]): number | null {
  if (candles.length <= ATR_PERIOD) return null;
  const tr = candles.map((c, i) =>
    i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1]!.close), Math.abs(c.low - candles[i - 1]!.close)));
  let atr = tr.slice(0, ATR_PERIOD).reduce((a, b) => a + b, 0) / ATR_PERIOD;
  for (let i = ATR_PERIOD; i < tr.length; i++) atr = (atr * (ATR_PERIOD - 1) + tr[i]!) / ATR_PERIOD;
  return atr > 0 && Number.isFinite(atr) ? atr : null;
}

export function computeZones(candles: readonly ZoneCandle[]): Zone[] {
  const n = candles.length;
  const atr = wilderAtr(candles);
  if (atr === null || n < 2 * SR_PIVOT_LENGTH + 1) return [];
  const prices: number[] = [];
  const first = Math.max(SR_PIVOT_LENGTH, n - 1 - SR_LOOKBACK);
  for (let i = first; i + SR_PIVOT_LENGTH < n; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - SR_PIVOT_LENGTH; j <= i + SR_PIVOT_LENGTH; j++) {
      if (j === i) continue;
      const c = candles[j]!, left = j < i;
      if (left ? c.high >= candles[i]!.high : c.high > candles[i]!.high) isHigh = false;
      if (left ? c.low <= candles[i]!.low : c.low < candles[i]!.low) isLow = false;
    }
    if (isHigh) prices.push(candles[i]!.high);
    if (isLow) prices.push(candles[i]!.low);
  }
  if (prices.length === 0) return [];
  const gLow = Math.min(...prices), gHigh = Math.max(...prices);
  const binW = Math.max(atr * SR_BIN_ATR, candles[n - 1]!.close * 1e-8);
  const nb = Math.min(400, Math.max(1, Math.ceil((gHigh - gLow) / binW) + 1));
  const counts = Array.from({ length: nb }, () => 0);
  for (const px of prices) counts[Math.min(nb - 1, Math.max(0, Math.floor((px - gLow) / binW)))]! += 1;
  const gapBins = Math.max(1, Math.ceil((atr * SR_GAP_ATR) / binW));
  const zones: Zone[] = [];
  for (let picks = 0; picks < SR_MAX_ZONES; picks++) {
    const mx = Math.max(...counts);
    if (mx <= 0) break;
    const best = counts.indexOf(mx);
    const lo = gLow + (best - 1) * binW, hi = gLow + (best + 2) * binW;
    let inCluster = prices.filter((px) => px >= lo && px < hi);
    let bestNeighbour = -1, neighbourCount = 0;
    for (let b = Math.max(0, best - gapBins); b <= Math.min(nb - 1, best + gapBins); b++) {
      if (Math.abs(b - best) < 3 || counts[b]! <= 0) continue;
      if (counts[b]! > neighbourCount) { neighbourCount = counts[b]!; bestNeighbour = b; }
    }
    if (bestNeighbour >= 0) {
      const nLo = gLow + (bestNeighbour - 1) * binW, nHi = gLow + (bestNeighbour + 2) * binW;
      const neighbour = prices.filter((px) => px >= nLo && px < nHi && !(px >= lo && px < hi));
      if (neighbour.length === inCluster.length) inCluster = [...inCluster, ...neighbour];
    }
    if (inCluster.length > 0) {
      const center = inCluster.reduce((a, b) => a + b, 0) / inCluster.length;
      zones.push({ center, top: Math.max(Math.max(...inCluster), center + binW / 2), bottom: Math.min(Math.min(...inCluster), center - binW / 2), count: inCluster.length });
    }
    for (let b = Math.max(0, best - gapBins); b <= Math.min(nb - 1, best + gapBins); b++) counts[b] = -1;
  }
  return zones;
}

/** Lucy's VSA colour of bar j: W > avg+4σ, M > +3σ, O > +2σ, A > avg, Y ≥ 1.25× previous, else N; N under the 120-bar average. */
export function lucyColour(vol: readonly number[], j: number): string | null {
  if (j < 119) return null;
  for (let q = j - 119; q <= j; q++) if (!(vol[q]! > 0)) return null;
  let s120 = 0;
  for (let q = j - 119; q <= j; q++) s120 += vol[q]!;
  const v = vol[j]!;
  if (v < s120 / 120) return "N";
  let s = 0;
  for (let q = j - 19; q <= j; q++) s += vol[q]!;
  const avg = s / 20;
  let v2 = 0;
  for (let q = j - 19; q <= j; q++) v2 += (vol[q]! - avg) ** 2;
  const sd = Math.sqrt(v2 / 20);
  if (v > avg + 4 * sd) return "W";
  if (v > avg + 3 * sd) return "M";
  if (v > avg + 2 * sd) return "O";
  if (v > avg) return "A";
  const prev = vol[j - 1]!;
  if (prev > 0 && v / prev >= 1.25) return "Y";
  return "N";
}
