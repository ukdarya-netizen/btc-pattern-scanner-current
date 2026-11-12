/**
 * «Подписчики» — owner only (owner 2026-11-12: «как в CAB и Нигилисте», ported from Nihilist): one list of everyone
 * who registered (dashboard + bot are one account), stats cards, status filters, search, sort, presence,
 * subscription dates, approve / block / reset password / deactivate / delete.
 */
import { useCallback, useEffect, useState, type ElementType, type ReactElement, type ReactNode } from "react";
import {
  ArrowUpDown, Ban, Bot, Check, Clock, Eye, EyeOff, KeyRound, Loader2, Monitor, PowerOff, Search, ShieldCheck, Trash2,
  UserCheck, Users, X,
} from "lucide-react";
import { del, getJson as get, patch } from "../lib/api";

type Status = "pending" | "approved" | "expired" | "blocked" | "inactive";
type Member = {
  id: number; email: string; name: string; chatId: string | null; telegramUsername: string | null;
  subscribedUntil: string | null; status: Status; notify: boolean; owner: boolean;
  createdAt: string; approvedAt: string | null; lastLoginAt: string | null; lastActivityAt: string | null;
  online: boolean; botBlockedAt: string | null;
};
type Filter = "all" | "active" | "expired" | "inactive" | "blocked" | "pending";
type Sort = "newest" | "oldest" | "months-desc" | "months-asc";
const TZ = "Asia/Dubai";

const access = (m: Member): Exclude<Filter, "all"> => (m.status === "approved" ? "active" : m.status);

const fmtDateTime = (s: string | null | undefined) =>
  !s ? "—" : new Date(s).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short", timeZone: TZ });

function fmtLastActivity(s: string | null): string {
  if (!s) return "ещё не входил(а)";
  const sec = Math.max(0, Math.floor((Date.now() - new Date(s).getTime()) / 1000));
  if (sec < 60) return "только что";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} мин. назад`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} ч. назад` : fmtDateTime(s);
}

function fmtTimeLeft(s: string | null): string | null {
  if (!s) return null;
  const ms = new Date(s).getTime() - Date.now();
  if (ms <= 0) return null;
  const m = Math.floor(ms / 60_000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return d > 0 ? `${d} д ${h} ч` : h > 0 ? `${h} ч ${m % 60} мин` : `${m % 60} мин`;
}

function months(m: Member): number {
  if (!m.subscribedUntil) return 0;
  const start = m.approvedAt ?? m.createdAt;
  return Math.max(0, (new Date(m.subscribedUntil).getTime() - new Date(start).getTime()) / (365.2425 / 12 * 86_400_000));
}
const fmtMonths = (m: Member) => {
  const v = months(m);
  return v <= 0 ? "не задан" : `${(Math.round(v * 10) / 10).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} мес.`;
};

function toDateTimeInput(s: string | null): string {
  if (!s) return "";
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(s)).filter((x) => x.type !== "literal").map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

function statusLabel(m: Member): string {
  if (m.owner) return "Владелец · доступ без срока";
  if (m.botBlockedAt && !m.notify) return "Dashboard активен · бот заблокирован пользователем";
  return {
    blocked: "Dashboard + бот · доступ заблокирован",
    pending: "Dashboard + бот · ожидает одобрения",
    approved: m.notify ? "Dashboard + бот · подписка активна" : "Dashboard активен · сигналы выключены (/unsubscribe)",
    expired: "Dashboard + бот · подписка истекла",
    inactive: "Dashboard + бот · доступ деактивирован",
  }[m.status];
}
const LABEL_TONE: Record<Exclude<Filter, "all">, string> = {
  active: "text-emerald-400", expired: "text-rose-400", blocked: "text-rose-400", pending: "text-amber-400", inactive: "text-muted-foreground",
};

const Badge = ({ cls, children, title }: { cls: string; children: ReactNode; title?: string }) =>
  <span title={title} className={`inline-flex items-center gap-1 border px-1.5 py-0.5 text-xs ${cls}`}>{children}</span>;

function PasswordDialog({ m, onClose }: { m: Member; onClose: () => void }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [show, setShow] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (pw.length < 6) { setErr("Минимум 6 символов"); return; }
    if (pw !== pw2) { setErr("Пароли не совпадают"); return; }
    setSaving(true); setErr(null);
    try { await patch(`/api/admin/users/${m.id}`, { newPassword: pw }); onClose(); } catch (e) { setErr(e instanceof Error ? e.message : "Ошибка сервера"); }
    setSaving(false);
  };
  const field = (v: string, set: (v: string) => void, ph: string) => (
    <div className="relative">
      <input type={show ? "text" : "password"} value={v} onChange={(e) => { set(e.target.value); setErr(null); }} placeholder={ph}
        autoComplete="new-password" onKeyDown={(e) => { if (e.key === "Enter") void save(); }}
        className="h-10 w-full border border-border bg-background px-3 pr-9 text-sm outline-none focus:border-gold" />
      <button type="button" tabIndex={-1} onClick={() => setShow((s) => !s)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground">
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4" onClick={onClose}>
      <div className="gold-card w-full max-w-sm space-y-3 p-5" onClick={(e) => e.stopPropagation()}>
        <h3 className="flex items-center gap-2 font-semibold"><KeyRound className="size-4 text-gold" />Сброс пароля</h3>
        <p className="text-sm text-muted-foreground">Пользователь: <span className="font-medium text-foreground">{m.name}</span></p>
        <p className="text-xs text-muted-foreground">Пользователю придёт сообщение в бот, что пароль изменён администратором.</p>
        {field(pw, setPw, "Новый пароль — минимум 6 символов")}
        {field(pw2, setPw2, "Повторите пароль")}
        {err && <p className="text-xs text-rose-400">{err}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button onClick={onClose} disabled={saving} className="h-9 border border-border px-4 text-sm">Отмена</button>
          <button onClick={() => void save()} disabled={saving || !pw || !pw2} className="flex h-9 items-center gap-1.5 rounded-lg bg-gold px-4 text-sm font-semibold text-black disabled:opacity-60">
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : <KeyRound className="size-3.5" />}Сохранить
          </button>
        </div>
      </div>
    </div>
  );
}

function Row({ m, refresh }: { m: Member; refresh: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [date, setDate] = useState(toDateTimeInput(m.subscribedUntil));
  const [chat, setChat] = useState(m.chatId ?? "");
  const [err, setErr] = useState("");
  const [pwOpen, setPwOpen] = useState(false);
  useEffect(() => setDate(toDateTimeInput(m.subscribedUntil)), [m.subscribedUntil]);
  useEffect(() => { setChat(m.chatId ?? ""); setErr(""); }, [m.chatId]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key); setErr("");
    try { await fn(); refresh(); } catch (e) { setErr(e instanceof Error ? e.message : "Ошибка"); }
    setBusy(null);
  };
  const act = (a: "approve" | "block" | "deactivate" | "delete") => {
    if (a === "delete" && !window.confirm(`Удалить «${m.name}»?\nЭто действие нельзя отменить.`)) return;
    if (a === "deactivate" && !window.confirm(`Деактивировать «${m.name}»?\nДоступ будет закрыт, но пользователь сможет повторно запросить его.`)) return;
    void run(a, () => {
      if (a === "delete") return del(`/api/admin/users/${m.id}`);
      if (a === "approve") {
        // Default period: 1 calendar month from now (as CAB), unless an active date is already set.
        const until = new Date(); until.setMonth(until.getMonth() + 1);
        const keep = m.subscribedUntil && new Date(m.subscribedUntil).getTime() > Date.now();
        return patch(`/api/admin/users/${m.id}`, { status: "approved", ...(keep ? {} : { subscribedUntil: until.toISOString() }) });
      }
      return patch(`/api/admin/users/${m.id}`, { status: a === "block" ? "blocked" : "inactive" });
    });
  };
  const saveDate = (v: string) => {
    const d = v ? new Date(`${v}:00+04:00`) : null;
    void run("date", () => patch(`/api/admin/users/${m.id}`, { subscribedUntil: d && !Number.isNaN(d.getTime()) ? d.toISOString() : null }));
  };
  const saveChat = (v: string) => {
    if (v.trim() === (m.chatId ?? "")) return;
    void run("chat", () => patch(`/api/admin/users/${m.id}`, { chatId: v.trim() || null }).catch((e) => { setChat(m.chatId ?? ""); throw e; }));
  };

  const a = access(m);
  const expired = m.status === "expired";
  const dashBadge = {
    approved: <Badge cls="text-emerald-400 border-emerald-500/30 bg-emerald-500/10"><Monitor className="size-3" />Dashboard: активен</Badge>,
    expired: <Badge cls="text-rose-400 border-rose-500/30 bg-rose-500/10"><Clock className="size-3" />Dashboard: подписка истекла</Badge>,
    pending: <Badge cls="text-amber-400 border-amber-400/30 bg-amber-400/10"><Clock className="size-3" />Dashboard: ожидает</Badge>,
    blocked: <Badge cls="text-rose-400 border-rose-500/30 bg-rose-500/10"><Ban className="size-3" />Dashboard: заблокирован</Badge>,
    inactive: <Badge cls="text-muted-foreground border-border"><PowerOff className="size-3" />Dashboard: деактивирован</Badge>,
  }[m.status];
  const botBadge = m.botBlockedAt && !m.notify
    ? <Badge cls="text-rose-400 border-rose-500/40 bg-rose-500/10" title={`Зафиксировано: ${fmtDateTime(m.botBlockedAt)}`}><Ban className="size-3" />Пользователь заблокировал бота</Badge>
    : m.status === "approved" && m.notify ? <Badge cls="text-sky-400 border-sky-400/30 bg-sky-400/10"><Bot className="size-3" />Бот: подписка активна</Badge>
      : m.status === "expired" ? <Badge cls="text-rose-400 border-rose-500/30 bg-rose-500/10"><Clock className="size-3" />Бот: подписка истекла</Badge>
        : <Badge cls="text-muted-foreground border-border"><Bot className="size-3" />Бот: отключён</Badge>;
  const presence = m.online
    ? <Badge cls="text-emerald-400 border-emerald-500/30 bg-emerald-500/10" title={`Активность: ${fmtDateTime(m.lastActivityAt)}`}><span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />Онлайн</Badge>
    : <Badge cls="text-muted-foreground border-border" title={m.lastActivityAt ? `Активность: ${fmtDateTime(m.lastActivityAt)}` : "Пользователь ещё не открывал dashboard"}><span className="size-1.5 rounded-full bg-muted-foreground/50" />Не в сети</Badge>;
  const icon = (k: string, el: ReactElement) => (busy === k ? <Loader2 className="size-3.5 animate-spin" /> : el);
  const btn = (k: string, title: string, cls: string, onClick: () => void, el: ReactElement) => (
    <button title={title} disabled={!!busy} onClick={onClick} className={`grid size-7 place-items-center ${cls}`}>{icon(k, el)}</button>
  );
  const left = fmtTimeLeft(m.subscribedUntil);

  return (
    <div className="border-b border-border px-4 py-3 last:border-0 hover:bg-white/[0.02]">
      <div className="flex flex-wrap items-start gap-3 sm:flex-nowrap">
        <div className="min-w-0 flex-1 basis-full sm:basis-auto">
          <p className="truncate text-sm font-medium">{m.name}{m.owner && <ShieldCheck className="ml-1.5 inline size-3.5 text-gold" />}</p>
          <p className="truncate text-xs text-muted-foreground">{m.email}</p>
          <p className="truncate font-mono text-xs text-muted-foreground/70">{[m.telegramUsername ? `@${m.telegramUsername}` : null, m.chatId ? `ID ${m.chatId}` : null].filter(Boolean).join(" · ") || "—"}</p>
        </div>
        <div className="hidden shrink-0 flex-col items-end gap-0.5 text-xs text-muted-foreground sm:flex">
          <span>Регистрация: {fmtDateTime(m.createdAt)}</span>
          <span className={m.lastLoginAt ? "text-foreground/80" : ""}>Последний вход: {m.lastLoginAt ? fmtDateTime(m.lastLoginAt) : "ещё не входил(а)"}</span>
          <span>Активность: {fmtLastActivity(m.lastActivityAt)}</span>
        </div>
        <div className="flex shrink-0 flex-wrap items-start gap-1 sm:flex-col sm:items-end">{dashBadge}{presence}{botBadge}</div>
        {!m.owner && (
          <div className="flex shrink-0 items-center gap-0.5">
            {m.status !== "approved" && btn("approve", "Одобрить", "text-emerald-400 hover:bg-emerald-500/10", () => act("approve"), <Check className="size-3.5" />)}
            {m.status !== "blocked" && btn("block", "Заблокировать", "text-amber-400 hover:bg-amber-400/10", () => act("block"), <X className="size-3.5" />)}
            {btn("pw", "Сбросить пароль", "text-sky-400 hover:bg-sky-500/10", () => setPwOpen(true), <KeyRound className="size-3.5" />)}
            {m.status === "approved" && btn("deactivate", "Деактивировать", "text-orange-400 hover:bg-orange-500/10", () => act("deactivate"), <PowerOff className="size-3.5" />)}
            {btn("delete", "Удалить", "text-rose-400 hover:bg-rose-500/10", () => act("delete"), <Trash2 className="size-3.5" />)}
          </div>
        )}
        {m.owner && btn("pw", "Сбросить пароль", "text-sky-400 hover:bg-sky-500/10", () => setPwOpen(true), <KeyRound className="size-3.5" />)}
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        {!m.owner && (
          <>
            <span className="font-mono text-foreground/80">Срок: {fmtMonths(m)}</span>
            <span className="text-muted-foreground">Подписка (Дубай): с <span className="text-foreground/80">{fmtDateTime(m.approvedAt ?? m.createdAt)}</span> · до:</span>
            <input type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} onBlur={(e) => saveDate(e.target.value)}
              className={`h-7 border bg-transparent px-1.5 font-mono ${expired ? "border-rose-500/50 text-rose-400" : date ? "border-emerald-500/40 text-emerald-400" : "border-border text-muted-foreground"}`} />
            {busy === "date" && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
            {date && busy !== "date" && <button title="Очистить" onClick={() => { setDate(""); saveDate(""); }} className="text-muted-foreground hover:text-rose-400"><X className="size-3" /></button>}
            {date && !expired && busy !== "date" && <span className="text-emerald-400">✓ активна{left && <span className="ml-1 text-muted-foreground">· ещё {left}</span>}</span>}
            {expired && <span className="text-rose-400">истекла</span>}
          </>
        )}
        <span className={`ml-auto ${m.owner ? "text-gold" : LABEL_TONE[a]}`}>{statusLabel(m)}</span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">Telegram Chat ID:</span>
        <input inputMode="numeric" value={chat} onChange={(e) => { setChat(e.target.value); setErr(""); }} onBlur={(e) => saveChat(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} placeholder="Например, 6964248629"
          className="h-6 w-44 border border-border bg-transparent px-1.5 font-mono" />
        {busy === "chat" && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
        {err && <span className="text-rose-400">{err}</span>}
      </div>
      {pwOpen && <PasswordDialog m={m} onClose={() => setPwOpen(false)} />}
    </div>
  );
}

export function Subscribers() {
  const [members, setMembers] = useState<Member[]>([]);
  const [subs, setSubs] = useState<{ active: number; newToday: number } | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<Sort>("newest");
  const [filter, setFilter] = useState<Filter>("all");
  const load = useCallback(async () => {
    try {
      const d = await get<{ members: Member[]; subscribers: { active: number; newToday: number } }>("/api/admin/members");
      setMembers(d.members); setSubs(d.subscribers);
    } catch { /* keep the last list */ }
    setLoading(false);
  }, []);
  useEffect(() => { void load(); const t = window.setInterval(() => void load(), 30_000); return () => window.clearInterval(t); }, [load]);

  const q = search.trim().toLowerCase().replace(/^@/, "");
  const shown = members
    .filter((m) => (filter === "all" || access(m) === filter)
      && (!q || [m.chatId ?? "", m.email, m.name, m.telegramUsername ?? ""].some((v) => v.toLowerCase().includes(q))))
    .sort((a, b) => {
      const ta = new Date(a.createdAt).getTime(), tb = new Date(b.createdAt).getTime();
      if (sort === "newest") return tb - ta;
      if (sort === "oldest") return ta - tb;
      const d = months(a) - months(b);
      return d !== 0 ? (sort === "months-desc" ? -d : d) : tb - ta;
    });
  const n = (f: Filter) => (f === "all" ? members.length : members.filter((m) => access(m) === f).length);

  const cards: Array<{ f: Filter; label: string; icon: ElementType; color: string; ring: string }> = [
    { f: "all", label: "Всего", icon: Users, color: "text-foreground", ring: "ring-foreground/30" },
    { f: "active", label: "Доступ активен", icon: UserCheck, color: "text-emerald-400", ring: "ring-emerald-500/40" },
    { f: "expired", label: "Подписка истекла", icon: Clock, color: "text-orange-400", ring: "ring-orange-400/40" },
    { f: "inactive", label: "Неактивны", icon: PowerOff, color: "text-muted-foreground", ring: "ring-muted-foreground/40" },
    { f: "blocked", label: "Заблокированные", icon: Ban, color: "text-rose-400", ring: "ring-rose-500/40" },
  ];
  const pills: Array<{ f: Filter; label: string; cls?: string }> = [
    { f: "all", label: "Все" },
    { f: "active", label: "Доступ активен", cls: "bg-emerald-500/15 text-emerald-400 border-emerald-500/40" },
    { f: "expired", label: "EXPIRED", cls: "bg-rose-500/15 text-rose-400 border-rose-500/40" },
    { f: "inactive", label: "Неактивны" },
    { f: "blocked", label: "Заблок.", cls: "bg-rose-500/15 text-rose-400 border-rose-500/40" },
    { f: "pending", label: "Ожидают", cls: "bg-amber-400/15 text-amber-400 border-amber-400/40" },
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {cards.map(({ f, label, icon: Icon, color, ring }) => (
          <button key={f} onClick={() => setFilter(f)}
            className={`gold-card p-4 text-left transition-all ${filter === f ? `ring-1 ${ring}` : ""}`}>
            <div className={`mb-1 flex items-center gap-2 ${color}`}><Icon className="size-4" /><span className="font-mono text-xs uppercase">{label}</span></div>
            <p className="text-2xl font-bold">{n(f)}</p>
          </button>
        ))}
        <div className="gold-card p-4">
          <div className="mb-1 flex items-center gap-2 text-violet-400"><Users className="size-4" /><span className="font-mono text-xs uppercase">Подписчиков</span></div>
          <p className="text-2xl font-bold">{subs?.active ?? 0}</p>
          {subs && <p className="mt-1 text-[10px] text-muted-foreground">+{subs.newToday} сегодня</p>}
        </div>
      </div>
      <div className="space-y-3">
        <div className="relative max-w-sm">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Email, Chat ID, @ник или имя…"
            className="h-8 w-full border border-border bg-background pl-8 pr-8 text-sm outline-none focus:border-gold" />
          {search && <button onClick={() => setSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"><X className="size-3.5" /></button>}
        </div>
        <div className="flex flex-wrap gap-2">
          {pills.map(({ f, label, cls }) => (
            <button key={f} onClick={() => setFilter(f)}
              className={`flex items-center gap-1.5 border px-3 py-1 font-mono text-xs ${filter === f ? (cls ?? "border-foreground/30 bg-foreground/10 text-foreground") : "border-border text-muted-foreground hover:text-foreground"}`}>
              {label}<span className={`text-[10px] font-bold tabular-nums ${filter === f ? "" : "opacity-60"}`}>{n(f)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="gold-card">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="text-sm font-medium tracking-wider">СПИСОК УЧАСТНИКОВ</span>
          <div className="flex items-center gap-3">
            {(q || filter !== "all") && <span className="text-xs text-muted-foreground">{shown.length} из {members.length}</span>}
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              <ArrowUpDown className="size-3" />
              <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="h-7 bg-black text-xs text-foreground outline-none">
                <option value="newest">Новые первыми</option>
                <option value="oldest">Старые первыми</option>
                <option value="months-desc">Больше месяцев подписки</option>
                <option value="months-asc">Меньше месяцев подписки</option>
              </select>
            </label>
          </div>
        </div>
        {shown.length ? shown.map((m) => <Row key={m.id} m={m} refresh={() => void load()} />)
          : <p className="px-4 py-8 text-center text-sm text-muted-foreground">{loading ? "Загрузка…" : "Нет участников"}</p>}
      </div>
    </div>
  );
}
