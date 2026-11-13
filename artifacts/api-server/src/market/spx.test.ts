import test from "node:test";
import assert from "node:assert/strict";
import { parseStooq, parseYahoo, spxHistory } from "./spx";

test("S&P 500: Yahoo chart and Stooq CSV parse to daily closes, oldest first; dev makes no request", async () => {
  assert.deepEqual(parseYahoo({ chart: { result: [{ timestamp: [1_700_086_400, 1_700_000_000], indicators: { quote: [{ close: [4510.5, null] }] } }] } }),
    [{ t: 1_700_086_400_000, close: 4510.5 }]);
  assert.deepEqual(parseStooq("Date,Open,High,Low,Close,Volume\n2026-11-12,1,1,1,6001.2,0\n2026-11-11,1,1,1,5990,0\n"),
    [{ t: Date.parse("2026-11-11T00:00:00Z"), close: 5990 }, { t: Date.parse("2026-11-12T00:00:00Z"), close: 6001.2 }]);
  const saved = { dep: process.env.REPLIT_DEPLOYMENT, env: process.env.NODE_ENV, fetch: globalThis.fetch };
  delete process.env.REPLIT_DEPLOYMENT; process.env.NODE_ENV = "development";
  let calls = 0;
  globalThis.fetch = (async () => { calls++; throw new Error("no"); }) as typeof fetch;
  try {
    assert.deepEqual(await spxHistory(), []);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = saved.fetch; process.env.NODE_ENV = saved.env;
    if (saved.dep !== undefined) process.env.REPLIT_DEPLOYMENT = saved.dep;
  }
});
