import { useEffect, useState } from "react";
import { Activity, BookOpen, Gauge, LineChart as LineChartIcon, HeartPulse, Layers, LogOut, MoreHorizontal, Target, Users, X } from "lucide-react";
import { AuthError, type Decision, type Metrics, type OutcomeGroup, type Session, type Signal, type Status, asset, currentSession, getJson, post, price, saveSession, time } from "./lib/api";
import { Login, Register, ResetPassword } from "./pages/Auth";
import { type Data, type Filter, type Mode, NO_FILTER, type Period, type Tab, periodOptions } from "./lib/data";
import { Segmented } from "./components/ui";
import { Overview } from "./pages/Overview";
import { Positions } from "./pages/Positions";
import { History } from "./pages/History";
import { Patterns } from "./pages/Patterns";
import { Decisions } from "./pages/Decisions";
import { Market } from "./pages/Market";
import { Health } from "./pages/Health";
import { Subscribers } from "./pages/Subscribers";
import { Reference } from "./pages/Reference";
import { LanguageToggle } from "./components/LanguageToggle";

/** Navigation on the left, as in CAB and Nihilist (owner 2026-11-12). «Подписчики» and Bot Health — owner only. */
const NAV: Array<{ tab: Tab; label: string; sub: string; icon: typeof Target; owner?: boolean }> = [
  { tab: "positions", label: "Открытые позиции", sub: "движение · стоп · цели · история", icon: Target },
  { tab: "overview", label: "Обзор", sub: "общая статистика", icon: Activity },
  // Owner 2026-11-14: the signal history lives on «Открытые позиции» under the open and recently closed ones (as CAB).
  { tab: "patterns", label: "Паттерны", sub: "результат каждого", icon: Layers },
  // Owner 2026-11-13: everything about the market on one tab, for everyone.
  { tab: "market", label: "Рынок", sub: "дельта · OI · фандинг · доминация · S&P 500", icon: LineChartIcon },
  { tab: "reference", label: "Справочник", sub: "паттерны · ведение сделки", icon: BookOpen },
  { tab: "subscribers", label: "Подписчики", sub: "дашборд + Telegram-бот", icon: Users, owner: true },
  { tab: "health", label: "Bot Health", sub: "сервер · сканер · сервисы · Telegram", icon: HeartPulse, owner: true },
  { tab: "decisions", label: "Решения", sub: "решения паттернов · цель или стоп", icon: Gauge, owner: true },
];
const TABS = NAV.map((n) => [n.tab, n.label] as const);
const tabFromHash = (): Tab => {
  const h = window.location.hash.replace("#", "") as Tab;
  if (h === "history") return "positions"; // old links: the history is on «Открытые позиции» now
  return TABS.some(([t]) => t === h) ? h : "overview";
};

type AuthPage = "login" | "register" | "reset-password";
const authPage = (): AuthPage | null => {
  const h = window.location.hash.replace("#", "");
  return h === "login" || h === "register" || h === "reset-password" ? h : null;
};

/** Presence (as CAB / Nihilist): heartbeat every 30 s while the tab is visible. */
function useHeartbeat(on: boolean): void {
  useEffect(() => {
    if (!on) return;
    const beat = () => { if (document.visibilityState === "visible") void post("/api/auth/heartbeat", {}).catch(() => undefined); };
    beat();
    const t = setInterval(beat, 30_000);
    document.addEventListener("visibilitychange", beat);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", beat); };
  }, [on]);
}

/** Owner: access requests waiting for approval («+N» on «Подписчики», as CAB), every 60 s. */
function usePendingCount(on: boolean): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!on) return;
    const load = () => void getJson<{ count: number }>("/api/admin/users/pending-count").then((d) => setN(d.count)).catch(() => undefined);
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [on]);
  return n;
}

export default function App() {
  const [tab, setTabState] = useState<Tab>(tabFromHash);
  const [filter, setFilter] = useState<Filter>(NO_FILTER);
  const [period, setPeriod] = useState<Period>("all");
  // Owner 2026-11-12: channel and shadow are never mixed — every number is for the chosen mode (default: channel).
  const [mode, setMode] = useState<Mode>("live");
  const [raw, setRaw] = useState<Data>({ status: null, open: [], closed: [], market: null, outcomes: [], decisions: [] });
  const [error, setError] = useState<string | null>(null);
  const [sess, setSess] = useState<Session | null>(currentSession);
  const [notice, setNotice] = useState<string | null>(null);
  const [page, setPage] = useState<AuthPage | null>(authPage);
  const [menu, setMenu] = useState(false);
  const owner = sess?.role === "owner";
  useHeartbeat(Boolean(sess));
  const pending = usePendingCount(owner);
  const logout = (msg: string | null = null) => { saveSession(null); setSess(null); setNotice(msg); window.location.hash = "login"; };

  const setTab = (t: Tab) => { setTabState(t); setMenu(false); window.location.hash = t; document.getElementById("content")?.scrollTo({ top: 0 }); };
  // «history» (from Overview / Patterns) = «Открытые позиции», scrolled to the history block with the filter set.
  const go = (t: Tab, f?: Partial<Filter>) => {
    if (f) setFilter({ ...NO_FILTER, ...f });
    if (t === "history") { setTab("positions"); setTimeout(() => document.getElementById("history")?.scrollIntoView({ behavior: "smooth", block: "start" }), 80); return; }
    setTab(t);
  };
  useEffect(() => {
    const on = () => { setPage(authPage()); setTabState(tabFromHash()); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  useEffect(() => {
    if (!sess) return;
    let alive = true;
    const load = async () => {
      try {
        const [status, o, c] = await Promise.all([
          getJson<Status>("/api/btc/status"),
          getJson<{ rows: Signal[] }>("/api/btc/signals?status=open&limit=200"),
          getJson<{ rows: Signal[] }>("/api/btc/signals?status=closed&limit=500"),
        ]);
        // Market, decisions and outcomes are the owner's (Bot Health).
        const [market, oc, dc] = sess.role === "owner" ? await Promise.all([
          getJson<{ candleCloseAt: string | null; metrics: Metrics | null }>("/api/btc/metrics"),
          getJson<{ groups: OutcomeGroup[] }>("/api/btc/decisions/outcomes?days=7"),
          getJson<{ rows: Decision[] }>("/api/btc/decisions?limit=100"),
        ]) : [null, { groups: [] }, { rows: [] }];
        if (!alive) return;
        setRaw({ status, open: o.rows, closed: c.rows, market, outcomes: oc.groups, decisions: dc.rows });
        setError(null);
      } catch (err) {
        if (!alive) return;
        if (err instanceof AuthError) { logout(err.message === "Требуется вход" ? null : err.message); return; }
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    const timer = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(timer); };
  }, [sess]);

  if (!sess || page) {
    if (page === "register") return <Register />;
    if (page === "reset-password") return <ResetPassword />;
    return <Login notice={notice} onLogin={(s) => { setSess(s); setNotice(null); setPage(null); window.location.hash = "overview"; }} />;
  }

  const isLive = (s: Signal) => ((owner ? mode : "live") === "live") === s.live;
  const data: Data = { ...raw, open: raw.open.filter(isLive), closed: raw.closed.filter(isLive) };
  const label = (key: string) => data.status?.patterns.find((p) => p.key === key)?.label ?? key;
  const last = data.status?.stream.lastPrice ?? null;
  const connected = data.status?.stream.connected ?? false;

  const nav = NAV.filter((n) => !n.owner || owner);
  // Owner 2026-11-14: Решения, Подписчики, Bot Health — owner only; a subscriber opening such a link sees «Обзор».
  const shown: Tab = !owner && NAV.some((n) => n.owner && n.tab === tab) ? "overview" : tab;
  const current = nav.find((n) => n.tab === shown) ?? NAV.find((n) => n.tab === "overview")!;
  const navItem = (n: (typeof NAV)[number], big = false) => {
    const Icon = n.icon;
    const active = shown === n.tab;
    return (
      <button key={n.tab} onClick={() => setTab(n.tab)}
        className={`flex w-full items-start gap-3 rounded-lg border px-3 ${big ? "py-3" : "py-2.5"} text-left text-sm transition ${active ? "border-gold/50 bg-gold/10 text-gold" : "border-transparent text-muted-foreground hover:bg-white/[0.03] hover:text-foreground"}`}>
        <Icon className={`mt-0.5 h-4 w-4 shrink-0 ${active ? "text-gold" : ""}`} />
        <span className="flex flex-1 flex-col">
          <span className="flex items-center justify-between gap-2 font-medium">{n.label}
            {n.tab === "positions" && data.open.length > 0 && <span className="rounded-full bg-gold px-1.5 text-[10px] font-bold text-black">{data.open.length}</span>}
            {n.tab === "subscribers" && pending > 0 && <span className="rounded-full bg-rose-500 px-1.5 text-[10px] font-bold text-white">+{pending}</span>}
          </span>
          <span className="text-xs font-normal opacity-60">{n.sub}</span>
        </span>
      </button>
    );
  };
  const periodMatters = shown === "overview" || shown === "positions" || shown === "patterns";

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden">
      <aside className="hidden w-64 shrink-0 flex-col border-r border-gold/20 bg-black/70 md:flex">
        <button onClick={() => setTab("overview")} className="flex h-20 items-center gap-3 border-b border-gold/20 px-4">
          <img src={asset("brand/avatar.webp")} alt="" className="h-11 w-11 rounded-full border border-gold/60 object-cover" />
          {/* Owner 2026-11-13: the wordmark is the one from her artwork (brush gold + white), not a web font. */}
          <img src={asset("brand/wordmark.webp")} alt="Bitcoin Margin Master" className="h-14 w-auto max-w-[150px] object-contain" />
        </button>
        <nav className="flex-1 space-y-1 overflow-y-auto p-3">{nav.map((n) => navItem(n))}</nav>
        <button onClick={() => logout()} title={sess.email} className="mx-3 mb-2 flex items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground hover:text-foreground">
          <LogOut className="h-3.5 w-3.5" /><span className="truncate">Выйти · {sess.name}</span>
        </button>
        <div className="space-y-1.5 border-t border-gold/20 p-4 text-[11px] text-muted-foreground">
          <div className="flex justify-between"><span>BTC-USDT</span><span className="tabular-nums text-foreground">{price(last)}</span></div>
          <div className="flex justify-between"><span>Поток цены</span><span className={connected ? "text-emerald-400" : "text-rose-400"}>● {connected ? "на связи" : "нет связи"}</span></div>
          <div className="flex justify-between"><span>Последняя свеча</span><span>{time(data.status?.scanner.lastCandleCloseAt)}</span></div>
          <p className="pt-2 text-center text-[10px] uppercase tracking-[0.3em] text-gold/60">Discipline · Leverage · Freedom</p>
        </div>
      </aside>

      <main className="flex h-full min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-gold/20 bg-black/60 px-4 py-2 md:px-6">
          <img src={asset("brand/avatar.webp")} alt="" className="h-8 w-8 rounded-full border border-gold/60 object-cover md:hidden" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold md:text-xl">{current.label}</h1>
            <p className="hidden text-xs text-muted-foreground md:block">{current.sub}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold tabular-nums md:hidden">{price(last)}</span>
            <LanguageToggle />
            {owner && shown !== "subscribers" && shown !== "market" && shown !== "decisions" && shown !== "health" && shown !== "reference" && (
              <Segmented<Mode> value={mode} options={[["live", "Канал"], ["shadow", "Тень"]]} onChange={(m) => { setMode(m); setFilter(NO_FILTER); }} />
            )}
            {periodMatters && (
              <select value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Период"
                className="rounded-full border border-gold/30 bg-black/60 px-3 py-1 text-xs text-foreground focus:border-gold focus:outline-none">
                {periodOptions(data.closed).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            )}
          </div>
        </header>
        <div id="content" className="flex-1 space-y-4 overflow-auto p-4 pb-24 md:p-6 md:pb-6">
          {error && <p className="rounded-lg border border-rose-500/40 bg-rose-500/5 p-3 text-sm text-rose-300">Нет связи с API: {error}</p>}
          {owner && mode === "shadow" && shown !== "subscribers" && shown !== "market" && shown !== "decisions" && shown !== "health" && shown !== "reference" && <p className="rounded-lg border border-gold/30 bg-gold/5 p-2 text-center text-xs text-gold">Режим «Тень»: сигналы, которые пишутся и считаются, но не публикуются в канал.</p>}
          {shown === "overview" && <Overview data={data} period={period} setPeriod={setPeriod} mode={mode} go={go} />}
          {shown === "positions" && <Positions data={data} label={label} go={go} history={<History data={data} period={period} label={label} filter={filter} setFilter={setFilter} />} />}
          {shown === "patterns" && <Patterns data={data} period={period} mode={mode} go={go} />}
          {shown === "reference" && <Reference data={data} />}
          {shown === "subscribers" && owner && <Subscribers />}
          {shown === "market" && <Market data={raw} owner={owner} />}
          {shown === "decisions" && owner && <Decisions data={raw} label={label} />}
          {shown === "health" && owner && <Health />}
          <footer className="pt-6 text-center text-[10px] uppercase tracking-[0.35em] text-gold/50">Honey badger don't care · время Дубай</footer>
        </div>
      </main>

      {/* Phones: bottom bar + «Ещё» (as in Nihilist). */}
      {menu && (
        <div className="fixed inset-0 z-40 bg-black/70 md:hidden" onClick={() => setMenu(false)}>
          <div className="gold-card absolute inset-x-3 bottom-20 space-y-1 p-2" onClick={(e) => e.stopPropagation()}>
            {nav.map((n) => navItem(n, true))}
            <button onClick={() => logout()} className="flex w-full items-center gap-3 px-3 py-3 text-sm text-muted-foreground"><LogOut className="h-4 w-4" />Выйти · {sess.email}</button>
          </div>
        </div>
      )}
      <nav className="fixed inset-x-0 bottom-0 z-50 grid h-16 grid-cols-4 border-t border-gold/20 bg-black/95 backdrop-blur md:hidden">
        {NAV.filter((n) => n.tab === "positions" || n.tab === "overview" || n.tab === "market").map((n) => {
          const Icon = n.icon;
          return (
            <button key={n.tab} onClick={() => setTab(n.tab)} className={`flex flex-col items-center justify-center gap-1 text-[11px] ${shown === n.tab ? "text-gold" : "text-muted-foreground"}`}>
              <Icon className="h-5 w-5" />{n.tab === "positions" ? `Позиции${data.open.length ? ` · ${data.open.length}` : ""}` : n.label}
            </button>
          );
        })}
        <button onClick={() => setMenu((v) => !v)} className={`flex flex-col items-center justify-center gap-1 text-[11px] ${menu ? "text-gold" : "text-muted-foreground"}`}>
          {menu ? <X className="h-5 w-5" /> : <MoreHorizontal className="h-5 w-5" />}Ещё
        </button>
      </nav>
    </div>
  );
}
