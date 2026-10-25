/**
 * Read-only history check of the range setups on BingX BTC-USDT (no DB, no
 * orders, no Telegram):  node --import tsx src/analysis/rangeBacktest.ts
 * Replays the detector over all available 4h and 1d candles and, for every
 * breakout/deviation, reports candle-volume confirmation and the outcome on
 * later bars: stop first, else target 1, else target 2 (a bar touching stop
 * and target counts as stop). Aggregated CVD history is not replayed here,
 * so this is the upper bound before the flow filter.
 */
import { replayRanges } from "../engine/rangeDetector";
import { levelsFor, VOLUME_MULT_MIN, volumeMultiple, type Setup } from "../engine/rangePatterns";
import { INTERVAL_MS, type Candle } from "../market/bingx";

async function history(interval: "4h" | "1d"): Promise<Candle[]> {
  const step = INTERVAL_MS[interval];
  const out = new Map<number, Candle>();
  let end = Date.now();
  for (let page = 0; page < 20; page++) {
    const url = new URL("https://open-api.bingx.com/openApi/swap/v3/quote/klines");
    url.search = new URLSearchParams({ symbol: "BTC-USDT", interval, limit: "1440", endTime: String(end) }).toString();
    const body = await (await fetch(url)).json() as { code: number; data?: Array<Record<string, unknown>> };
    const rows = (body.data ?? []).map((k) => ({ time: Number(k.time), open: Number(k.open), high: Number(k.high),
      low: Number(k.low), close: Number(k.close), volume: Number(k.volume) }));
    if (!rows.length) break;
    for (const r of rows) if (r.time + step <= Date.now()) out.set(r.time, r);
    const oldest = Math.min(...rows.map((r) => r.time));
    if (oldest >= end) break;
    end = oldest - 1;
    if (rows.length < 1440) break;
  }
  return [...out.values()].sort((a, b) => a.time - b.time);
}

type Row = { tf: string; setup: Setup; dir: "long" | "short"; time: string; vol: number | null;
  volOk: boolean; outcome: "stop" | "t1" | "t2" | "open"; r: number };

function outcome(candles: Candle[], from: number, dir: "long" | "short", stop: number, t1: number, t2: number):
  { outcome: Row["outcome"]; r: number } {
  const entry = candles[from]!.close;
  const risk = Math.abs(entry - stop);
  let hit1 = false;
  for (let i = from + 1; i < candles.length; i++) {
    const c = candles[i]!;
    const stopHit = dir === "long" ? c.low <= (hit1 ? entry : stop) : c.high >= (hit1 ? entry : stop);
    const t1Hit = dir === "long" ? c.high >= t1 : c.low <= t1;
    const t2Hit = dir === "long" ? c.high >= t2 : c.low <= t2;
    if (stopHit) return hit1 ? { outcome: "t1", r: 0.5 * Math.abs(t1 - entry) / risk } : { outcome: "stop", r: -1 };
    if (t2Hit) return { outcome: "t2", r: 0.5 * (Math.abs(t1 - entry) + Math.abs(t2 - entry)) / risk };
    if (t1Hit) hit1 = true;
  }
  return { outcome: "open", r: 0 };
}

async function main() {
  const rows: Row[] = [];
  for (const tf of ["4h", "1d"] as const) {
    const candles = await history(tf);
    console.log(`${tf}: ${candles.length} closed bars from ${new Date(candles[0]!.time).toISOString().slice(0, 10)}`);
    for (const event of replayRanges(candles).events) {
      const setup: Setup = event.kind.startsWith("breakout") ? "breakout" : "deviation";
      const dir = event.kind === "breakout_up" || event.kind === "deviation_bull" ? "long" : "short";
      const levels = levelsFor(event, setup, dir);
      const vol = volumeMultiple(candles.slice(0, event.index + 1));
      const res = outcome(candles, event.index, dir, levels.stop, levels.targets[0]!.price, levels.targets[1]!.price);
      rows.push({ tf, setup, dir, time: new Date(event.time).toISOString().slice(0, 16), vol,
        volOk: vol !== null && vol >= VOLUME_MULT_MIN[setup], ...res });
    }
  }
  for (const group of ["all", "volume_confirmed"] as const) {
    console.log(`\n== ${group}`);
    for (const tf of ["4h", "1d"]) for (const setup of ["breakout", "deviation"] as const) for (const dir of ["long", "short"] as const) {
      const g = rows.filter((r) => r.tf === tf && r.setup === setup && r.dir === dir && (group === "all" || r.volOk) && r.outcome !== "open");
      if (!g.length) { console.log(`${tf} ${setup} ${dir}: 0`); continue; }
      const wins = g.filter((r) => r.outcome !== "stop").length;
      const sumR = g.reduce((s, r) => s + r.r, 0);
      console.log(`${tf} ${setup} ${dir}: n=${g.length} win=${Math.round(wins / g.length * 100)}% avgR=${(sumR / g.length).toFixed(2)} sumR=${sumR.toFixed(1)}`);
    }
  }
  console.log("\nlast 15 events:");
  for (const r of rows.slice(-15)) console.log(JSON.stringify(r));
}

main().catch((err) => { console.error(err); process.exit(1); });
