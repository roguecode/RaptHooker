import { describe, expect, it } from 'vitest';
import type { History } from '@rapthooker/shared';
import {
  checkCustomRange,
  clampWindow,
  detailRange,
  flowLayout,
  isZoomed,
  mergeHistory,
  nearestIndex,
  panWindow,
  pinchWindow,
  pngFileName,
  pngLayout,
  presetRange,
  resizeWindow,
  skipImplausible,
  splitImplausible,
  stackLabels,
  stepIndex,
  windowFromSelection,
  zoomWindow,
} from './chartMath';
import { brewAnnotations } from './annotations';

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;
const bounds = { from: 0, to: 10 * D };

describe('clampWindow', () => {
  it('leaves a window inside the bounds alone', () => {
    expect(clampWindow({ from: D, to: 2 * D }, bounds)).toEqual({ from: D, to: 2 * D });
  });

  it('slides a window back inside, keeping its span', () => {
    expect(clampWindow({ from: -D, to: D }, bounds)).toEqual({ from: 0, to: 2 * D });
    expect(clampWindow({ from: 9 * D, to: 11 * D }, bounds)).toEqual({ from: 8 * D, to: 10 * D });
  });

  it('shrinks a window wider than the bounds to the bounds', () => {
    expect(clampWindow({ from: -5 * D, to: 20 * D }, bounds)).toEqual(bounds);
  });

  it('widens a too-narrow window around its middle', () => {
    expect(clampWindow({ from: D, to: D + MIN }, bounds, 10 * MIN)).toEqual({ from: D - 4.5 * MIN, to: D + 5.5 * MIN });
  });

  it('uses the bounds when they are narrower than the smallest span', () => {
    expect(clampWindow({ from: 0, to: MIN }, { from: 0, to: 5 * MIN }, 15 * MIN)).toEqual({ from: 0, to: 5 * MIN });
  });
});

describe('zoomWindow', () => {
  it('keeps the anchor at the same place on screen', () => {
    const w = zoomWindow({ from: 2 * D, to: 6 * D }, 3 * D, 0.5, bounds);
    expect(w.to - w.from).toBe(2 * D);
    expect((3 * D - w.from) / (w.to - w.from)).toBeCloseTo(0.25);
  });

  it('stops at the bounds when zooming out', () => {
    expect(zoomWindow({ from: 2 * D, to: 6 * D }, 4 * D, 10, bounds)).toEqual(bounds);
  });

  it("doesn't zoom in past the smallest span", () => {
    const w = zoomWindow({ from: D, to: D + 20 * MIN }, D + 10 * MIN, 0.1, bounds, 15 * MIN);
    expect(w.to - w.from).toBe(15 * MIN);
  });
});

describe('panWindow', () => {
  it('moves the window and stops at the ends', () => {
    expect(panWindow({ from: D, to: 3 * D }, D, bounds)).toEqual({ from: 2 * D, to: 4 * D });
    expect(panWindow({ from: D, to: 3 * D }, -5 * D, bounds)).toEqual({ from: 0, to: 2 * D });
    expect(panWindow({ from: D, to: 3 * D }, 50 * D, bounds)).toEqual({ from: 8 * D, to: 10 * D });
  });
});

describe('pinchWindow', () => {
  const start = { from: 2 * D, to: 6 * D };

  it('halves the span when the fingers spread to twice the distance, around their midpoint', () => {
    const w = pinchWindow(start, [400, 600], [300, 700], 1000, bounds);
    expect(w.to - w.from).toBeCloseTo(2 * D);
    // The midpoint (half way across: day 4) stays half way across.
    expect((w.from + w.to) / 2).toBeCloseTo(4 * D);
  });

  it('pans when both fingers move together', () => {
    const w = pinchWindow(start, [400, 600], [500, 700], 1000, bounds);
    expect(w.to - w.from).toBeCloseTo(4 * D);
    // Dragging right by a tenth of the plot shows a tenth of the span earlier.
    expect(w.from).toBeCloseTo(2 * D - 0.4 * D);
  });

  it('stays inside the bounds', () => {
    const w = pinchWindow(start, [400, 600], [490, 510], 1000, bounds);
    expect(w).toEqual(bounds);
  });

  it("doesn't jump when the fingers are almost on top of each other", () => {
    const w = pinchWindow(start, [500, 501], [500, 502], 1000, bounds);
    expect(w.to - w.from).toBeCloseTo(4 * D);
  });
});

describe('windowFromSelection', () => {
  it('turns a drag across the plot into a time window', () => {
    expect(windowFromSelection({ from: 0, to: 10 * D }, 200, 300, 1000, bounds)).toEqual({ from: 2 * D, to: 5 * D });
  });
});

describe('resizeWindow', () => {
  const start = { from: 2 * D, to: 4 * D };

  it('moves one end', () => {
    expect(resizeWindow(start, 'from', -D, bounds)).toEqual({ from: D, to: 4 * D });
    expect(resizeWindow(start, 'to', D, bounds)).toEqual({ from: 2 * D, to: 5 * D });
  });

  it('stops at the bounds and keeps the smallest span', () => {
    expect(resizeWindow(start, 'from', -10 * D, bounds)).toEqual({ from: 0, to: 4 * D });
    expect(resizeWindow(start, 'to', -3 * D, bounds, 15 * MIN)).toEqual({ from: 2 * D, to: 2 * D + 15 * MIN });
  });
});

describe('isZoomed', () => {
  it('is false for the whole range', () => {
    expect(isZoomed(bounds, bounds)).toBe(false);
    expect(isZoomed({ from: D, to: 3 * D }, bounds)).toBe(true);
  });
});

describe('presetRange', () => {
  const now = 100 * D;
  const ctx = { now, firstAt: 50 * D };

  it('rolls back from now for the timed presets', () => {
    expect(presetRange('6h', ctx)).toEqual({ from: now - 6 * H, to: now, live: true });
    expect(presetRange('14d', ctx)).toEqual({ from: now - 14 * D, to: now, live: true });
  });

  it('starts at the first reading for "all", and at the brew for "brew"', () => {
    expect(presetRange('all', ctx)).toEqual({ from: 50 * D, to: now, live: true });
    expect(presetRange('brew', { ...ctx, brewStart: 90 * D })).toEqual({ from: 90 * D, to: now, live: true });
    expect(presetRange('brew', { ...ctx, brewStart: 90 * D, brewEnd: 95 * D })).toEqual({ from: 90 * D, to: 95 * D, live: false });
    expect(presetRange('brew', ctx)).toEqual(presetRange('all', ctx));
  });

  it('uses the custom range, following new readings only when it runs to now', () => {
    expect(presetRange('custom', { ...ctx, custom: { from: 60 * D, to: 70 * D } })).toEqual({ from: 60 * D, to: 70 * D, live: false });
    expect(presetRange('custom', { ...ctx, custom: { from: 60 * D, to: now + H } })).toEqual({ from: 60 * D, to: now, live: true });
    expect(presetRange('custom', { ...ctx, custom: null })).toEqual(presetRange('all', ctx));
  });
});

describe('checkCustomRange', () => {
  const now = new Date('2026-06-10T12:00').getTime();

  it('accepts a sensible range', () => {
    expect(checkCustomRange('2026-06-01T08:00', '2026-06-02T08:00', now)).toEqual({
      from: new Date('2026-06-01T08:00').getTime(),
      to: new Date('2026-06-02T08:00').getTime(),
    });
  });

  it('explains what is wrong', () => {
    expect(checkCustomRange('', '2026-06-02T08:00', now)).toMatch(/start and an end/);
    expect(checkCustomRange('2026-06-02T08:00', '2026-06-01T08:00', now)).toMatch(/before the end/);
    expect(checkCustomRange('2026-06-11T08:00', '2026-06-12T08:00', now)).toMatch(/future/);
    expect(checkCustomRange('2026-06-01T08:00', '2026-06-01T08:05', now)).toMatch(/15 minutes/);
  });
});

describe('detailRange', () => {
  it('needs nothing more when the overview has every reading or shows most of the range', () => {
    expect(detailRange({ from: D, to: 2 * D }, bounds, 0, true)).toBeNull();
    expect(detailRange({ from: 0, to: 8 * D }, bounds, 15 * MIN, true)).toBeNull();
    expect(detailRange(null, bounds, 15 * MIN, true)).toBeNull();
  });

  it('pads the view and snaps it to a grid, so small pans fetch nothing new', () => {
    const a = detailRange({ from: 3 * D + H, to: 4 * D + H }, bounds, 15 * MIN, true)!;
    expect(a.from).toBeLessThanOrEqual(2.5 * D + H);
    expect(a.to).toBeGreaterThanOrEqual(4.5 * D + H);
    expect(a.live).toBe(false);
    const b = detailRange({ from: 3 * D + H + 10 * MIN, to: 4 * D + H + 10 * MIN }, bounds, 15 * MIN, true)!;
    expect(b).toEqual(a);
  });

  it('follows new readings when the view reaches the end of a live range', () => {
    const r = detailRange({ from: 9 * D, to: 10 * D }, bounds, 15 * MIN, true)!;
    expect(r.to).toBeGreaterThanOrEqual(bounds.to);
    expect(r.live).toBe(true);
    expect(detailRange({ from: 9 * D, to: 10 * D }, bounds, 15 * MIN, false)!.live).toBe(false);
  });
});

const hist = (ts: number[], extra: Partial<History> = {}): History => ({
  pillId: 'p',
  from: ts[0] ?? 0,
  to: ts[ts.length - 1] ?? 0,
  bucketMs: 0,
  ts,
  gravity: ts.map((t) => 1 + t / 1e6),
  temperature: ts.map(() => 20),
  velocity: ts.map(() => null),
  battery: ts.map(() => 90),
  rssi: ts.map(() => -60),
  tilt: ts.map(() => 45),
  implausible: ts.map(() => false),
  ...extra,
});

describe('mergeHistory', () => {
  it('swaps the detailed part in where it covers', () => {
    const base = { ...hist([0, 100, 200, 300, 400]), bucketMs: 100 };
    const detail = { ...hist([150, 175, 200, 225, 250]), from: 150, to: 250 };
    const m = mergeHistory(base, detail)!;
    expect(m.ts).toEqual([0, 100, 150, 175, 200, 225, 250, 300, 400]);
    expect(m.gravity).toHaveLength(m.ts.length);
    expect(m.implausible).toHaveLength(m.ts.length);
    expect(m.bucketMs).toBe(0);
  });

  it('fills columns only one side has with nulls', () => {
    const base = hist([0, 100, 200], { pillGravity: [1, 1, 1] });
    const detail = { ...hist([110, 120]), from: 105, to: 125 };
    const m = mergeHistory(base, detail)!;
    expect(m.pillGravity).toEqual([1, 1, null, null, 1]);
  });

  it('returns whichever exists', () => {
    const base = hist([0]);
    expect(mergeHistory(base, null)).toBe(base);
    expect(mergeHistory(null, base)).toBe(base);
    expect(mergeHistory(null, null)).toBeNull();
  });
});

describe('splitImplausible', () => {
  it('leaves implausible readings out of the line without breaking it, and pulls them into the plausible range', () => {
    const s = splitImplausible([1.05, 1.5, 1.04, null, 1.03], [false, true, false, null, false]);
    expect(s.main).toEqual([1.05, undefined, 1.04, null, 1.03]);
    expect(s.faded).toEqual([null, 1.05, null, null, null]);
    expect(s.fadedRaw).toEqual([null, 1.5, null, null, null]);
    expect(s.any).toBe(true);
  });

  it("doesn't move them when nothing is plausible", () => {
    const s = splitImplausible([0.9, 1.3], [true, true]);
    expect(s.faded).toEqual([0.9, 1.3]);
    expect(s.main).toEqual([undefined, undefined]);
  });

  it('keeps everything without the flags', () => {
    expect(splitImplausible([1, null], undefined)).toMatchObject({ main: [1, null], any: false });
    expect(skipImplausible([1, 2, null], [true, false, true])).toEqual([undefined, 2, null]);
    expect(skipImplausible([1], undefined)).toEqual([1]);
  });
});

describe('nearestIndex and stepIndex', () => {
  const ts = [0, 10, 20, 30, 40];
  const vals = [1, undefined, null, 4, 5];

  it('finds the nearest reading with a value', () => {
    expect(nearestIndex(ts, vals, 12)).toBe(0);
    expect(nearestIndex(ts, vals, 22)).toBe(3);
    expect(nearestIndex(ts, vals, 100)).toBe(4);
    expect(nearestIndex(ts, vals, -5)).toBe(0);
    expect(nearestIndex([0, 1], [null, null], 0)).toBe(-1);
  });

  it('steps over readings without a value', () => {
    expect(stepIndex(vals, 0, 1)).toBe(3);
    expect(stepIndex(vals, 3, -1)).toBe(0);
    expect(stepIndex(vals, 4, 1)).toBe(-1);
  });
});

describe('stackLabels', () => {
  it('puts overlapping labels on the next row, and drops them when the rows run out', () => {
    const rows = stackLabels(
      [
        { x: 0, width: 50 },
        { x: 20, width: 50 },
        { x: 40, width: 50 },
        { x: 60, width: 50 },
        { x: 200, width: 50 },
      ],
      2,
    );
    expect(rows).toEqual([0, 1, -1, 0, 0]);
  });
});

describe('exported image', () => {
  it('flows legend items onto new rows', () => {
    expect(flowLayout([40, 40, 40], 100, 10)).toEqual([
      { x: 0, row: 0 },
      { x: 50, row: 0 },
      { x: 0, row: 1 },
    ]);
  });

  it('makes room for the title, the plot and the legend', () => {
    const one = pngLayout({ plotWidth: 1000, plotHeight: 500, scale: 2, legendWidths: [100, 100] });
    const two = pngLayout({ plotWidth: 1000, plotHeight: 500, scale: 2, legendWidths: [600, 600] });
    expect(one.width).toBe(1000 + 2 * one.pad);
    expect(one.plot.y).toBeGreaterThan(one.subtitleY);
    expect(one.legend[0]!.y).toBeGreaterThan(one.plot.y + 500);
    expect(two.height).toBeGreaterThan(one.height);
    expect(one.footerY).toBeLessThan(one.height);
  });

  it('names the file after the pill and the day', () => {
    const at = new Date(2026, 9, 4, 13, 0).getTime();
    expect(pngFileName('Pale Ale #2 (Fermenter)', at)).toBe('pale-ale-2-fermenter-2026-10-04.png');
    expect(pngFileName('Bière', at)).toBe('biere-2026-10-04.png');
    expect(pngFileName('***', at)).toBe('chart-2026-10-04.png');
  });
});

describe('brewAnnotations', () => {
  it('marks the start and each event, in time order', () => {
    const a = brewAnnotations({
      startedAt: 1000,
      endedAt: null,
      events: [
        { id: 'b', brewId: 'x', at: 3000, kind: 'cold_crash', text: '' },
        { id: 'a', brewId: 'x', at: 2000, kind: 'dry_hop', text: 'Citra and Mosaic, 50 g each, day three' },
      ],
    });
    expect(a.map((x) => x.label)).toEqual(['Brew started', 'Dry hop: Citra and Mosaic,…', 'Cold crash']);
    expect(a.map((x) => x.ts)).toEqual([1000, 2000, 3000]);
    expect(brewAnnotations(null)).toEqual([]);
  });
});
