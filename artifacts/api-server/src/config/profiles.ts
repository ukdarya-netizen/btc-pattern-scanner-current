/**
 * BTC trade types (owner, 2026-10-25): only the 4h and 1d timeframes, signals
 * from the Auto Range Detector (breakout / deviation) with volume and flow
 * confirmation. Stop and targets come from the range itself; the defaults
 * below are only a fallback and the liquidation guard always applies.
 */
export type ProfileKey = "h4" | "d1";
export type Direction = "long" | "short";

export type TargetSpec = { pct: number; fraction: number };

export type TradeProfile = {
  key: ProfileKey;
  label: string;
  leverage: number;
  /** Candle timeframe the profile's patterns are evaluated on. */
  timeframe: "4h" | "1d";
  defaultStopPct: number;
  defaultTargets: TargetSpec[];
  /** Move the stop to entry once the first target is hit. */
  breakevenAfterFirstTarget: boolean;
  maxHoldMs: number;
};

const H = 60 * 60 * 1000;
const D = 24 * H;

export const PROFILES: Record<ProfileKey, TradeProfile> = {
  h4: {
    key: "h4",
    label: "4 часа",
    // Liquidation at ~4.6% → largest allowed stop ~3.7%; a 4h range stop
    // (midpoint or swept extreme) is normally 0.7–2.5%.
    leverage: 20,
    timeframe: "4h",
    defaultStopPct: 2.0,
    defaultTargets: [
      { pct: 2.0, fraction: 0.5 },
      { pct: 4.0, fraction: 0.5 },
    ],
    breakevenAfterFirstTarget: true,
    maxHoldMs: 10 * D,
  },
  d1: {
    key: "d1",
    label: "1 день",
    // Liquidation at ~9.6% → largest allowed stop ~7.7%; daily ranges are wide.
    leverage: 10,
    timeframe: "1d",
    defaultStopPct: 4.0,
    defaultTargets: [
      { pct: 4.0, fraction: 0.5 },
      { pct: 8.0, fraction: 0.5 },
    ],
    breakevenAfterFirstTarget: true,
    maxHoldMs: 45 * D,
  },
};

/**
 * BingX BTC-USDT first-tier maintenance margin rate (isolated). Verify on the
 * exchange's risk-limit page; a higher value only makes the guard stricter.
 */
export const BTC_MAINTENANCE_MARGIN_RATE = 0.004;
/** Taker fee per side, as a fraction of notional. */
export const TAKER_FEE_RATE = 0.0005;
/** A stop must sit inside this share of the distance to liquidation. */
export const MAX_STOP_SHARE_OF_LIQUIDATION = 0.8;
