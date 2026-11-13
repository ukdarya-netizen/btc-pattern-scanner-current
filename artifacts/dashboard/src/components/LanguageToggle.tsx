import { getLang, setLang, type Lang } from "../lib/i18n";

const OPTIONS: Array<{ lang: Lang; label: string; title: string }> = [
  { lang: "ru", label: "RU", title: "Русский" },
  { lang: "en", label: "EN", title: "English" },
];

/** RU / EN switch as in CAB / Nihilist; choosing a language reloads the page. */
export function LanguageToggle({ className = "" }: { className?: string }) {
  const current = getLang();
  return (
    <div className={`inline-flex overflow-hidden rounded-full border border-gold/30 text-[11px] font-semibold ${className}`}>
      {OPTIONS.map((o) => (
        <button key={o.lang} type="button" aria-pressed={current === o.lang} title={o.title}
          onClick={() => { if (current !== o.lang) setLang(o.lang); }}
          className={`px-2.5 py-1 leading-none transition ${current === o.lang ? "bg-gold text-black" : "text-muted-foreground hover:text-gold"}`}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
