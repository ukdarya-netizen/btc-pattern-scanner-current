/**
 * Dashboard access (AltBullet protects its dashboard with an owner PIN).
 * When DASHBOARD_PIN is set, every /api/btc/* request must carry the PIN in
 * the `x-dashboard-pin` header. Repeated wrong PINs from one address are
 * locked out for 15 minutes. Without DASHBOARD_PIN the dashboard stays open.
 */
import { timingSafeEqual, createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

const MAX_FAILURES = 10;
const WINDOW_MS = 15 * 60_000;
const failures = new Map<string, { count: number; firstAt: number }>();

const digest = (v: string) => createHash("sha256").update(v).digest();

export function pinMatches(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected));
}

export function requireDashboardPin(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.DASHBOARD_PIN?.trim();
  if (!expected) { next(); return; }
  const ip = req.ip ?? "unknown";
  const now = Date.now();
  const f = failures.get(ip);
  if (f && now - f.firstAt < WINDOW_MS && f.count >= MAX_FAILURES) {
    res.status(429).json({ error: "too_many_attempts" });
    return;
  }
  const given = String(req.header("x-dashboard-pin") ?? "");
  if (given && pinMatches(given, expected)) {
    failures.delete(ip);
    next();
    return;
  }
  if (given) {
    const entry = f && now - f.firstAt < WINDOW_MS ? f : { count: 0, firstAt: now };
    entry.count += 1;
    failures.set(ip, entry);
    if (failures.size > 10_000) failures.clear();
  }
  res.status(401).json({ error: "pin_required" });
}
