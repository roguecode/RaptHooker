import type { History } from '@rapthooker/shared';
import { t, tk } from '../i18n';

/** A span of time, Unix ms. */
export interface TimeWindow {
  from: number;
  to: number;
}

export interface HistoryRange extends TimeWindow {
  /** Follows new readings as they arrive. */
  live: boolean;
}

const MIN = 60_000;
const H = 60 * MIN;
const D = 24 * H;

/** The narrowest the chart zooms in. */
export const MIN_SPAN_MS = 15 * MIN;

// Zooming and panning

/** Keeps a window inside the bounds and at least `minSpan` wide (or as wide as the bounds when they're narrower). */
export function clampWindow(win: TimeWindow, bounds: TimeWindow, minSpan = MIN_SPAN_MS): TimeWindow {
  const boundSpan = Math.max(0, bounds.to - bounds.from);
  const span = Math.min(Math.max(win.to - win.from, Math.min(minSpan, boundSpan)), boundSpan);
  let from = win.to - win.from < span ? (win.from + win.to) / 2 - span / 2 : win.from;
  from = Math.min(Math.max(from, bounds.from), bounds.to - span);
  return { from, to: from + span };
}

/** Zooms by `factor` (below 1 zooms in) keeping `anchor` (a time) where it is on screen. */
export function zoomWindow(win: TimeWindow, anchor: number, factor: number, bounds: TimeWindow, minSpan = MIN_SPAN_MS): TimeWindow {
  const span = win.to - win.from;
  const boundSpan = Math.max(0, bounds.to - bounds.from);
  const frac = span > 0 ? Math.min(1, Math.max(0, (anchor - win.from) / span)) : 0.5;
  const next = Math.min(boundSpan, Math.max(span * factor, Math.min(minSpan, boundSpan)));
  const from = anchor - frac * next;
  return clampWindow({ from, to: from + next }, bounds, minSpan);
}

/** Moves the window by `delta` ms, stopping at the bounds. */
export function panWindow(win: TimeWindow, delta: number, bounds: TimeWindow): TimeWindow {
  return clampWindow({ from: win.from + delta, to: win.to + delta }, bounds, 0);
}

/**
 * The window for a two-finger pinch: the time under the fingers' midpoint at the start stays under their midpoint, and
 * the span scales with the distance between them. Positions are CSS px from the plot's left edge.
 */
export function pinchWindow(
  start: TimeWindow,
  startPx: [number, number],
  nowPx: [number, number],
  plotWidth: number,
  bounds: TimeWindow,
  minSpan = MIN_SPAN_MS,
): TimeWindow {
  const span = start.to - start.from;
  const w = Math.max(1, plotWidth);
  // Fingers almost on top of each other (or one above the other) would make huge jumps.
  const d0 = Math.max(Math.abs(startPx[1] - startPx[0]), 24);
  const d1 = Math.max(Math.abs(nowPx[1] - nowPx[0]), 24);
  const c0 = (startPx[0] + startPx[1]) / 2;
  const c1 = (nowPx[0] + nowPx[1]) / 2;
  const anchor = start.from + (c0 / w) * span;
  const boundSpan = Math.max(0, bounds.to - bounds.from);
  const next = Math.min(boundSpan, Math.max((span * d0) / d1, Math.min(minSpan, boundSpan)));
  const from = anchor - (c1 / w) * next;
  return clampWindow({ from, to: from + next }, bounds, minSpan);
}

/** The window for a drag-selection across the plot (CSS px from the plot's left edge). */
export function windowFromSelection(
  win: TimeWindow,
  left: number,
  width: number,
  plotWidth: number,
  bounds: TimeWindow,
  minSpan = MIN_SPAN_MS,
): TimeWindow {
  const span = win.to - win.from;
  const w = Math.max(1, plotWidth);
  const from = win.from + (left / w) * span;
  const to = win.from + ((left + width) / w) * span;
  return clampWindow({ from, to }, bounds, minSpan);
}

/** Drags one end of the window (the overview strip's handles). */
export function resizeWindow(start: TimeWindow, edge: 'from' | 'to', delta: number, bounds: TimeWindow, minSpan = MIN_SPAN_MS): TimeWindow {
  const min = Math.min(minSpan, Math.max(0, bounds.to - bounds.from));
  if (edge === 'from') {
    const from = Math.min(Math.max(bounds.from, start.from + delta), start.to - min);
    return { from, to: start.to };
  }
  const to = Math.max(Math.min(bounds.to, start.to + delta), start.from + min);
  return { from: start.from, to };
}

/** True when the window shows less than the whole range. */
export const isZoomed = (win: TimeWindow, bounds: TimeWindow): boolean => win.to - win.from < (bounds.to - bounds.from) * 0.995;

// Ranges

export type RangePreset = '6h' | '24h' | '3d' | '7d' | '14d' | '30d' | 'brew' | 'all' | 'custom';

/** Labels and titles are English (marked with tk): show them with t(). */
export const RANGE_PRESETS: { id: Exclude<RangePreset, 'custom'>; label: string; title: string; ms: number }[] = [
  // i18n: short button labels: 6 hours, 24 hours, 3 days... (H is hours, D is days)
  { id: '6h', label: tk('6H'), title: tk('Last 6 hours'), ms: 6 * H },
  { id: '24h', label: tk('24H'), title: tk('Last 24 hours'), ms: D },
  { id: '3d', label: tk('3D'), title: tk('Last 3 days'), ms: 3 * D },
  { id: '7d', label: tk('7D'), title: tk('Last 7 days'), ms: 7 * D },
  { id: '14d', label: tk('14D'), title: tk('Last 14 days'), ms: 14 * D },
  { id: '30d', label: tk('30D'), title: tk('Last 30 days'), ms: 30 * D },
  // i18n: "Brew" is a noun: the time the brew has been running
  { id: 'brew', label: tk('Brew'), title: tk('Since the brew started'), ms: 0 },
  { id: 'all', label: tk('All'), title: tk('Everything recorded'), ms: 0 },
];

export interface RangeContext {
  now: number;
  /** The first reading (or when the pill was added). */
  firstAt: number;
  brewStart?: number | null;
  brewEnd?: number | null;
  custom?: TimeWindow | null;
}

/** The history to fetch for a preset. Ranges that run to now follow new readings. */
export function presetRange(preset: RangePreset, ctx: RangeContext): HistoryRange {
  const { now } = ctx;
  if (preset === 'custom' && ctx.custom && Math.min(ctx.custom.to, now) > ctx.custom.from) {
    return { from: ctx.custom.from, to: Math.min(ctx.custom.to, now), live: ctx.custom.to >= now - MIN };
  }
  if (preset === 'brew' && ctx.brewStart) {
    const end = ctx.brewEnd ?? null;
    return { from: ctx.brewStart, to: end ?? now, live: end === null };
  }
  const fixed = RANGE_PRESETS.find((p) => p.id === preset && p.ms > 0);
  if (fixed) return { from: now - fixed.ms, to: now, live: true };
  return { from: Math.min(ctx.firstAt, now - H), to: now, live: true };
}

/** Checks a custom range typed into two datetime-local inputs: the range, or what's wrong with it. */
export function checkCustomRange(fromText: string, toText: string, now: number): TimeWindow | string {
  const from = fromText ? new Date(fromText).getTime() : NaN;
  const to = toText ? new Date(toText).getTime() : NaN;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return t('Pick a start and an end');
  if (from >= to) return t('The start has to be before the end');
  if (from >= now) return t('The start is in the future');
  if (to - from < MIN_SPAN_MS) return t('Pick at least 15 minutes');
  return { from, to };
}

// Two-level history: the whole range, plus a closer look at the zoomed-in part

const STEPS = [MIN, 5 * MIN, 15 * MIN, 30 * MIN, H, 2 * H, 3 * H, 6 * H, 12 * H, D, 2 * D, 4 * D, 7 * D, 14 * D, 28 * D];

/**
 * The range to fetch in more detail for a zoomed-in view, or null when the whole-range history is detailed enough
 * (it has every reading, or the view shows most of it). Padded and snapped to a grid so small pans don't refetch.
 */
export function detailRange(view: TimeWindow | null, bounds: TimeWindow, overviewBucketMs: number, live: boolean): HistoryRange | null {
  if (!view || overviewBucketMs <= 0) return null;
  const span = view.to - view.from;
  if (span <= 0 || span >= (bounds.to - bounds.from) * 0.6) return null;
  const q = STEPS.find((s) => s >= span / 4) ?? STEPS[STEPS.length - 1]!;
  const from = Math.max(Math.floor(bounds.from / MIN) * MIN, Math.floor((view.from - span / 2) / q) * q);
  const to = Math.ceil((view.to + span / 2) / q) * q;
  // Past the end of the range, keep the snapped end (it doesn't move as readings arrive) and follow new readings.
  return to >= bounds.to ? { from, to, live } : { from, to, live: false };
}

type Column = Exclude<keyof History, 'pillId' | 'from' | 'to' | 'bucketMs' | 'ts'>;
const COLUMNS: Column[] = ['gravity', 'temperature', 'velocity', 'battery', 'rssi', 'tilt', 'implausible', 'pillGravity', 'pillVelocity'];

/** The whole-range history with the detailed part swapped in where it covers. */
export function mergeHistory(base: History | null, detail: History | null): History | null {
  if (!base || !detail) return base ?? detail;
  const lo = Math.min(detail.from, detail.ts[0] ?? Infinity);
  const hi = Math.max(detail.to, detail.ts[detail.ts.length - 1] ?? -Infinity);
  let a = 0;
  while (a < base.ts.length && base.ts[a]! < lo) a++;
  let b = a;
  while (b < base.ts.length && base.ts[b]! <= hi) b++;
  const out: History = {
    ...base,
    from: Math.min(base.from, detail.from),
    to: Math.max(base.to, detail.to),
    bucketMs: Math.min(base.bucketMs, detail.bucketMs),
    ts: [...base.ts.slice(0, a), ...detail.ts, ...base.ts.slice(b)],
  };
  for (const c of COLUMNS) {
    const x = base[c] as unknown[] | undefined;
    const y = detail[c] as unknown[] | undefined;
    if (!x && !y) continue;
    const pad = (arr: unknown[] | undefined, n: number) => arr ?? new Array<null>(n).fill(null);
    (out as unknown as Record<string, unknown[]>)[c] = [
      ...pad(x, base.ts.length).slice(0, a),
      ...pad(y, detail.ts.length),
      ...pad(x, base.ts.length).slice(b),
    ];
  }
  return out;
}

// Implausible readings

export interface GravitySplit<T> {
  /** Plausible values; implausible ones are `undefined` so the line joins its neighbours (a `null` breaks the line). */
  main: (T | null | undefined)[];
  /** Only the implausible values, pulled into the plausible range so they don't squash the chart. */
  faded: (number | null)[];
  /** The implausible values as they were. */
  fadedRaw: (number | null)[];
  any: boolean;
}

/** Splits gravity into the line to draw and the readings where the pill didn't look like it was floating. */
export function splitImplausible(values: (number | null)[], implausible: (boolean | null)[] | undefined): GravitySplit<number> {
  const n = values.length;
  const main: (number | null | undefined)[] = new Array(n);
  const faded: (number | null)[] = new Array<number | null>(n).fill(null);
  const fadedRaw: (number | null)[] = new Array<number | null>(n).fill(null);
  let lo = Infinity;
  let hi = -Infinity;
  let any = false;
  for (let i = 0; i < n; i++) {
    const v = values[i] ?? null;
    if (v !== null && implausible?.[i] === true) {
      main[i] = undefined;
      fadedRaw[i] = v;
      any = true;
    } else {
      main[i] = v;
      if (v !== null) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
  }
  if (any) {
    const clampable = lo <= hi;
    for (let i = 0; i < n; i++) {
      const v = fadedRaw[i];
      if (v !== null && v !== undefined) faded[i] = clampable ? Math.min(hi, Math.max(lo, v)) : v;
    }
  }
  return { main, faded, fadedRaw, any };
}

/** Removes the values at implausible readings without breaking the line. */
export function skipImplausible<T>(values: (T | null)[], implausible: (boolean | null)[] | undefined): (T | null | undefined)[] {
  if (!implausible) return values;
  return values.map((v, i) => (implausible[i] === true && v !== null ? undefined : v));
}

/** Index of the reading nearest `t` that has a value, or -1. `ts` must be sorted. */
export function nearestIndex(ts: number[], values: ArrayLike<number | null | undefined>, t: number): number {
  let lo = 0;
  let hi = ts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  const ok = (i: number) => values[i] !== null && values[i] !== undefined;
  let l = lo - 1;
  let r = lo;
  while (l >= 0 && !ok(l)) l--;
  while (r < ts.length && !ok(r)) r++;
  if (l < 0) return r < ts.length ? r : -1;
  if (r >= ts.length) return l;
  return t - ts[l]! <= ts[r]! - t ? l : r;
}

/** The next index (in direction `dir`) with a value, or -1. */
export function stepIndex(values: ArrayLike<number | null | undefined>, from: number, dir: 1 | -1): number {
  for (let i = from + dir; i >= 0 && i < values.length; i += dir) {
    if (values[i] !== null && values[i] !== undefined) return i;
  }
  return -1;
}

// Labels and the exported image

/**
 * Rows for labels along the x axis so they don't overlap: each label goes in the first row where it fits, or -1 when
 * there's no room. Boxes must be sorted by x.
 */
export function stackLabels(boxes: { x: number; width: number }[], rows: number, gap = 4): number[] {
  const ends = new Array<number>(Math.max(0, rows)).fill(-Infinity);
  return boxes.map((b) => {
    for (let r = 0; r < ends.length; r++) {
      if (b.x >= ends[r]! + gap) {
        ends[r] = b.x + b.width;
        return r;
      }
    }
    return -1;
  });
}

/** Lays items out left to right, wrapping onto new rows. */
export function flowLayout(widths: number[], maxWidth: number, gap: number): { x: number; row: number }[] {
  let x = 0;
  let row = 0;
  return widths.map((w) => {
    if (x > 0 && x + w > maxWidth) {
      x = 0;
      row++;
    }
    const at = { x, row };
    x += w + gap;
    return at;
  });
}

export interface PngLayout {
  width: number;
  height: number;
  pad: number;
  titleY: number;
  subtitleY: number;
  plot: { x: number; y: number };
  legend: { x: number; y: number }[];
  footerY: number;
}

/** Where everything goes in the exported image (device px). */
export function pngLayout(opts: { plotWidth: number; plotHeight: number; scale: number; legendWidths: number[] }): PngLayout {
  const s = opts.scale;
  const pad = Math.round(18 * s);
  const titleH = Math.round(50 * s);
  const rowH = Math.round(20 * s);
  const width = opts.plotWidth + pad * 2;
  const flow = flowLayout(opts.legendWidths, opts.plotWidth, Math.round(16 * s));
  const rows = flow.length ? flow[flow.length - 1]!.row + 1 : 0;
  const plotY = pad + titleH;
  const legendY = plotY + opts.plotHeight + Math.round(12 * s);
  const footerY = legendY + rows * rowH + Math.round(8 * s);
  return {
    width,
    height: footerY + Math.round(16 * s) + pad,
    pad,
    titleY: pad + Math.round(18 * s),
    subtitleY: pad + Math.round(38 * s),
    plot: { x: pad, y: plotY },
    legend: flow.map((f) => ({ x: pad + f.x, y: legendY + f.row * rowH + Math.round(10 * s) })),
    footerY: footerY + Math.round(8 * s),
  };
}

/** "<pill>-<date>.png", safe for any file system. */
export function pngFileName(name: string, at: number): string {
  const slug =
    name
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'chart';
  const d = new Date(at);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `${slug}-${date}.png`;
}
