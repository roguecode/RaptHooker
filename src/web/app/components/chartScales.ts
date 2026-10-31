import { useCallback, useMemo } from 'react';
import { useStored, writeStored } from '../storage';
import type { SeriesKey } from './Chart';
import type { TimeWindow } from './chartMath';

/** A scale's lowest and highest value. */
export type ScaleRange = [number, number];

/** Scales the user has set: gravity in SG, temperature in °C, the others in their own units. The rest scale themselves. */
export type ScaleRanges = Partial<Record<SeriesKey, ScaleRange>>;

const KEYS: readonly SeriesKey[] = ['gravity', 'temperature', 'velocity', 'battery', 'rssi', 'tilt'];

export function parseScaleRanges(raw: string | null): ScaleRanges {
  try {
    const saved = JSON.parse(raw ?? '{}') as unknown;
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
    const out: ScaleRanges = {};
    for (const k of KEYS) {
      const r = (saved as Record<string, unknown>)[k];
      if (!Array.isArray(r) || r.length !== 2) continue;
      const [lo, hi] = r as unknown[];
      if (typeof lo === 'number' && typeof hi === 'number' && Number.isFinite(lo) && Number.isFinite(hi) && lo < hi) out[k] = [lo, hi];
    }
    return out;
  } catch {
    return {};
  }
}

const asIs = (raw: string | null) => raw;

/** A chart's scales, remembered in this browser for one pill or brew (`id` like "pill.<id>"). */
export function useScaleRanges(id: string): [ScaleRanges, (next: ScaleRanges) => void] {
  const key = `rapthooker.scales.${id}`;
  const [raw] = useStored<string | null>(key, asIs);
  const ranges = useMemo(() => parseScaleRanges(raw), [raw]);
  const set = useCallback((next: ScaleRanges) => writeStored(key, Object.keys(next).length ? JSON.stringify(next) : null), [key]);
  return [ranges, set];
}

export type AxisSide = 'left' | 'right';

export interface AxisPlan {
  key: SeriesKey;
  side: AxisSide;
  /** Its numbers are shown. */
  numbers: boolean;
  /** It has a selector beside its numbers. */
  strip: boolean;
  /** Draws the chart's horizontal grid lines (gravity's, as ever). */
  grid: boolean;
}

/** Room for each scale's numbers, CSS px (uPlot's usual 5px gap from the plot included). */
export const AXIS_SIZE: Record<SeriesKey, number> = { gravity: 52, temperature: 48, velocity: 42, battery: 44, rssi: 40, tilt: 40 };
/** A scale's selector, between the plot and its numbers, with this much room either side. */
export const STRIP_W = 14;
export const STRIP_GAP = 4;
const STRIP_ROOM = STRIP_W + 2 * STRIP_GAP;
/** How far a scale's numbers sit from the plot: uPlot's usual 5px, or past its selector. */
export const labelGap = (a: AxisPlan): number => (a.strip ? STRIP_ROOM + 1 : 5);
/** The plot keeps at least this much of the chart's width (and this many px) whatever scales are shown. */
const PLOT_SHARE = 0.4;
const MIN_PLOT = 120;

/** How wide a scale is, CSS px. */
export const axisWidth = (a: AxisPlan): number => (a.numbers ? AXIS_SIZE[a.key] : 0) + (a.strip ? STRIP_ROOM : 0);

/**
 * Where each line's scale goes: gravity on the left, temperature on the right, and the others (in the order given)
 * alternating left then right. On each side the first sits next to the plot and always shows its numbers (and its
 * selector while the scales are being set). The others get a selector, then numbers, while they fit in `width` (the
 * chart's) alongside the plot; on a narrow screen their numbers only show while the scales are being set.
 */
export function axisLayout(keys: readonly SeriesKey[], opts: { narrow: boolean; editing: boolean; width: number }): AxisPlan[] {
  const placed: { key: SeriesKey; side: AxisSide }[] = [];
  if (keys.includes('gravity')) placed.push({ key: 'gravity', side: 'left' });
  if (keys.includes('temperature')) placed.push({ key: 'temperature', side: 'right' });
  let left = true;
  for (const key of keys) {
    if (key === 'gravity' || key === 'temperature') continue;
    placed.push({ key, side: left ? 'left' : 'right' });
    left = !left;
  }
  const sides = new Set<AxisSide>();
  const plan = placed.map((a) => {
    const first = !sides.has(a.side);
    sides.add(a.side);
    return { ...a, first, numbers: first, strip: first && opts.editing, grid: a.key === 'gravity' };
  });
  let room = opts.width - Math.max(MIN_PLOT, opts.width * PLOT_SHARE) - plan.reduce((n, a) => n + axisWidth(a), 0);
  if (opts.editing) {
    for (const a of plan) {
      if (a.first || room < STRIP_ROOM) continue;
      a.strip = true;
      room -= STRIP_ROOM;
    }
  }
  if (opts.editing || !opts.narrow) {
    for (const a of plan) {
      if (a.first || room < AXIS_SIZE[a.key] || (opts.editing && !a.strip)) continue;
      a.numbers = true;
      room -= AXIS_SIZE[a.key];
    }
  }
  return plan.map(({ first: _first, ...a }) => a);
}

/** The lowest and highest finite value across the columns, or null when there are none. */
export function extentOf(columns: readonly ArrayLike<number | null | undefined>[]): ScaleRange | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const col of columns) {
    for (let i = 0; i < col.length; i++) {
      const v = col[i];
      if (v === null || v === undefined || !Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  return lo <= hi ? [lo, hi] : null;
}

/** The smallest range taking in both. */
export function unionRange(a: TimeWindow | undefined, b: TimeWindow | undefined): TimeWindow | undefined {
  if (!a || !b) return a ?? b;
  return { from: Math.min(a.from, b.from), to: Math.max(a.to, b.to) };
}

/** Enough decimals to tell an axis's numbers apart, `incr` apart (uPlot's steps: 1, 2, 2.5 or 5 × 10ⁿ). */
export function axisDecimals(incr: number): number {
  let d = 0;
  while (d < 4 && Math.abs(Math.round(incr * 10 ** d) - incr * 10 ** d) > 1e-6 * 10 ** d) d++;
  return d;
}

function rgb(color: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  const hex = m[1]!.length === 3 ? [...m[1]!].map((c) => c + c).join('') : m[1]!;
  const n = parseInt(hex, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Two colours too alike to tell two lines apart. */
export function similarColor(a: string, b: string): boolean {
  const x = rgb(a);
  const y = rgb(b);
  if (!x || !y) return a.trim().toLowerCase() === b.trim().toLowerCase();
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) < 64;
}

/** For a line that would look like another: these work on dark and light backgrounds. */
export const SPARE_COLORS = ['#ef4444', '#d946ef', '#84cc16', '#f97316'];

/**
 * Each line's colour. Gravity is drawn in the pill's colour, which can be one of the theme's colours for another line
 * (a cyan pill and the cyan velocity): that line takes the theme's gravity colour instead, or a spare one.
 */
export function pickLineColors(
  gravity: string,
  theme: Record<SeriesKey, string>,
  themeGravity: string,
  spares: readonly string[] = SPARE_COLORS,
): Record<SeriesKey, string> {
  const out: Record<SeriesKey, string> = { ...theme, gravity };
  for (const key of KEYS) {
    if (key === 'gravity' || !similarColor(out[key], gravity)) continue;
    const others = KEYS.filter((k) => k !== key).map((k) => out[k]);
    out[key] = [themeGravity, ...spares].find((c) => others.every((o) => !similarColor(o, c))) ?? out[key];
  }
  return out;
}
