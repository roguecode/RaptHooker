import { describe, expect, it } from 'vitest';
import { parseThemePref, resolveTheme, THEME_COLORS } from './theme';

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

  it('has a browser bar colour for each theme', () => {
    expect(THEME_COLORS.dark).toMatch(/^#[0-9a-f]{6}$/i);
    expect(THEME_COLORS.light).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
