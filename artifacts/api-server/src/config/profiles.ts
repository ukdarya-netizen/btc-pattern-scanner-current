/**
 * Three BTC trade types. Stops/targets here are PROVISIONAL defaults until
 * the BTC history analysis calibrates them; every pattern may override stop
 * and targets, but never beyond the liquidation safety limit below.
 */
export type ProfileKey = "scalp" | "intraday" | "swing";
export type Direction = "long" | "short";

export type TargetSpec = { pct: number; fraction: number };

export type TradeProfile = {
  key: ProfileKey;
  label: string;
  leverage: number;
  /** Candle timeframe the profile's patterns are evaluated on. */
  timeframe: "5m" | "15m" | "1h";
  defaultStopPct: number;
  defaultTargets: TargetSpec[];
  /** Move the stop to entry once the first target is hit. */
  breakevenAfterFirstTarget: boolean;
  maxHoldMs: number;
};

const H = 60 * 60 * 1000;

export const PROFILES: Record<ProfileKey, TradeProfile> = {
  scalp: {
    key: "scalp",
    label: "Скальп",
    leverage: 100,
    timeframe: "5m",
    defaultStopPct: 0.35,
    defaultTargets: [
      { pct: 0.35, fraction: 0.5 },
      { pct: 0.7, fraction: 0.5 },
    ],
    breakevenAfterFirstTarget: true,
    maxHoldMs: 2 * H,
  },
  intraday: {
    key: "intraday",
    label: "Интрадей",
    leverage: 50,
    timeframe: "15m",
    defaultStopPct: 1.0,
    defaultTargets: [
      { pct: 1.0, fraction: 0.5 },
      { pct: 2.0, fraction: 0.5 },
    ],
    breakevenAfterFirstTarget: true,
    maxHoldMs: 24 * H,
  },
  swing: {
    key: "swing",
    label: "Среднесрок",
    leverage: 25,
    timeframe: "1h",
    defaultStopPct: 2.5,
    defaultTargets: [
      { pct: 2.5, fraction: 0.5 },
      { pct: 5.0, fraction: 0.5 },
    ],
    breakevenAfterFirstTarget: true,
    maxHoldMs: 7 * 24 * H,
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
