import catalogs from './locales.json' with { type: 'json' };

/**
 * Words on screen images, in the language the address asks for. The English text is the key, as in the web app: the
 * translations are the web app's own (src/web/app/i18n/locales), and `npm run i18n` copies the ones used here into
 * locales.json.
 */

type Vars = Record<string, string | number>;
type Catalog = Record<string, string | Partial<Record<Intl.LDMLPluralRule, string>>>;

const CATALOGS = catalogs as Record<string, Catalog>;

const fill = (text: string, vars?: Vars): string =>
  vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : text;

/** The catalogue for a language tag: exact (pt-BR), else the language (de-AT → de), else English. */
function catalogFor(lang: string): { id: string; catalog: Catalog } {
  const ids = Object.keys(CATALOGS);
  const exact = ids.find((id) => id.toLowerCase() === lang.toLowerCase());
  const base = lang.split('-')[0]!.toLowerCase();
  const id = exact ?? ids.find((i) => i.split('-')[0]!.toLowerCase() === base);
  return id ? { id, catalog: CATALOGS[id]! } : { id: 'en', catalog: {} };
}

export interface ScreenStrings {
  /** The Intl locale for numbers and times. */
  locale: string;
  t: (text: string, vars?: Vars) => string;
  /** Like t() for a word that's translated by where it's used (the catalogue key is `context::text`). */
  tc: (context: string, text: string, vars?: Vars) => string;
  tp: (count: number, one: string, other: string, vars?: Vars) => string;
  /** A number in the language's style with `min` to `max` decimals (no "-0"). */
  num: (n: number, max?: number, min?: number) => string;
  /** A time of day (14:05, or 2:05 PM). */
  time: (ts: number) => string;
  timeAgo: (ts: number | null | undefined, now: number) => string;
}

export function screenStrings(lang: string, timeZone: string | null): ScreenStrings {
  const { id, catalog } = catalogFor(lang);
  let locale = lang;
  try {
    new Intl.NumberFormat(locale);
  } catch {
    locale = id;
  }
  const plural = new Intl.PluralRules(id);
  const numbers = new Map<string, Intl.NumberFormat>();
  const clock = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', ...(timeZone ? { timeZone } : {}) });

  const t = (text: string, vars?: Vars) => {
    const entry = catalog[text];
    return fill(typeof entry === 'string' && entry ? entry : text, vars);
  };
  const tc = (context: string, text: string, vars?: Vars) => {
    const entry = catalog[`${context}::${text}`];
    return fill(typeof entry === 'string' && entry ? entry : text, vars);
  };
  const num = (n: number, max = 0, min = max) => {
    const key = `${min}|${max}`;
    let f = numbers.get(key);
    if (!f) {
      f = new Intl.NumberFormat(locale, { minimumFractionDigits: min, maximumFractionDigits: max });
      numbers.set(key, f);
    }
    const rounded = Number(n.toFixed(max));
    return f.format(rounded === 0 ? 0 : rounded);
  };
  const tp = (count: number, one: string, other: string, vars?: Vars) => {
    const all = { count: count.toLocaleString(locale), ...vars };
    const entry = catalog[`${one}|${other}`];
    if (entry && typeof entry === 'object') {
      const text = entry[plural.select(count)] ?? entry.other;
      if (text) return fill(text, all);
    }
    return fill(count === 1 ? one : other, all);
  };

  // As the web app says it (format.ts).
  const timeAgo = (ts: number | null | undefined, now: number) => {
    if (!ts) return t('never');
    const s = Math.max(0, Math.round((now - ts) / 1000));
    if (s < 10) return t('just now');
    if (s < 60) return t('{n} s ago', { n: num(s) });
    const m = Math.round(s / 60);
    if (m < 60) return t('{n} min ago', { n: num(m) });
    const h = Math.round(m / 6) / 10;
    if (h < 24) return t('{n} h ago', { n: num(h < 10 ? Math.round(h * 10) / 10 : Math.round(h), 1, 0) });
    const raw = Math.round(h / 2.4) / 10;
    const d = raw < 10 ? Math.round(raw * 10) / 10 : Math.round(raw);
    return tp(d, '{count} day ago', '{count} days ago', { count: num(d, 1, 0) });
  };

  return { locale, t, tc, tp, num, time: (ts) => clock.format(ts), timeAgo };
}
