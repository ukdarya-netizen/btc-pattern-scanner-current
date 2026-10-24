import assert from "node:assert/strict";
import { test } from "node:test";
import { requireDashboardPin } from "./dashboardAccess";

function call(pin: string | undefined, ip = "1.1.1.1") {
  let status = 200;
  let passed = false;
  const req = { ip, header: (name: string) => (name === "x-dashboard-pin" ? pin : undefined) } as never;
  const res = { status(code: number) { status = code; return this; }, json() { return this; } } as never;
  requireDashboardPin(req, res, () => { passed = true; });
  return { status, passed };
}

test("dashboard is open without DASHBOARD_PIN and guarded with it", () => {
  delete process.env.DASHBOARD_PIN;
  assert.equal(call(undefined).passed, true);
  process.env.DASHBOARD_PIN = "4821";
  assert.equal(call(undefined).status, 401);
  assert.equal(call("4821").passed, true);
  for (let i = 0; i < 10; i++) call("0000", "2.2.2.2");
  assert.equal(call("4821", "2.2.2.2").status, 429, "locked after repeated wrong PINs");
  delete process.env.DASHBOARD_PIN;
});
