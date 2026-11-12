/**
 * Owner-only parts of the dashboard (owner 2026-11-12: «Подписчики», as in CAB and Nihilist — only the owner sees them).
 * The dashboard itself may be open (no DASHBOARD_PIN), so the owner is recognised by:
 *  - the Telegram MiniApp: initData signed with the bot token (Telegram's WebApp check), from a chat listed in
 *    TELEGRAM_ADMIN_CHAT_IDS, not older than 24 h; or
 *  - the dashboard PIN, when DASHBOARD_PIN is set (only the owner has it).
 * No new secret is needed.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { pinMatches } from "./dashboardAccess";

const MAX_AGE_S = 24 * 3600;
const adminIds = () => (process.env.TELEGRAM_ADMIN_CHAT_IDS ?? "").split(",").map((x) => x.trim()).filter(Boolean);

/** Telegram user id from valid MiniApp initData, else null. */
export function telegramUserFromInitData(initData: string, botToken: string, nowS = Math.floor(Date.now() / 1000)): string | null {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");
  const check = [...params].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expected = createHmac("sha256", secret).update(check).digest("hex");
  const a = Buffer.from(expected), b = Buffer.from(hash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || nowS - authDate > MAX_AGE_S) return null;
  try {
    const user = JSON.parse(params.get("user") ?? "null") as { id?: number } | null;
    return user?.id ? String(user.id) : null;
  } catch { return null; }
}

export function isOwnerRequest(req: Request): boolean {
  const pin = process.env.DASHBOARD_PIN?.trim();
  const given = String(req.header("x-dashboard-pin") ?? "");
  if (pin && given && pinMatches(given, pin)) return true;
  const uid = telegramUserFromInitData(String(req.header("x-telegram-init-data") ?? ""), process.env.TELEGRAM_BOT_TOKEN ?? "");
  return uid !== null && adminIds().includes(uid);
}

export function requireOwner(req: Request, res: Response, next: NextFunction): void {
  if (isOwnerRequest(req)) { next(); return; }
  res.status(403).json({ error: "owner_only" });
}
