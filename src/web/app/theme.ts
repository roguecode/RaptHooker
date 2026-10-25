import { useSyncExternalStore } from 'react';
import { readStored, writeStored } from './storage';
import { tk } from './i18n';

/** What this browser asked for: 'auto' follows the system's light or dark setting. */
export type ThemePref = 'auto' | 'dark' | 'light';
export type Theme = 'dark' | 'light';

export const THEME_KEY = 'rapthooker.theme';

/** The browser bar colour (meta theme-color) for each theme; matches --bg in styles.css. */
export const THEME_COLORS: Record<Theme, string> = { dark: '#08071c', light: '#f4f2ff' };

/** Labels are English (marked with tk): show them with t(). */
export const THEME_OPTIONS: { id: ThemePref; label: string; icon: 'contrast' | 'moon' | 'sun' }[] = [
  { id: 'auto', label: tk('Auto'), icon: 'contrast' },
  { id: 'dark', label: tk('Dark'), icon: 'moon' },
  { id: 'light', label: tk('Light'), icon: 'sun' },
];

export function parseThemePref(raw: string | null | undefined): ThemePref {
  return raw === 'dark' || raw === 'light' ? raw : 'auto';
}

/** Dark unless the system asks for light (or the browser picked one). */
export function resolveTheme(pref: ThemePref, systemPrefersLight: boolean): Theme {
  if (pref !== 'auto') return pref;
  return systemPrefersLight ? 'light' : 'dark';
}

interface ThemeState {
  pref: ThemePref;
  theme: Theme;
}

let state: ThemeState = { pref: 'auto', theme: 'dark' };
const listeners = new Set<() => void>();
let media: MediaQueryList | null = null;
let started = false;

function systemLight(): boolean {
  return media?.matches ?? false;
}

function apply(): void {
  const pref = parseThemePref(readStored(THEME_KEY));
  const theme = resolveTheme(pref, systemLight());
  const changed = pref !== state.pref || theme !== state.theme;
  state = { pref, theme };
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme;
  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    // With 'auto' each tag keeps to its own media query; a chosen theme sets both.
    const own: Theme = meta.media.includes('light') ? 'light' : 'dark';
    meta.content = THEME_COLORS[pref === 'auto' ? own : theme];
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
  window.addEventListener('storage', (e) => (e.key === THEME_KEY || e.key === null) && apply());
  apply();
}

export function setThemePref(pref: ThemePref): void {
  writeStored(THEME_KEY, pref === 'auto' ? null : pref);
  apply();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * The theme in use. `theme` is what's on screen ('dark' or 'light'), which canvas drawings (charts) can use to
 * rebuild with the new colours from the CSS variables.
 */
export function useTheme(): ThemeState & { setPref: (pref: ThemePref) => void } {
  const s = useSyncExternalStore(
    subscribe,
    () => state,
    () => state,
  );
  return { ...s, setPref: setThemePref };
}
