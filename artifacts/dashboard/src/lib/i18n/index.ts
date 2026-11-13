/**
 * RU/EN switch. The UI text is written in Russian; in English mode every
 * Russian text node and common text attribute is replaced from en.json
 * (Russian strings of the dashboard and of the API texts it shows; ported from Nihilist / CAB 2026-11-13).
 * Switching language reloads the page so every component re-renders with the new locale.
 */
export type Lang = "ru" | "en";

const STORAGE_KEY = "uiLang";
const ATTRS = ["placeholder", "title", "aria-label", "alt"] as const;
const CYRILLIC = /[А-Яа-яЁё]/;

export function getLang(): Lang {
  try {
    const fromUrl = new URLSearchParams(window.location.search).get("lang");
    if (fromUrl === "en" || fromUrl === "ru")
      localStorage.setItem(STORAGE_KEY, fromUrl);
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "ru" || saved === "en") return saved;
    // Not chosen yet: the language of the Telegram account (Mini App), else of the browser; Russian for
    // Russian / Ukrainian / Belarusian / Kazakh, English for everyone else.
    const tg = (window as unknown as { Telegram?: { WebApp?: { initDataUnsafe?: { user?: { language_code?: string } } } } })
      .Telegram?.WebApp?.initDataUnsafe?.user?.language_code;
    const code = (tg || navigator.language || "ru").toLowerCase();
    return /^(ru|uk|be|kk)/.test(code) ? "ru" : "en";
  } catch {
    return "ru";
  }
}

export function setLang(lang: Lang): void {
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* storage unavailable: the language stays as detected */
  }
  window.location.reload();
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

type Template = { re: RegExp; en: string };

function buildTranslator(dict: Record<string, string>) {
  const exact = new Map<string, string>();
  const templates: Template[] = [];
  const partial: [string, string][] = [];
  for (const [ru, en] of Object.entries(dict)) {
    if (/\{\d+\}/.test(ru)) {
      const pattern = ru
        .split(/(\{\d+\})/)
        .map((part) =>
          /^\{\d+\}$/.test(part)
            ? "(.*?)"
            : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        )
        .join("");
      templates.push({ re: new RegExp(`^${pattern}$`), en });
    } else {
      exact.set(ru, en);
      if (ru.length >= 4) partial.push([ru, en]);
    }
  }
  partial.sort((a, b) => b[0].length - a[0].length);
  const cache = new Map<string, string>();

  function translateCore(text: string): string {
    const hit = exact.get(text);
    if (hit !== undefined) return hit;
    for (const t of templates) {
      const m = t.re.exec(text);
      if (m)
        return t.en.replace(/\{(\d+)\}/g, (_, i) => translateCore(m[Number(i) + 1] ?? "")); // values inside a template are translated too (Nihilist)
    }
    let out = text;
    for (const [ru, en] of partial) {
      if (out.includes(ru)) out = out.split(ru).join(en);
    }
    return out;
  }

  return function translate(raw: string): string {
    if (!CYRILLIC.test(raw)) return raw;
    const cached = cache.get(raw);
    if (cached !== undefined) return cached;
    const lead = /^\s*/.exec(raw)![0];
    const trail = /\s*$/.exec(raw)![0];
    const core = norm(raw);
    const result = lead + translateCore(core) + (core ? trail : "");
    if (cache.size > 5000) cache.clear();
    cache.set(raw, result);
    return result;
  };
}

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "TEXTAREA", "NOSCRIPT", "CODE"]);

function startDomTranslation(translate: (s: string) => string): void {
  const applied = new WeakMap<Node, string>();

  function fixText(node: Text): void {
    const value = node.nodeValue ?? "";
    if (applied.get(node) === value) return;
    const parent = node.parentElement;
    if (parent && SKIP_TAGS.has(parent.tagName)) return;
    const next = translate(value);
    if (next !== value) {
      applied.set(node, next);
      node.nodeValue = next;
    }
  }

  function fixAttrs(el: Element): void {
    for (const name of ATTRS) {
      const value = el.getAttribute(name);
      if (value && CYRILLIC.test(value)) {
        const next = translate(value);
        if (next !== value) el.setAttribute(name, next);
      }
    }
  }

  function fixTree(root: Node): void {
    if (root.nodeType === Node.TEXT_NODE) {
      fixText(root as Text);
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    const el = root as Element;
    if (SKIP_TAGS.has(el.tagName)) return;
    fixAttrs(el);
    const walker = document.createTreeWalker(
      el,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    );
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === Node.TEXT_NODE) fixText(n as Text);
      else fixAttrs(n as Element);
    }
  }

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "characterData") fixText(record.target as Text);
      else if (record.type === "attributes") fixAttrs(record.target as Element);
      else record.addedNodes.forEach(fixTree);
    }
  });
  fixTree(document.body);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...ATTRS],
  });
}

/** Dates and numbers written for "ru-RU" follow the chosen language. */
function patchLocales(): void {
  const swap = (loc: unknown): unknown =>
    typeof loc === "string" && /^ru(-|$)/i.test(loc) ? "en-US" : loc;
  for (const key of [
    "toLocaleString",
    "toLocaleDateString",
    "toLocaleTimeString",
  ] as const) {
    const original = Date.prototype[key] as (
      this: Date,
      l?: unknown,
      o?: unknown,
    ) => string;
    Date.prototype[key] = function (this: Date, l?: unknown, o?: unknown) {
      return original.call(this, swap(l), o);
    } as never;
  }
  const numberOriginal = Number.prototype.toLocaleString as (
    this: number,
    l?: unknown,
    o?: unknown,
  ) => string;
  Number.prototype.toLocaleString = function (
    this: number,
    l?: unknown,
    o?: unknown,
  ) {
    return numberOriginal.call(this, swap(l), o);
  } as never;
  const DateFormat = Intl.DateTimeFormat;
  Intl.DateTimeFormat = function (l?: unknown, o?: unknown) {
    return new DateFormat(swap(l) as string, o as never);
  } as never;
  Object.setPrototypeOf(Intl.DateTimeFormat, DateFormat);
  Object.defineProperty(Intl.DateTimeFormat, "prototype", {
    value: DateFormat.prototype,
  });
  const NumFormat = Intl.NumberFormat;
  Intl.NumberFormat = function (l?: unknown, o?: unknown) {
    return new NumFormat(swap(l) as string, o as never);
  } as never;
  Object.setPrototypeOf(Intl.NumberFormat, NumFormat);
  Object.defineProperty(Intl.NumberFormat, "prototype", {
    value: NumFormat.prototype,
  });
}

export async function installI18n(): Promise<void> {
  if (getLang() !== "en") return;
  document.documentElement.lang = "en";
  patchLocales();
  const { default: dict } = await import("./en.json");
  const translate = buildTranslator(dict as Record<string, string>);
  document.title = translate(document.title);
  const start = () => startDomTranslation(translate);
  if (document.body) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
}
