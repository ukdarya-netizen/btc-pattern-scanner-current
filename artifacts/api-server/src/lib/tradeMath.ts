import {
  BTC_MAINTENANCE_MARGIN_RATE,
  MAX_STOP_SHARE_OF_LIQUIDATION,
  TAKER_FEE_RATE,
  type Direction,
  type TargetSpec,
} from "../config/profiles";

export const sign = (direction: Direction): 1 | -1 => (direction === "long" ? 1 : -1);

/** Isolated-margin liquidation price (fees ignored, conservative MMR). */
export function liquidationPrice(entry: number, leverage: number, direction: Direction): number {
  const distance = 1 / leverage - BTC_MAINTENANCE_MARGIN_RATE;
  if (!(distance > 0)) throw new RangeError(`leverage ${leverage} leaves no margin above maintenance`);
  return direction === "long" ? entry * (1 - distance) : entry * (1 + distance);
}

/** Distance from entry to liquidation in price %. */
export function liquidationDistancePct(leverage: number): number {
  return (1 / leverage - BTC_MAINTENANCE_MARGIN_RATE) * 100;
}

/** Largest stop % allowed for a leverage (stop must trigger well before liquidation). */
export function maxStopPct(leverage: number): number {
  return liquidationDistancePct(leverage) * MAX_STOP_SHARE_OF_LIQUIDATION;
}

export function stopPriceFor(entry: number, stopPct: number, direction: Direction): number {
  return direction === "long" ? entry * (1 - stopPct / 100) : entry * (1 + stopPct / 100);
}

export function targetPricesFor(
  entry: number,
  targets: readonly TargetSpec[],
  direction: Direction,
): { price: number; fraction: number; hitAt: string | null }[] {
  const total = targets.reduce((sum, t) => sum + t.fraction, 0);
  if (Math.abs(total - 1) > 1e-9) throw new RangeError("target fractions must sum to 1");
  return [...targets]
    .sort((a, b) => a.pct - b.pct)
    .map((t) => ({
      price: direction === "long" ? entry * (1 + t.pct / 100) : entry * (1 - t.pct / 100),
      fraction: t.fraction,
      hitAt: null,
    }));
}

/** Signed price move in % (positive = in the trade's favour). */
export function movePct(entry: number, price: number, direction: Direction): number {
  return (sign(direction) * (price - entry) / entry) * 100;
}

/**
 * Net result on margin, in %: levered price result minus taker fees on entry
 * notional and on each exit notional.
 *   realizedPricePct     = Σ fraction_i × move_i (%)
 *   realizedExitNotional = Σ fraction_i × exit_i / entry
 */
export function marginPnlPct(
  realizedPricePct: number,
  realizedExitNotional: number,
  leverage: number,
  feeRate = TAKER_FEE_RATE,
): number {
  const feesPct = feeRate * (1 + realizedExitNotional) * 100;
  return leverage * (realizedPricePct - feesPct);
}
