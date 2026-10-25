import { describe, expect, it } from 'vitest';
import { brewDay, kioskLayout, pageItems, parseKioskSettings } from './layout';

describe('kioskLayout', () => {
  it('puts a single pill on one screen', () => {
    expect(kioskLayout(1920, 1000, 1)).toEqual({ cols: 1, rows: 1, perPage: 1, pages: 1 });
  });

  it('puts two pills side by side on a wide screen', () => {
    expect(kioskLayout(1920, 1000, 2)).toMatchObject({ cols: 2, rows: 1, perPage: 2, pages: 1 });
  });

  it('fits a handful of pills on a TV in one grid', () => {
    const l = kioskLayout(1920, 1000, 6);
    expect(l.pages).toBe(1);
    expect(l.cols * l.rows).toBeGreaterThanOrEqual(6);
    expect(l).toMatchObject({ cols: 3, rows: 2 });
  });

  it('prefers a row of tall tiles to a grid with a hole in it', () => {
    expect(kioskLayout(1840, 940, 3)).toMatchObject({ cols: 3, rows: 1 });
  });

  it('rotates when they do not fit, spreading pills evenly over the screens', () => {
    // A phone in portrait fits two tiles at a time.
    const l = kioskLayout(390, 700, 5);
    expect(l.pages).toBe(3);
    expect(l.perPage).toBe(2);
    expect(l.cols).toBe(1);
  });

  it('shows one pill at a time when asked', () => {
    expect(kioskLayout(1920, 1000, 4, { max: 1 })).toEqual({ cols: 1, rows: 1, perPage: 1, pages: 4 });
  });

  it('copes with no pills and tiny screens', () => {
    expect(kioskLayout(1920, 1000, 0)).toMatchObject({ perPage: 1, pages: 1 });
    expect(kioskLayout(200, 150, 3)).toMatchObject({ cols: 1, rows: 1, perPage: 1, pages: 3 });
  });
});

describe('pageItems', () => {
  const items = ['a', 'b', 'c', 'd', 'e'];

  it('slices a screen and wraps round', () => {
    expect(pageItems(items, 0, 2)).toEqual(['a', 'b']);
    expect(pageItems(items, 2, 2)).toEqual(['e']);
    expect(pageItems(items, 3, 2)).toEqual(['a', 'b']);
    expect(pageItems(items, -1, 2)).toEqual(['e']);
    expect(pageItems([], 4, 2)).toEqual([]);
  });
});

describe('brewDay', () => {
  it('counts the first day as day 1', () => {
    const start = Date.UTC(2026, 0, 1, 18);
    expect(brewDay(start, start + 60_000)).toBe(1);
    expect(brewDay(start, start + 86_400_000)).toBe(2);
    expect(brewDay(start, start + 9.5 * 86_400_000)).toBe(10);
    expect(brewDay(start, start - 5000)).toBe(1);
  });
});

describe('parseKioskSettings', () => {
  it('falls back to 20 s and fitting as many as possible', () => {
    expect(parseKioskSettings(null)).toEqual({ seconds: 20, one: false });
    expect(parseKioskSettings('{"seconds":7,"one":"yes"}')).toEqual({ seconds: 20, one: false });
    expect(parseKioskSettings('{"seconds":60,"one":true}')).toEqual({ seconds: 60, one: true });
    expect(parseKioskSettings('garbage')).toEqual({ seconds: 20, one: false });
  });
});
