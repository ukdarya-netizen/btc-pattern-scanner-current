/**
 * Ways to lead a Bitcoin MM trade in Lucy's Trading Bot (owner 2026-11-14), simulated on the signal's own entry,
 * stop and holding time over closed 15m candles — the virtual panel the owner reads in January before choosing.
 *   mm          — as Bitcoin MM: half at target 1 and the stop to entry, the rest at target 2;
 *   be1_take2   — stop to entry at +1%, everything at +2%;
 *   be1_take3   — stop to entry at +1%, everything at +3%;
 *   be1_q25     — at +1% a quarter and the stop to entry, then a quarter at +2%, +3%, +4%.
 * Conservative inside a candle: the stop (current level) is checked before any target of the same candle, and a
 * stop moved to entry works from the next candle. Fees: taker on entry and exit (2 × 0.05% of price).
 */
export type Side = "long" | "short";
export type Candle = { t: number; h: number; l: number; c: number };
export type Step = { pct?: number; price?: number; fraction: number; be?: boolean };
export type Ladder = { id: string; label: string; steps: (targets: Array<{ price: number; fraction: number }>) => Step[] };

export const FEE_PCT = 0.1;
export const LADDERS: Ladder[] = [
  { id: "mm", label: "Как Bitcoin MM: 50% на цели 1 и стоп в безубыток, остаток на цели 2",
    steps: (tg) => tg.map((t, i) => ({ price: t.price, fraction: t.fraction, be: i === 0 })) },
  { id: "be1_take2", label: "Безубыток после +1%, всё на +2%", steps: () => [{ pct: 1, fraction: 0, be: true }, { pct: 2, fraction: 1 }] },
  { id: "be1_take3", label: "Безубыток после +1%, всё на +3%", steps: () => [{ pct: 1, fraction: 0, be: true }, { pct: 3, fraction: 1 }] },
  { id: "be1_q25", label: "Безубыток после +1%, по 25% на +1%, +2%, +3%, +4%",
    steps: () => [{ pct: 1, fraction: 0.25, be: true }, { pct: 2, fraction: 0.25 }, { pct: 3, fraction: 0.25 }, { pct: 4, fraction: 0.25 }] },
];

export type SimResult = { done: boolean; pct: number; exit: "stop" | "breakeven" | "take" | "timeout" | null; beHit: boolean };

const move = (side: Side, entry: number, price: number) => ((price - entry) / entry) * 100 * (side === "long" ? 1 : -1);

export function simulate(p: {
  side: Side; entry: number; stop: number; startAt: number; endAt: number; candles: Candle[]; steps: Step[]; now: number;
}): SimResult {
  const dirn = p.side === "long" ? 1 : -1;
  const levels = p.steps
    .map((s) => ({ ...s, at: s.price ?? p.entry * (1 + dirn * (s.pct ?? 0) / 100) }))
    .sort((a, b) => dirn * (a.at - b.at));
  let stop = p.stop, rest = 1, realized = 0, next = 0, beMoved = false;
  const finish = (exit: SimResult["exit"], price: number): SimResult => {
    realized += rest * move(p.side, p.entry, price);
    return { done: true, pct: realized - FEE_PCT, exit, beHit: beMoved };
  };
  for (const k of p.candles) {
    if (k.t < p.startAt) continue;
    if (k.t >= p.endAt) return finish("timeout", k.c); // first candle past the holding time: closed at its open ≈ last close
    const adverse = p.side === "long" ? k.l : k.h;
    if (dirn * (adverse - stop) <= 0) return finish(beMoved && Math.abs(stop - p.entry) < 1e-9 ? "breakeven" : "stop", stop);
    const favorable = p.side === "long" ? k.h : k.l;
    let moveBe = false;
    while (next < levels.length && dirn * (favorable - levels[next]!.at) >= 0) {
      const lv = levels[next]!;
      const share = next === levels.length - 1 ? rest : Math.min(lv.fraction, rest);
      realized += share * move(p.side, p.entry, lv.at);
      rest -= share;
      if (lv.be) moveBe = true;
      next += 1;
      if (rest <= 1e-9) return { done: true, pct: realized - FEE_PCT, exit: "take", beHit: beMoved };
    }
    if (moveBe && !beMoved) { beMoved = true; if (dirn * (p.entry - stop) > 0) stop = p.entry; }
  }
  if (p.now >= p.endAt && p.candles.length) return finish("timeout", p.candles.at(-1)!.c);
  return { done: false, pct: realized, exit: null, beHit: beMoved };
}

/** Pattern families of the template (owner 2026-11-14): one row per family and side in Lucy's bot. */
export const FAMILIES: Array<{ id: string; label: string; match: RegExp }> = [
  { id: "range_1d", label: "Диапазон 1D", match: /^d1_(breakout|deviation)_/ },
  { id: "levels_1d", label: "Уровни 1D", match: /^neon_.*_1d_/ },
  { id: "smc_4h", label: "Smart Money 4h", match: /^smc_4h_/ },
  { id: "smc_1d", label: "Smart Money 1D", match: /^smc_1d_/ },
  { id: "cascade", label: "Каскад ликвидаций", match: /^lc_/ },
];
export const familyOf = (patternKey: string) => FAMILIES.find((f) => f.match.test(patternKey))?.id ?? null;
