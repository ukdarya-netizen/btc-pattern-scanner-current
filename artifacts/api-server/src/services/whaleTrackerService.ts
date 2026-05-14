import { aggregator } from "./exchanges/aggregator";

const WHALE_MIN_NOTIONAL_USD = 1_500_000;
const WHALE_WINDOW_MS        = 180_000;

export interface WhaleTrackResult {
  pass: boolean;
  reason: string;
  whaleBuyUsd: number;
  whaleSellUsd: number;
}

export function checkWhaleActivity(direction: "long" | "short"): WhaleTrackResult {
  const trades = aggregator.getPrimaryTrades();

  if (trades.length === 0) {
    return { pass: true, reason: "нет данных сделок (пропуск) ✓", whaleBuyUsd: 0, whaleSellUsd: 0 };
  }

  const cutoff = Date.now() - WHALE_WINDOW_MS;
  const recent = trades.filter(t => t.timestamp >= cutoff);

  let whaleBuyUsd  = 0;
  let whaleSellUsd = 0;
  let maxBuyPrint  = 0;
  let maxSellPrint = 0;

  for (const t of recent) {
    const notional = t.price * t.size;
    if (notional < WHALE_MIN_NOTIONAL_USD) continue;
    if (t.side === "buy") {
      whaleBuyUsd  += notional;
      if (notional > maxBuyPrint) maxBuyPrint = notional;
    } else {
      whaleSellUsd += notional;
      if (notional > maxSellPrint) maxSellPrint = notional;
    }
  }

  const dirMaxPrint = direction === "long" ? maxBuyPrint  : maxSellPrint;
  const dirTotal    = direction === "long" ? whaleBuyUsd  : whaleSellUsd;
  const label       = direction === "long" ? "покупок"    : "продаж";

  if (dirMaxPrint < WHALE_MIN_NOTIONAL_USD) {
    const maxM = (dirMaxPrint / 1_000_000).toFixed(2);
    return {
      pass: false,
      reason: `НЕТ КИТОВ (Принты < $1.5M, макс: $${maxM}M)`,
      whaleBuyUsd,
      whaleSellUsd,
    };
  }

  return {
    pass: true,
    reason: `Кит зафиксирован: $${(dirMaxPrint / 1_000_000).toFixed(2)}M (total ${label}: $${(dirTotal / 1_000_000).toFixed(2)}M) ✓`,
    whaleBuyUsd,
    whaleSellUsd,
  };
}
