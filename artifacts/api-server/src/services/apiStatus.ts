import { logger } from "../lib/logger";

export interface ApiStatusEntry {
  name: string;
  label: string;
  ok: boolean;
  message: string;
  lastCheckedAt: number;
}

type CheckFn = () => Promise<{ ok: boolean; message: string }>;

class ApiStatusService {
  private entries = new Map<string, ApiStatusEntry>();
  private checks = new Map<string, CheckFn>();
  private timer: ReturnType<typeof setInterval> | null = null;

  register(name: string, label: string, check: CheckFn) {
    this.checks.set(name, check);
    this.entries.set(name, { name, label, ok: false, message: "проверка...", lastCheckedAt: Date.now() });
  }

  private async runOne(name: string) {
    const check = this.checks.get(name);
    const prev = this.entries.get(name);
    if (!check || !prev) return;
    try {
      const { ok, message } = await check();
      this.entries.set(name, { name, label: prev.label, ok, message, lastCheckedAt: Date.now() });
    } catch (e) {
      this.entries.set(name, { name, label: prev.label, ok: false, message: (e as Error).message, lastCheckedAt: Date.now() });
    }
  }

  private async runAll() {
    await Promise.all(Array.from(this.checks.keys()).map((name) => this.runOne(name)));
  }

  start(intervalMs = 30_000) {
    if (this.timer) return;
    void this.runAll();
    this.timer = setInterval(() => void this.runAll(), intervalMs);
    logger.info({ checks: Array.from(this.checks.keys()) }, "ApiStatusService started");
  }

  getAll(): ApiStatusEntry[] {
    return Array.from(this.entries.values());
  }
}

export const apiStatusService = new ApiStatusService();
