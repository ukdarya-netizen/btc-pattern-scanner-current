import type { Direction } from "../config/profiles";
import { movePct } from "../lib/tradeMath";

export type TargetState = { price: number; fraction: number; hitAt: string | null };

export type PositionState = {
  direction: Direction;
  entryPrice: number;
  stopPrice: number;
  targets: TargetState[];
  remainingFraction: number;
  realizedPricePct: number;
  realizedExitNotional: number;
  breakevenMoved: boolean;
  breakevenAfterFirstTarget: boolean;
  mfePct: number;
  maePct: number;
  expiresAt: number;
  closed: boolean;
  closeReason: CloseReason | null;
  exitPrice: number | null;
};

export type CloseReason = "take_profit" | "stop" | "breakeven" | "timeout";

export type PositionEvent =
  | { kind: "target_hit"; index: number; price: number; at: number }
  | { kind: "breakeven_moved"; price: number; at: number }
  | { kind: "closed"; reason: CloseReason; price: number; at: number };

const EPS = 1e-12;

function crossed(direction: Direction, price: number, level: number, favourable: boolean): boolean {
  if (direction === "long") return favourable ? price >= level : price <= level;
  return favourable ? price <= level : price >= level;
}

function realize(state: PositionState, fraction: number, exitPrice: number): void {
  state.realizedPricePct += fraction * movePct(state.entryPrice, exitPrice, state.direction);
  state.realizedExitNotional += fraction * (exitPrice / state.entryPrice);
  state.remainingFraction = Math.max(0, state.remainingFraction - fraction);
}

function close(state: PositionState, reason: CloseReason, exitPrice: number, at: number,
  events: PositionEvent[]): void {
  if (state.remainingFraction > EPS) realize(state, state.remainingFraction, exitPrice);
  state.remainingFraction = 0;
  state.closed = true;
  state.closeReason = reason;
  state.exitPrice = exitPrice;
  events.push({ kind: "closed", reason, price: exitPrice, at });
}

function stopReason(state: PositionState): CloseReason {
  return state.breakevenMoved && Math.abs(state.stopPrice - state.entryPrice) < EPS
    ? "breakeven" : "stop";
}

function hitTargets(state: PositionState, reachPrice: number, at: number, events: PositionEvent[]): void {
  for (let i = 0; i < state.targets.length && !state.closed; i++) {
    const target = state.targets[i]!;
    if (target.hitAt !== null || !crossed(state.direction, reachPrice, target.price, true)) continue;
    target.hitAt = new Date(at).toISOString();
    events.push({ kind: "target_hit", index: i, price: target.price, at });
    const isLast = state.targets.every((t) => t.hitAt !== null);
    if (isLast) {
      close(state, "take_profit", target.price, at, events);
      return;
    }
    realize(state, target.fraction, target.price);
    if (state.breakevenAfterFirstTarget && !state.breakevenMoved) {
      state.breakevenMoved = true;
      state.stopPrice = state.entryPrice;
      events.push({ kind: "breakeven_moved", price: state.entryPrice, at });
    }
  }
}

function track(state: PositionState, favourable: number, adverse: number): void {
  state.mfePct = Math.max(state.mfePct, movePct(state.entryPrice, favourable, state.direction));
  state.maePct = Math.min(state.maePct, movePct(state.entryPrice, adverse, state.direction));
}

/**
 * One live trade price (a tick). Stop is checked before targets; at a single
 * price both cannot be true for a correctly ordered stop/target ladder.
 * A gap through the stop fills at the stop price (exchange stop-market model
 * is slightly worse; the observed price is kept in the event for audit).
 */
export function applyTick(state: PositionState, price: number, at: number): PositionEvent[] {
  const events: PositionEvent[] = [];
  if (state.closed || !(price > 0)) return events;
  track(state, price, price);
  if (crossed(state.direction, price, state.stopPrice, false)) {
    close(state, stopReason(state), state.stopPrice, at, events);
    return events;
  }
  hitTargets(state, price, at, events);
  if (!state.closed && at >= state.expiresAt) close(state, "timeout", price, at, events);
  return events;
}

/**
 * One closed candle (fallback when live ticks were unavailable). The order of
 * high and low inside a candle is unknown, so when the candle touches both the
 * stop and a target the stop is assumed first (conservative).
 */
export function applyCandle(
  state: PositionState,
  candle: { high: number; low: number; close: number; closeTime: number },
): PositionEvent[] {
  const events: PositionEvent[] = [];
  if (state.closed) return events;
  const favourable = state.direction === "long" ? candle.high : candle.low;
  const adverse = state.direction === "long" ? candle.low : candle.high;
  track(state, favourable, adverse);
  if (crossed(state.direction, adverse, state.stopPrice, false)) {
    close(state, stopReason(state), state.stopPrice, candle.closeTime, events);
    return events;
  }
  hitTargets(state, favourable, candle.closeTime, events);
  // A breakeven stop set inside this candle may already have been touched;
  // without intra-candle order this is resolved on the next candle/tick.
  if (!state.closed && candle.closeTime >= state.expiresAt) {
    close(state, "timeout", candle.close, candle.closeTime, events);
  }
  return events;
}
