import test from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { buildHistoryCsv } from "./historyStudy";

test("BTC history: price joined with OI, takers, funding, liquidations, long/short by time; 1h and 4h", async () => {
  const saved = { dep: process.env.REPLIT_DEPLOYMENT, key: process.env.COINGLASS_API_KEY, fetch: globalThis.fetch };
  process.env.REPLIT_DEPLOYMENT = "1"; process.env.COINGLASS_API_KEY = "k";
  const t1 = Date.now() - 2 * 3_600_000, t2 = Date.now() - 3_600_000;
  globalThis.fetch = (async (url: string) => {
    const path = new URL(String(url)).pathname;
    const row = (t: number) => ({ time: t, open: 1, high: 2, low: 0.5, close: path.includes("price") ? 100 : 7,
      aggregated_buy_volume_usd: 10, aggregated_sell_volume_usd: 4, aggregated_long_liquidation_usd: 3, aggregated_short_liquidation_usd: 1, global_account_long_short_ratio: 1.8 });
    return new Response(JSON.stringify({ code: "0", data: [row(t1), row(t2)] }), { status: 200 });
  }) as unknown as typeof fetch;
  try {
    const { csv, rows } = await buildHistoryCsv();
    const lines = gunzipSync(csv).toString().trim().split("\n");
    assert.equal(rows, 4);
    assert.equal(lines[0], "tf,t,open,high,low,close,oi,fut_buy,fut_sell,spot_buy,spot_sell,funding,liq_long,liq_short,ls_ratio");
    assert.equal(lines[1], `1h,${t1},1,2,0.5,100,7,10,4,10,4,7,3,1,1.8`);
    assert.ok(lines[3]!.startsWith("4h,"));
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.dep === undefined) delete process.env.REPLIT_DEPLOYMENT; else process.env.REPLIT_DEPLOYMENT = saved.dep;
    if (saved.key === undefined) delete process.env.COINGLASS_API_KEY; else process.env.COINGLASS_API_KEY = saved.key;
  }
});
