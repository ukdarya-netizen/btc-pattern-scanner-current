import { useEffect, useState, type ReactNode } from "react";
import { getJson, time } from "../lib/api";
import { Card, Pill } from "../components/ui";

/**
 * Bot Health (owner 2026-11-13): the bot's own health on its own tab — process, price stream, scanner cycle,
 * external APIs, CoinGlass budget, database, Telegram queue, reports. Market metrics and decisions are on
 * «Рынок» and the decisions on «Решения». Refreshed every 30 s.
 */
type Api = { ok: boolean; downForMin: number; consecutiveFailures: number; lastError: string | null; lastSuccessAt: string | null };
type Health = {
  at: string;
  process: { uptimeMin: number; rssMb: number; heapMb: number };
  stream: { connected: boolean; lastTickAt: string | null; lastPrice: number | null };
  scanner: { lastCandleCloseAt: string | null; lastCycleAt: string | null; minutesSinceCandle: number | null; lastDurationMs: number | null; lastError: string | null; missingFlow: string[] };
  apis: Record<string, Api>;
  coinglass: { started: number; ok: number; failed: number; rateLimited: number; cooldownMs: number; minGapMs: number };
  db: { ok: boolean; pingMs: number | null };
  telegram: Record<string, { n: number; oldest: string | null; lastSent: string | null; maxAttempts: number }>;
  reports: Array<{ periodKey: string; sentAt: string | null }>;
  openSignals: number;
  patterns: { total: number; live: number };
};

const API_LABEL: Record<string, string> = { coinglass: "CoinGlass", bingx: "BingX REST", bingx_stream: "BingX поток цены", telegram: "Telegram" };
const ago = (iso: string | null) => (iso ? `${Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000))} мин назад` : "—");

function Row({ label, ok, children }: { label: string; ok: boolean | null; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-gold/10 py-2 text-sm last:border-0">
      <div className="flex items-center gap-2">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${ok === null ? "bg-zinc-500" : ok ? "bg-emerald-400" : "bg-rose-500"}`} />
        <span>{label}</span>
      </div>
      <div className="text-right text-muted-foreground">{children}</div>
    </div>
  );
}

export function Health() {
  const [h, setH] = useState<Health | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => getJson<Health>("/api/btc/health").then((r) => { if (alive) { setH(r); setErr(null); } }).catch((e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    load();
    const id = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(id); };
  }, []);
  if (!h) return <Card title="Bot Health"><p className="text-sm text-muted-foreground">{err ? `Нет ответа сервера: ${err}` : "Проверяю…"}</p></Card>;

  const cycleOk = h.scanner.minutesSinceCandle !== null && h.scanner.minutesSinceCandle <= 15 && !h.scanner.lastError;
  const cg = h.coinglass;
  const cgFailPct = cg.started ? (cg.failed / cg.started) * 100 : 0;
  const pending = h.telegram.pending?.n ?? 0;
  const failed = h.telegram.failed?.n ?? 0;
  const issues = [
    !h.stream.connected && "нет потока цены",
    !cycleOk && "сканер отстаёт или с ошибкой",
    ...Object.entries(h.apis).filter(([, a]) => !a.ok).map(([k]) => `${API_LABEL[k] ?? k} недоступен`),
    !h.db.ok && "база не отвечает",
    pending > 20 && `очередь Telegram ${pending}`,
    cg.cooldownMs > 0 && "CoinGlass на паузе (429)",
  ].filter(Boolean) as string[];

  return (
    <div className="space-y-4">
      <Card title={<>Bot Health · {time(h.at)}</>} right={issues.length ? <Pill kind="bad">проблем: {issues.length}</Pill> : <Pill kind="good">всё работает</Pill>}>
        {issues.length > 0 && <p className="mb-2 text-sm text-rose-300">{issues.join(" · ")}</p>}
        <Row label="Процесс" ok={true}>работает {Math.floor(h.process.uptimeMin / 60)} ч {h.process.uptimeMin % 60} мин · память {h.process.rssMb} МБ</Row>
        <Row label="Поток цены BingX" ok={h.stream.connected}>{h.stream.connected ? "на связи" : "нет связи"} · последний тик {ago(h.stream.lastTickAt)}</Row>
        <Row label="Сканер (цикл 5m)" ok={cycleOk}>
          свеча {time(h.scanner.lastCandleCloseAt)} ({h.scanner.minutesSinceCandle ?? "—"} мин) · цикл {h.scanner.lastDurationMs == null ? "—" : `${(h.scanner.lastDurationMs / 1000).toFixed(1)} с`}
          {h.scanner.lastError ? <div className="text-amber-400">ошибка: {h.scanner.lastError}</div> : null}
          {h.scanner.missingFlow.length ? <div className="text-amber-400">нет данных: {h.scanner.missingFlow.join(", ")}</div> : null}
        </Row>
        <Row label="База данных" ok={h.db.ok}>{h.db.ok ? `ответ ${h.db.pingMs} мс` : "не отвечает"}</Row>
        <Row label="Паттерны" ok={null}>{h.patterns.total} · в канал {h.patterns.live} · открытых позиций {h.openSignals}</Row>
      </Card>

      <Card title="Внешние сервисы">
        {Object.entries(h.apis).length === 0 && <p className="text-sm text-muted-foreground">Запросов ещё не было.</p>}
        {Object.entries(h.apis).map(([k, a]) => (
          <Row key={k} label={API_LABEL[k] ?? k} ok={a.ok}>
            {a.ok ? `последний успех ${ago(a.lastSuccessAt)}` : `недоступен ${a.downForMin} мин · ошибок подряд ${a.consecutiveFailures}`}
            {!a.ok && a.lastError ? <div className="text-amber-400">{a.lastError}</div> : null}
          </Row>
        ))}
        <Row label="CoinGlass: лимит ключа (общий с CAB и Нигилистом)" ok={cg.rateLimited === 0 && cgFailPct < 5}>
          запросов {cg.started} · успешно {cg.ok} · ошибок {cg.failed} ({cgFailPct.toFixed(1)}%) · 429: {cg.rateLimited}
          {cg.cooldownMs > 0 ? <div className="text-amber-400">пауза ещё {Math.ceil(cg.cooldownMs / 1000)} с</div> : null}
        </Row>
      </Card>

      <Card title="Telegram">
        <Row label="Очередь отправки" ok={pending <= 20 && failed === 0}>
          ждут {pending} · отправлено {h.telegram.sent?.n ?? 0} · не доставлено {failed} · пропущено {h.telegram.skipped?.n ?? 0}
          <div>последняя отправка {ago(h.telegram.sent?.lastSent ?? null)}</div>
        </Row>
        <Row label="Отчёты" ok={null}>{h.reports.length ? h.reports.map((r) => `${r.periodKey} · ${time(r.sentAt)}`).join(" · ") : "ещё не было"}</Row>
      </Card>
      <p className="text-xs text-muted-foreground">Счётчики CoinGlass и сервисов — с последнего перезапуска. Метрики рынка — во вкладке «Рынок», журнал решений — во вкладке «Решения».</p>
    </div>
  );
}
