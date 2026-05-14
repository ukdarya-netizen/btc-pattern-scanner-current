import { aggregator } from "./exchanges/aggregator";

const OB_DEPTH_PCT     = 0.005;
const OB_WALL_RATIO    = 2.5;

export interface OBImbalanceResult {
  pass: boolean;
  reason: string;
  bidVolumeUsd: number;
  askVolumeUsd: number;
}

export function checkImbalance(direction: "long" | "short"): OBImbalanceResult {
  const ob    = aggregator.getAggregatedOrderbook();
  const price = aggregator.getPrimaryPrice();

  if (!ob || price === 0) {
    return { pass: true, reason: "нет данных стакана (пропуск) ✓", bidVolumeUsd: 0, askVolumeUsd: 0 };
  }

  const lowerBound = price * (1 - OB_DEPTH_PCT);
  const upperBound = price * (1 + OB_DEPTH_PCT);

  const bidVol = ob.mergedBids
    .filter(l => l.price >= lowerBound && l.price <= price)
    .reduce((s, l) => s + l.size * l.price, 0);

  const askVol = ob.mergedAsks
    .filter(l => l.price >= price && l.price <= upperBound)
    .reduce((s, l) => s + l.size * l.price, 0);

  if (direction === "long") {
    if (askVol > 0 && askVol > bidVol * OB_WALL_RATIO) {
      const ratio = (askVol / Math.max(bidVol, 1)).toFixed(1);
      return {
        pass: false,
        reason: `СТАКАН (Плита сверху в ${ratio}x больше)`,
        bidVolumeUsd: bidVol,
        askVolumeUsd: askVol,
      };
    }
  } else {
    if (bidVol > 0 && bidVol > askVol * OB_WALL_RATIO) {
      const ratio = (bidVol / Math.max(askVol, 1)).toFixed(1);
      return {
        pass: false,
        reason: `СТАКАН (Плита снизу в ${ratio}x больше)`,
        bidVolumeUsd: bidVol,
        askVolumeUsd: askVol,
      };
    }
  }

  const bidK = (bidVol / 1_000).toFixed(0);
  const askK = (askVol / 1_000).toFixed(0);
  return {
    pass: true,
    reason: `Стакан OK (Bid: $${bidK}K / Ask: $${askK}K) ✓`,
    bidVolumeUsd: bidVol,
    askVolumeUsd: askVol,
  };
}
