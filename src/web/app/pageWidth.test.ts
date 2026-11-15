// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { currentPageWidth, PAGE_WIDTH_KEY, PAGE_WIDTHS, parsePageWidth, setPageWidth, startPageWidth } from './pageWidth';

afterEach(() => setPageWidth('standard'));

describe('page width', () => {
  it('reads the saved choice, defaulting to standard', () => {
    expect(parsePageWidth('wide')).toBe('wide');
    expect(parsePageWidth('full')).toBe('full');
    expect(parsePageWidth(null)).toBe('standard');
    expect(parsePageWidth('huge')).toBe('standard');
  });

  it('starts with what this browser picked, and remembers a new choice', () => {
    localStorage.setItem(PAGE_WIDTH_KEY, 'full');
    startPageWidth();
    expect(document.documentElement.dataset.width).toBe('full');
    expect(currentPageWidth()).toBe('full');

    setPageWidth('wide');
    expect(localStorage.getItem(PAGE_WIDTH_KEY)).toBe('wide');
    expect(document.documentElement.dataset.width).toBe('wide');

    // Standard is the default, so it isn't kept.
    setPageWidth('standard');
    expect(localStorage.getItem(PAGE_WIDTH_KEY)).toBeNull();
    expect(currentPageWidth()).toBe('standard');
  });

  it('widens the page for every choice but standard', () => {
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'styles.css'), 'utf8');
    const styled = [...css.matchAll(/html\[data-width='(\w+)'\] main \{/g)].map((m) => m[1]);
    expect(styled).toEqual(PAGE_WIDTHS.filter((w) => w !== 'standard'));
  });
});
