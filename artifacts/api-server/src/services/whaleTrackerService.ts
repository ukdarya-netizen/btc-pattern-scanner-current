import { aggregator } from "./exchanges/aggregator";

const WHALE_MIN_NOTIONAL_USD = 300_000; // single trade >= $300k counts as whale
const WHALE_WINDOW_MS        = 120_000; // look back 2 minutes
const WHALE_REQUIRED_USD     = 300_000; // total directional whale volume to pass gate

export interface WhaleTrackResult {
  pass: boolean;
  reason: string;
  whaleBuyUsd: number;
  whaleSellUsd: number;
}

export function checkWhaleActivity(direction: "long" | "short"): WhaleTrackResult {
  const trades = aggregator.getPrimaryTrades();

  if (trades.length === 0) {
    return { pass: true, reason: "нет данных сделок (пропуск)", whaleBuyUsd: 0, whaleSellUsd: 0 };
  }

  const cutoff = Date.now() - WHALE_WINDOW_MS;
  const recent = trades.filter(t => t.timestamp >= cutoff);

  let whaleBuyUsd  = 0;
  let whaleSellUsd = 0;

  for (const t of recent) {
    const notional = t.price * t.size;
    if (notional < WHALE_MIN_NOTIONAL_USD) continue;
    if (t.side === "buy")  whaleBuyUsd  += notional;
    else                   whaleSellUsd += notional;
  }

  const dirWhale = direction === "long" ? whaleBuyUsd : whaleSellUsd;
  const oppWhale = direction === "long" ? whaleSellUsd : whaleBuyUsd;

  if (dirWhale < WHALE_REQUIRED_USD) {
    const label = direction === "long" ? "покупок" : "продаж";
    const opp   = direction === "long" ? "продаж" : "покупок";
    const reason = oppWhale > dirWhale * 2
      ? `Киты против позиции: $${(oppWhale / 1_000).toFixed(0)}K ${opp} vs $${(dirWhale / 1_000).toFixed(0)}K ${label}`
      : `Нет крупных ${label} за 2м ($${(dirWhale / 1_000).toFixed(0)}K)`;
    return { pass: false, reason, whaleBuyUsd, whaleSellUsd };
  }

  const label = direction === "long" ? "покупок" : "продаж";
  return {
    pass: true,
    reason: `Крупные ${label}: $${(dirWhale / 1_000_000).toFixed(2)}M за 2м ✓`,
    whaleBuyUsd,
    whaleSellUsd,
  };
}
