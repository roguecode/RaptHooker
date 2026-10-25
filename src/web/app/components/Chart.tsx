import {
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
} from 'react';
import uPlot, { type AlignedData, type Options, type Series } from 'uplot';
import 'uplot/dist/uPlot.min.css';
import './Chart.css';
import type { History } from '@rapthooker/shared';
import { useUnits } from '../units';
import { useTheme } from '../theme';
import { dateTime, fixed } from '../format';
import { currentLocale, t, tk } from '../i18n';
import { Icon } from './Icon';
import type { ChartAnnotation } from './annotations';
import {
  clampWindow,
  isZoomed,
  MIN_SPAN_MS,
  nearestIndex,
  panWindow,
  pinchWindow,
  skipImplausible,
  splitImplausible,
  stackLabels,
  stepIndex,
  windowFromSelection,
  zoomWindow,
  type TimeWindow,
} from './chartMath';
import { exportChartPng, type PngLegendItem } from './pngExport';

export type { ChartAnnotation } from './annotations';
export type { TimeWindow } from './chartMath';

export type SeriesKey = 'gravity' | 'temperature' | 'velocity' | 'battery' | 'rssi' | 'tilt';

/** Labels are English (marked with tk): show them with t(). */
export const SERIES: { key: SeriesKey; label: string; color: string }[] = [
  { key: 'gravity', label: tk('Gravity'), color: '--series-gravity' },
  { key: 'temperature', label: tk('Temperature'), color: '--series-temp' },
  { key: 'velocity', label: tk('Velocity'), color: '--series-velocity' },
  { key: 'battery', label: tk('Battery'), color: '--series-battery' },
  { key: 'rssi', label: tk('Signal'), color: '--series-rssi' },
  { key: 'tilt', label: tk('Tilt'), color: '--series-tilt' },
];

/** What `ref` gives you. */
export interface ChartHandle {
  /** Downloads the chart, with a title and its legend, as a PNG. */
  exportPng: (opts: { title: string; subtitle?: string; fileName: string }) => Promise<void>;
}

export interface ChartProps {
  history: History | null;
  series: SeriesKey[];
  /** The visible window, Unix ms. */
  from: number;
  to: number;
  /**
   * How far the user can zoom out and pan. When given, the parent zooms on the client: `onZoom` is called continuously
   * while pinching or dragging. Without it, zooming stays inside from–to and `onZoom` is called once a gesture ends
   * (suits a parent that fetches the zoomed range).
   */
  bounds?: TimeWindow;
  gravityColor?: string;
  /** Called with the new visible window when the user zooms or pans. Zooming is off without it. */
  onZoom?: (from: number, to: number) => void;
  /** Double-click, double-tap, 0 or Escape. Defaults to onZoom(bounds) when `bounds` is given. */
  onResetZoom?: () => void;
  /** Smaller, no legend, no zooming. */
  compact?: boolean;
  /** Draws the target final gravity as a dashed line. */
  targetFg?: number | null;
  /** Draws the original gravity as a dotted line. */
  og?: number | null;
  /** Dashed vertical lines with small labels (brew events...). */
  annotations?: ChartAnnotation[];
  /** Lets the user click or tap a gravity reading and press `pickLabel`; gets the reading's time (Unix ms) and SG. */
  onPickPoint?: (ts: number, gravity: number) => void;
  pickLabel?: string;
  /** For screen readers, e.g. "History of Pill 1". */
  label?: string;
  ref?: Ref<ChartHandle>;
}

type ColKey = SeriesKey | 'pillGravity' | 'pillVelocity' | 'implausible';

interface Col {
  key: ColKey;
  values: (number | null | undefined)[];
  /** Values to show in the legend when `values` were moved (implausible readings pulled into range). */
  raw?: (number | null)[];
}

interface Pick {
  idx: number;
  ts: number;
  left: number;
  top: number;
  below: boolean;
}

const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#a78bfa';

/** A canvas colour from any CSS colour, including var(--name). */
function resolveColor(c: string | undefined, fallback: string): string {
  if (!c) return fallback;
  const v = /^var\((--[\w-]+)\)$/.exec(c.trim());
  if (v) return cssVar(v[1]!);
  if (c.startsWith('--')) return cssVar(c);
  return c;
}

function alpha(color: string, a: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (!hex) return color;
  const n = parseInt(hex[1]!, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

const plotHeight = (compact: boolean) => (compact ? 180 : window.innerWidth < 640 ? 260 : 360);
const sameWindow = (a: TimeWindow, b: TimeWindow) => Math.abs(a.from - b.from) < 1 && Math.abs(a.to - b.to) < 1;
const finite = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);

/** Pads a scale's range, with a smallest span so sensor noise on a flat line isn't blown up. */
function padRange(min: number | null, max: number | null, pad: number, minSpan: number, fallback: [number, number]): [number, number] {
  if (!finite(min) || !finite(max)) return fallback;
  let lo = min;
  let hi = max;
  if (hi - lo < minSpan) {
    const mid = (lo + hi) / 2;
    lo = mid - minSpan / 2;
    hi = mid + minSpan / 2;
  }
  const p = (hi - lo) * pad;
  return [lo - p, hi + p];
}

function MinusIcon() {
  return (
    <svg
      width={15}
      height={15}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M5 12h14" />
    </svg>
  );
}

/**
 * A pill's history (uPlot). Drag across it (mouse or one finger) to zoom in, pinch or Ctrl+wheel to zoom, double-click
 * or double-tap to show it all. Readings where the pill didn't look like it was floating are faded dots, left out of
 * the line.
 */
export function Chart({
  history,
  series,
  from,
  to,
  bounds,
  gravityColor,
  onZoom,
  onResetZoom,
  compact = false,
  targetFg,
  og,
  annotations,
  onPickPoint,
  pickLabel = t('Use as OG'),
  label = t('Chart'),
  ref,
}: ChartProps) {
  const wrap = useRef<HTMLDivElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const plot = useRef<uPlot | null>(null);
  const legendItems = useRef<PngLegendItem[]>([]);
  const ignoreSelect = useRef(true);
  const commitRef = useRef<((win: TimeWindow) => void) | null>(null);
  const resetRef = useRef<() => void>(() => {});
  const pickAt = useRef<(idx: number) => void>(() => {});
  const hintId = useId();
  const u = useUnits();
  const [pick, setPick] = useState<Pick | null>(null);
  const zoomable = !compact && onZoom !== undefined;

  const active = useMemo(() => SERIES.filter((s) => series.includes(s.key)).map((s) => s.key), [series]);

  const cols = useMemo<Col[]>(() => {
    const h = history;
    if (!h) return active.map((key) => ({ key, values: [] }));
    const out: Col[] = [];
    const g = (v: number | null) => (v === null ? null : u.gravityValue(v));
    for (const key of active) {
      switch (key) {
        case 'gravity': {
          const split = splitImplausible(h.gravity.map(g), h.implausible);
          out.push({ key, values: split.main });
          if (h.pillGravity) out.push({ key: 'pillGravity', values: skipImplausible(h.pillGravity.map(g), h.implausible) });
          if (split.any) out.push({ key: 'implausible', values: split.faded, raw: split.fadedRaw });
          break;
        }
        case 'temperature':
          out.push({ key, values: h.temperature.map((v) => (v === null ? null : u.tempValue(v))) });
          break;
        case 'velocity':
          out.push({ key, values: skipImplausible(h.velocity, h.implausible) });
          if (h.pillVelocity) out.push({ key: 'pillVelocity', values: h.pillVelocity });
          break;
        default:
          out.push({ key, values: h[key] });
      }
    }
    return out;
  }, [history, active, u]);

  const data = useMemo<AlignedData>(
    () => [history ? history.ts.map((t) => t / 1000) : [], ...cols.map((c) => c.values)] as AlignedData,
    [history, cols],
  );
  const hasData = (history?.ts.length ?? 0) > 0;
  const hasG = active.includes('gravity');
  const gIdx = cols.findIndex((c) => c.key === 'gravity');
  const fadedAuto = useMemo(
    () => cols.some((c) => c.key === 'implausible') && !cols.find((c) => c.key === 'gravity')?.values.some(finite),
    [cols],
  );

  // What the uPlot hooks and gesture handlers need, without rebuilding the plot.
  const latest = useRef({
    data,
    cols,
    view: { from, to } as TimeWindow,
    bounds: bounds ?? { from, to },
    onZoom,
    onResetZoom,
    onPickPoint,
    liveZoom: bounds !== undefined,
    zoomable,
    lines: { og: null as number | null, target: null as number | null },
    annotations: [] as ChartAnnotation[],
    pick: null as Pick | null,
  });
  const L = latest.current;
  L.data = data;
  L.cols = cols;
  L.bounds = bounds ?? { from, to };
  L.onZoom = onZoom;
  L.onResetZoom = onResetZoom;
  L.onPickPoint = onPickPoint;
  L.liveZoom = bounds !== undefined;
  L.zoomable = zoomable;
  L.lines = {
    og: og != null && hasG ? u.gravityValue(og) : null,
    target: targetFg != null && hasG ? u.gravityValue(targetFg) : null,
  };
  L.annotations = annotations ?? [];
  L.pick = pick;

  // Colours come from CSS variables, so a theme change rebuilds the chart too.
  const { theme } = useTheme();
  const key = `${cols.map((c) => c.key).join(',')}|${fadedAuto}|${u.gravity}|${u.temperature}|${gravityColor ?? ''}|${compact}|${zoomable}|${theme}`;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const muted = cssVar('--muted');
    const grid = cssVar('--grid');
    const gColor = gravityColor ?? cssVar('--series-gravity');
    const plato = u.gravity === 'plato';
    const gText = (v: number) => (plato ? `${fixed(v, 2)} °P` : fixed(v, 4));
    const fmt: Record<ColKey, (v: number) => string> = {
      gravity: gText,
      pillGravity: gText,
      implausible: gText,
      temperature: (v) => `${fixed(v, 1)} ${u.tempLabel}`,
      velocity: (v) => t('{n} pts/day', { n: fixed(v, 1) }),
      pillVelocity: (v) => t('{n} pts/day', { n: fixed(v, 1) }),
      battery: (v) => `${fixed(v, 0)}%`,
      rssi: (v) => `${fixed(v, 0)} dBm`,
      tilt: (v) => `${fixed(v, 1)}°`,
    };
    const axisBase = { stroke: muted, grid: { stroke: grid, width: 1 }, ticks: { show: false }, font: '11px system-ui, sans-serif' };
    const colsNow = latest.current.cols;
    const has = (k: ColKey) => colsNow.some((c) => c.key === k);

    const seriesFor = (c: Col, i: number): { s: Series; png: PngLegendItem } => {
      const value = (_p: uPlot, v: number | null, _s: number, idx: number | null) => {
        const raw = latest.current.cols[i]?.raw;
        const shown = raw && idx !== null ? (raw[idx] ?? null) : v;
        return shown == null ? '–' : fmt[c.key](shown);
      };
      const base: Series = { spanGaps: false, points: { show: false }, value };
      switch (c.key) {
        case 'gravity': {
          const name = t('Gravity ({unit})', { unit: u.gravityLabel });
          return {
            s: {
              ...base,
              label: name,
              scale: 'g',
              stroke: gColor,
              width: 2.4,
              fill: (p: uPlot) => {
                const { top, height } = p.bbox ?? { top: NaN, height: NaN };
                // uPlot asks for the fill before the plot has a size.
                if (!Number.isFinite(top) || !Number.isFinite(height) || height <= 0) return alpha(gColor, 0.12);
                const grad = p.ctx.createLinearGradient(0, top, 0, top + height);
                grad.addColorStop(0, alpha(gColor, 0.28));
                grad.addColorStop(1, alpha(gColor, 0));
                return grad;
              },
            },
            png: { label: name, color: gColor },
          };
        }
        case 'pillGravity': {
          const color = alpha(gColor, 0.85);
          const name = t("Pill's own gravity");
          return {
            s: { ...base, label: name, scale: 'g', stroke: color, width: 1.3, dash: [2, 4] },
            png: { label: name, color, dash: true },
          };
        }
        case 'implausible':
          return {
            s: {
              ...base,
              label: t('Pill not floating?'),
              class: 'u-implausible',
              scale: 'g',
              auto: fadedAuto,
              stroke: alpha(muted, 0.7),
              fill: alpha(muted, 0.22),
              paths: () => null,
              points: { show: true, size: 6, width: 1, stroke: alpha(muted, 0.55), fill: alpha(muted, 0.2) },
            },
            png: { label: t('Pill not floating? (left out)'), color: muted, dots: true },
          };
        case 'temperature': {
          const color = cssVar('--series-temp');
          const name = t('Temperature');
          return { s: { ...base, label: name, scale: 't', stroke: color, width: 1.8 }, png: { label: name, color } };
        }
        case 'velocity': {
          const color = cssVar('--series-velocity');
          const name = has('pillVelocity') ? t('Velocity (RaptHooker)') : t('Velocity');
          return {
            s: { ...base, label: name, scale: 'velocity', stroke: color, width: 1.4, dash: [5, 4] },
            png: { label: name, color, dash: true },
          };
        }
        case 'pillVelocity': {
          const color = alpha(cssVar('--series-velocity'), 0.8);
          const name = t("Pill's own velocity");
          return {
            s: { ...base, label: name, scale: 'velocity', stroke: color, width: 1.1, dash: [2, 4] },
            png: { label: name, color, dash: true },
          };
        }
        default: {
          const meta = SERIES.find((x) => x.key === c.key)!;
          const color = cssVar(meta.color);
          const name = t(meta.label);
          return {
            s: { ...base, label: name, scale: c.key, stroke: color, width: 1.4, dash: [5, 4] },
            png: { label: name, color, dash: true },
          };
        }
      }
    };
    const built = colsNow.map(seriesFor);
    legendItems.current = built.map((b) => b.png);

    const drawExtras = (p: uPlot) => {
      const dpr = devicePixelRatio;
      const ctx = p.ctx;
      const { left, top, width, height } = p.bbox;
      const { lines, annotations: anns, pick: picked, cols: cs, data: d } = latest.current;
      ctx.save();
      ctx.beginPath();
      ctx.rect(left, top, width, height);
      ctx.clip();
      ctx.font = `${11 * dpr}px system-ui, sans-serif`;
      const hline = (v: number | null, color: string, dash: number[], text: string, right: boolean) => {
        if (v === null || !has('gravity')) return;
        const y = p.valToPos(v, 'g', true);
        if (!(y >= top && y <= top + height)) return;
        ctx.strokeStyle = color;
        ctx.setLineDash(dash.map((x) => x * dpr));
        ctx.lineWidth = 1.2 * dpr;
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(left + width, y);
        ctx.stroke();
        ctx.fillStyle = muted;
        const tw = ctx.measureText(text).width;
        ctx.fillText(text, right ? left + width - tw - 6 * dpr : left + 6 * dpr, y - 5 * dpr);
      };
      // i18n: label on the chart's dashed line for the target final gravity
      hline(lines.target, alpha(gColor, 0.7), [6, 6], t('target FG'), false);
      if (lines.og !== null)
        hline(
          lines.og,
          alpha(gColor, 0.6),
          [2, 3],
          t('OG {gravity}', { gravity: plato ? `${fixed(lines.og, 1)} °P` : fixed(lines.og, 3) }),
          true,
        );

      if (anns.length) {
        const xMin = p.scales.x?.min ?? -Infinity;
        const xMax = p.scales.x?.max ?? Infinity;
        const surface = cssVar('--surface-solid');
        ctx.font = `${10 * dpr}px system-ui, sans-serif`;
        const shown = anns
          .filter((a) => a.ts / 1000 >= xMin && a.ts / 1000 <= xMax)
          .sort((a, b) => a.ts - b.ts)
          .map((a) => {
            const x = p.valToPos(a.ts / 1000, 'x', true);
            const w = ctx.measureText(a.label).width + 8 * dpr;
            return { a, x, w, color: resolveColor(a.color, muted), boxX: Math.max(left, Math.min(x + 3 * dpr, left + width - w)) };
          });
        const rows = stackLabels(
          shown.map((s) => ({ x: s.boxX, width: s.w })),
          3,
          4 * dpr,
        );
        shown.forEach((s, i) => {
          ctx.strokeStyle = alpha(s.color, 0.75);
          ctx.setLineDash([4 * dpr, 4 * dpr]);
          ctx.lineWidth = dpr;
          ctx.beginPath();
          ctx.moveTo(Math.round(s.x) + 0.5, top);
          ctx.lineTo(Math.round(s.x) + 0.5, top + height);
          ctx.stroke();
          const row = rows[i]!;
          if (row < 0) return;
          const y = top + 3 * dpr + row * 15 * dpr;
          ctx.setLineDash([]);
          ctx.fillStyle = alpha(surface, 0.85);
          ctx.fillRect(s.boxX, y, s.w, 13 * dpr);
          ctx.fillStyle = s.color;
          ctx.textBaseline = 'middle';
          ctx.fillText(s.a.label, s.boxX + 4 * dpr, y + 6.5 * dpr);
          ctx.textBaseline = 'alphabetic';
        });
      }

      if (picked) {
        const v = cs.find((c) => c.key === 'gravity')?.values[picked.idx];
        const t = (d[0] as number[])[picked.idx];
        if (finite(v) && t !== undefined) {
          ctx.setLineDash([]);
          ctx.strokeStyle = cssVar('--text');
          ctx.lineWidth = 2 * dpr;
          ctx.beginPath();
          ctx.arc(p.valToPos(t, 'x', true), p.valToPos(v, 'g', true), 6 * dpr, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.restore();
    };

    let pickTimer = 0;
    const reset = () => {
      const l = latest.current;
      window.clearTimeout(pickTimer);
      setPick(null);
      if (!l.zoomable) return;
      if (l.onResetZoom) l.onResetZoom();
      else if (l.liveZoom) l.onZoom?.(l.bounds.from, l.bounds.to);
    };

    // With nothing hovered, the legend shows the latest reading.
    const legendToLatest = (p: uPlot) => {
      if ((p.cursor.left ?? -1) >= 0) return;
      const last = (p.data[0]?.length ?? 0) - 1;
      if (last >= 0 && p.legend.idx !== last) p.setLegend({ idx: last });
    };

    const opts: Options = {
      width: Math.max(260, el.clientWidth),
      height: plotHeight(compact),
      padding: [12, 8, 0, 4],
      cursor: {
        drag: { x: zoomable, y: false, setScale: false, dist: 8 },
        points: { size: 7 },
        bind: {
          dblclick: () => () => {
            reset();
            return null;
          },
        },
      },
      legend: { show: !compact, live: true },
      scales: {
        x: { time: true },
        g: { auto: true, range: (_p, min, max) => padRange(min, max, 0.08, plato ? 0.8 : 0.003, plato ? [0, 12] : [1, 1.05]) },
        t: { auto: true, range: (_p, min, max) => padRange(min, max, 0.15, 1, [15, 25]) },
      },
      axes: [
        { ...axisBase, space: 70 },
        ...(has('gravity')
          ? [
              {
                ...axisBase,
                scale: 'g',
                size: 52,
                values: (_p: uPlot, vals: number[], _a: number, _s: number, incr: number) =>
                  vals.map((v) => (plato ? fixed(v, incr < 0.1 ? 2 : 1) : fixed(v, incr < 0.001 ? 4 : 3))),
              },
            ]
          : []),
        ...(has('temperature')
          ? [
              {
                ...axisBase,
                scale: 't',
                side: 1,
                size: 48,
                grid: { show: false },
                values: (_p: uPlot, vals: number[], _a: number, _s: number, incr: number) =>
                  vals.map((v) => `${fixed(v, incr < 1 ? 1 : 0)}°`),
              },
            ]
          : []),
      ],
      series: [{ value: (_p, v) => (v == null ? '–' : dateTime(v * 1000)) }, ...built.map((b) => b.s)],
      hooks: {
        setSelect: [
          (p) => {
            if (ignoreSelect.current || p.select.width < 8) return;
            const l = latest.current;
            const win = windowFromSelection(l.view, p.select.left, p.select.width, p.over.clientWidth, l.bounds);
            p.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
            commit(win);
          },
        ],
        draw: [drawExtras],
        setCursor: [legendToLatest],
      },
    };

    ignoreSelect.current = true;
    const cur = latest.current;
    const chart = new uPlot(opts, cur.data, el);
    chart.setScale('x', { min: cur.view.from / 1000, max: cur.view.to / 1000 });
    plot.current = chart;
    const ready = window.setTimeout(() => (ignoreSelect.current = false));

    // Zooming and panning: the plot follows straight away; the parent hears about it as it goes (when it zooms on the
    // client) or once the gesture ends.
    let raf = 0;
    let pending: TimeWindow | null = null;
    let wheelTimer = 0;
    const show = (win: TimeWindow) => {
      latest.current.view = win;
      chart.setScale('x', { min: win.from / 1000, max: win.to / 1000 });
      if (latest.current.pick) setPick(null);
    };
    const preview = (win: TimeWindow) => {
      pending = win;
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        const w = pending;
        pending = null;
        if (!w) return;
        show(w);
        if (latest.current.liveZoom) latest.current.onZoom?.(w.from, w.to);
      });
    };
    const commit = (win: TimeWindow) => {
      window.cancelAnimationFrame(raf);
      raf = 0;
      pending = null;
      show(win);
      latest.current.onZoom?.(win.from, win.to);
    };
    commitRef.current = commit;
    resetRef.current = reset;

    const over = chart.over;
    const local = (e: { clientX: number; clientY: number }) => {
      const r = over.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height };
    };

    /** Shows the picker for a reading, above or below `anchorY` (CSS px in the plot) so it doesn't cover the pointer. */
    const placePick = (idx: number, anchorY?: number) => {
      const l = latest.current;
      const v = l.cols.find((c) => c.key === 'gravity')?.values[idx];
      const t = (l.data[0] as number[])[idx];
      const w = wrap.current;
      if (!finite(v) || t === undefined || !w) return;
      const o = over.getBoundingClientRect();
      const r = w.getBoundingClientRect();
      const y = anchorY ?? chart.valToPos(v, 'g');
      setPick({ idx, ts: Math.round(t * 1000), left: o.left - r.left + chart.valToPos(t, 'x'), top: o.top - r.top + y, below: y < 90 });
    };
    pickAt.current = placePick;
    const openPick = (x: number, y: number) => {
      const l = latest.current;
      const g = l.cols.find((c) => c.key === 'gravity');
      if (!l.onPickPoint || !g) return;
      const idx = nearestIndex(l.data[0] as number[], g.values, chart.posToVal(x, 'x'));
      if (idx >= 0) placePick(idx, y);
    };
    // Waits a moment, so a double click or tap zooms out without the picker popping up first.
    const schedulePick = (x: number, y: number, ms: number) => {
      window.clearTimeout(pickTimer);
      if (latest.current.onPickPoint) pickTimer = window.setTimeout(() => openPick(x, y), ms);
    };

    // Mouse: uPlot handles drag-to-zoom; a plain click picks a reading.
    let downAt: { x: number; y: number } | null = null;
    let lastTouchUp = 0;
    const onMouseDown = (e: MouseEvent) => {
      downAt = { x: e.clientX, y: e.clientY };
    };
    const onClick = (e: MouseEvent) => {
      if (performance.now() - lastTouchUp < 800) return;
      if (e.detail > 1) return window.clearTimeout(pickTimer);
      if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return;
      const p = local(e);
      schedulePick(p.x, p.y, 250);
    };

    // Touch: one finger across the plot selects a range to zoom to (up and down still scrolls the page), two fingers
    // pinch and pan, a tap shows the values there and a double tap shows it all.
    const touches = new Map<number, { x: number; y: number }>();
    let mode: 'none' | 'pending' | 'select' | 'pinch' | 'done' = 'none';
    let start = { x: 0, y: 0 };
    let pinch: { win: TimeWindow; px: [number, number] } | null = null;
    let lastTap = { t: 0, x: 0 };
    const pair = (): [number, number] => {
      const [a, b] = [...touches.values()];
      return [a?.x ?? 0, b?.x ?? 0];
    };
    const clearSelect = () => chart.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
    const capture = (id: number) => {
      try {
        over.setPointerCapture(id);
      } catch {}
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') return;
      const p = local(e);
      touches.set(e.pointerId, p);
      if (touches.size === 1) {
        mode = 'pending';
        start = p;
      } else if (touches.size === 2 && latest.current.zoomable) {
        if (mode === 'select') clearSelect();
        mode = 'pinch';
        pinch = { win: latest.current.view, px: pair() };
        for (const id of touches.keys()) capture(id);
      }
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!touches.has(e.pointerId)) return;
      const p = local(e);
      touches.set(e.pointerId, p);
      if (mode === 'pending' && latest.current.zoomable) {
        const dx = p.x - start.x;
        if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(p.y - start.y)) {
          mode = 'select';
          capture(e.pointerId);
        }
      }
      if (mode === 'select') {
        const a = Math.max(0, Math.min(start.x, p.x));
        const b = Math.min(p.w, Math.max(start.x, p.x));
        chart.setSelect({ left: a, top: 0, width: b - a, height: p.h }, false);
      } else if (mode === 'pinch' && pinch && touches.size >= 2) {
        preview(pinchWindow(pinch.win, pinch.px, pair(), p.w, latest.current.bounds, MIN_SPAN_MS));
      }
    };
    const onPointerEnd = (e: PointerEvent) => {
      if (!touches.has(e.pointerId)) return;
      const p = local(e);
      touches.delete(e.pointerId);
      const up = e.type === 'pointerup';
      if (up) lastTouchUp = performance.now();
      if (mode === 'select') {
        const a = Math.max(0, Math.min(start.x, p.x));
        const b = Math.min(p.w, Math.max(start.x, p.x));
        clearSelect();
        mode = touches.size ? 'done' : 'none';
        if (up && b - a >= 12) commit(windowFromSelection(latest.current.view, a, b - a, p.w, latest.current.bounds));
        return;
      }
      if (mode === 'pinch') {
        mode = touches.size ? 'done' : 'none';
        commit(pending ?? latest.current.view);
        return;
      }
      if (mode === 'pending' && up) {
        const now = performance.now();
        if (now - lastTap.t < 350 && Math.abs(p.x - lastTap.x) < 40) {
          lastTap = { t: 0, x: 0 };
          reset();
        } else {
          lastTap = { t: now, x: p.x };
          chart.setCursor({ left: p.x, top: p.y });
          schedulePick(p.x, p.y, 360);
        }
      }
      if (!touches.size) mode = 'none';
    };
    const onWheel = (e: WheelEvent) => {
      const l = latest.current;
      if (!(e.ctrlKey || e.metaKey) || !l.zoomable) return;
      e.preventDefault();
      const p = local(e);
      const win = pending ?? l.view;
      const anchor = win.from + (p.x / Math.max(1, p.w)) * (win.to - win.from);
      preview(zoomWindow(win, anchor, Math.exp(Math.max(-0.5, Math.min(0.5, e.deltaY * 0.01))), l.bounds));
      window.clearTimeout(wheelTimer);
      wheelTimer = window.setTimeout(() => commit(pending ?? latest.current.view), 250);
    };

    over.addEventListener('mousedown', onMouseDown);
    over.addEventListener('click', onClick);
    over.addEventListener('pointerdown', onPointerDown);
    over.addEventListener('pointermove', onPointerMove);
    over.addEventListener('pointerup', onPointerEnd);
    over.addEventListener('pointercancel', onPointerEnd);
    over.addEventListener('wheel', onWheel, { passive: false });

    const ro = new ResizeObserver(() => {
      const w = Math.max(260, el.clientWidth);
      if (w !== chart.width) {
        chart.setSize({ width: w, height: plotHeight(compact) });
        if (latest.current.pick) setPick(null);
      }
    });
    ro.observe(el);
    return () => {
      window.clearTimeout(ready);
      window.clearTimeout(wheelTimer);
      window.clearTimeout(pickTimer);
      window.cancelAnimationFrame(raf);
      ro.disconnect();
      over.removeEventListener('mousedown', onMouseDown);
      over.removeEventListener('click', onClick);
      over.removeEventListener('pointerdown', onPointerDown);
      over.removeEventListener('pointermove', onPointerMove);
      over.removeEventListener('pointerup', onPointerEnd);
      over.removeEventListener('pointercancel', onPointerEnd);
      over.removeEventListener('wheel', onWheel);
      el.style.minHeight = `${el.offsetHeight}px`;
      chart.destroy();
      plot.current = null;
      commitRef.current = null;
      setPick(null);
      window.requestAnimationFrame(() => (el.style.minHeight = ''));
    };
    // The plot is rebuilt only when its series change; data and the window go through the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    const chart = plot.current;
    if (!chart) return;
    ignoreSelect.current = true;
    chart.setData(data, false);
    const v = latest.current.view;
    chart.setScale('x', { min: v.from / 1000, max: v.to / 1000 });
    const last = (data[0] as number[]).length - 1;
    if (last >= 0 && chart.cursor.left !== undefined && chart.cursor.left < 0) chart.setLegend({ idx: last });
    setPick(null);
    const t = window.setTimeout(() => (ignoreSelect.current = false));
    return () => window.clearTimeout(t);
  }, [data]);

  useEffect(() => {
    const next = { from, to };
    if (sameWindow(next, latest.current.view)) return;
    latest.current.view = next;
    plot.current?.setScale('x', { min: from / 1000, max: to / 1000 });
    setPick(null);
  }, [from, to]);

  const annKey = (annotations ?? []).map((a) => `${a.ts}:${a.label}:${a.color ?? ''}`).join('|');
  useEffect(() => {
    plot.current?.redraw(false, false);
  }, [og, targetFg, annKey, pick?.idx]);

  useImperativeHandle(
    ref,
    () => ({
      exportPng: async ({ title, subtitle, fileName }) => {
        const chart = plot.current;
        if (!chart) throw new Error(t('The chart is still loading'));
        setPick(null);
        latest.current.pick = null;
        chart.redraw(false, false);
        const legend = legendItems.current.filter((_l, i) => chart.series[i + 1]?.show !== false);
        await exportChartPng(chart, { title, subtitle, legend, fileName });
      },
    }),
    [],
  );

  const zoomed = zoomable && isZoomed({ from, to }, bounds ?? { from, to });
  const zoomBy = (factor: number) => {
    const { view: v, bounds: b } = latest.current;
    commitRef.current?.(zoomWindow(v, (v.from + v.to) / 2, factor, b));
  };
  const panBy = (frac: number) => {
    const { view: v, bounds: b } = latest.current;
    commitRef.current?.(panWindow(v, (v.to - v.from) * frac, b));
  };
  const panTo = (edge: 'start' | 'end') => {
    const { view: v, bounds: b } = latest.current;
    const span = v.to - v.from;
    commitRef.current?.(clampWindow(edge === 'start' ? { from: b.from, to: b.from + span } : { from: b.to - span, to: b.to }, b));
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || e.altKey || e.ctrlKey || e.metaKey) return;
    let handled = true;
    if (e.key === 'Escape' && pick) setPick(null);
    else if (e.key === 'Enter' && onPickPoint && gIdx >= 0) {
      const i = nearestIndex(data[0] as number[], cols[gIdx]!.values, latest.current.view.to / 1000);
      if (i >= 0) pickAt.current(i);
    } else if (!zoomable) handled = false;
    else if (e.key === 'ArrowLeft') panBy(-0.25);
    else if (e.key === 'ArrowRight') panBy(0.25);
    else if (e.key === '+' || e.key === '=') zoomBy(0.5);
    else if (e.key === '-' || e.key === '_') zoomBy(2);
    else if ((e.key === '0' || e.key === 'Escape') && zoomed) resetRef.current();
    else if (e.key === 'Home') panTo('start');
    else if (e.key === 'End') panTo('end');
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const pickedValue = pick && history ? (history.gravity[pick.idx] ?? null) : null;
  const step = (dir: 1 | -1) => {
    if (!pick || gIdx < 0) return;
    const i = stepIndex(cols[gIdx]!.values, pick.idx, dir);
    if (i >= 0) pickAt.current(i);
  };

  const interactive = zoomable || onPickPoint !== undefined;
  return (
    <div
      ref={wrap}
      className={`chart-wrap${interactive ? ' interactive' : ''}${zoomable && hasData ? ' zoomable' : ''}`}
      tabIndex={interactive ? 0 : undefined}
      role="group"
      aria-label={label}
      aria-describedby={interactive ? hintId : undefined}
      onKeyDown={interactive ? onKeyDown : undefined}
    >
      <div ref={box} />
      {!hasData && <div className="chart-empty">{t('No readings in this range yet')}</div>}
      {interactive && (
        <span id={hintId} className="chart-sr">
          {zoomable ? t('Arrow keys move along the chart, plus and minus zoom, 0 shows it all.') : ''}
          {/* i18n: {action} is a button label such as "Use as OG" */}
          {onPickPoint
            ? ` ${t('Enter picks a reading to {action}.', { action: currentLocale() === 'en' ? pickLabel.toLowerCase() : pickLabel })}`
            : ''}
        </span>
      )}
      {zoomable && hasData && (
        <div className="chart-zoom" role="group" aria-label={t('Zoom')}>
          <button type="button" className="icon-btn" aria-label={t('Zoom in')} title={t('Zoom in (+)')} onClick={() => zoomBy(0.5)}>
            <Icon name="plus" size={15} />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={t('Zoom out')}
            title={t('Zoom out (−)')}
            disabled={!zoomed}
            onClick={() => zoomBy(2)}
          >
            <MinusIcon />
          </button>
          {zoomed && (
            <button
              type="button"
              className="icon-btn"
              aria-label={t('Show it all')}
              title={t('Show it all (0)')}
              onClick={() => resetRef.current()}
            >
              <Icon name="refresh" size={14} />
            </button>
          )}
        </div>
      )}
      {pick && onPickPoint && pickedValue !== null && (
        <div
          className={`chart-pick${pick.below ? ' below' : ''}`}
          style={{ left: `clamp(6.5rem, ${pick.left}px, calc(100% - 6.5rem))`, top: pick.top }}
          role="dialog"
          aria-label={t('Reading')}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setPick(null);
              wrap.current?.focus();
            }
          }}
        >
          <div className="chart-pick-head">
            <strong className="num">{u.gravityText(pickedValue)}</strong>
            <span>{dateTime(pick.ts)}</span>
            <button type="button" className="icon-btn" aria-label={t('Close')} onClick={() => setPick(null)}>
              <Icon name="x" size={14} />
            </button>
          </div>
          <div className="chart-pick-actions">
            <button type="button" className="icon-btn" aria-label={t('Previous reading')} onClick={() => step(-1)}>
              <Icon name="left" size={15} />
            </button>
            <button
              type="button"
              className="btn small primary"
              autoFocus
              onClick={() => {
                onPickPoint(pick.ts, pickedValue);
                setPick(null);
              }}
            >
              {pickLabel}
            </button>
            <button type="button" className="icon-btn" aria-label={t('Next reading')} onClick={() => step(1)}>
              <Icon name="right" size={15} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
