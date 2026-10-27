import { useSyncExternalStore } from 'react';
import { readStored, writeStored } from './storage';
import { tk } from './i18n';

/** What this browser asked for: 'auto' follows the system's light or dark setting. */
export type ThemePref = 'auto' | 'dark' | 'light';
export type Theme = 'dark' | 'light';
/** The colours, each with a dark and a light version. Violet is the original look (styles.css); the rest are in palettes.css. */
export type Palette = 'violet' | 'ocean' | 'hops' | 'amber' | 'rose' | 'graphite';

export const THEME_KEY = 'rapthooker.theme';
export const PALETTE_KEY = 'rapthooker.palette';
export const DEFAULT_PALETTE: Palette = 'violet';

/** Labels are English (marked with tk): show them with t(). */
export const THEME_OPTIONS: { id: ThemePref; label: string; icon: 'contrast' | 'moon' | 'sun' }[] = [
  { id: 'auto', label: tk('Auto'), icon: 'contrast' },
  { id: 'dark', label: tk('Dark'), icon: 'moon' },
  { id: 'light', label: tk('Light'), icon: 'sun' },
];

/**
 * `bar` is the browser bar colour (meta theme-color) in each theme and matches that palette's --bg; `swatch` is the
 * accent gradient shown in the picker. Labels are English (marked with tk): show them with t().
 */
export const PALETTES: { id: Palette; label: string; bar: Record<Theme, string>; swatch: string }[] = [
  {
    id: 'violet',
    label: tk('Violet'),
    bar: { dark: '#08071c', light: '#f4f2ff' },
    swatch: 'linear-gradient(135deg, #c4b5fd, #8b5cf6 45%, #3b82f6)',
  },
  {
    id: 'ocean',
    label: tk('Ocean'),
    bar: { dark: '#031019', light: '#eff9fc' },
    swatch: 'linear-gradient(135deg, #a5f3fc, #06b6d4 45%, #2563eb)',
  },
  {
    id: 'hops',
    label: tk('Hops'),
    bar: { dark: '#06110a', light: '#f3f8ec' },
    swatch: 'linear-gradient(135deg, #d9f99d, #84cc16 45%, #059669)',
  },
  {
    id: 'amber',
    label: tk('Amber'),
    bar: { dark: '#130c06', light: '#fdf7ef' },
    swatch: 'linear-gradient(135deg, #fde68a, #f59e0b 45%, #ea580c)',
  },
  {
    id: 'rose',
    label: tk('Rosé'),
    bar: { dark: '#14070f', light: '#fdf2f7' },
    swatch: 'linear-gradient(135deg, #fbcfe8, #ec4899 45%, #f97316)',
  },
  {
    id: 'graphite',
    label: tk('Graphite'),
    bar: { dark: '#0a0a0c', light: '#f4f4f5' },
    swatch: 'linear-gradient(135deg, #f4f4f5, #a1a1aa 45%, #3f3f46)',
  },
];

export function parseThemePref(raw: string | null | undefined): ThemePref {
  return raw === 'dark' || raw === 'light' ? raw : 'auto';
}

export function parsePalette(raw: string | null | undefined): Palette {
  return PALETTES.find((p) => p.id === raw)?.id ?? DEFAULT_PALETTE;
}

/** The browser bar colour for a palette in a theme. */
export function barColor(palette: Palette, theme: Theme): string {
  return (PALETTES.find((p) => p.id === palette) ?? PALETTES[0]!).bar[theme];
}

/** Dark unless the system asks for light (or the browser picked one). */
export function resolveTheme(pref: ThemePref, systemPrefersLight: boolean): Theme {
  if (pref !== 'auto') return pref;
  return systemPrefersLight ? 'light' : 'dark';
}

interface ThemeState {
  pref: ThemePref;
  theme: Theme;
  palette: Palette;
}

let state: ThemeState = { pref: 'auto', theme: 'dark', palette: DEFAULT_PALETTE };
const listeners = new Set<() => void>();
let media: MediaQueryList | null = null;
let started = false;

function systemLight(): boolean {
  return media?.matches ?? false;
}

function apply(): void {
  const pref = parseThemePref(readStored(THEME_KEY));
  const theme = resolveTheme(pref, systemLight());
  const palette = parsePalette(readStored(PALETTE_KEY));
  const changed = pref !== state.pref || theme !== state.theme || palette !== state.palette;
  state = { pref, theme, palette };
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.palette = palette;
  root.style.colorScheme = theme;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    // With 'auto' each tag keeps to its own media query; a chosen theme sets both.
    const own: Theme = meta.media.includes('light') ? 'light' : 'dark';
    meta.content = barColor(palette, pref === 'auto' ? own : theme);
  }
  if (changed) {
    for (const fn of listeners) fn();
    window.dispatchEvent(new CustomEvent('rapthooker:theme', { detail: state }));
  }
}

/** Applies the saved theme to <html data-theme> and follows system changes. Call once before the first render. */
export function startTheme(): void {
  if (started) return;
  started = true;
  media = window.matchMedia?.('(prefers-color-scheme: light)') ?? null;
  media?.addEventListener('change', apply);
  window.addEventListener('storage', (e) => (e.key === THEME_KEY || e.key === PALETTE_KEY || e.key === null) && apply());
  apply();
}

export function setThemePref(pref: ThemePref): void {
  writeStored(THEME_KEY, pref === 'auto' ? null : pref);
  apply();
}

export function setPalette(palette: Palette): void {
  writeStored(PALETTE_KEY, palette === DEFAULT_PALETTE ? null : palette);
  apply();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * The theme in use. `theme` is what's on screen ('dark' or 'light') and `palette` its colours; canvas drawings (charts)
 * rebuild when `look` changes, to pick up the new colours from the CSS variables.
 */
export function useTheme(): ThemeState & { look: string; setPref: (pref: ThemePref) => void; setPalette: (palette: Palette) => void } {
  const s = useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
  return { ...s, look: `${s.palette}-${s.theme}`, setPref: setThemePref, setPalette };
}
