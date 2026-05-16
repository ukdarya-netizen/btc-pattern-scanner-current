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

    if (snap.liqMapSignal && snap.liqRealSignal && snap.liqMapSignal === snap.liqRealSignal) {
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

    const factors: LiqSignal[] = [factorLiq, factorOb, factorCvd];
    const present = factors.filter(Boolean) as Array<"LONG" | "SHORT">;

    if (present.length < 3) {
      return { shouldSignal: false, direction: "", factorLiq, factorOb, factorCvd, descLiq, descOb, descCvd };
    }

    const longVotes  = present.filter(f => f === "LONG").length;
    const shortVotes = present.filter(f => f === "SHORT").length;

    if (longVotes === 3) {
      logger.info({ type: this.type }, "Buffer: ALL 3 LONG — signal!");
      return { shouldSignal: true, direction: "LONG",  factorLiq, factorOb, factorCvd, descLiq, descOb, descCvd };
    }
    if (shortVotes === 3) {
      logger.info({ type: this.type }, "Buffer: ALL 3 SHORT — signal!");
      return { shouldSignal: true, direction: "SHORT", factorLiq, factorOb, factorCvd, descLiq, descOb, descCvd };
    }

    logger.info({ type: this.type, factorLiq, factorOb, factorCvd }, "Buffer: contradiction, no signal");
    return { shouldSignal: false, direction: "", factorLiq, factorOb, factorCvd, descLiq, descOb, descCvd };
  }

  reset(): void {
    this.last = null;
    this.prev = null;
  }
}
