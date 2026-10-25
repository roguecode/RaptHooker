import type { BrewCurve, BrewEvent } from '@rapthooker/shared';
import { useUnits } from '../../units';
import { num } from '../../format';
import { t } from '../../i18n';
import { eventKind } from './brewText';

const W = 720;
const H = 280;
const M = { top: 14, right: 46, bottom: 30, left: 54 };

function niceTicks(min: number, max: number, count: number): number[] {
  const span = max - min;
  if (!(span > 0)) return [min];
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-6; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

const dayStep = (days: number) => (days <= 2 ? 0.25 : days <= 4 ? 0.5 : days <= 12 ? 1 : days <= 28 ? 2 : days <= 60 ? 7 : 14);

/** Polyline paths for a series, broken where it has gaps. */
function paths(xs: number[], ys: (number | null)[]): string[] {
  const out: string[] = [];
  let cur = '';
  ys.forEach((y, i) => {
    if (y === null) {
      if (cur) out.push(cur);
      cur = '';
      return;
    }
    cur += `${cur ? 'L' : 'M'}${xs[i]!.toFixed(1)} ${y.toFixed(1)}`;
  });
  if (cur) out.push(cur);
  return out;
}

/**
 * A static gravity and temperature chart for the printable summary: drawn as SVG so it stays sharp on paper, sized to
 * fit an A4 page. Events show as numbered markers matching the timeline.
 */
export function SummaryChart({
  curve,
  events,
  targetFg,
  color,
}: {
  curve: BrewCurve;
  events: BrewEvent[];
  targetFg: number | null;
  color?: string;
}) {
  const u = useUnits();
  const g = curve.gravity.map((v) => (v === null ? null : u.gravityValue(v)));
  const temps = curve.temperature.map((v) => (v === null ? null : u.tempValue(v)));
  const gVals = g.filter((v): v is number => v !== null);
  const tVals = temps.filter((v): v is number => v !== null);
  if (gVals.length < 2) return <p className="muted">{t('Not enough readings for a chart.')}</p>;

  const lastH = Math.max(1, curve.hours[curve.hours.length - 1] ?? 1, ...events.map((e) => (e.at - curve.startedAt) / 3_600_000));
  const target = targetFg === null ? null : u.gravityValue(targetFg);
  let gMin = Math.min(...gVals, ...(target === null ? [] : [target]));
  let gMax = Math.max(...gVals);
  const gPad = Math.max((gMax - gMin) * 0.08, u.gravity === 'plato' ? 0.3 : 0.001);
  gMin -= gPad;
  gMax += gPad;
  let tMin = tVals.length ? Math.min(...tVals) : 0;
  let tMax = tVals.length ? Math.max(...tVals) : 1;
  const tPad = Math.max((tMax - tMin) * 0.15, 0.5);
  tMin -= tPad;
  tMax += tPad;

  const iw = W - M.left - M.right;
  const ih = H - M.top - M.bottom;
  const x = (h: number) => M.left + (Math.max(0, h) / lastH) * iw;
  const yG = (v: number) => M.top + (1 - (v - gMin) / (gMax - gMin)) * ih;
  const yT = (v: number) => M.top + (1 - (v - tMin) / (tMax - tMin)) * ih;
  const xs = curve.hours.map(x);
  const days = lastH / 24;
  const step = dayStep(days);
  const xTicks: number[] = [];
  for (let d = 0; d <= days + 1e-9; d += step) xTicks.push(d);
  const gTicks = niceTicks(gMin, gMax, 5).filter((v) => v >= gMin && v <= gMax);
  const tTicks = tVals.length ? niceTicks(tMin, tMax, 5).filter((v) => v >= tMin && v <= tMax) : [];
  const gColor = color ?? '#7c3aed';

  return (
    <figure className="summary-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('Gravity and temperature over the brew')}>
        <g className="sc-grid">
          {gTicks.map((v) => (
            <line key={`g${v}`} x1={M.left} x2={W - M.right} y1={yG(v)} y2={yG(v)} />
          ))}
          {xTicks.map((d) => (
            <line key={`x${d}`} x1={x(d * 24)} x2={x(d * 24)} y1={M.top} y2={M.top + ih} />
          ))}
        </g>
        <g className="sc-axis">
          {gTicks.map((v) => (
            <text key={`gl${v}`} x={M.left - 6} y={yG(v) + 4} textAnchor="end">
              {u.gravity === 'plato' ? num(v, 1) : num(v, 3)}
            </text>
          ))}
          {tTicks.map((v) => (
            <text key={`tl${v}`} x={W - M.right + 6} y={yT(v) + 4} textAnchor="start">
              {`${num(v, 1, 0)}°`}
            </text>
          ))}
          {xTicks.map((d) => (
            <text key={`xl${d}`} x={x(d * 24)} y={H - 10} textAnchor="middle">
              {/* i18n: "d" is short for days on the chart's time axis */}
              {t('{days} d', { days: num(d, 2, 0) })}
            </text>
          ))}
        </g>
        {target !== null && target >= gMin && target <= gMax && (
          <g className="sc-target">
            <line x1={M.left} x2={W - M.right} y1={yG(target)} y2={yG(target)} style={{ stroke: gColor }} />
            <text x={M.left + 6} y={yG(target) - 5}>
              {t('target FG')}
            </text>
          </g>
        )}
        {paths(
          xs,
          temps.map((v) => (v === null ? null : yT(v))),
        ).map((d, i) => (
          <path key={`t${i}`} className="sc-temp" d={d} />
        ))}
        {paths(
          xs,
          g.map((v) => (v === null ? null : yG(v))),
        ).map((d, i) => (
          <path key={`g${i}`} className="sc-gravity" d={d} style={{ stroke: gColor }} />
        ))}
        {events.map((e, i) => {
          const ex = x((e.at - curve.startedAt) / 3_600_000);
          const c = eventKind(e.kind).color;
          return (
            <g key={e.id} className="sc-event">
              <line x1={ex} x2={ex} y1={M.top + 10} y2={M.top + ih} style={{ stroke: c }} />
              <circle cx={ex} cy={M.top + 8} r={8} style={{ fill: c }} />
              <text x={ex} y={M.top + 11.5} textAnchor="middle">
                {i + 1}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="summary-legend">
        <span>
          <i style={{ background: gColor }} /> {t('Gravity ({unit})', { unit: u.gravityLabel })}
        </span>
        {tVals.length > 0 && (
          <span>
            <i className="dashed" /> {t('Temperature ({unit})', { unit: u.tempLabel })}
          </span>
        )}
        <span className="muted">{t('Days since the brew started')}</span>
      </figcaption>
    </figure>
  );
}
