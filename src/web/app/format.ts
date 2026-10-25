import { useEffect, useState } from 'react';
import { currentLocale, t, tc, tp } from './i18n';

export function useNow(intervalMs = 15_000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * The locale for Intl dates and numbers: the browser's own variant of the language in use (en-GB, de-AT...) so dates
 * look the way the reader is used to, or the language itself.
 */
export function intlLocale(): string {
  const lang = currentLocale();
  const base = lang.split('-')[0]!.toLowerCase();
  let langs: readonly string[] = [];
  try {
    langs = navigator.languages?.length ? navigator.languages : [navigator.language];
  } catch {
    // No navigator (tests): the language itself.
  }
  const own = langs.find((l) => l?.toLowerCase() === lang.toLowerCase()) ?? langs.find((l) => l?.split('-')[0]!.toLowerCase() === base);
  if (own) {
    try {
      return Intl.getCanonicalLocales(own)[0] ?? lang;
    } catch {
      return lang;
    }
  }
  return lang;
}

const numberFormats = new Map<string, Intl.NumberFormat>();

/** A number in the language's style (1,234.5 or 1.234,5), with `min` to `max` decimals. */
export function num(n: number, max = 0, min = max): string {
  const locale = intlLocale();
  const key = `${locale}|${min}|${max}`;
  let f = numberFormats.get(key);
  if (!f) {
    f = new Intl.NumberFormat(locale, { minimumFractionDigits: min, maximumFractionDigits: max });
    numberFormats.set(key, f);
  }
  return f.format(n);
}

/** Up to one decimal below 10 (1.5, 2), whole numbers above; and the number shown, for picking a plural. */
function rough(x: number): { text: string; n: number } {
  const n = x < 10 ? Math.round(x * 10) / 10 : Math.round(x);
  return { text: num(n, 1, 0), n };
}

export function timeAgo(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return t('never');
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 10) return t('just now');
  // i18n: "s" is seconds
  if (s < 60) return t('{n} s ago', { n: num(s) });
  const m = Math.round(s / 60);
  if (m < 60) return t('{n} min ago', { n: num(m) });
  const h = Math.round(m / 6) / 10;
  // i18n: "h" is hours
  if (h < 24) return t('{n} h ago', { n: rough(h).text });
  const d = rough(Math.round(h / 2.4) / 10);
  return tp(d.n, '{count} day ago', '{count} days ago', { count: d.text });
}

export function timeUntil(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return '–';
  const s = Math.round((ts - now) / 1000);
  if (s <= 5) return t('any moment');
  if (s < 60) return t('in {n} s', { n: num(s) });
  const m = Math.round(s / 60);
  if (m < 60) return t('in {n} min', { n: num(m) });
  return t('in {n} h', { n: num(Math.round(m / 6) / 10, 1, 0) });
}

export function duration(ms: number): string {
  if (ms < 60_000) return t('{n} s', { n: num(Math.max(0, Math.round(ms / 1000))) });
  const m = Math.round(ms / 60_000);
  if (m < 60) return t('{n} min', { n: num(m) });
  const h = Math.floor(m / 60);
  if (h < 48) return t('{h} h {m} min', { h: num(h), m: num(m % 60) });
  const d = Math.floor(h / 24);
  return tp(d, '{count} day {h} h', '{count} days {h} h', { h: num(h % 24) });
}

export function days(ms: number): string {
  const d = ms / 86_400_000;
  if (d < 1) return t('{n} h', { n: num(Math.max(0, Math.round(d * 24))) });
  // i18n: {n} always has one decimal, e.g. "7.5 days" (and "1.0 days")
  return t('{n} days', { n: num(d, 1) });
}

export function dateTime(ts: number | null | undefined): string {
  if (!ts) return '–';
  return new Date(ts).toLocaleString(intlLocale(), {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function dateOnly(ts: number | null | undefined): string {
  if (!ts) return '–';
  return new Date(ts).toLocaleDateString(intlLocale(), { day: 'numeric', month: 'short', year: 'numeric' });
}

/** A time of day (14:05 or 02:05 PM). */
export function timeOnly(ts: number): string {
  return new Date(ts).toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit' });
}

/** Value for an <input type="datetime-local">. */
export function toLocalInput(ts: number): string {
  const d = new Date(ts - new Date(ts).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

export function fromLocalInput(value: string): number {
  return new Date(value).getTime();
}

/** A number with `decimals` decimals in the language's style, without a "-0" for tiny negative numbers. */
export function fixed(n: number, decimals: number): string {
  const rounded = Number(n.toFixed(decimals));
  return num(rounded === 0 ? 0 : rounded, decimals);
}

export function bytes(n: number): string {
  if (n < 1024) return `${num(n)} B`;
  if (n < 1024 ** 2) return `${num(n / 1024, 1)} KB`;
  if (n < 1024 ** 3) return `${num(n / 1024 ** 2, 1)} MB`;
  return `${num(n / 1024 ** 3, 2)} GB`;
}

export type SignalQuality = 'excellent' | 'good' | 'ok' | 'weak' | 'very-weak';

export interface SignalRating {
  rssi: number;
  /** Bars to show, 0–4. */
  level: 0 | 1 | 2 | 3 | 4;
  quality: SignalQuality;
  label: string;
}

/**
 * How good a pill's Bluetooth signal is at the hub, from its strength (RSSI, in dBm: closer to 0 is stronger). Readings
 * arrive reliably down to about −85 dBm; below that some start to go missing, and below about −93 dBm many do.
 */
export function signalQuality(rssi: number | null | undefined): SignalRating | null {
  if (rssi === null || rssi === undefined || !Number.isFinite(rssi)) return null;
  const rate = (level: SignalRating['level'], quality: SignalQuality, label: string): SignalRating => ({ rssi, level, quality, label });
  // i18n: how good a Bluetooth signal is
  if (rssi >= -65) return rate(4, 'excellent', tc('signal', 'Excellent'));
  if (rssi >= -75) return rate(3, 'good', tc('signal', 'Good'));
  if (rssi >= -85) return rate(2, 'ok', tc('signal', 'OK'));
  if (rssi >= -93) return rate(1, 'weak', tc('signal', 'Weak'));
  return rate(0, 'very-weak', tc('signal', 'Very weak'));
}

/** Bars to show for a signal, 0–4. */
export const signalLevel = (rssi: number | null | undefined): number => signalQuality(rssi)?.level ?? 0;
