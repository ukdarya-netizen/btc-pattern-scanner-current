import { logger } from "../lib/logger";

export type SignalType = "scalp" | "intraday" | "swing";
export type LiqSignal = "LONG" | "SHORT" | "";

export interface MarketSnapshot {
  ts: number;
  price: number;

  liqMapSignal: LiqSignal;
  liqMapZonePrice: number;
  liqMapZoneUsd: number;
  liqRealLongUsd: number;
  liqRealShortUsd: number;
  liqRealSignal: LiqSignal;

  obImbalance: number;
  obSignal: LiqSignal;

  cvdDelta: number;
  cvdSignal: LiqSignal;
  cvdDesc: string;

  suggestedSl: number;
  suggestedTp: number;
  slSource: string;
  tpSource: string;
  slValid: boolean;
  tpValid: boolean;
  leverage: number;
  atrPct: number;
  vwap: number;
}

export interface EvalResult {
  shouldSignal: boolean;
  direction: "LONG" | "SHORT" | "";
  factorLiq: LiqSignal;
  factorOb: LiqSignal;
  factorCvd: LiqSignal;
  descLiq: string;
  descOb: string;
  descCvd: string;
}

function emptyEval(): EvalResult {
  return { shouldSignal: false, direction: "", factorLiq: "", factorOb: "", factorCvd: "", descLiq: "", descOb: "", descCvd: "" };
}

export class SignalBuffer {
  last: MarketSnapshot | null = null;
  prev: MarketSnapshot | null = null;

  constructor(public readonly type: SignalType) {}

  update(snap: MarketSnapshot): void {
    this.prev = this.last;
    this.last = snap;
    logger.info({
      type: this.type,
      price: snap.price,
      liqMap: snap.liqMapSignal || "—",
      liqReal: snap.liqRealSignal || "—",
      ob: snap.obSignal || "—",
      obBid: `${(snap.obImbalance * 100).toFixed(1)}%`,
      cvd: snap.cvdSignal || "—",
    }, "Buffer updated");
  }

  evaluate(): EvalResult {
    const snap = this.last;
    if (!snap) return emptyEval();

    let factorLiq: LiqSignal = "";
    let descLiq = "";

    // Sweep absorption: longs swept (liqReal SHORT) while OB ≥75% bid + CVD LONG
    // = market is absorbing the cascade → reversal LONG (and vice versa for shorts)
    const longAbsorption  = snap.liqRealSignal === "SHORT" && snap.obImbalance >= 0.75 && snap.cvdSignal === "LONG";
    const shortAbsorption = snap.liqRealSignal === "LONG"  && snap.obImbalance <= 0.25 && snap.cvdSignal === "SHORT";

    if (longAbsorption) {
      factorLiq = "LONG";
      const totalLiq = (snap.liqRealLongUsd / 1_000_000).toFixed(1);
      descLiq = `💥 Абсорбция sweep: лонги ликв. $${totalLiq}M при bid ${(snap.obImbalance * 100).toFixed(1)}%`;
      logger.info({ type: this.type, liqReal: snap.liqRealSignal, obBid: snap.obImbalance }, "Buffer: sweep absorption → LONG");
    } else if (shortAbsorption) {
      factorLiq = "SHORT";
      const totalLiq = (snap.liqRealShortUsd / 1_000_000).toFixed(1);
      descLiq = `💥 Абсорбция sweep: шорты ликв. $${totalLiq}M при ask ${((1 - snap.obImbalance) * 100).toFixed(1)}%`;
      logger.info({ type: this.type, liqReal: snap.liqRealSignal, obBid: snap.obImbalance }, "Buffer: sweep absorption → SHORT");
    } else if (snap.liqMapSignal && snap.liqRealSignal && snap.liqMapSignal === snap.liqRealSignal) {
      factorLiq = snap.liqMapSignal;
      const dominant = factorLiq === "LONG" ? snap.liqRealShortUsd : snap.liqRealLongUsd;
      const zoneM = (snap.liqMapZoneUsd / 1_000_000).toFixed(1);
      const domM  = (dominant / 1_000_000).toFixed(1);
      descLiq = `💥 Зона $${zoneM}M @ $${snap.liqMapZonePrice.toFixed(0)} | реал. $${domM}M`;
    } else if (snap.liqRealSignal) {
      const total = snap.liqRealLongUsd + snap.liqRealShortUsd;
      factorLiq = snap.liqRealSignal;
      descLiq = `💥 Реальные ликвидации $${(total / 1_000_000).toFixed(1)}M`;
    }

    const factorOb = snap.obSignal;
    const descOb   = factorOb
      ? `📖 Bid ${(snap.obImbalance * 100).toFixed(1)}% — ${factorOb === "LONG" ? "покупатели" : "продавцы"}`
      : "";

    const factorCvd = snap.cvdSignal;
    const descCvd   = factorCvd ? snap.cvdDesc : "";

    // ── Primary gate: OB + CVD must both be present and agree ──────────────
    // These are real-time factors; liq map/real is slow/stale and acts only as a blocker.
    if (!factorOb || !factorCvd) {
      const why = !factorOb ? "OB нейтральный" : "CVD нейтральный";
      logger.info({ type: this.type, ob: factorOb || "—", cvd: factorCvd || "—" }, `Buffer: ${why} — no signal`);
      return { shouldSignal: false, direction: "", factorLiq, factorOb, factorCvd, descLiq, descOb, descCvd };
    }
    if (factorOb !== factorCvd) {
      logger.info({ type: this.type, factorOb, factorCvd }, "Buffer: OB/CVD disagree — no signal");
      return { shouldSignal: false, direction: "", factorLiq, factorOb, factorCvd, descLiq, descOb, descCvd };
    }

    const direction = factorOb as "LONG" | "SHORT";

    // ── Secondary gate: liq factor only BLOCKS if it actively opposes ──────
    if (factorLiq && factorLiq !== direction) {
      logger.info({ type: this.type, direction, factorLiq }, "Buffer: liq factor opposes OB+CVD — blocked");
      return { shouldSignal: false, direction: "", factorLiq, factorOb, factorCvd, descLiq, descOb, descCvd };
    }

    const confirmed = factorLiq === direction ? "3/3" : "2/3 OB+CVD";
    logger.info({ type: this.type, direction, confirmed }, "Buffer: signal fired!");
    return { shouldSignal: true, direction, factorLiq, factorOb, factorCvd, descLiq, descOb, descCvd };
  }

  reset(): void {
    this.last = null;
    this.prev = null;
  }
}
