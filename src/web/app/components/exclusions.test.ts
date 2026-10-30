import { describe, expect, it } from 'vitest';
import type { History } from '@rapthooker/shared';
import { bridgeAt, bridgeGap, excludeColumn, fillHistory, mergeWindows } from './exclusions';

const MIN = 60_000;
const H = 60 * MIN;

/** Readings every 15 minutes from `from` to `to` hours. */
const times = (from: number, to: number) => Array.from({ length: Math.round((to - from) * 4) + 1 }, (_, i) => from * H + i * 15 * MIN);
/** A fermentation: 1.050 down to 1.010, fastest at 48 hours. */
const ferment = (t: number) => 1.01 + 0.04 / (1 + Math.exp((t / H - 48) / 10));

describe('excluded ranges', () => {
  it('sorts the windows and joins ones that overlap or touch', () => {
    expect(
      mergeWindows([
        { from: 5, to: 8 },
        { from: 1, to: 3 },
        { from: 3, to: 4 },
        { from: 7, to: 10 },
        { from: 12, to: 11 },
      ]),
    ).toEqual([
      { from: 1, to: 4 },
      { from: 5, to: 10 },
    ]);
  });

  it('carries a steady trend straight through a bump', () => {
    const ts = times(0, 24);
    const values = ts.map((t) => 1.05 - (0.001 * t) / H + (t >= 10 * H && t <= 12 * H ? 0.02 : 0));
    const b = bridgeGap(ts, values, { from: 10 * H, to: 12 * H })!;
    // From the last reading before to the first after.
    expect(b.from).toBe(9.75 * H);
    expect(b.to).toBe(12.25 * H);
    expect(b.at(11 * H)).toBeCloseTo(1.05 - 0.011, 9);
  });

  it('bends with the fermentation where a straight line would cut the corner', () => {
    const ts = times(0, 120);
    const win = { from: 26 * H, to: 42 * H };
    const values = ts.map((t) => ferment(t) + (t >= win.from && t <= win.to ? 0.015 : 0));
    const b = bridgeGap(ts, values, win)!;
    const chord = (t: number) => b.at(b.from) + ((b.at(b.to) - b.at(b.from)) * (t - b.from)) / (b.to - b.from);
    let curveErr = 0;
    let lineErr = 0;
    for (let t = b.from; t <= b.to; t += 15 * MIN) {
      curveErr = Math.max(curveErr, Math.abs(b.at(t) - ferment(t)));
      lineErr = Math.max(lineErr, Math.abs(chord(t) - ferment(t)));
    }
    expect(curveErr).toBeLessThan(0.0006);
    expect(curveErr).toBeLessThan(lineErr / 3);
  });

  it('never overshoots the readings it joins', () => {
    const ts = times(0, 24);
    // Rising into the window, falling out of it.
    const values = ts.map((t) => (t < 10 * H ? 20 + t / H / 10 : t > 14 * H ? 21 - (t / H - 14) / 10 : 30));
    const b = bridgeGap(ts, values, { from: 10 * H, to: 14 * H })!;
    const lo = Math.min(b.at(b.from), b.at(b.to));
    const hi = Math.max(b.at(b.from), b.at(b.to));
    for (let t = b.from; t <= b.to; t += 5 * MIN) {
      expect(b.at(t)).toBeGreaterThanOrEqual(lo - 1e-12);
      expect(b.at(t)).toBeLessThanOrEqual(hi + 1e-12);
    }
  });

  it('carries on from one side, levelling off, when nothing comes after', () => {
    const ts = times(0, 20);
    const values = ts.map((t) => 1.05 - (0.002 * t) / H + (t >= 18 * H ? 0.01 : 0));
    const b = bridgeGap(ts, values, { from: 18 * H, to: 21 * H })!;
    expect(b.from).toBe(17.75 * H);
    expect(b.to).toBe(20 * H);
    const start = b.at(b.from);
    const drop = start - b.at(b.to);
    // Still falling, but by less than the straight line would (0.0045 over 2¼ hours).
    expect(drop).toBeGreaterThan(0.002);
    expect(drop).toBeLessThan(0.0045);
    expect(start).toBeCloseTo(1.05 - 0.0355, 9);
  });

  it("doesn't read a trend into noise on a flat line", () => {
    const ts = Array.from({ length: 22 * 60 }, (_, i) => i * MIN);
    // Jitter of up to ±0.0003 around 1.011, the same every run.
    const values = ts.map((_, i) => 1.011 + 0.0003 * Math.sin(i * 2.399963) * Math.cos(i * 0.618034));
    const b = bridgeGap(ts, values, { from: 20 * H, to: 23 * H })!;
    expect(b.to).toBe(ts[ts.length - 1]);
    expect(Math.abs(b.at(b.to) - b.at(b.from))).toBeLessThan(1e-9);
  });

  it("doesn't go on from readings a long way off", () => {
    const ts = [...times(0, 5), ...times(20, 30)];
    const values = ts.map((t) => 1.03 - (0.0005 * t) / H);
    const b = bridgeGap(ts, values, { from: 19 * H, to: 21 * H })!;
    // Only the readings after the window count: it starts at the first one hidden.
    expect(b.from).toBe(20 * H);
    expect(b.to).toBe(21.25 * H);
    expect(bridgeGap(ts, values, { from: 5.1 * H, to: 19 * H })).toBeNull();
  });

  it('has nothing to do when no readings are hidden', () => {
    expect(
      bridgeGap(
        times(0, 2),
        times(0, 2).map(() => 1),
        { from: 0.3 * H, to: 0.4 * H },
      ),
    ).toBeNull();
  });

  it('empties the windows and shares one curve between windows with no readings between them', () => {
    const ts = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((h) => h * H);
    const values = [1, 2, 3, 50, null, 50, 7, 50, 9, 10];
    const around = (h: number) => ({ from: h * H - MIN, to: h * H + MIN });
    const apart = excludeColumn(ts, values, [around(3), around(5), around(7)]);
    expect(apart.values).toEqual([1, 2, 3, null, null, null, 7, null, 9, 10]);
    expect(apart.hidden).toEqual([false, false, false, true, false, true, false, true, false, false]);
    // 3 and 5 have only a gap between them; 6 is a reading, so 7 gets its own curve.
    expect(apart.bridges.map((b) => [b.from / H, b.to / H])).toEqual([
      [2, 6],
      [6, 8],
    ]);
    expect(bridgeAt(apart.bridges, 4 * H)?.at(4 * H)).toBeGreaterThan(3);
    expect(excludeColumn(ts, values, [around(3)], false).bridges).toEqual([]);
  });

  it('fills a history in from the curves for small charts', () => {
    const ts = times(0, 6);
    const n = ts.length;
    const h: History = {
      pillId: 'p',
      from: ts[0]!,
      to: ts[n - 1]!,
      bucketMs: 0,
      ts,
      gravity: ts.map((t) => 1.05 - (0.001 * t) / H + (t === 3 * H ? 0.03 : 0)),
      temperature: ts.map(() => 20),
      velocity: ts.map(() => null),
      battery: ts.map(() => 90),
      rssi: ts.map(() => -60),
      tilt: ts.map(() => 40),
      implausible: ts.map((t) => (t === 3 * H ? true : t === H ? true : false)),
    };
    expect(fillHistory(h, [])).toBe(h);
    const filled = fillHistory(h, [{ from: 2.9 * H, to: 3.1 * H }])!;
    const i = ts.indexOf(3 * H);
    expect(filled.gravity[i]).toBeCloseTo(1.047, 9);
    expect(filled.implausible[i]).toBe(false);
    expect(filled.temperature[i]).toBeCloseTo(20, 9);
    expect(filled.velocity[i]).toBeNull();
    // Outside the window, nothing changes (an implausible reading stays one).
    expect(filled.implausible[ts.indexOf(H)]).toBe(true);
    expect(filled.gravity.slice(0, i)).toEqual(h.gravity.slice(0, i));
  });
});
