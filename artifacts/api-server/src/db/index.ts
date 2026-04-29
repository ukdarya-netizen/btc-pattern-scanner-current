import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";
import { logger } from "../lib/logger";

const connectionString = process.env["DATABASE_URL"];

if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is required");
}

const pool = new Pool({
  connectionString,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on("error", (err) => {
  logger.error({ err }, "PostgreSQL pool error");
});

export const db = drizzle(pool, { schema });

export async function testConnection(): Promise<boolean> {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch (e) {
    logger.error({ err: e }, "Database connection failed");
    return false;
  }
}
