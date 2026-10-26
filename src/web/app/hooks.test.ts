import { describe, expect, it } from 'vitest';
import type { History, Reading } from '@rapthooker/shared';
import { appendReading, historyGapMs } from './hooks';

const reading = (ts: number, extra: Partial<Reading> = {}): Reading => ({
  ts,
  gravity: 1.05,
  temperature: 20,
  velocity: -2,
  battery: 90,
  rssi: -60,
  tilt: 50,
  x: 0,
  y: 0,
  z: 0,
  plausible: true,
  pillGravity: 1.051,
  pillVelocity: -3,
  ...extra,
});

const history = (extra: Partial<History> = {}): History => ({
  pillId: 'p',
  from: 0,
  to: 1000,
  bucketMs: 0,
  ts: [1000],
  gravity: [1.06],
  temperature: [20],
  velocity: [null],
  battery: [90],
  rssi: [-60],
  tilt: [50],
  implausible: [false],
  ...extra,
});

describe('appendReading', () => {
  it('keeps every column the same length, including the optional ones', () => {
    const h = appendReading(history({ pillGravity: [1.061], pillVelocity: [null] }), reading(2000, { plausible: false }), 60_000);
    expect(h.ts).toEqual([1000, 2000]);
    expect(h.implausible).toEqual([false, true]);
    expect(h.pillGravity).toEqual([1.061, 1.051]);
    expect(h.pillVelocity).toEqual([null, -3]);
    expect(h.to).toBe(2000);
  });

  it("doesn't add the pill's columns when the history doesn't have them", () => {
    const h = appendReading(history(), reading(2000), 60_000);
    expect(h.pillGravity).toBeUndefined();
    expect(h.pillVelocity).toBeUndefined();
  });

  it('adds a row of nulls after a gap, and ignores readings it already has', () => {
    const h = appendReading(history(), reading(1000 + 10 * 60_000), 60_000);
    expect(h.ts).toHaveLength(3);
    expect(h.gravity[1]).toBeNull();
    expect(h.implausible[1]).toBeNull();
    expect(appendReading(h, reading(500), 60_000)).toBe(h);
  });
});

describe('historyGapMs', () => {
  it("breaks the line where the hub does: a few of the pill's intervals, 10 minutes to 3 hours", () => {
    expect(historyGapMs(null)).toBe(20 * 60_000);
    expect(historyGapMs(60)).toBe(10 * 60_000);
    // A pill sending every half hour isn't broken up at each reading.
    expect(historyGapMs(1800)).toBe(2 * 3_600_000);
    expect(historyGapMs(3600)).toBe(3 * 3_600_000);
  });
});
