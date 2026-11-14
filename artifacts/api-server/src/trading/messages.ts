/** Bitcoin MM → Lucy's Trading Bot: the messages of a signal (pure, no database). See relay.ts. */
export const SOURCE = "BitcoinMarginMaster";
export const RULES_VERSION = "btc-mm-v1";
export const sourceSignalId = (id: number) => `btc-signal-${id}`;
export function decimal(x: number): string {
  if (!Number.isFinite(x) || x <= 0) throw new Error("bad_price");
  const v = Number(x.toPrecision(12));
  const s = String(v);
  return /e/i.test(s) ? v.toFixed(20).replace(/0+$/, "").replace(/\.$/, "") : s;
}

export type SignalRow = {
  id: number; pattern_key: string; direction: "long" | "short"; profile: string; leverage: number;
  entry_price: number; initial_stop_price: number; targets: Array<{ price: number; fraction: number }>;
  detected_at: Date; expires_at: Date;
};
export type EventRow = { id: number; kind: string; price: number | null; detail: Record<string, unknown>; created_at: Date };
export type Message = { kind: "signal" | "command"; id: string; payload: Record<string, unknown> };

const closeReason = (r: unknown) =>
  r === "take_profit" ? "profit" : r === "breakeven" ? "breakeven_stop" : r === "timeout" ? "expired" : "stop_loss";

/** Every message of one signal, in order, from its events (deterministic: the same events give the same list). */
export function messagesOf(s: SignalRow, events: EventRow[]): Message[] {
  const opened = events.find((e) => e.kind === "opened");
  if (!opened) return [];
  const out: Message[] = [{
    kind: "signal", id: sourceSignalId(s.id),
    payload: {
      sourceSignalId: sourceSignalId(s.id), source: SOURCE, rulesVersion: RULES_VERSION, confirmationStatus: "confirmed",
      symbol: "BTCUSDT", side: s.direction, patternId: s.pattern_key, setup: s.pattern_key, profile: s.profile,
      signalAt: s.detected_at.toISOString(), releasedAt: opened.created_at.toISOString(),
      entryPrice: decimal(s.entry_price), stopLoss: decimal(s.initial_stop_price), leverage: s.leverage,
      // How Bitcoin MM manages the trade; every step also arrives as a command.
      exitRules: {
        noFixedTakeProfit: false,
        takeProfits: s.targets.map((t) => ({ price: decimal(t.price), closeFractionOfInitial: t.fraction })),
        breakevenAfterFirstTake: true,
        maxHoldHours: Math.round((s.expires_at.getTime() - s.detected_at.getTime()) / 3_600_000),
        stopsFollowSourceCommands: true,
      },
    },
  }];
  let seq = 0;
  const cmd = (at: unknown, body: Record<string, unknown>) => {
    seq += 1;
    const commandId = `btc-${s.id}-${seq}`;
    out.push({ kind: "command", id: commandId, payload: {
      commandId, sourceSignalId: sourceSignalId(s.id), symbol: "BTCUSDT", sequence: seq,
      occurredAt: new Date(typeof at === "number" ? at : Date.now()).toISOString(), ...body,
    } });
  };
  const sorted = [...events].sort((a, b) => a.id - b.id);
  const closedEv = sorted.find((e) => e.kind === "closed");
  for (const e of sorted) {
    if (e.kind === "target_hit") {
      const index = Number(e.detail.index);
      const target = s.targets[index];
      // The last target closes the rest: that is the `closed` event's command.
      if (!target || (closedEv && index === s.targets.length - 1)) continue;
      cmd(e.detail.at, { type: "close", reason: "profit", partial: true, closeFractionOfInitial: target.fraction, ...(e.price ? { exitPrice: decimal(e.price) } : {}) });
      if (e.detail.breakevenMoved === true) cmd(e.detail.at, { type: "move_stop", reason: "breakeven", stopPrice: decimal(s.entry_price) });
    } else if (e.kind === "closed") {
      cmd(e.detail.at, { type: "close", reason: closeReason(e.detail.reason), ...(e.price ? { exitPrice: decimal(e.price) } : {}) });
    }
  }
  return out;
}


export type Receipt = "delivered" | "quarantined" | "retry";
export function classifyReceipt(kind: "signal" | "command", status: number, body: unknown, messageId: string): Receipt {
  const b = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : null;
  if (kind === "command") {
    if (b && b.stored === true && b.commandId === messageId && [200, 201, 202, 409].includes(status)) return "delivered";
  } else if ((status >= 200 && status < 300) || status === 409) return "delivered";
  if (status === 400 || status === 422) return "quarantined";
  return "retry";
}
const MAX_BACKOFF_MS = 10 * 60_000;
export const backoffMs = (attempts: number) => Math.min(30_000 * 2 ** Math.min(Math.max(attempts, 1) - 1, 10), MAX_BACKOFF_MS);

