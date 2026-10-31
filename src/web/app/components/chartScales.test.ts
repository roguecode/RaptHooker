// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  axisDecimals,
  axisLayout,
  axisWidth,
  extentOf,
  parseScaleRanges,
  pickLineColors,
  similarColor,
  SPARE_COLORS,
  unionRange,
  useScaleRanges,
} from './chartScales';
import type { SeriesKey } from './Chart';

beforeEach(() => localStorage.clear());
afterEach(cleanup);

const ALL: SeriesKey[] = ['gravity', 'temperature', 'velocity', 'battery', 'rssi', 'tilt'];
const sides = (keys: SeriesKey[]) => axisLayout(keys, { narrow: false, editing: false, width: 1200 }).map((a) => `${a.key}:${a.side}`);

describe('axisLayout', () => {
  it('puts gravity on the left, temperature on the right and the rest alternately left then right', () => {
    expect(sides(ALL)).toEqual(['gravity:left', 'temperature:right', 'velocity:left', 'battery:right', 'rssi:left', 'tilt:right']);
    expect(sides(['gravity', 'battery', 'tilt'])).toEqual(['gravity:left', 'battery:left', 'tilt:right']);
    expect(sides(['temperature', 'rssi'])).toEqual(['temperature:right', 'rssi:left']);
  });

  it('draws the grid from the gravity scale only, as ever', () => {
    const plan = (keys: SeriesKey[]) => axisLayout(keys, { narrow: false, editing: false, width: 1200 }).map((a) => a.grid);
    expect(plan(['gravity', 'temperature', 'velocity'])).toEqual([true, false, false]);
    expect(plan(['temperature', 'velocity'])).toEqual([false, false]);
  });

  it('shows every scale on a wide chart, with selectors only while they are being set', () => {
    const closed = axisLayout(ALL, { narrow: false, editing: false, width: 1200 });
    expect(closed.every((a) => a.numbers && !a.strip)).toBe(true);
    const open = axisLayout(ALL, { narrow: false, editing: true, width: 1200 });
    expect(open.every((a) => a.numbers && a.strip)).toBe(true);
  });

  it('on a phone shows only the first scale on each side until they are being set', () => {
    const closed = axisLayout(ALL, { narrow: true, editing: false, width: 600 });
    expect(closed.filter((a) => a.numbers).map((a) => a.key)).toEqual(['gravity', 'temperature']);
    const open = axisLayout(['gravity', 'temperature', 'velocity'], { narrow: true, editing: true, width: 600 });
    expect(open.every((a) => a.numbers && a.strip)).toBe(true);
  });

  it('keeps room for the plot: selectors before numbers, and the first on each side always', () => {
    const width = 350;
    const open = axisLayout(ALL, { narrow: true, editing: true, width });
    expect(open.find((a) => a.key === 'gravity')).toMatchObject({ numbers: true, strip: true });
    expect(open.find((a) => a.key === 'temperature')).toMatchObject({ numbers: true, strip: true });
    expect(open.find((a) => a.key === 'velocity')).toMatchObject({ numbers: false, strip: true });
    expect(open.reduce((n, a) => n + axisWidth(a), 0)).toBeLessThanOrEqual(width * 0.6);
    // Too narrow for even those two: they still show.
    const tiny = axisLayout(['gravity', 'temperature', 'velocity'], { narrow: true, editing: true, width: 200 });
    expect(tiny.map((a) => [a.numbers, a.strip])).toEqual([
      [true, true],
      [true, true],
      [false, false],
    ]);
    // A closed chart drops the extra numbers that don't fit.
    const closed = axisLayout(ALL, { narrow: false, editing: false, width: 400 });
    expect(closed.reduce((n, a) => n + axisWidth(a), 0)).toBeLessThanOrEqual(400 * 0.6);
    expect(closed.slice(0, 2).every((a) => a.numbers)).toBe(true);
  });
});

describe('parseScaleRanges', () => {
  it('keeps only usable ranges for known lines', () => {
    expect(parseScaleRanges(null)).toEqual({});
    expect(parseScaleRanges('not json')).toEqual({});
    expect(parseScaleRanges('[1,2]')).toEqual({});
    expect(
      parseScaleRanges(
        JSON.stringify({
          gravity: [1.01, 1.05],
          temperature: [20, 18],
          velocity: [0, 'x'],
          battery: [0, 100, 3],
          rssi: [-90, -40],
          other: [0, 1],
        }),
      ),
    ).toEqual({ gravity: [1.01, 1.05], rssi: [-90, -40] });
  });
});

describe('pickLineColors', () => {
  // The default dark theme's colours, and the pills' own (PILL_COLORS).
  const theme: Record<SeriesKey, string> = {
    gravity: '#a78bfa',
    temperature: '#f472b6',
    velocity: '#22d3ee',
    battery: '#34d399',
    rssi: '#fbbf24',
    tilt: '#60a5fa',
  };

  it("keeps the theme's colours when the pill's colour stands apart", () => {
    expect(pickLineColors('#a78bfa', theme, '#a78bfa')).toEqual(theme);
  });

  it("gives a line the pill's colour would hide the theme's gravity colour", () => {
    expect(pickLineColors('#22d3ee', theme, '#a78bfa')).toEqual({ ...theme, gravity: '#22d3ee', velocity: '#a78bfa' });
    // Rose is close to the pink temperature.
    expect(pickLineColors('#fb7185', theme, '#a78bfa').temperature).toBe('#a78bfa');
  });

  it('takes a spare colour when the theme gravity colour would look like the pill too', () => {
    // Indigo is close to both the blue tilt and the violet gravity.
    const c = pickLineColors('#818cf8', theme, '#a78bfa');
    expect(c.tilt).toBe(SPARE_COLORS[0]);
    for (const [k, v] of Object.entries(c)) if (k !== 'gravity') expect(similarColor(v, '#818cf8')).toBe(false);
  });

  it('every pill colour leaves the lines told apart', () => {
    for (const pill of ['#a78bfa', '#60a5fa', '#22d3ee', '#f472b6', '#34d399', '#fbbf24', '#fb7185', '#818cf8']) {
      const colors = Object.values(pickLineColors(pill, theme, '#a78bfa'));
      for (let i = 0; i < colors.length; i++)
        for (let j = i + 1; j < colors.length; j++)
          expect(similarColor(colors[i]!, colors[j]!), `${pill}: ${colors[i]} ${colors[j]}`).toBe(false);
    }
  });
});

describe('extentOf, unionRange and axisDecimals', () => {
  it('finds the lowest and highest finite value', () => {
    expect(
      extentOf([
        [null, 3, undefined, 1],
        [NaN, 7],
      ]),
    ).toEqual([1, 7]);
    expect(extentOf([[null], []])).toBeNull();
  });

  it('joins two ranges, either of which may be missing', () => {
    expect(unionRange({ from: 1, to: 3 }, { from: 2, to: 5 })).toEqual({ from: 1, to: 5 });
    expect(unionRange(undefined, { from: 2, to: 5 })).toEqual({ from: 2, to: 5 });
    expect(unionRange(undefined, undefined)).toBeUndefined();
  });

  it("gives an axis's numbers just enough decimals", () => {
    expect([10, 5, 1, 0.5, 0.25, 0.2, 0.1, 0.05, 0.025, 0.0002].map(axisDecimals)).toEqual([0, 0, 0, 1, 2, 1, 1, 2, 3, 4]);
  });
});

describe('useScaleRanges', () => {
  it('remembers the scales per pill or brew in this browser', () => {
    const a = renderHook(() => useScaleRanges('pill.a'));
    const b = renderHook(() => useScaleRanges('pill.b'));
    expect(a.result.current[0]).toEqual({});
    act(() => a.result.current[1]({ gravity: [1, 1.05] }));
    expect(a.result.current[0]).toEqual({ gravity: [1, 1.05] });
    expect(b.result.current[0]).toEqual({});
    expect(JSON.parse(localStorage.getItem('rapthooker.scales.pill.a')!)).toEqual({ gravity: [1, 1.05] });
    // Back to automatic for all of them: nothing is left stored.
    act(() => a.result.current[1]({}));
    expect(localStorage.getItem('rapthooker.scales.pill.a')).toBeNull();
  });
});
