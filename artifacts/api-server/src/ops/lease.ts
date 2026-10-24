/**
 * Single active engine per database (AltBullet keeps one scanner via a DB
 * lease). A session-level Postgres advisory lock is held on a dedicated
 * connection for the process lifetime; a second process (for example the
 * workspace dev server next to the published app on the same database)
 * waits instead of double-tracking positions and double-posting to Telegram.
 * If the connection drops, the lock is released by Postgres automatically.
 */
import { pool } from "@workspace/db";
import { logger } from "../lib/logger";

const LOCK_KEY = "btc-bullet-engine";
let held: { release: () => void } | null = null;

export async function tryAcquireEngineLease(): Promise<boolean> {
  if (held) return true;
  const client = await pool.connect();
  try {
    const result = await client.query<{ ok: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [LOCK_KEY],
    );
    if (result.rows[0]?.ok === true) {
      client.on("error", (err) => {
        logger.error({ err }, "engine lease connection lost — exiting so the supervisor restarts cleanly");
        process.exit(1);
      });
      held = { release: () => client.release() };
      return true;
    }
    client.release();
    return false;
  } catch (err) {
    client.release();
    throw err;
  }
}

/** Resolves once this process owns the engine. */
export async function waitForEngineLease(): Promise<void> {
  for (;;) {
    try {
      if (await tryAcquireEngineLease()) {
        logger.info("BTC engine: lease acquired");
        return;
      }
      logger.warn("BTC engine: another process holds the engine lease — waiting");
    } catch (err) {
      logger.warn({ err }, "BTC engine: lease check failed — retrying");
    }
    await new Promise((r) => setTimeout(r, 60_000));
  }
}
