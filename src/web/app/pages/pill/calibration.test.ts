import { describe, expect, it } from 'vitest';
import { DEFAULT_PILL_MODEL, fitTilt, type TiltPoint } from '@rapthooker/shared';
import {
  baseGravity,
  DEFAULT_CHOICES,
  describeChanges,
  fitCurve,
  points,
  readingState,
  residualText,
  thermometerOffset,
  tiltAdvice,
  tiltFit,
  waterOffset,
} from './calibration';

const pt = (tilt: number, sg: number, at = 0): TiltPoint => ({ tilt, sg, at });

describe('baseGravity', () => {
  it("takes the pill's gravity without the offset", () => {
    expect(baseGravity({ pillGravity: 1.002, tilt: 30 }, { gravity: 0.001, temperature: 0 }, DEFAULT_PILL_MODEL)).toBeCloseTo(1.001, 6);
  });

  it('works it out from the tilt when the model does', () => {
    const tiltPoly = fitTilt([pt(20, 1.0), pt(60, 1.08)]);
    expect(
      baseGravity({ pillGravity: 1.5, tilt: 40 }, { gravity: 0.002, temperature: 0 }, { gravitySource: 'tilt', tiltPoly }),
    ).toBeCloseTo(1.04, 6);
    // Without a tilt it falls back to the pill's.
    expect(
      baseGravity({ pillGravity: 1.012, tilt: null }, { gravity: 0.002, temperature: 0 }, { gravitySource: 'tilt', tiltPoly }),
    ).toBeCloseTo(1.01, 6);
  });
});

describe('offsets', () => {
  it('makes water read 1.000', () => {
    expect(waterOffset(1.0021)).toBe(-0.0021);
    expect(waterOffset(0.99876)).toBe(0.0012);
    expect(Object.is(waterOffset(1), 0)).toBe(true);
  });

  it('makes the pill agree with the thermometer', () => {
    // The pill shows 21.3 with a +0.5 offset (so it measures 20.8); the thermometer says 20.
    expect(thermometerOffset(20, { temperature: 21.3 }, { gravity: 0, temperature: 0.5 })).toBe(-0.8);
  });

  it('describes gravity offsets in points', () => {
    expect(points(-0.0021)).toBe('−2.1 points');
    expect(points(0.0015)).toBe('+1.5 points');
    expect(points(0)).toBe('0 points');
    expect(residualText(-0.02)).toBe('0.0 pts');
    expect(residualText(1.26)).toBe('+1.3 pts');
    expect(residualText(-0.5)).toBe('−0.5 pts');
  });
});

describe('readingState', () => {
  it('is stale after two intervals', () => {
    expect(readingState(null, 300, 0)).toBe('none');
    expect(readingState({ ts: 0 }, 300, 600_000)).toBe('fresh');
    expect(readingState({ ts: 0 }, 300, 700_000)).toBe('stale');
    // Unknown interval: 15 minutes.
    expect(readingState({ ts: 0 }, null, 30 * 60_000)).toBe('fresh');
  });
});

describe('tiltFit', () => {
  it('fits the points and reports how far each is from the fit', () => {
    const f = tiltFit([pt(20, 1.0), pt(40, 1.04), pt(60, 1.08)]);
    expect(f.coeffs).not.toBeNull();
    for (const r of f.rows) expect(Math.abs(r.residual!)).toBeLessThan(0.01);
    expect(f.rms).toBeLessThan(0.01);
  });

  it('has nothing to fit with one tilt', () => {
    const f = tiltFit([pt(20, 1.0), pt(20, 1.01)]);
    expect(f.coeffs).toBeNull();
    expect(f.rows.every((r) => r.fitted === null && r.residual === null)).toBe(true);
    expect(f.rms).toBeNull();
  });
});

describe('fitCurve', () => {
  it('puts the points and the curve on one sorted axis with no repeated x', () => {
    const pts = [pt(40, 1.04), pt(20, 1.0), pt(40, 1.041)];
    const c = fitCurve(pts, [0.96, 0.002]);
    for (let i = 1; i < c.x.length; i++) expect(c.x[i]!).toBeGreaterThan(c.x[i - 1]!);
    expect(c.points.filter((p) => p !== null)).toHaveLength(3);
    expect(c.x[0]).toBeLessThan(20);
    expect(c.x[c.x.length - 1]).toBeGreaterThan(40);
    const i = c.points.indexOf(1.0);
    expect(c.curve[i]).toBeCloseTo(1.0, 6);
    expect(fitCurve([], null)).toEqual({ x: [], points: [], curve: [] });
    expect(fitCurve([pt(30, 1)], null).curve.every((v) => v === null)).toBe(true);
  });
});

describe('tiltAdvice', () => {
  it('suggests what to do next', () => {
    expect(tiltAdvice([])).toMatch(/plain water/);
    expect(tiltAdvice([pt(20, 1)])).toMatch(/at least one more/);
    expect(tiltAdvice([pt(20, 1), pt(22, 1.005)])).toMatch(/close together/);
    expect(tiltAdvice([pt(20, 1), pt(60, 1.08)])).toMatch(/straight line/);
    expect(tiltAdvice([pt(20, 1), pt(40, 1.04), pt(60, 1.08)])).toMatch(/3 points: good/);
  });
});

describe('describeChanges', () => {
  it('lists what saving would change', () => {
    expect(describeChanges(DEFAULT_CHOICES, DEFAULT_CHOICES)).toEqual([]);
    expect(
      describeChanges(DEFAULT_CHOICES, { gravitySource: 'tilt', velocitySource: 'computed', velocityHours: 12, smoothing: 'light' }),
    ).toEqual([
      'Gravity: from the pill → worked out by RaptHooker from the tilt',
      'Velocity: from the pill → worked out by RaptHooker',
      "RaptHooker's velocity: over 24 → 12 hours",
      'Smoothing: off → light (1-hour average)',
    ]);
  });
});
