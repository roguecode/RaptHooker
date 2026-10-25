import type { PillModel, Smoothing, TiltPoint } from './types.js';

/** Least-squares polynomial fit: coefficients a0..an of y = a0 + a1·x + a2·x² …, or null if the points can't support it. */
export function polyfit(points: { x: number; y: number }[], degree: number): number[] | null {
  const n = degree + 1;
  if (points.length < n) return null;
  // Normal equations, solved by Gaussian elimination with partial pivoting.
  const m: number[][] = Array.from({ length: n }, () => new Array<number>(n + 1).fill(0));
  for (const { x, y } of points) {
    const pow: number[] = [1];
    for (let i = 1; i < 2 * n; i++) pow.push(pow[i - 1]! * x);
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) m[r]![c]! += pow[r + c]!;
      m[r]![n]! += pow[r]! * y;
    }
  }
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    if (Math.abs(m[pivot]![col]!) < 1e-12) return null;
    [m[col], m[pivot]] = [m[pivot]!, m[col]!];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r]![col]! / m[col]![col]!;
      for (let c = col; c <= n; c++) m[r]![c]! -= f * m[col]![c]!;
    }
  }
  const out = m.map((row, i) => row[n]! / row[i]!);
  return out.every(Number.isFinite) ? out : null;
}

export function polyval(coeffs: number[], x: number): number {
  let y = 0;
  for (let i = coeffs.length - 1; i >= 0; i--) y = y * x + coeffs[i]!;
  return y;
}

/** The polynomial degree used for a set of tilt points: straight line for 2, quadratic for 3, cubic from 4. */
export const tiltDegree = (count: number): number => Math.min(3, Math.max(1, count - 1));

/** Fits gravity against tilt; null with fewer than two distinct tilts. */
export function fitTilt(points: TiltPoint[]): number[] | null {
  const distinct = new Set(points.map((p) => p.tilt.toFixed(1))).size;
  if (distinct < 2) return null;
  return polyfit(
    points.map((p) => ({ x: p.tilt, y: p.sg })),
    Math.min(tiltDegree(points.length), distinct - 1),
  );
}

/** Gravity worked out by RaptHooker from the tilt, or null when the pill's model doesn't use (or can't do) it. */
export function tiltGravity(model: PillModel, tilt: number | null): number | null {
  if (model.gravitySource !== 'tilt' || !model.tiltPoly || tilt === null) return null;
  const sg = polyval(model.tiltPoly, tilt);
  return Number.isFinite(sg) ? sg : null;
}

/** Window the gravity is averaged over for each smoothing setting, ms. */
export const SMOOTHING_MS: Record<Smoothing, number> = { off: 0, light: 60 * 60_000, strong: 4 * 60 * 60_000 };

/**
 * Gravity points per day from a least-squares line through the readings (negative while fermenting), or null when
 * there's too little to go on (fewer than 6 readings, or under 2 hours of data).
 */
export function slopePerDay(ts: number[], gravity: number[]): number | null {
  const n = Math.min(ts.length, gravity.length);
  if (n < 6 || ts[n - 1]! - ts[0]! < 2 * 3_600_000) return null;
  const t0 = ts[0]!;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const x = (ts[i]! - t0) / 86_400_000;
    const y = (gravity[i]! - 1) * 1000;
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
  }
  const d = n * sxx - sx * sx;
  if (!(Math.abs(d) > 1e-12)) return null;
  return (n * sxy - sx * sy) / d;
}

/** Trailing moving average over `windowMs` (null values are skipped and stay null). */
export function smooth(ts: number[], values: (number | null)[], windowMs: number): (number | null)[] {
  if (windowMs <= 0) return values.slice();
  const out: (number | null)[] = [];
  let start = 0;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v !== null && v !== undefined) {
      sum += v;
      count++;
    }
    while (ts[start]! < ts[i]! - windowMs) {
      const old = values[start];
      if (old !== null && old !== undefined) {
        sum -= old;
        count--;
      }
      start++;
    }
    out.push(v === null || v === undefined || count === 0 ? null : sum / count);
  }
  return out;
}

/**
 * slopePerDay over a trailing window at every point: RaptHooker's own velocity, points per day. Null values are
 * skipped; a point gets null when its window has too little data.
 */
export function rollingSlope(ts: number[], values: (number | null)[], windowMs: number): (number | null)[] {
  const out: (number | null)[] = [];
  const t0 = ts[0] ?? 0;
  const win: number[] = [];
  let head = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  const term = (i: number) => [(ts[i]! - t0) / 86_400_000, (values[i]! - 1) * 1000] as const;
  for (let i = 0; i < ts.length; i++) {
    if (values[i] !== null && values[i] !== undefined) {
      win.push(i);
      const [x, y] = term(i);
      sx += x;
      sy += y;
      sxx += x * x;
      sxy += x * y;
    }
    while (head < win.length && ts[win[head]!]! <= ts[i]! - windowMs) {
      const [x, y] = term(win[head]!);
      sx -= x;
      sy -= y;
      sxx -= x * x;
      sxy -= x * y;
      head++;
    }
    const n = win.length - head;
    const d = n * sxx - sx * sx;
    const span = n > 0 ? ts[win[win.length - 1]!]! - ts[win[head]!]! : 0;
    out.push(n >= 6 && span >= 2 * 3_600_000 && Math.abs(d) > 1e-12 ? (n * sxy - sx * sy) / d : null);
  }
  return out;
}
