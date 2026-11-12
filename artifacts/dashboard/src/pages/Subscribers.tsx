import { useEffect, useState } from "react";
import { type Subscriber, type Subscribers as Data, getJson, time } from "../lib/api";
import { Card, type Col, Pill, Segmented, SortTable, Tile } from "../components/ui";

type Show = "all" | "active" | "inactive";

/** Everyone who pressed /start in the bot (owner only, as «Подписчики» in CAB and Nihilist). */
export function Subscribers() {
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [show, setShow] = useState<Show>("all");
  const [q, setQ] = useState("");
  useEffect(() => {
    let alive = true;
    const load = () => getJson<Data>("/api/btc/subscribers")
      .then((d) => { if (alive) { setData(d); setErr(null); } })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    void load();
    const t = setInterval(load, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  if (err) return <Card title="Подписчики"><p className="text-sm text-rose-300">Не загрузилось: {err}</p></Card>;
  if (!data) return <Card title="Подписчики"><p className="text-sm text-muted-foreground">Загружаю…</p></Card>;
  const needle = q.trim().toLowerCase().replace(/^@/, "");
  const rows = data.rows.filter((r) => (show === "all" || (show === "active") === r.active)
    && (!needle || r.chatId.includes(needle) || (r.name ?? "").toLowerCase().includes(needle) || (r.username ?? "").toLowerCase().includes(needle)));
  const cols: Col<Subscriber>[] = [
    { head: "Имя", cell: (r) => r.name ?? <span className="text-muted-foreground">—</span>, sort: (r) => r.name ?? "" },
    { head: "Username", cell: (r) => (r.username ? <a className="text-gold hover:underline" href={`https://t.me/${r.username}`} target="_blank" rel="noreferrer">@{r.username}</a> : "—"), sort: (r) => r.username ?? "" },
    { head: "Chat ID", cell: (r) => r.chatId, sort: (r) => r.chatId },
    { head: "Статус", cell: (r) => <Pill kind={r.active ? "good" : "bad"}>{r.active ? "активна" : "не активна"}</Pill>, sort: (r) => (r.active ? 1 : 0) },
    { head: "Подписка с", cell: (r) => time(r.subscribedAt), sort: (r) => Date.parse(r.subscribedAt) },
    { head: "Изменена", cell: (r) => time(r.updatedAt), sort: (r) => Date.parse(r.updatedAt) },
    { head: "Доставлено", cell: (r) => r.sent, sort: (r) => r.sent },
    { head: "Ошибки", cell: (r) => <span className={r.failed ? "text-rose-300" : ""}>{r.failed}</span>, sort: (r) => r.failed },
    { head: "Последнее сообщение", cell: (r) => time(r.lastSentAt), sort: (r) => (r.lastSentAt ? Date.parse(r.lastSentAt) : null) },
  ];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Tile label="Всего" value={data.totals.all} onClick={() => setShow("all")} />
        <Tile label="Активны" value={data.totals.active} tone="text-emerald-400" sub="получают сигналы" onClick={() => setShow("active")} />
        <Tile label="Не активны" value={data.totals.inactive} tone="text-rose-400" sub="/stop или бот заблокирован" onClick={() => setShow("inactive")} />
        <Tile label="Новые сегодня" value={data.totals.newToday} sub="день по Дубаю" />
      </div>
      <Card title={`Подписчики · ${rows.length}`} right={
        <div className="flex flex-wrap items-center gap-2">
          <Segmented<Show> value={show} options={[["all", "Все"], ["active", "Активны"], ["inactive", "Не активны"]]} onChange={setShow} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Имя, @username, Chat ID"
            className="w-48 rounded-full border border-gold/30 bg-black/60 px-3 py-1 text-xs focus:border-gold focus:outline-none" />
        </div>
      }>
        <SortTable<Subscriber> cols={cols} rows={rows} rowKey={(r) => r.chatId} initial={{ col: "Подписка с", desc: true }} empty="Никого под эти условия."
          card={(r) => (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{r.name ?? "—"}{r.username ? <span className="ml-2 text-gold">@{r.username}</span> : null}</span>
                <Pill kind={r.active ? "good" : "bad"}>{r.active ? "активна" : "не активна"}</Pill>
              </div>
              <div className="mt-1 flex justify-between text-[11px] text-muted-foreground">
                <span>ID {r.chatId} · с {time(r.subscribedAt)}</span><span>доставлено {r.sent}{r.failed ? ` · ошибок ${r.failed}` : ""}</span>
              </div>
            </>
          )} />
        <p className="mt-2 text-xs text-muted-foreground">
          Подписчик — тот, кто нажал /start в боте. Имена берутся из Telegram{data.namesPending ? ` (ещё подгружаются: ${data.namesPending})` : ""}. Сортировка — нажми на заголовок столбца.
        </p>
      </Card>
    </div>
  );
}
