import { useEffect, useMemo, useRef, useState } from 'react';
import uPlot, { type AlignedData, type Options } from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { useUnits } from '../units';
import { useTheme } from '../theme';
import { fixed, num } from '../format';
import { t } from '../i18n';
import { ChartTip, type ChartTipHandle, type ChartTipRow } from './ChartTip';
import { axisIncrs } from './chartMath';
import { keepTappedValues } from './tapCursor';
import './CompareChart.css';

export interface CompareLine {
  id: string;
  label: string;
  color: string;
  /** Shown under the name in the legend (e.g. OG → FG, ABV). */
  detail?: string;
  hours: number[];
  /** SG. */
  gravity: (number | null)[];
  /** °C. */
  temperature: (number | null)[];
}

/** Distinct colours for up to eight brews, readable on light and dark backgrounds. */
export const COMPARE_COLORS = ['#8b5cf6', '#f97316', '#10b981', '#3b82f6', '#ec4899', '#eab308', '#06b6d4', '#ef4444'];

const cssVar = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
const plotHeight = () => (window.innerWidth < 640 ? 260 : 360);

type UnitsNow = ReturnType<typeof useUnits>;
interface Reading {
  g: number | null;
  t: number | null;
}

/** A brew's reading nearest `day` days in (brews are sampled at different times, so rarely exactly on it), in the units shown. */
function readingAt(l: CompareLine, day: number, u: UnitsNow): Reading {
  if (l.hours.length === 0) return { g: null, t: null };
  const h = day * 24;
  let lo = 0;
  let hi = l.hours.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (l.hours[mid]! < h) lo = mid + 1;
    else hi = mid;
  }
  const i = lo > 0 && Math.abs(l.hours[lo - 1]! - h) < Math.abs(l.hours[lo]! - h) ? lo - 1 : lo;
  if (Math.abs(l.hours[i]! - h) > 2) return { g: null, t: null };
  const g = l.gravity[i] ?? null;
  const t = l.temperature[i] ?? null;
  return { g: g === null ? null : u.gravityValue(g), t: t === null ? null : u.tempValue(t) };
}

function readingText({ g, t: temp }: Reading, showTemp: boolean, u: UnitsNow): string {
  const gravity = g === null ? '–' : u.gravity === 'plato' ? `${u.gravityNumber(g)} °P` : u.gravityNumber(g);
  return showTemp ? `${gravity} · ${temp === null ? '–' : `${u.tempNumber(temp)}${u.tempLabel}`}` : gravity;
}

/** Several brews' gravity (and optionally temperature) overlaid by days since each started. */
export function CompareChart({ lines, showTemp }: { lines: CompareLine[]; showTemp: boolean }) {
  const wrap = useRef<HTMLDivElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const tip = useRef<ChartTipHandle | null>(null);
  const u = useUnits();
  const { look } = useTheme();
  const [cursor, setCursor] = useState<number | null>(null);

  const data = useMemo<AlignedData>(() => {
    if (lines.length === 0) return [[]];
    const tables = lines.map((l) => {
      const cols: (number | null)[][] = [l.gravity.map((g) => (g === null ? null : u.gravityValue(g)))];
      if (showTemp) cols.push(l.temperature.map((t) => (t === null ? null : u.tempValue(t))));
      return [l.hours.map((h) => h / 24), ...cols] as AlignedData;
    });
    return uPlot.join(tables);
  }, [lines, showTemp, u]);

  useEffect(() => {
    const el = box.current;
    const tooltip = tip.current;
    if (!el || lines.length === 0) return;
    const muted = cssVar('--muted', '#888');
    const grid = cssVar('--grid', 'rgba(128,128,128,0.15)');
    const axisBase = { stroke: muted, grid: { stroke: grid, width: 1 }, ticks: { show: false }, font: '11px system-ui, sans-serif' };
    /** Each brew's reading under the pointer, beside it. */
    const showTip = (p: uPlot) => {
      const w = wrap.current;
      const idx = p.cursor.idx;
      const x = p.cursor.left ?? -1;
      const day = idx == null ? undefined : p.data[0][idx];
      if (!w || day == null || x < 0) return tooltip?.hide();
      const rows: ChartTipRow[] = lines.flatMap((l) => {
        const r = readingAt(l, day, u);
        return r.g !== null || (showTemp && r.t !== null) ? [{ label: l.label, value: readingText(r, showTemp, u), color: l.color }] : [];
      });
      if (rows.length === 0) return tooltip?.hide();
      const o = p.over.getBoundingClientRect();
      const r = w.getBoundingClientRect();
      const top = o.top - r.top;
      tooltip?.show({
        x: o.left - r.left + x,
        y: top + (p.cursor.top ?? 0),
        area: { left: 0, top, right: r.width, bottom: top + o.height },
        title: t('{n} days in', { n: fixed(day, 1) }),
        rows,
      });
    };
    const series: Options['series'] = [{}];
    for (const l of lines) {
      series.push({ label: l.label, scale: 'g', stroke: l.color, width: 2.2, spanGaps: false, points: { show: false } });
      if (showTemp) {
        series.push({
          label: t('{name} temperature', { name: l.label }),
          scale: 't',
          stroke: `${l.color}99`,
          width: 1.2,
          dash: [5, 4],
          points: { show: false },
        });
      }
    }
    const opts: Options = {
      width: Math.max(260, el.clientWidth),
      height: plotHeight(),
      padding: [12, 8, 0, 4],
      legend: { show: false },
      cursor: { drag: { x: false, y: false }, points: { size: 6 } },
      scales: {
        x: { time: false },
        g: {
          auto: true,
          range: (_p, min, max) => (min === max ? [min - 0.005, max + 0.005] : [min - (max - min) * 0.06, max + (max - min) * 0.06]),
        },
        t: {
          auto: true,
          range: (_p, min, max) => (min === max ? [min - 1, max + 1] : [min - (max - min) * 0.15, max + (max - min) * 0.15]),
        },
      },
      axes: [
        // i18n: "d" is days, on the chart's axis
        { ...axisBase, space: 50, values: (_p, vals) => vals.map((v) => t('{n} d', { n: num(v, 1, 0) })) },
        {
          ...axisBase,
          scale: 'g',
          size: 52,
          incrs: axisIncrs(u.gravityDecimals),
          values: (_p, vals) => vals.map((v) => u.gravityNumber(v)),
        },
        ...(showTemp
          ? [
              {
                ...axisBase,
                scale: 't',
                side: 1,
                size: 44,
                grid: { show: false },
                values: (_p: uPlot, vals: number[]) => vals.map((v) => `${fixed(v, 0)}°`),
              },
            ]
          : []),
      ],
      series,
      hooks: {
        setCursor: [
          (p) => {
            setCursor(p.cursor.idx ?? null);
            showTip(p);
          },
        ],
      },
    };
    const chart = new uPlot(opts, data, el);
    const releaseTap = keepTappedValues(chart);
    const ro = new ResizeObserver(() => {
      const w = Math.max(260, el.clientWidth);
      if (w !== chart.width) chart.setSize({ width: w, height: plotHeight() });
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      releaseTap();
      chart.destroy();
      tooltip?.hide();
    };
  }, [data, lines, showTemp, u, look]);

  const day = cursor === null ? null : ((data[0] as number[])[cursor] ?? null);

  return (
    <div className="compare-chart">
      <div ref={wrap} className="compare-plot">
        <div ref={box} />
        <ChartTip ref={tip} />
      </div>
      <div className="compare-legend">
        {/* i18n: {n} always has one decimal */}
        {day !== null && <div className="compare-day num">{t('{n} days in', { n: fixed(day, 1) })}</div>}
        {lines.map((l) => (
          <div key={l.id} className="compare-key">
            <span className="swatch" style={{ background: l.color }} />
            <div className="grow">
              <strong>{l.label}</strong>
              {l.detail && <small>{l.detail}</small>}
            </div>
            {day !== null && <span className="num small">{readingText(readingAt(l, day, u), showTemp, u)}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
