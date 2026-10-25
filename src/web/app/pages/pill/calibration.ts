import { fitTilt, polyval, type Offsets, type PillModel, type Reading, type TiltPoint } from '@rapthooker/shared';
import { fixed } from '../../format';
import { t, tk, tp } from '../../i18n';

export const MAX_TILT_POINTS = 20;
/** What the API accepts for offsets. */
export const OFFSET_LIMITS = { gravity: 0.05, temperature: 10 } as const;

/** The choices in "Where the numbers come from". */
export type SourceChoices = Pick<PillModel, 'gravitySource' | 'velocitySource' | 'velocityHours' | 'smoothing'>;

export const DEFAULT_CHOICES: SourceChoices = { gravitySource: 'pill', velocitySource: 'pill', velocityHours: 24, smoothing: 'off' };

const NAMES = {
  gravitySource: { pill: tk('from the pill'), tilt: tk('worked out by RaptHooker from the tilt') },
  velocitySource: { pill: tk('from the pill'), computed: tk('worked out by RaptHooker') },
  // i18n: smoothing settings ("off" means no smoothing)
  smoothing: { off: tk('off'), light: tk('light (1-hour average)'), strong: tk('strong (4-hour average)') },
} as const;

/** What saving would change, in words. */
export function describeChanges(from: SourceChoices, to: SourceChoices): string[] {
  const out: string[] = [];
  if (from.gravitySource !== to.gravitySource) {
    out.push(
      t('Gravity: {from} → {to}', { from: t(NAMES.gravitySource[from.gravitySource]), to: t(NAMES.gravitySource[to.gravitySource]) }),
    );
  }
  if (from.velocitySource !== to.velocitySource) {
    out.push(
      t('Velocity: {from} → {to}', { from: t(NAMES.velocitySource[from.velocitySource]), to: t(NAMES.velocitySource[to.velocitySource]) }),
    );
  }
  if (from.velocityHours !== to.velocityHours) {
    out.push(t("RaptHooker's velocity: over {from} → {to} hours", { from: from.velocityHours, to: to.velocityHours }));
  }
  if (from.smoothing !== to.smoothing) {
    out.push(t('Smoothing: {from} → {to}', { from: t(NAMES.smoothing[from.smoothing]), to: t(NAMES.smoothing[to.smoothing]) }));
  }
  return out;
}

const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
const finite = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);

/** The gravity the pill's model works out for a reading, before the offset and smoothing. */
export function baseGravity(
  r: Pick<Reading, 'pillGravity' | 'tilt'>,
  offsets: Offsets,
  model: Pick<PillModel, 'gravitySource' | 'tiltPoly'>,
): number {
  if (model.gravitySource === 'tilt' && model.tiltPoly && r.tilt !== null) {
    const g = polyval(model.tiltPoly, r.tilt);
    if (Number.isFinite(g)) return g;
  }
  return r.pillGravity - offsets.gravity;
}

/** The gravity offset that makes plain water read 1.000 (rounded to 0.0001). */
export const waterOffset = (base: number): number => r4(1 - base) + 0;

/** The temperature offset (°C, to 0.01) that makes the pill agree with a thermometer. */
export function thermometerOffset(referenceC: number, r: Pick<Reading, 'temperature'>, offsets: Offsets): number {
  return Math.round((referenceC - (r.temperature - offsets.temperature)) * 100) / 100 + 0;
}

/** "+1.5 points", "−2.1 points" (1 point = 0.001 SG). */
export function points(sg: number): string {
  const p = Math.round(sg * 10000) / 10;
  if (p === 0) return t('0 points');
  return t('{value} points', { value: `${p > 0 ? '+' : '−'}${fixed(Math.abs(p), 1)}` });
}

export type ReadingState = 'none' | 'fresh' | 'stale';

/** Whether the latest reading is recent enough to calibrate with: older than two intervals is stale. */
export function readingState(r: Pick<Reading, 'ts'> | null, intervalSec: number | null, now: number): ReadingState {
  if (!r) return 'none';
  return now - r.ts > 2 * (intervalSec ?? 900) * 1000 + 60_000 ? 'stale' : 'fresh';
}

export interface TiltFitRow {
  point: TiltPoint;
  fitted: number | null;
  /** Measured minus fitted, gravity points. */
  residual: number | null;
}

export interface TiltFit {
  coeffs: number[] | null;
  rows: TiltFitRow[];
  /** Root mean square of the residuals, gravity points. */
  rms: number | null;
}

/** Fits the tilt points (as the hub does) and how far each point is from the fit. */
export function tiltFit(pts: TiltPoint[]): TiltFit {
  const coeffs = fitTilt(pts);
  const rows = pts.map((point) => {
    const fitted = coeffs ? polyval(coeffs, point.tilt) : null;
    return { point, fitted, residual: finite(fitted) ? (point.sg - fitted) * 1000 : null };
  });
  const res = rows.map((r) => r.residual).filter(finite);
  const rms = coeffs && res.length ? Math.sqrt(res.reduce((s, r) => s + r * r, 0) / res.length) : null;
  return { coeffs, rows, rms };
}

/** The points and the fitted curve on one sorted x axis (tilt), ready for a chart. */
export function fitCurve(
  pts: TiltPoint[],
  coeffs: number[] | null,
  steps = 48,
): { x: number[]; points: (number | null)[]; curve: (number | null)[] } {
  if (!pts.length) return { x: [], points: [], curve: [] };
  let lo = Infinity;
  let hi = -Infinity;
  for (const p of pts) {
    lo = Math.min(lo, p.tilt);
    hi = Math.max(hi, p.tilt);
  }
  const pad = Math.max(2, (hi - lo) * 0.1);
  lo = Math.max(0, lo - pad);
  hi = Math.min(90, hi + pad);
  const rows: { x: number; y: number | null }[] = [];
  for (let i = 0; i <= steps; i++) rows.push({ x: lo + ((hi - lo) * i) / steps, y: null });
  for (const p of pts) rows.push({ x: p.tilt, y: p.sg });
  rows.sort((a, b) => a.x - b.x || (a.y === null ? -1 : 1));
  // A chart needs every x to be different.
  for (let i = 1; i < rows.length; i++) if (rows[i]!.x <= rows[i - 1]!.x) rows[i]!.x = rows[i - 1]!.x + 1e-6;
  return {
    x: rows.map((r) => r.x),
    points: rows.map((r) => r.y),
    curve: rows.map((r) => {
      if (!coeffs) return null;
      const v = polyval(coeffs, r.x);
      return Number.isFinite(v) ? v : null;
    }),
  };
}

/** "+0.4 pts", "−1.2 pts", "0.0 pts". */
export function residualText(pts: number): string {
  const r = Math.round(pts * 10) / 10;
  return r === 0 ? t('0.0 pts') : t('{value} pts', { value: `${r > 0 ? '+' : '−'}${fixed(Math.abs(r), 1)}` });
}

/** A line of advice for the tilt points so far. */
export function tiltAdvice(pts: TiltPoint[]): string {
  const n = pts.length;
  if (n === 0) return t('Start with plain water (1.000), then add liquids of higher gravity.');
  if (!fitTilt(pts)) return t('Add at least one more point, at a different gravity, so RaptHooker can draw a line.');
  const sgs = pts.map((p) => p.sg);
  const spread = Math.max(...sgs) - Math.min(...sgs);
  if (spread < 0.02) return t('Your points are close together: add one with a higher gravity, up to the highest OG you brew.');
  if (n === 2) return t('Two points give a straight line. Add a third (or more) so RaptHooker can follow the curve.');
  if (n < 6) {
    return tp(
      n,
      '{count} point: good. 3–6 points spread from water to your highest OG work best.',
      '{count} points: good. 3–6 points spread from water to your highest OG work best.',
    );
  }
  return tp(n, '{count} point: plenty.', '{count} points: plenty.');
}
