import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { barColor, DEFAULT_PALETTE, PALETTES, parsePalette, parseThemePref, resolveTheme, type Palette, type Theme } from './theme';

const css = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');

/** A variable's value in the block for `selector`. */
function cssVar(source: string, selector: string, name: string): string | undefined {
  const start = source.indexOf(`${selector} {`);
  if (start < 0) return undefined;
  const block = source.slice(start, source.indexOf('}', start));
  return new RegExp(`--${name}:\\s*([^;]+);`).exec(block)?.[1]?.trim();
}

/** The --bg a palette and theme get: Violet is styles.css itself, the rest are in palettes.css. */
function bgOf(palette: Palette, theme: Theme): string | undefined {
  if (palette === 'violet') return cssVar(css('./styles.css'), theme === 'dark' ? ':root' : ":root[data-theme='light']", 'bg');
  return cssVar(css('./palettes.css'), `:root[data-palette='${palette}'][data-theme='${theme}']`, 'bg');
}

describe('theme', () => {
  it('reads the saved choice, defaulting to auto', () => {
    expect(parseThemePref('light')).toBe('light');
    expect(parseThemePref('dark')).toBe('dark');
    expect(parseThemePref(null)).toBe('auto');
    expect(parseThemePref('purple')).toBe('auto');
  });

  it('follows the system only on auto, and is dark unless the system asks for light', () => {
    expect(resolveTheme('auto', true)).toBe('light');
    expect(resolveTheme('auto', false)).toBe('dark');
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme('light', false)).toBe('light');
  });
});

describe('palettes', () => {
  it('reads the saved palette, defaulting to the original violet', () => {
    expect(DEFAULT_PALETTE).toBe('violet');
    expect(PALETTES[0]!.id).toBe('violet');
    expect(parsePalette('ocean')).toBe('ocean');
    expect(parsePalette('graphite')).toBe('graphite');
    expect(parsePalette(null)).toBe('violet');
    expect(parsePalette('neon')).toBe('violet');
  });

  it('has a dark and a light version of each, with a browser bar colour matching its background', () => {
    expect(new Set(PALETTES.map((p) => p.id)).size).toBe(PALETTES.length);
    for (const { id } of PALETTES)
      for (const theme of ['dark', 'light'] as const) {
        expect(barColor(id, theme)).toMatch(/^#[0-9a-f]{6}$/i);
        expect(bgOf(id, theme), `${id} ${theme}`).toBe(barColor(id, theme));
      }
  });

  it('lists every palette in palettes.css', () => {
    const inCss = new Set([...css('./palettes.css').matchAll(/data-palette='([\w-]+)'/g)].map((m) => m[1]));
    expect([...inCss].sort()).toEqual(
      PALETTES.map((p) => p.id)
        .filter((id) => id !== 'violet')
        .sort(),
    );
  });
});
