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

  // V4 cross-exchange data (display + signal enhancement)
  netflowNet15m: number;
  netflowNet1h: number;
  netflowRatio15m: number;
  netflowSignal: LiqSignal;
  cgObImbalance: number;
  cgObSignal: LiqSignal;

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
  // Confirmation tracking
  confirmationCount: number;    // 0 = no direction, 1 = 1 scan, 2 = fired
  pendingDirection: "LONG" | "SHORT" | "";  // direction accumulating in prev
  confirmationReason?: string;  // why we're waiting
}

function emptyEval(): EvalResult {
  return {
    shouldSignal: false, direction: "", factorLiq: "", factorOb: "", factorCvd: "",
    descLiq: "", descOb: "", descCvd: "",
    confirmationCount: 0, pendingDirection: "", confirmationReason: undefined,
  };
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
    if (!factorOb || !factorCvd) {
      const why = !factorOb ? "OB нейтральный" : "CVD нейтральный";
      logger.info({ type: this.type, ob: factorOb || "—", cvd: factorCvd || "—" }, `Buffer: ${why} — no signal`);
      return { shouldSignal: false, direction: "", factorLiq, factorOb, factorCvd, descLiq, descOb, descCvd, confirmationCount: 0, pendingDirection: "", confirmationReason: why };
    }
    if (factorOb !== factorCvd) {
      logger.info({ type: this.type, factorOb, factorCvd }, "Buffer: OB/CVD disagree — no signal");
      return { shouldSignal: false, direction: "", factorLiq, factorOb, factorCvd, descLiq, descOb, descCvd, confirmationCount: 0, pendingDirection: "", confirmationReason: `OB=${factorOb} CVD=${factorCvd} расходятся` };
    }

    const direction = factorOb as "LONG" | "SHORT";

    // ── Secondary gate: liq factor only BLOCKS if it actively opposes ──────
    if (factorLiq && factorLiq !== direction) {
      logger.info({ type: this.type, direction, factorLiq }, "Buffer: liq factor opposes OB+CVD — blocked");
      return { shouldSignal: false, direction: "", factorLiq, factorOb, factorCvd, descLiq, descOb, descCvd, confirmationCount: 0, pendingDirection: direction, confirmationReason: `liq=${factorLiq} блокирует ${direction}` };
    }

    // ── Momentum gate: require prev scan to also agree (2 consecutive scans) ─
    // This confirms sustained taker flow (~10 min) rather than a single spike.
    // NOT a time cooldown — both OB and CVD in prev must agree with current direction.
    // After reset() (on signal fire), prev=null → forces 2 fresh scans before next signal.
    if (!this.prev) {
      // First scan after reset — accumulate, don't fire yet
      logger.info({ type: this.type, direction }, "Buffer: 1st scan accumulated — awaiting 2nd confirmation scan");
      return {
        shouldSignal: false, direction: "", factorLiq, factorOb, factorCvd, descLiq, descOb, descCvd,
        confirmationCount: 1, pendingDirection: direction,
        confirmationReason: "1/2 сканов — ожидание подтверждения",
      };
    }

    const prevOb  = this.prev.obSignal;
    const prevCvd = this.prev.cvdSignal;
    const prevAgreesOb  = prevOb  === direction;
    const prevAgreesCvd = prevCvd === direction;

    if (!prevAgreesOb || !prevAgreesCvd) {
      // Previous scan didn't sustain the same direction — still accumulating
      const why = !prevAgreesOb
        ? `prev OB=${prevOb || "—"} (нужен ${direction})`
        : `prev CVD=${prevCvd || "—"} (нужен ${direction})`;
      logger.info({ type: this.type, direction, why }, "Buffer: prev scan didn't confirm — waiting for sustained flow");
      return {
        shouldSignal: false, direction: "", factorLiq, factorOb, factorCvd, descLiq, descOb, descCvd,
        confirmationCount: 1, pendingDirection: direction,
        confirmationReason: `1/2 сканов: ${why}`,
      };
    }

    // Both current AND previous scans agree on OB+CVD → sustained taker flow confirmed
    const confirmed = factorLiq === direction ? "3/3 (2 скана)" : "OB+CVD (2 скана)";
    logger.info({ type: this.type, direction, confirmed }, "Buffer: signal fired! (2-scan momentum confirmed)");
    return {
      shouldSignal: true, direction, factorLiq, factorOb, factorCvd, descLiq, descOb, descCvd,
      confirmationCount: 2, pendingDirection: direction, confirmationReason: undefined,
    };
  }

  reset(): void {
    this.last = null;
    this.prev = null;
  }

  /** Returns current pending accumulation state (for debug display) */
  getPendingState(): { direction: "LONG" | "SHORT" | ""; count: number } {
    if (!this.last) return { direction: "", count: 0 };
    const ob  = this.last.obSignal;
    const cvd = this.last.cvdSignal;
    if (ob && cvd && ob === cvd) {
      const dir = ob as "LONG" | "SHORT";
      const hasPrevConfirm = this.prev
        ? this.prev.obSignal === dir && this.prev.cvdSignal === dir
        : false;
      return { direction: dir, count: hasPrevConfirm ? 2 : 1 };
    }
    return { direction: "", count: 0 };
  }
}
