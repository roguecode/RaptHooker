import type { BrewPrediction, BrewStage } from './types.js';

/**
 * Fermentation maths: whether the gravity has stopped moving, and a curve fitted to the readings so far to tell how
 * far along a brew is and where it will end up.
 *
 * The curve is a four-parameter logistic, the usual S shape of a fermentation (slow start, fast middle, slow finish):
 *
 *   gravity(t) = FG + (OG − FG) / (1 + e^(k·(t − mid)))
 *
 * OG and FG are where it starts and ends, `mid` is when it's halfway and `k` how steep it is. Everything here is pure,
 * so the hub and the web app work it out the same way.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface GravityPoint {
  /** Unix time, ms. */
  t: number;
  /** Specific gravity. */
  g: number;
}

export const FERMENTATION_LIMITS = {
  /** The gravity counts as stable when it moves less than this… */
  stableTolerance: 0.001,
  /** …over this long… */
  stableWindowMs: 48 * HOUR,
  /** …with at least this much data. */
  stableMinSpanMs: 24 * HOUR,
  /** A drop smaller than this (2 points) isn't fermentation yet. */
  minDrop: 0.002,
  /** No predictions with less data than this. */
  minFitSpanMs: 12 * HOUR,
  /** Fewer buckets than this and there's nothing to fit. */
  minPoints: 8,
  /** Predicted finishes further away than this are too uncertain to show. */
  maxFinishMs: 60 * DAY,
} as const;

// Fit bounds, in gravity points ((SG − 1) × 1000) and hours.
const K_MIN = 0.004;
const K_MAX = 0.6;
const FG_MIN = -15;
const MID_BEFORE = 72;
const MID_AFTER = 240;
const MAX_BUCKETS = 240;
/** How much the FG guess counts, against a point's squared error (in gravity points): a gentle nudge. */
const PRIOR_WEIGHT = 0.003;

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Median gravity over fixed time buckets, oldest first. Each bucket is placed at the mean time of its readings. */
export function bucketMedians(points: GravityPoint[], bucketMs = HOUR): GravityPoint[] {
  const buckets = new Map<number, { t: number; g: number[] }>();
  for (const p of points) {
    if (!Number.isFinite(p.t) || !Number.isFinite(p.g)) continue;
    const key = Math.floor(p.t / bucketMs);
    const b = buckets.get(key);
    if (b) {
      b.t += p.t;
      b.g.push(p.g);
    } else buckets.set(key, { t: p.t, g: [p.g] });
  }
  return [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => ({ t: Math.round(b.t / b.g.length), g: median(b.g)! }));
}

export interface FermentationCurve {
  /** Upper asymptote: the gravity before fermentation, SG. */
  og: number;
  /** Lower asymptote: the expected final gravity, SG. */
  fg: number;
  /** Steepness, per hour. */
  k: number;
  /** When the gravity is halfway between OG and FG, ms. */
  midAt: number;
  /** Root-mean-square distance of the readings from the curve, SG. */
  rmse: number;
  /** Points the fit used (after dropping outliers). */
  n: number;
}

const share = (c: FermentationCurve, t: number) => 1 / (1 + Math.exp((c.k * (t - c.midAt)) / HOUR));

export function curveGravity(c: FermentationCurve, t: number): number {
  return c.fg + (c.og - c.fg) * share(c, t);
}

/** How fast the curve is falling at `t`, gravity points per day. */
export function curveRate(c: FermentationCurve, t: number): number {
  const s = share(c, t);
  return (c.og - c.fg) * 1000 * c.k * s * (1 - s) * 24;
}

/** When the curve comes within `within` (SG) of its final gravity, ms; null when its whole drop is smaller than that. */
export function curveFinishAt(c: FermentationCurve, within = FERMENTATION_LIMITS.stableTolerance): number | null {
  const drop = c.og - c.fg;
  if (!(drop > within)) return null;
  return c.midAt + (Math.log(drop / within - 1) / c.k) * HOUR;
}

interface Fitted {
  u: number;
  m: number;
  f: number;
  a: number;
  sse: number;
}

/**
 * Fits the logistic curve to gravity readings by least squares. For a given steepness and midpoint the curve is a
 * straight line in FG and (OG − FG), so those two are solved exactly and only the other two are searched: a coarse grid
 * then a pattern search. A second pass leaves out readings far off the first curve (hop debris, a knock, CO₂).
 *
 * `priorFg` gently steadies FG before the curve has turned (when the readings can't yet tell where it levels off); once
 * they can, they outweigh it. Returns null with fewer than 6 points.
 */
export function fitFermentation(points: GravityPoint[], opts: { priorFg?: number | null } = {}): FermentationCurve | null {
  const pts = points.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.g)).sort((a, b) => a.t - b.t);
  if (pts.length < 6) return null;
  const t0 = pts[0]!.t;
  const xs = pts.map((p) => (p.t - t0) / HOUR);
  const ys = pts.map((p) => (p.g - 1) * 1000);
  const xMax = xs[xs.length - 1]!;
  if (!(xMax > 0)) return null;
  const prior = opts.priorFg != null && Number.isFinite(opts.priorFg) ? (opts.priorFg - 1) * 1000 : null;
  const w = prior === null ? 0 : PRIOR_WEIGHT;
  const p = prior ?? 0;
  const uMin = Math.log(K_MIN);
  const uMax = Math.log(K_MAX);
  const mMin = -MID_BEFORE;
  const mMax = xMax + MID_AFTER;

  const evaluate = (x: number[], y: number[], u: number, m: number): Fitted => {
    const k = Math.exp(u);
    const n = x.length;
    let sy = 0;
    let syy = 0;
    let ss = 0;
    let sss = 0;
    let ssy = 0;
    for (let i = 0; i < n; i++) {
      const s = 1 / (1 + Math.exp(k * (x[i]! - m)));
      const yi = y[i]!;
      sy += yi;
      syy += yi * yi;
      ss += s;
      sss += s * s;
      ssy += s * yi;
    }
    const nw = n + w;
    const yw = sy + w * p;
    const det = nw * sss - ss * ss;
    let f: number;
    let a: number;
    if (det > 1e-9 * nw * Math.max(sss, 1e-12)) {
      f = (yw * sss - ss * ssy) / det;
      a = (nw * ssy - ss * yw) / det;
    } else {
      f = yw / nw;
      a = 0;
    }
    if (a < 0) {
      a = 0;
      f = yw / nw;
    }
    if (f < FG_MIN) {
      f = FG_MIN;
      a = sss > 0 ? Math.max(0, (ssy - f * ss) / sss) : 0;
    }
    const dataSse = syy - 2 * f * sy - 2 * a * ssy + n * f * f + 2 * f * a * ss + a * a * sss;
    return { u, m, f, a, sse: Math.max(0, dataSse) + w * (f - p) ** 2 };
  };

  const clampU = (u: number) => Math.min(uMax, Math.max(uMin, u));
  const clampM = (m: number) => Math.min(mMax, Math.max(mMin, m));

  const refine = (x: number[], y: number[], start: Fitted, du: number, dm: number): Fitted => {
    let best = start;
    for (let i = 0; i < 200 && (du > 0.002 || dm > 0.02); i++) {
      let moved = false;
      for (const [cu, cm] of [
        [best.u + du, best.m],
        [best.u - du, best.m],
        [best.u, best.m + dm],
        [best.u, best.m - dm],
      ] as const) {
        const c = evaluate(x, y, clampU(cu), clampM(cm));
        if (c.sse < best.sse - 1e-12) {
          best = c;
          moved = true;
        }
      }
      if (!moved) {
        du /= 2;
        dm /= 2;
      }
    }
    return best;
  };

  const uSteps = 24;
  const mSteps = Math.min(160, Math.max(40, Math.ceil(mMax - mMin)));
  const du = (uMax - uMin) / (uSteps - 1);
  const dm = (mMax - mMin) / (mSteps - 1);
  let best: Fitted | null = null;
  for (let i = 0; i < uSteps; i++) {
    for (let j = 0; j < mSteps; j++) {
      const c = evaluate(xs, ys, uMin + i * du, mMin + j * dm);
      if (!best || c.sse < best.sse) best = c;
    }
  }
  best = refine(xs, ys, best!, du, dm);

  // Second pass without the outliers.
  const residual = (fit: Fitted, x: number, y: number) => y - fit.f - fit.a / (1 + Math.exp(Math.exp(fit.u) * (x - fit.m)));
  const abs = xs.map((x, i) => Math.abs(residual(best!, x, ys[i]!)));
  const limit = Math.max(1.5, 4 * 1.4826 * median(abs)!);
  let fx = xs;
  const keep = abs.map((r) => r <= limit);
  const kept = keep.filter(Boolean).length;
  if (kept < xs.length && kept >= Math.max(6, Math.ceil(xs.length * 0.7))) {
    fx = xs.filter((_, i) => keep[i]);
    const fy = ys.filter((_, i) => keep[i]);
    best = refine(fx, fy, evaluate(fx, fy, best.u, best.m), du / 2, dm / 2);
  }

  const dataSse = best.sse - w * (best.f - p) ** 2;
  const rmse = Math.sqrt(Math.max(0, dataSse) / fx.length) / 1000;
  const curve: FermentationCurve = {
    og: 1 + (best.f + best.a) / 1000,
    fg: 1 + best.f / 1000,
    k: Math.exp(best.u),
    midAt: t0 + best.m * HOUR,
    rmse,
    n: fx.length,
  };
  return [curve.og, curve.fg, curve.k, curve.midAt, curve.rmse].every(Number.isFinite) ? curve : null;
}

/**
 * True once the gravity has stopped moving: less than a point (0.001) of change over the last 48 hours of readings,
 * with at least 24 hours of data. With `og`, it also has to have dropped at least 2 points from it, so a brew that
 * hasn't started fermenting yet doesn't count as finished.
 */
export function gravityStable(points: GravityPoint[], opts: { og?: number | null } = {}): boolean {
  const L = FERMENTATION_LIMITS;
  const hourly = bucketMedians(points);
  if (hourly.length < 2) return false;
  const first = hourly[0]!.t;
  const last = hourly[hourly.length - 1]!.t;
  if (last - first < L.stableMinSpanMs) return false;
  const window = hourly.filter((p) => p.t >= last - L.stableWindowMs);
  const from = window[0]!.t;
  const head = median(window.filter((p) => p.t <= from + 6 * HOUR).map((p) => p.g))!;
  const tail = median(window.filter((p) => p.t >= last - 6 * HOUR).map((p) => p.g))!;
  if (Math.abs(head - tail) >= L.stableTolerance) return false;
  if (opts.og != null && opts.og - tail < L.minDrop) return false;
  return true;
}

const round4 = (sg: number) => Math.round(sg * 10_000) / 10_000;

/** Where a fitted fermentation is at time `t`. */
export function stageAt(curve: FermentationCurve, t: number, stable = false): BrewStage {
  if (stable) return 'done';
  const s = share(curve, t);
  const rate = 4 * s * (1 - s);
  if (rate >= 0.25) return 'active';
  return t < curve.midAt ? 'lag' : 'finishing';
}

/**
 * Predicts where a brew is going from its (plausible) readings: the stage it's at, its final gravity and when it will
 * be within a point of it. Null with under 12 hours of readings or when no curve fits.
 *
 * - lag: the gravity hasn't started dropping yet (FG is then only a guess from `targetFg`, or 75% attenuation).
 * - active: dropping fast.
 * - finishing: slowing down, under a quarter of its fastest rate.
 * - done: `stable` (see gravityStable).
 */
export function predictFermentation(
  points: GravityPoint[],
  opts: { stable?: boolean; og?: number | null; targetFg?: number | null; now?: number } = {},
): BrewPrediction | null {
  const L = FERMENTATION_LIMITS;
  const pts = points.filter((p) => Number.isFinite(p.t) && Number.isFinite(p.g)).sort((a, b) => a.t - b.t);
  if (pts.length < 2) return null;
  const firstAt = pts[0]!.t;
  const lastAt = pts[pts.length - 1]!.t;
  const span = lastAt - firstAt;
  if (span < L.minFitSpanMs) return null;
  const bucket = Math.max(HOUR, Math.ceil(span / MAX_BUCKETS / HOUR) * HOUR);
  const buckets = bucketMedians(pts, bucket);
  // The first hour after the pill goes in can read off while it settles and bubbles cling to it.
  const settled = buckets.filter((p) => p.t >= firstAt + HOUR);
  const fitPts = settled.length >= L.minPoints ? settled : buckets;
  if (fitPts.length < L.minPoints) return null;

  const fittedAt = Math.round(opts.now ?? lastAt);
  const head = median(fitPts.slice(0, 3).map((p) => p.g))!;
  const tail = median(fitPts.slice(-3).map((p) => p.g))!;
  const startLevel = opts.og ?? head;
  const priorFg = opts.targetFg ?? startLevel - 0.75 * (startLevel - 1);

  if (head - tail < L.minDrop) {
    if (opts.stable) return { stage: 'done', fg: round4(tail), finishAt: null, confidence: 'medium', fittedAt };
    return { stage: 'lag', fg: round4(priorFg), finishAt: null, confidence: 'low', fittedAt };
  }

  const curve = fitFermentation(fitPts, { priorFg });
  if (!curve) return null;
  const stage = stageAt(curve, lastAt, opts.stable);

  if (opts.stable) {
    // Finished: the final gravity is what it reads now, reached when it last came within a point of that.
    let reached = lastAt;
    for (let i = fitPts.length - 1; i >= 0 && Math.abs(fitPts[i]!.g - tail) < L.stableTolerance; i--) reached = fitPts[i]!.t;
    return { stage, fg: round4(tail), finishAt: reached, confidence: 'high', fittedAt };
  }

  const done = 1 - share(curve, lastAt);
  const drop = Math.max(curve.og - curve.fg, 0.001);
  let level = done >= 0.85 && span >= 48 * HOUR ? 2 : done >= 0.5 ? 1 : 0;
  if (curve.rmse > 0.002 || curve.rmse / drop > 0.1) level = Math.max(0, level - 1);
  if (curve.fg <= 1 + FG_MIN / 1000 + 0.0005) level = 0;
  const confidence = (['low', 'medium', 'high'] as const)[level]!;

  let finishAt = curveFinishAt(curve);
  if (finishAt !== null && (finishAt - lastAt > L.maxFinishMs || !Number.isFinite(finishAt))) finishAt = null;
  if (finishAt !== null) finishAt = Math.round(finishAt / 60_000) * 60_000;
  return { stage, fg: round4(curve.fg), finishAt, confidence, fittedAt };
}
