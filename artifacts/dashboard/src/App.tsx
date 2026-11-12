import { useEffect, useState } from "react";
import { type Decision, type Metrics, type OutcomeGroup, PinRequired, type Signal, type Status, asset, getJson, price, setPin, time } from "./lib/api";
import { type Data, type Filter, type Mode, NO_FILTER, type Tab } from "./lib/data";
import { Crown, Segmented } from "./components/ui";
import { Overview } from "./pages/Overview";
import { Positions } from "./pages/Positions";
import { History } from "./pages/History";
import { Patterns } from "./pages/Patterns";
import { Service } from "./pages/Service";

const TABS: Array<[Tab, string]> = [
  ["overview", "Обзор"], ["positions", "Позиции"], ["history", "История"], ["patterns", "Паттерны"], ["service", "Служебное"],
];
const tabFromHash = (): Tab => {
  const h = window.location.hash.replace("#", "") as Tab;
  return TABS.some(([t]) => t === h) ? h : "overview";
};

function PinForm({ onSubmit, error }: { onSubmit: (pin: string) => void; error: string | null }) {
  const [pin, setValue] = useState("");
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-4">
      <img src={asset("brand/login.webp")} alt="" className="absolute inset-0 h-full w-full object-cover opacity-60" />
      <div className="absolute inset-0 bg-gradient-to-t from-black via-black/60 to-black/30" />
      <form className="gold-card relative w-full max-w-xs space-y-3 p-6 backdrop-blur"
        onSubmit={(e) => { e.preventDefault(); onSubmit(pin); }}>
        <div className="flex items-center gap-2 text-gold"><Crown className="h-5 w-7" /><span className="text-xs uppercase tracking-[0.3em]">Bitcoin</span></div>
        <h1 className="brand-title text-3xl leading-none">Margin Master</h1>
        <label className="block text-xs uppercase tracking-widest text-muted-foreground" htmlFor="pin">PIN</label>
        <input id="pin" type="password" inputMode="numeric" autoFocus value={pin} onChange={(e) => setValue(e.target.value)}
          className="w-full rounded-lg border border-gold/40 bg-black/70 px-3 py-2 text-foreground focus:border-gold focus:outline-none" />
        {error && <p className="text-sm text-rose-400">{error}</p>}
        <button className="w-full rounded-lg bg-gold px-3 py-2 font-semibold text-black hover:brightness-110">Войти</button>
        <p className="text-center text-[10px] uppercase tracking-[0.3em] text-gold/70">Discipline · Leverage · Freedom</p>
      </form>
    </main>
  );
}

export default function App() {
  const [tab, setTabState] = useState<Tab>(tabFromHash);
  const [filter, setFilter] = useState<Filter>(NO_FILTER);
  const [days, setDays] = useState<number>(0);
  // Owner 2026-11-12: channel and shadow are never mixed — every number is for the chosen mode (default: channel).
  const [mode, setMode] = useState<Mode>("live");
  const [raw, setRaw] = useState<Data>({ status: null, open: [], closed: [], market: null, outcomes: [], decisions: [] });
  const [error, setError] = useState<string | null>(null);
  const [needPin, setNeedPin] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const setTab = (t: Tab) => { setTabState(t); window.location.hash = t; window.scrollTo({ top: 0 }); };
  const go = (t: Tab, f?: Partial<Filter>) => { if (f) setFilter({ ...NO_FILTER, ...f }); setTab(t); };
  useEffect(() => {
    const on = () => setTabState(tabFromHash());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [status, o, c, market] = await Promise.all([
          getJson<Status>("/api/btc/status"),
          getJson<{ rows: Signal[] }>("/api/btc/signals?status=open&limit=200"),
          getJson<{ rows: Signal[] }>("/api/btc/signals?status=closed&limit=500"),
          getJson<{ candleCloseAt: string | null; metrics: Metrics | null }>("/api/btc/metrics"),
        ]);
        const [oc, dc] = await Promise.all([
          getJson<{ groups: OutcomeGroup[] }>("/api/btc/decisions/outcomes?days=7"),
          getJson<{ rows: Decision[] }>("/api/btc/decisions?limit=100"),
        ]);
        if (!alive) return;
        setRaw({ status, open: o.rows, closed: c.rows, market, outcomes: oc.groups, decisions: dc.rows });
        setError(null); setNeedPin(false); setPinError(null);
      } catch (err) {
        if (!alive) return;
        if (err instanceof PinRequired) { setNeedPin(true); return; }
        setError(err instanceof Error ? err.message : String(err));
      }
    };
    void load();
    const timer = setInterval(load, 15_000);
    return () => { alive = false; clearInterval(timer); };
  }, [reloadKey]);

  if (needPin) {
    return <PinForm error={pinError} onSubmit={(pin) => {
      setPin(pin); setPinError("Проверяю…"); setReloadKey((k) => k + 1);
      setTimeout(() => setPinError("Неверный PIN"), 1500);
    }} />;
  }

  const isLive = (s: Signal) => (mode === "live") === s.live;
  const data: Data = { ...raw, open: raw.open.filter(isLive), closed: raw.closed.filter(isLive) };
  const label = (key: string) => data.status?.patterns.find((p) => p.key === key)?.label ?? key;
  const last = data.status?.stream.lastPrice ?? null;
  const connected = data.status?.stream.connected ?? false;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-gold/20 bg-black/80 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-2">
          <button onClick={() => setTab("overview")} className="flex items-center gap-2">
            <img src={asset("brand/avatar.webp")} alt="" className="h-9 w-9 rounded-full border border-gold/60 object-cover" />
            <div className="text-left leading-tight">
              <div className="flex items-center gap-1 text-gold"><Crown className="h-3 w-4" /><span className="text-[10px] uppercase tracking-[0.3em]">Bitcoin</span></div>
              <div className="brand-title text-lg leading-none">Margin Master</div>
            </div>
          </button>
          <nav className="order-3 flex w-full gap-1 overflow-x-auto md:order-none md:w-auto md:flex-1 md:justify-center">
            {TABS.map(([t, l]) => (
              <button key={t} onClick={() => setTab(t)}
                className={`whitespace-nowrap rounded-full px-3 py-1.5 text-sm transition ${tab === t ? "bg-gold text-black font-semibold" : "text-muted-foreground hover:text-gold"}`}>
                {l}{t === "positions" && data.open.length > 0 ? ` · ${data.open.length}` : ""}
              </button>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <div className="text-right leading-tight">
              <div className="text-sm font-semibold tabular-nums text-foreground">{price(last)}</div>
              <div className={`text-[10px] ${connected ? "text-emerald-400" : "text-rose-400"}`}>● {connected ? "поток на связи" : "нет связи"} · {time(data.status?.scanner.lastCandleCloseAt)}</div>
            </div>
            <Segmented<Mode> value={mode} options={[["live", "Канал"], ["shadow", "Тень"]]} onChange={(m) => { setMode(m); setFilter(NO_FILTER); }} />
            <Segmented<number> value={days} options={[[0, "Всё"], [30, "30 д"], [7, "7 д"]]} onChange={setDays} />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-4 p-4">
        {error && <p className="rounded-lg border border-rose-500/40 bg-rose-500/5 p-3 text-sm text-rose-300">Нет связи с API: {error}</p>}
        {mode === "shadow" && <p className="rounded-lg border border-gold/30 bg-gold/5 p-2 text-center text-xs text-gold">Режим «Тень»: сигналы, которые пишутся и считаются, но не публикуются в канал.</p>}
        {tab === "overview" && <Overview data={data} days={days} mode={mode} go={go} />}
        {tab === "positions" && <Positions data={data} label={label} />}
        {tab === "history" && <History data={data} days={days} label={label} filter={filter} setFilter={setFilter} />}
        {tab === "patterns" && <Patterns data={data} days={days} mode={mode} label={label} go={go} />}
        {tab === "service" && <Service data={raw} label={label} />}
        <footer className="pt-6 text-center text-[10px] uppercase tracking-[0.35em] text-gold/50">Honey badger don't care · время Дубай</footer>
      </main>
    </div>
  );
}
