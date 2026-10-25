import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/**
 * Translations. English text is the key: `t('Start a brew')`, with `{name}` placeholders filled from `vars`.
 * Plurals: `tp(count, '{count} reading', '{count} readings')`; catalogues give each plural category the language
 * needs (Intl.PluralRules). Catalogues live in ./locales/<id>.json and are loaded when picked.
 * `npm run i18n` lists the strings to translate and checks every catalogue.
 */

export type Vars = Record<string, string | number>;
export type PluralEntry = Partial<Record<Intl.LDMLPluralRule, string>>;
export type Catalog = Record<string, string | PluralEntry>;

export const LOCALES = [
  { id: 'en', name: 'English' },
  { id: 'de', name: 'Deutsch' },
  { id: 'es', name: 'Español' },
  { id: 'fr', name: 'Français' },
  { id: 'it', name: 'Italiano' },
  { id: 'nl', name: 'Nederlands' },
  { id: 'pl', name: 'Polski' },
  { id: 'pt-BR', name: 'Português (Brasil)' },
] as const;

export type LocaleId = (typeof LOCALES)[number]['id'];

const STORAGE_KEY = 'rapthooker.locale';
const loaders = import.meta.glob<{ default: Catalog }>('./locales/*.json');

let current: { locale: LocaleId; catalog: Catalog; plural: Intl.PluralRules } = {
  locale: 'en',
  catalog: {},
  plural: new Intl.PluralRules('en'),
};

const fill = (text: string, vars?: Vars): string =>
  vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : text;

/** Translates `text` into the current language, filling `{placeholders}`. */
export function t(text: string, vars?: Vars): string {
  const entry = current.catalog[text];
  return fill(typeof entry === 'string' && entry ? entry : text, vars);
}

/**
 * Like t(), for a short word that means different things in different places (e.g. 'Light' as a theme and as a
 * smoothing level): the catalogue key is `<context>::<text>`, so each can be translated on its own.
 */
export function tc(context: string, text: string, vars?: Vars): string {
  const entry = current.catalog[`${context}::${text}`];
  return fill(typeof entry === 'string' && entry ? entry : text, vars);
}

/** Translates a count-dependent phrase; `{count}` is filled in automatically. */
export function tp(count: number, one: string, other: string, vars?: Vars): string {
  const all = { count: count.toLocaleString(current.locale), ...vars };
  const entry = current.catalog[`${one}|${other}`];
  if (entry && typeof entry === 'object') {
    const text = entry[current.plural.select(count)] ?? entry.other;
    if (text) return fill(text, all);
  }
  return fill(count === 1 ? one : other, all);
}

/** The language in use, for Intl number and date formatting. */
export const currentLocale = (): LocaleId => current.locale;

/** Switches the language with an already-loaded catalogue (tests, and the provider). */
export function setCatalog(locale: LocaleId, catalog: Catalog): void {
  current = { locale, catalog, plural: new Intl.PluralRules(locale) };
}

/**
 * Marks text to translate later with `t(value)` (e.g. labels kept in a constant array), so `npm run i18n` finds it.
 * Returns the text unchanged.
 */
export const tk = <T extends string>(text: T): T => text;

/** The best match for the browser's languages, or English. */
export function browserLocale(languages: readonly string[] = navigator.languages ?? [navigator.language]): LocaleId {
  for (const lang of languages) {
    const exact = LOCALES.find((l) => l.id.toLowerCase() === lang.toLowerCase());
    if (exact) return exact.id;
    const base = lang.split('-')[0]!.toLowerCase();
    const loose = LOCALES.find((l) => l.id.split('-')[0]!.toLowerCase() === base);
    if (loose) return loose.id;
  }
  return 'en';
}

export function savedLocale(): LocaleId | null {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return LOCALES.some((l) => l.id === saved) ? (saved as LocaleId) : null;
  } catch {
    return null;
  }
}

async function load(locale: LocaleId): Promise<Catalog> {
  if (locale === 'en') return {};
  const loader = loaders[`./locales/${locale}.json`];
  return loader ? (await loader()).default : {};
}

/** Loads a language before the app first renders, so it doesn't flash English. */
export async function initI18n(): Promise<void> {
  const locale = savedLocale() ?? browserLocale();
  try {
    setCatalog(locale, await load(locale));
  } catch (err) {
    console.warn('could not load translations', err);
  }
  document.documentElement.lang = current.locale;
}

interface I18nContext {
  locale: LocaleId;
  /** null: following the browser. */
  choice: LocaleId | null;
  setLocale: (locale: LocaleId | null) => void;
}

const Ctx = createContext<I18nContext>({ locale: 'en', choice: null, setLocale: () => undefined });

/** Re-renders everything below it when the language changes (via `key`). */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setCurrent] = useState<LocaleId>(current.locale);
  const [choice, setChoice] = useState<LocaleId | null>(savedLocale);

  const setLocale = useCallback((next: LocaleId | null) => {
    try {
      if (next) localStorage.setItem(STORAGE_KEY, next);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Private browsing: the choice lasts until the page closes.
    }
    setChoice(next);
    const target = next ?? browserLocale();
    void load(target).then((catalog) => {
      setCatalog(target, catalog);
      document.documentElement.lang = target;
      setCurrent(target);
    });
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo(() => ({ locale, choice, setLocale }), [locale, choice, setLocale]);
  return (
    <Ctx.Provider value={value}>
      <div key={locale} style={{ display: 'contents' }}>
        {children}
      </div>
    </Ctx.Provider>
  );
}

export const useI18n = (): I18nContext => useContext(Ctx);
