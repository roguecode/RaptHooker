import { describe, expect, it } from 'vitest';
import {
  bucketMedians,
  curveFinishAt,
  curveGravity,
  fitFermentation,
  gravityStable,
  predictFermentation,
  type GravityPoint,
} from './fermentation.js';

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 9, 1, 12);

/** Small seeded generator, so the noisy data is the same every run. */
function rng(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TRUE = { og: 1.055, fg: 1.008, k: 0.08, midH: 40 };
const trueGravity = (h: number) => TRUE.fg + (TRUE.og - TRUE.fg) / (1 + Math.exp(TRUE.k * (h - TRUE.midH)));
/** Hours for the true curve to come within a point of FG. */
const TRUE_FINISH_H = TRUE.midH + Math.log((TRUE.og - TRUE.fg) / 0.001 - 1) / TRUE.k;

/** A reading every 15 minutes up to `hours`, with noise (±0.0004 SG) and the odd wild reading. */
function brew(hours: number, seed = 1, curve = trueGravity): GravityPoint[] {
  const rand = rng(seed);
  const out: GravityPoint[] = [];
  for (let m = 0; m <= hours * 60; m += 15) {
    const h = m / 60;
    let g = curve(h) + (rand() + rand() + rand() - 1.5) * 0.0005;
    if (rand() < 0.02) g += 0.004;
    out.push({ t: T0 + m * 60_000, g });
  }
  return out;
}

describe('bucketMedians', () => {
  it('takes the median of each bucket', () => {
    const pts = [
      { t: T0, g: 1.05 },
      { t: T0 + 10 * 60_000, g: 1.06 },
      { t: T0 + 20 * 60_000, g: 1.051 },
      { t: T0 + HOUR, g: 1.04 },
    ];
    const b = bucketMedians(pts);
    expect(b).toHaveLength(2);
    expect(b[0]!.g).toBeCloseTo(1.051, 6);
    expect(b[0]!.t).toBe(T0 + 10 * 60_000);
    expect(b[1]!.g).toBe(1.04);
  });
});

describe('fitFermentation', () => {
  it('recovers the curve from noisy readings', () => {
    const fit = fitFermentation(bucketMedians(brew(120)))!;
    expect(fit).not.toBeNull();
    expect(fit.fg).toBeCloseTo(TRUE.fg, 3);
    expect(Math.abs(fit.og - TRUE.og)).toBeLessThan(0.0015);
    expect(Math.abs((fit.midAt - T0) / HOUR - TRUE.midH)).toBeLessThan(2);
    expect(fit.k).toBeGreaterThan(TRUE.k * 0.8);
    expect(fit.k).toBeLessThan(TRUE.k * 1.25);
    expect(fit.rmse).toBeLessThan(0.0005);
    expect(curveGravity(fit, T0 + 60 * HOUR)).toBeCloseTo(trueGravity(60), 3);
    expect(Math.abs((curveFinishAt(fit)! - T0) / HOUR - TRUE_FINISH_H)).toBeLessThan(6);
  });

  it('needs a few points', () => {
    expect(fitFermentation([{ t: T0, g: 1.05 }])).toBeNull();
  });
});

describe('predictFermentation', () => {
  it('waits for 12 hours of readings', () => {
    expect(predictFermentation(brew(8))).toBeNull();
    expect(predictFermentation([])).toBeNull();
  });

  it('calls a brew that has not started dropping the lag phase, guessing FG from the target', () => {
    const flat = brew(20, 2, () => 1.05);
    const p = predictFermentation(flat, { og: 1.05, targetFg: 1.011 })!;
    expect(p).toMatchObject({ stage: 'lag', fg: 1.011, finishAt: null, confidence: 'low' });
    // Without a target, 75% attenuation.
    expect(predictFermentation(flat, { og: 1.05 })!.fg).toBeCloseTo(1.0125, 4);
  });

  it('predicts FG and the finish while fermentation is active', () => {
    const p = predictFermentation(brew(48, 3), { og: TRUE.og })!;
    expect(p.stage).toBe('active');
    expect(Math.abs(p.fg - TRUE.fg)).toBeLessThan(0.0025);
    expect(p.finishAt).not.toBeNull();
    expect(Math.abs((p.finishAt! - T0) / HOUR - TRUE_FINISH_H)).toBeLessThan(16);
    expect(p.confidence).not.toBe('low');
  });

  it('sees it slowing down, then finished', () => {
    const late = predictFermentation(brew(90, 4), { og: TRUE.og })!;
    expect(late.stage).toBe('finishing');
    expect(late.fg).toBeCloseTo(TRUE.fg, 3);
    expect(late.confidence).toBe('high');

    const readings = brew(160, 5);
    expect(gravityStable(readings, { og: TRUE.og })).toBe(true);
    const done = predictFermentation(readings, { og: TRUE.og, stable: true })!;
    expect(done.stage).toBe('done');
    expect(done.fg).toBeCloseTo(TRUE.fg, 3);
    expect(done.finishAt).toBeLessThan(T0 + 120 * HOUR);
  });

  it('copes with a different, slower curve', () => {
    const slow = (h: number) => 1.008 + (1.07 - 1.008) / (1 + Math.exp(0.03 * (h - 120)));
    const p = predictFermentation(brew(160, 6, slow), { og: 1.07 })!;
    expect(p.stage).toBe('active');
    expect(Math.abs(p.fg - 1.008)).toBeLessThan(0.003);
  });
});

describe('gravityStable', () => {
  it('needs a day of readings and a flat last 48 hours', () => {
    expect(
      gravityStable(
        brew(20, 7, () => 1.01),
        { og: 1.05 },
      ),
    ).toBe(false);
    expect(
      gravityStable(
        brew(30, 7, () => 1.01),
        { og: 1.05 },
      ),
    ).toBe(true);
    expect(gravityStable(brew(70, 8))).toBe(false);
  });

  it("doesn't call a brew that never started finished", () => {
    expect(
      gravityStable(
        brew(60, 9, () => 1.05),
        { og: 1.05 },
      ),
    ).toBe(false);
    expect(gravityStable(brew(60, 9, () => 1.05))).toBe(true);
  });
});
