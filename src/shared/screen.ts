import type { GravityUnit, TemperatureUnit } from './types.js';

/**
 * Screen images: a picture of every pill (or of one) at a given size, for small screens that show an image from a web
 * address (a GeekMagic mini screen, an ESPHome display, an e-paper frame). Everything about the picture is in its
 * address, so a screen only has to fetch the same address again for fresh readings.
 */

export const SCREEN_FORMATS = ['png', 'jpg', 'bmp'] as const;
export type ScreenFormat = (typeof SCREEN_FORMATS)[number];

export const SCREEN_THEMES = ['dark', 'light'] as const;
export type ScreenTheme = (typeof SCREEN_THEMES)[number];

/** The app's colour palettes (theme.ts in the web app). */
export const SCREEN_PALETTES = ['violet', 'ocean', 'hops', 'amber', 'rose', 'graphite'] as const;
export type ScreenPalette = (typeof SCREEN_PALETTES)[number];

/**
 * What a picture can show. `header` is the hub's name and the time; `status` is online or offline and when the last
 * reading came; `brew` the brew's name, day and ABV; `progress` the fermentation bar; `stats` battery, signal and the
 * like; `chart` the gravity and temperature over `range`.
 */
export const SCREEN_ITEMS = ['header', 'name', 'status', 'gravity', 'temperature', 'brew', 'progress', 'chart', 'stats'] as const;
export type ScreenItem = (typeof SCREEN_ITEMS)[number];

/** What the chart covers: the brew that's running (the last day without one), or the last 1, 3 or 7 days. */
export const SCREEN_RANGES = ['brew', '1d', '3d', '7d'] as const;
export type ScreenRange = (typeof SCREEN_RANGES)[number];

export const SCREEN_MIN_SIZE = 64;
export const SCREEN_MAX_SIZE = 2048;

export interface ScreenOptions {
  width: number;
  height: number;
  theme: ScreenTheme;
  palette: ScreenPalette;
  show: ScreenItem[];
  range: ScreenRange;
  gravity: GravityUnit;
  temperature: TemperatureUnit;
  /** Language (and region) for the words, numbers and times, e.g. en-GB. */
  lang: string;
  /** Time zone for the clock, e.g. Europe/Berlin; null for the hub's own. */
  tz: string | null;
  /** All devices only: just those with a brew running. */
  brewing: boolean;
}

export const DEFAULT_SCREEN_ITEMS: readonly ScreenItem[] = ['name', 'status', 'gravity', 'temperature', 'brew', 'chart'];

export function defaultScreenOptions(units: { gravity: GravityUnit; temperature: TemperatureUnit }): ScreenOptions {
  return {
    width: 800,
    height: 480,
    theme: 'dark',
    palette: 'violet',
    show: [...DEFAULT_SCREEN_ITEMS],
    range: 'brew',
    gravity: units.gravity,
    temperature: units.temperature,
    lang: 'en',
    tz: null,
    brewing: false,
  };
}

const first = (v: unknown): string | undefined => {
  const one = Array.isArray(v) ? v[0] : v;
  return typeof one === 'string' ? one.trim() : undefined;
};

const pick = <T extends string>(options: readonly T[], v: unknown, fallback: T): T => {
  const s = first(v)?.toLowerCase();
  return options.find((o) => o.toLowerCase() === s) ?? fallback;
};

function size(v: unknown, fallback: number): number {
  const n = Number(first(v));
  if (!Number.isFinite(n) || first(v) === '') return fallback;
  return Math.min(SCREEN_MAX_SIZE, Math.max(SCREEN_MIN_SIZE, Math.round(n)));
}

/** A language tag Intl understands (en-GB), or English. */
export function screenLang(v: unknown): string {
  const s = first(v);
  if (!s || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(s)) return 'en';
  try {
    return Intl.getCanonicalLocales(s)[0] ?? 'en';
  } catch {
    return 'en';
  }
}

/** A time zone Intl knows (Europe/Berlin), or null. */
export function screenTimeZone(v: unknown): string | null {
  const s = first(v);
  if (!s || !/^[A-Za-z0-9_+\-/]{1,64}$/.test(s)) return null;
  try {
    return new Intl.DateTimeFormat('en', { timeZone: s }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/**
 * The options in an image address. Anything missing or not understood takes its default, and sizes are kept within
 * limits, so a screen always gets a picture.
 */
export function parseScreenQuery(query: Record<string, unknown>, defaults: ScreenOptions): ScreenOptions {
  const showRaw = query.show;
  const listed = (Array.isArray(showRaw) ? showRaw : [showRaw])
    .filter((v): v is string => typeof v === 'string')
    .flatMap((v) => v.split(','))
    .map((v) => v.trim().toLowerCase());
  const show = showRaw === undefined ? defaults.show : SCREEN_ITEMS.filter((item) => listed.includes(item));
  const flag = first(query.brewing)?.toLowerCase();
  return {
    width: size(query.w, defaults.width),
    height: size(query.h, defaults.height),
    theme: pick(SCREEN_THEMES, query.theme, defaults.theme),
    palette: pick(SCREEN_PALETTES, query.palette, defaults.palette),
    show,
    range: pick(SCREEN_RANGES, query.range, defaults.range),
    gravity: pick<GravityUnit>(['sg', 'plato'], query.gravity, defaults.gravity),
    temperature: pick<TemperatureUnit>(['C', 'F'], query.temp, defaults.temperature),
    lang: query.lang === undefined ? defaults.lang : screenLang(query.lang),
    tz: query.tz === undefined ? defaults.tz : screenTimeZone(query.tz),
    brewing: flag === undefined ? defaults.brewing : flag === '1' || flag === 'true' || flag === 'yes',
  };
}

// Commas and slashes are fine in a query and easier to read (and type into a screen's settings) than %2C and %2F.
const enc = (v: string) => encodeURIComponent(v).replace(/%2C/gi, ',').replace(/%2F/gi, '/');

/** The query for an image address, every option spelled out so the address doesn't change meaning between versions. */
export function screenQuery(o: ScreenOptions, opts: { allDevices: boolean }): string {
  const parts: [string, string][] = [
    ['w', String(o.width)],
    ['h', String(o.height)],
    ['theme', o.theme],
    ['palette', o.palette],
    ['show', SCREEN_ITEMS.filter((i) => o.show.includes(i)).join(',')],
  ];
  if (o.show.includes('chart')) parts.push(['range', o.range]);
  parts.push(['gravity', o.gravity], ['temp', o.temperature], ['lang', o.lang]);
  if (o.tz) parts.push(['tz', o.tz]);
  if (opts.allDevices && o.brewing) parts.push(['brewing', '1']);
  return parts.map(([k, v]) => `${k}=${enc(v)}`).join('&');
}

/** The path of an image of every device, or of one. */
export function screenPath(format: ScreenFormat, pillId?: string | null): string {
  return pillId ? `/api/pills/${encodeURIComponent(pillId)}/image.${format}` : `/api/image.${format}`;
}
