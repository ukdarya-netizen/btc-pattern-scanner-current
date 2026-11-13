/**
 * Login, access request (registration) and password reset — the CAB / Nihilist path (owner 2026-11-12),
 * in the Bitcoin Margin Master look.
 */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { CheckCircle2, Eye, EyeOff, Loader2 } from "lucide-react";
import { Crown } from "../components/ui";
import { asset, post, saveSession, type Session } from "../lib/api";
import { LanguageToggle } from "../components/LanguageToggle";

function useBot(): string | null {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/auth/bot").then((r) => r.json()).then((d: { username?: string | null }) => setName(d.username ?? null)).catch(() => undefined);
  }, []);
  return name;
}

function BotLink({ bot }: { bot: string | null }) {
  return bot
    ? <a href={`https://t.me/${bot}`} target="_blank" rel="noreferrer" className="font-mono text-gold hover:underline">@{bot}</a>
    : <span className="text-foreground">Bitcoin Margin Master</span>;
}

function Shell({ title, sub, children }: { title: string; sub: string; children: ReactNode }) {
  return (
    <div className="relative flex min-h-[100dvh] items-center justify-center overflow-hidden p-4">
      <img src={asset("brand/login.webp")} alt="" className="absolute inset-0 h-full w-full object-cover opacity-50" />
      <div className="absolute inset-0 bg-gradient-to-t from-black via-black/70 to-black/40" />
      <LanguageToggle className="absolute right-4 top-4 z-10 bg-black/60" />
      <div className="relative w-full max-w-sm space-y-5">
        <div className="text-center">
          <img src={asset("brand/avatar.webp")} alt="" className="mx-auto h-20 w-20 rounded-full border border-gold/60 object-cover" />
          <div className="mt-3 flex items-center justify-center gap-2 text-gold"><Crown className="h-4 w-6" /><span className="text-xs uppercase tracking-[0.3em]">Bitcoin</span></div>
          <h1 className="brand-title text-4xl leading-none">Margin Master</h1>
        </div>
        <div className="gold-card p-6 backdrop-blur">
          <h2 className="text-xl font-semibold">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{sub}</p>
          <div className="mt-5">{children}</div>
        </div>
        <p className="text-center text-[10px] uppercase tracking-[0.3em] text-gold/70">Discipline · Leverage · Freedom</p>
      </div>
    </div>
  );
}

const inputCls = "h-11 w-full rounded-lg border border-gold/30 bg-black/70 px-3 text-sm outline-none focus:border-gold";
const btnCls = "flex h-11 w-full items-center justify-center rounded-lg bg-gold font-semibold text-black transition hover:brightness-110 disabled:opacity-60";

function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return <label className="block space-y-1.5"><span className="text-sm font-medium">{label}</span>{children}</label>;
}

function Password({ value, onChange, placeholder, show, toggle, auto }: {
  value: string; onChange: (v: string) => void; placeholder: string; show: boolean; toggle: () => void; auto: string;
}) {
  return (
    <div className="relative">
      <input type={show ? "text" : "password"} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        required minLength={auto === "current-password" ? undefined : 6} autoComplete={auto} className={`${inputCls} pr-10`} />
      <button type="button" tabIndex={-1} onClick={toggle} className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}

const ErrorBox = ({ children }: { children: ReactNode }) =>
  <div className="space-y-1 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">{children}</div>;

export function Login({ onLogin, notice }: { onLogin: (s: Session) => void; notice?: string | null }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState(notice ?? "");
  const [loading, setLoading] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(""); setLoading(true);
    try {
      const s = await post<Session>("/api/auth/login", { email, password });
      saveSession(s);
      onLogin(s);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Нет соединения с сервером");
    }
    setLoading(false);
  };
  return (
    <Shell title="Вход в аккаунт" sub="Войдите в свой аккаунт">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required autoComplete="email" autoFocus className={inputCls} /></Field>
        <Field label="Пароль"><Password value={password} onChange={setPassword} placeholder="••••••••" show={show} toggle={() => setShow((v) => !v)} auto="current-password" /></Field>
        {error && (
          <ErrorBox>
            <p>{error}</p>
            {error === "Доступ заблокирован" && <p className="text-muted-foreground">Вы можете <a href="#register" className="font-medium text-gold hover:underline">запросить доступ заново</a>.</p>}
          </ErrorBox>
        )}
        <button className={btnCls} disabled={loading}>{loading && <Loader2 className="mr-2 size-4 animate-spin" />}Войти</button>
      </form>
      <p className="mt-4 text-center text-sm text-muted-foreground">Нет аккаунта? <a href="#register" className="text-gold hover:underline">Запросить доступ</a></p>
      <p className="mt-2 text-center text-sm"><a href="#reset-password" className="text-gold hover:underline">Забыли пароль?</a></p>
      <p className="mt-4 rounded-lg border border-gold/20 bg-gold/5 px-3 py-2 text-center text-xs leading-relaxed text-muted-foreground">
        Новым пользователям после оплаты нажмите «Запросить доступ» и пройдите регистрацию. По вопросам — @The_Lucy_x.
      </p>
    </Shell>
  );
}

export function Register() {
  const bot = useBot();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [chatId, setChatId] = useState("");
  const [telegramUsername, setTelegramUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState<null | { autoApproved: boolean }>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (password !== confirm) { setError("Пароли не совпадают"); return; }
    setLoading(true);
    try {
      const r = await post<{ autoApproved?: boolean }>("/api/auth/register", { name, email, chatId, telegramUsername, password });
      setDone({ autoApproved: Boolean(r.autoApproved) });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Нет соединения с сервером");
    }
    setLoading(false);
  };
  return (
    <Shell title="Запрос доступа" sub="Доступ открывается после проверки подписки">
      {done ? (
        <div className="space-y-3 py-4 text-center">
          <CheckCircle2 className="mx-auto size-12 text-emerald-400" />
          {done.autoApproved ? (
            <><p className="font-medium">Добро пожаловать!</p><p className="text-sm text-muted-foreground">Аккаунт создан и сразу одобрен. Можно войти прямо сейчас.</p></>
          ) : (
            <><p className="font-medium">Запрос отправлен!</p><p className="text-sm text-muted-foreground">Администратор проверит вашу подписку и одобрит доступ. После этого войдите с указанными email и паролем.</p></>
          )}
          <a href="#login" className="mt-2 inline-flex h-10 items-center rounded-lg border border-gold/30 px-5 text-sm hover:border-gold">{done.autoApproved ? "Войти" : "Вернуться ко входу"}</a>
        </div>
      ) : (
        <>
          <form onSubmit={submit} className="space-y-4">
            <Field label="Имя и фамилия"><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Иван Иванов" required autoFocus className={inputCls} /></Field>
            <Field label="Email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required autoComplete="email" className={inputCls} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={<>Telegram Chat ID <span className="text-rose-400">*</span></>}>
                <input value={chatId} onChange={(e) => setChatId(e.target.value.replace(/\D/g, ""))} placeholder="123456789" required inputMode="numeric" className={inputCls} />
              </Field>
              <Field label="Ник в Telegram"><input value={telegramUsername} onChange={(e) => setTelegramUsername(e.target.value)} placeholder="@username" className={inputCls} /></Field>
            </div>
            <p className="-mt-1 text-xs text-muted-foreground">
              <span className="font-medium text-rose-400">Chat ID</span> можно узнать командой /myid в меню Telegram-бота <BotLink bot={bot} />
            </p>
            <Field label="Пароль для входа"><Password value={password} onChange={setPassword} placeholder="Минимум 6 символов" show={show} toggle={() => setShow((v) => !v)} auto="new-password" /></Field>
            <Field label="Повторите пароль"><Password value={confirm} onChange={setConfirm} placeholder="Повторите пароль" show={show} toggle={() => setShow((v) => !v)} auto="new-password" /></Field>
            {error && <ErrorBox><p>{error}</p></ErrorBox>}
            <button className={btnCls} disabled={loading}>{loading && <Loader2 className="mr-2 size-4 animate-spin" />}Отправить запрос</button>
          </form>
          <p className="mt-4 text-center text-sm text-muted-foreground">Уже есть аккаунт? <a href="#login" className="text-gold hover:underline">Войти</a></p>
        </>
      )}
    </Shell>
  );
}

export function ResetPassword() {
  const bot = useBot();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (password !== confirm) { setError("Пароли не совпадают"); return; }
    if (password.length < 6) { setError("Пароль должен быть не менее 6 символов"); return; }
    setLoading(true);
    try {
      await post("/api/auth/reset-confirm", { email, code: code.trim(), newPassword: password });
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Нет соединения с сервером");
    }
    setLoading(false);
  };
  return (
    <Shell title="Сброс пароля" sub="Получи код через Telegram-бот и задай новый пароль">
      {done ? (
        <div className="space-y-3 py-4 text-center">
          <CheckCircle2 className="mx-auto size-12 text-emerald-400" />
          <p className="font-medium">Пароль успешно изменён!</p>
          <p className="text-sm text-muted-foreground">Теперь можно войти с новым паролем.</p>
          <a href="#login" className="mt-2 inline-flex h-10 items-center rounded-lg border border-gold/30 px-5 text-sm hover:border-gold">Войти</a>
        </div>
      ) : (
        <>
          <div className="mb-4 space-y-1 rounded-lg border border-gold/20 bg-gold/5 px-3 py-3 text-sm leading-relaxed text-muted-foreground">
            <p className="font-medium text-foreground">Как получить код:</p>
            <p>1. Напиши <span className="font-mono text-gold">/resetpassword</span> боту <BotLink bot={bot} /> — код придёт в личный чат с ботом</p>
            <p>2. Введи полученный 6-значный код ниже</p>
          </div>
          <form onSubmit={submit} className="space-y-4">
            <Field label="Email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" required autoComplete="email" autoFocus className={inputCls} /></Field>
            <Field label="Код из бота"><input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="123456" required inputMode="numeric" maxLength={6} className={inputCls} /></Field>
            <Field label="Новый пароль"><Password value={password} onChange={setPassword} placeholder="Минимум 6 символов" show={show} toggle={() => setShow((v) => !v)} auto="new-password" /></Field>
            <Field label="Повторите пароль"><Password value={confirm} onChange={setConfirm} placeholder="Повторите пароль" show={show} toggle={() => setShow((v) => !v)} auto="new-password" /></Field>
            {error && <ErrorBox><p>{error}</p></ErrorBox>}
            <button className={btnCls} disabled={loading}>{loading && <Loader2 className="mr-2 size-4 animate-spin" />}Сменить пароль</button>
          </form>
          <p className="mt-4 text-center text-sm"><a href="#login" className="text-gold hover:underline">Вернуться ко входу</a></p>
        </>
      )}
    </Shell>
  );
}
