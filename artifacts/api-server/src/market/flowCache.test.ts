import test from "node:test";
import assert from "node:assert/strict";
import { cgAllowed, getBtcFlow, resetBtcFlowCacheForTests } from "./coinglass";

const M15 = 15 * 60_000;

test("dev: no CoinGlass request at all (cgGet returns null without fetching)", async () => {
  const saved = { dep: process.env.REPLIT_DEPLOYMENT, env: process.env.NODE_ENV, fetch: globalThis.fetch };
  delete process.env.REPLIT_DEPLOYMENT; process.env.NODE_ENV = "development";
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("no"); }) as typeof fetch;
  try {
    assert.equal(cgAllowed(), false);
    resetBtcFlowCacheForTests();
    const flow = await getBtcFlow(10, 10 * M15 + 1000);
    assert.equal(flow.oi, null);
    assert.equal(calls, 0);
  } finally {
    process.env.REPLIT_DEPLOYMENT = saved.dep; process.env.NODE_ENV = saved.env; globalThis.fetch = saved.fetch;
    if (saved.dep === undefined) delete process.env.REPLIT_DEPLOYMENT;
  }
});

test("15m flow: one fetch per closed 15m bar; an incomplete fetch is retried at most once a minute", async () => {
  const saved = { dep: process.env.REPLIT_DEPLOYMENT, key: process.env.COINGLASS_API_KEY, fetch: globalThis.fetch, gap: process.env.COINGLASS_MIN_GAP_MS };
  process.env.REPLIT_DEPLOYMENT = "1"; process.env.COINGLASS_API_KEY = "k";
  let calls = 0;
  let lastClosed = 0;
  globalThis.fetch = (async (url: string) => {
    calls++;
    const u = new URL(String(url));
    const rows = [{ time: lastClosed, close: 1, aggregated_long_liquidation_usd: 1, aggregated_short_liquidation_usd: 1, aggregated_buy_volume_usd: 1,
      aggregated_sell_volume_usd: 1, cum_vol_delta: 1, global_account_long_short_ratio: 1, aggregated_bids_usd: 1, aggregated_asks_usd: 1, whale_index_value: 1 }];
    void u;
    return new Response(JSON.stringify({ code: "0", data: rows }), { status: 200 });
  }) as unknown as typeof fetch;
  try {
    resetBtcFlowCacheForTests();
    const t0 = 2_000_000 * M15 + 5_000; // 5 s after a 15m close
    lastClosed = t0 - 5_000 - M15; // the just-closed bar is there
    await getBtcFlow(10, t0);
    const perFetch = calls;
    assert.ok(perFetch >= 10);
    await getBtcFlow(10, t0 + 5 * 60_000); // next 5m cycle, same 15m bar
    await getBtcFlow(10, t0 + 15_000);     // a 15 s retry of a late candle
    assert.equal(calls, perFetch, "same closed 15m bar: no new requests");
    lastClosed = t0 - 5_000;               // the next bar closes
    await getBtcFlow(10, t0 + M15);
    assert.equal(calls, 2 * perFetch);
  } finally {
    globalThis.fetch = saved.fetch;
    if (saved.dep === undefined) delete process.env.REPLIT_DEPLOYMENT; else process.env.REPLIT_DEPLOYMENT = saved.dep;
    if (saved.key === undefined) delete process.env.COINGLASS_API_KEY; else process.env.COINGLASS_API_KEY = saved.key;
  }
});
