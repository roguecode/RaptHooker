import { describe, expect, it } from 'vitest';
import { fitTilt, polyfit, polyval, rollingSlope, slopePerDay, smooth, tiltGravity } from './calc.js';
import { abv } from './units.js';
import { DEFAULT_PILL_MODEL } from './types.js';

const HOUR = 3_600_000;

describe('polynomial fits', () => {
  it('recovers a quadratic', () => {
    const points = [0, 1, 2, 3, 4].map((x) => ({ x, y: 1 + 2 * x + 0.5 * x * x }));
    const c = polyfit(points, 2)!;
    expect(c[0]).toBeCloseTo(1, 9);
    expect(c[1]).toBeCloseTo(2, 9);
    expect(c[2]).toBeCloseTo(0.5, 9);
    expect(polyval(c, 10)).toBeCloseTo(71, 6);
  });

  it('needs enough distinct points', () => {
    expect(polyfit([{ x: 1, y: 1 }], 1)).toBeNull();
    expect(
      fitTilt([
        { tilt: 30, sg: 1.0, at: 0 },
        { tilt: 30, sg: 1.05, at: 0 },
      ]),
    ).toBeNull();
  });

  it('picks a lower degree when the points can only support that', () => {
    const fit = fitTilt([
      { tilt: 20, sg: 1.0, at: 0 },
      { tilt: 40, sg: 1.08, at: 0 },
      { tilt: 40, sg: 1.08, at: 1 },
    ])!;
    expect(fit).toHaveLength(2);
    expect(polyval(fit, 30)).toBeCloseTo(1.04, 9);
  });

  it('only uses the tilt when the model says so', () => {
    const tiltPoly = [0.92, 0.004];
    expect(tiltGravity({ ...DEFAULT_PILL_MODEL, tiltPoly }, 30)).toBeNull();
    expect(tiltGravity({ ...DEFAULT_PILL_MODEL, gravitySource: 'tilt', tiltPoly }, 30)).toBeCloseTo(1.04, 9);
    expect(tiltGravity({ ...DEFAULT_PILL_MODEL, gravitySource: 'tilt', tiltPoly: null }, 30)).toBeNull();
  });
});

describe('velocity', () => {
  const ts = Array.from({ length: 49 }, (_, i) => i * 0.5 * HOUR);
  const falling = ts.map((t) => 1.05 - (10 / 1000) * (t / (24 * HOUR)));

  it('fits points per day', () => {
    expect(slopePerDay(ts, falling)).toBeCloseTo(-10, 6);
  });

  it('needs at least two hours and six readings', () => {
    expect(slopePerDay(ts.slice(0, 4), falling.slice(0, 4))).toBeNull();
    expect(
      slopePerDay(
        [0, 1, 2, 3, 4, 5].map((i) => i * 60_000),
        [1, 1, 1, 1, 1, 1],
      ),
    ).toBeNull();
  });

  it('rolls over a window, skipping gaps', () => {
    const values: (number | null)[] = falling.map((g, i) => (i === 20 ? null : g));
    const v = rollingSlope(ts, values, 12 * HOUR);
    expect(v[2]).toBeNull();
    expect(v[30]).toBeCloseTo(-10, 6);
    expect(v[20]).toBeCloseTo(-10, 6);
  });
});

describe('smoothing', () => {
  it('averages over a trailing window and keeps gaps', () => {
    const ts = [0, 1, 2, 3, 4].map((i) => i * 30 * 60_000);
    const out = smooth(ts, [1.04, 1.06, null, 1.04, 1.06], HOUR);
    expect(out[0]).toBeCloseTo(1.04, 9);
    expect(out[1]).toBeCloseTo(1.05, 9);
    expect(out[2]).toBeNull();
    expect(out[4]).toBeCloseTo(1.05, 9);
  });

  it('does nothing when off', () => {
    expect(smooth([0, 1], [1, 2], 0)).toEqual([1, 2]);
  });
});

describe('ABV formulas', () => {
  it('standard is (OG − FG) × 131.25', () => {
    expect(abv(1.05, 1.01)).toBeCloseTo(5.25, 9);
  });

  it('alternative reads higher for strong beers', () => {
    expect(abv(1.1, 1.02, 'alternative')).toBeGreaterThan(abv(1.1, 1.02, 'standard'));
  });
});
