import type { History } from '@rapthooker/shared';
import { clampWindow, isZoomed, type TimeWindow } from './chartMath';

const H = 3_600_000;

/** A smooth curve standing in for the readings left out of a chart. */
export interface Bridge {
  /** Where it runs, Unix ms: between the readings it joins (or up to the last one left out, with nothing beyond). */
  from: number;
  to: number;
  at: (t: number) => number;
}

/** The nearest reading to an excluded range on one side, and how the readings were moving there. */
interface Edge {
  t: number;
  v: number;
  /** Per ms, or null with too few readings to tell. */
  slope: number | null;
}

const finite = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/** First index with ts[i] >= t. */
function lowerBound(ts: readonly number[], t: number): number {
  let lo = 0;
  let hi = ts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid]! < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index with ts[i] > t. */
function upperBound(ts: readonly number[], t: number): number {
  let lo = 0;
  let hi = ts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid]! <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Sorted, with windows that overlap or touch joined. */
export function mergeWindows(wins: readonly TimeWindow[]): TimeWindow[] {
  const sorted = wins
    .filter((w) => w.to > w.from)
    .map((w) => ({ from: w.from, to: w.to }))
    .sort((a, b) => a.from - b.from);
  const out: TimeWindow[] = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && w.from <= last.to) last.to = Math.max(last.to, w.to);
    else out.push(w);
  }
  return out;
}

/** How far either side of a range of `span` ms the trend is read from. */
const reachOf = (span: number) => Math.min(Math.max(span, 2 * H), 12 * H);

/**
 * Slope (per ms) of a straight line fitted through the points, the ones nearest `t0` counting most. A slope the points
 * don't clearly show (smaller than twice its standard error: sensor noise on a flat line) is 0.
 */
function trend(pts: { t: number; v: number }[], t0: number): number | null {
  if (pts.length < 2) return null;
  const far = Math.max(...pts.map((p) => Math.abs(p.t - t0))) * 1.25;
  if (far <= 0) return null;
  let sw = 0;
  let sx = 0;
  let sy = 0;
  const w = pts.map((p) => (1 - (Math.abs(p.t - t0) / far) ** 3) ** 3);
  pts.forEach((p, i) => {
    sw += w[i]!;
    sx += w[i]! * ((p.t - t0) / H);
    sy += w[i]! * p.v;
  });
  const mx = sx / sw;
  const my = sy / sw;
  let sxx = 0;
  let sxy = 0;
  pts.forEach((p, i) => {
    const dx = (p.t - t0) / H - mx;
    sxx += w[i]! * dx * dx;
    sxy += w[i]! * dx * (p.v - my);
  });
  if (!(sxx > 0)) return null;
  const slope = sxy / sxx;
  if (pts.length > 3) {
    // Heteroskedasticity-consistent (HC0) variance of a weighted least-squares slope.
    let v = 0;
    pts.forEach((p, i) => {
      const dx = (p.t - t0) / H - mx;
      const r = p.v - (my + slope * dx);
      v += (w[i]! * dx * r) ** 2;
    });
    if (Math.abs(slope) < (2 * Math.sqrt(v)) / sxx) return 0;
  }
  return slope / H;
}

/**
 * The reading nearest an excluded range, walking away from it from index `start` in `dir` (no further than `stop`),
 * and the trend over the readings beyond it. Null when the nearest reading is too far away to go on from.
 */
function edgeOf(
  ts: readonly number[],
  values: ArrayLike<number | null | undefined>,
  start: number,
  dir: -1 | 1,
  stop: number,
  boundary: number,
  span: number,
): Edge | null {
  const maxGap = Math.max(span, 3 * H);
  const reach = reachOf(span);
  const pts: { t: number; v: number }[] = [];
  for (let i = start; dir < 0 ? i >= stop : i < stop; i += dir) {
    const v = values[i];
    if (!finite(v)) continue;
    const t = ts[i]!;
    if (pts.length === 0 && Math.abs(t - boundary) > maxGap) return null;
    const fromAnchor = pts.length ? Math.abs(t - pts[0]!.t) : 0;
    // At least a few readings for the trend, reaching further for them when they're sparse (long, averaged ranges).
    if (fromAnchor > reach * (pts.length < 4 ? 3 : 1)) break;
    pts.push({ t, v });
    if (pts.length >= 20_000) break;
  }
  const anchor = pts[0];
  return anchor ? { t: anchor.t, v: anchor.v, slope: trend(pts, anchor.t) } : null;
}

/**
 * A cubic curve from one edge to the other that leaves each at the slope the readings had there. The slopes are
 * limited so the curve never overshoots (Fritsch–Carlson): it stays between the two readings it joins.
 */
function hermite(a: Edge, b: Edge): Bridge {
  const h = b.t - a.t;
  const d = (b.v - a.v) / h;
  let m0 = a.slope ?? d;
  let m1 = b.slope ?? d;
  if (d === 0) {
    m0 = 0;
    m1 = 0;
  } else {
    if (Math.sign(m0) !== Math.sign(d)) m0 = 0;
    if (Math.sign(m1) !== Math.sign(d)) m1 = 0;
    const p = m0 / d;
    const q = m1 / d;
    const s = p * p + q * q;
    if (s > 9) {
      const k = 3 / Math.sqrt(s);
      m0 = k * p * d;
      m1 = k * q * d;
    }
  }
  return {
    from: a.t,
    to: b.t,
    at: (t) => {
      const u = Math.min(1, Math.max(0, (t - a.t) / h));
      const u2 = u * u;
      const u3 = u2 * u;
      return (2 * u3 - 3 * u2 + 1) * a.v + (u3 - 2 * u2 + u) * h * m0 + (-2 * u3 + 3 * u2) * b.v + (u3 - u2) * h * m1;
    },
  };
}

/**
 * A curve through an excluded window, from the readings either side of it: it joins the last reading before and the
 * first after, carrying on the way each side was moving. With readings on one side only (the window runs to the
 * latest reading, say), it carries on from that side, levelling off. Null when nothing is hidden or there's nothing
 * near to go on from. `lo` and `hi` keep it between neighbouring windows.
 */
export function bridgeGap(
  ts: readonly number[],
  values: ArrayLike<number | null | undefined>,
  win: TimeWindow,
  lo = 0,
  hi = ts.length,
): Bridge | null {
  const a = lowerBound(ts, win.from);
  const b = upperBound(ts, win.to);
  if (a >= b) return null;
  const span = win.to - win.from;
  const before = edgeOf(ts, values, a - 1, -1, lo, win.from, span);
  const after = edgeOf(ts, values, b, 1, hi, win.to, span);
  if (before && after) return hermite(before, after);
  const tau = reachOf(span);
  if (before) {
    const m = before.slope ?? 0;
    return {
      from: before.t,
      to: Math.max(before.t, ts[b - 1]!),
      at: (t) => before.v + m * tau * (1 - Math.exp(-Math.max(0, t - before.t) / tau)),
    };
  }
  if (after) {
    const m = after.slope ?? 0;
    return { from: Math.min(after.t, ts[a]!), to: after.t, at: (t) => after.v - m * tau * (1 - Math.exp(-Math.max(0, after.t - t) / tau)) };
  }
  return null;
}

export interface ExcludedColumn {
  /** The values with those in the windows emptied (null), so the chart's line breaks there. */
  values: (number | null | undefined)[];
  /** True where a value was emptied. */
  hidden: boolean[];
  /** Curves to draw over the emptied stretches. */
  bridges: Bridge[];
}

/**
 * Empties a column in the excluded windows and works out the curves to draw instead. Windows with no readings between
 * them share one curve. `values` that are undefined (left out, like implausible gravity) are skipped as anchors.
 */
export function excludeColumn(
  ts: readonly number[],
  values: ArrayLike<number | null | undefined>,
  windows: readonly TimeWindow[],
  bridge = true,
): ExcludedColumn {
  const out: (number | null | undefined)[] = Array.from(values);
  const hidden = new Array<boolean>(out.length).fill(false);
  const wins = mergeWindows(windows);
  const spans = wins.map((w) => [lowerBound(ts, w.from), upperBound(ts, w.to)] as const);
  for (const [a, b] of spans) {
    for (let i = a; i < b; i++) {
      out[i] = null;
      hidden[i] = true;
    }
  }
  const bridges: Bridge[] = [];
  if (!bridge) return { values: out, hidden, bridges };

  const hasReading = (a: number, b: number) => {
    for (let i = a; i < b; i++) if (finite(out[i])) return true;
    return false;
  };
  for (let g = 0; g < wins.length;) {
    let end = g;
    while (end + 1 < wins.length && !hasReading(spans[end]![1], spans[end + 1]![0])) end++;
    const lo = g > 0 ? spans[g - 1]![1] : 0;
    const hi = end + 1 < wins.length ? spans[end + 1]![0] : ts.length;
    const b = bridgeGap(ts, out, { from: wins[g]!.from, to: wins[end]!.to }, lo, hi);
    if (b) bridges.push(b);
    g = end + 1;
  }
  return { values: out, hidden, bridges };
}

/** The bridge covering `t`, if any. */
export function bridgeAt(bridges: readonly Bridge[] | undefined, t: number): Bridge | undefined {
  return bridges?.find((b) => t >= b.from && t <= b.to);
}

/** The windows that overlap `bounds`. */
export function windowsIn<T extends TimeWindow>(wins: readonly T[] | undefined, bounds: TimeWindow): T[] {
  return (wins ?? []).filter((w) => w.to >= bounds.from && w.from <= bounds.to);
}

/** A view of a range just excluded with some of the readings either side (as much again), or null for everything. */
export function contextWindow(range: TimeWindow, bounds: TimeWindow): TimeWindow | null {
  const span = range.to - range.from;
  const next = clampWindow({ from: range.from - span, to: range.to + span }, bounds);
  return isZoomed(next, bounds) ? next : null;
}

type NumberColumn = 'gravity' | 'temperature' | 'velocity' | 'battery' | 'rssi' | 'tilt' | 'pillGravity' | 'pillVelocity';
const NUMBER_COLUMNS: NumberColumn[] = ['gravity', 'temperature', 'velocity', 'battery', 'rssi', 'tilt', 'pillGravity', 'pillVelocity'];

/**
 * The history with the excluded windows filled in from the curves (for small charts that don't mark them, like the
 * overview strip). Readings in the windows no longer count as implausible: their values are the curve's.
 */
export function fillHistory(h: History | null, windows: readonly TimeWindow[]): History | null {
  if (!h || windows.length === 0) return h;
  const out: History = { ...h };
  let hidden: boolean[] | null = null;
  for (const key of NUMBER_COLUMNS) {
    const col = h[key];
    if (!col) continue;
    const skipImplausible = key === 'gravity' || key === 'pillGravity';
    const anchors = skipImplausible ? col.map((v, i) => (h.implausible[i] === true ? undefined : v)) : col;
    const r = excludeColumn(h.ts, anchors, windows);
    hidden ??= r.hidden;
    out[key] = col.map((v, i) => {
      if (!r.hidden[i]) return v;
      const b = bridgeAt(r.bridges, h.ts[i]!);
      return b ? b.at(h.ts[i]!) : null;
    });
  }
  if (hidden) {
    const mask = hidden;
    out.implausible = h.implausible.map((v, i) => (mask[i] ? false : v));
  }
  return out;
}
