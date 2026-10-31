import {
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type Ref,
} from 'react';
import uPlot, { type AlignedData, type Options, type Range, type Series } from 'uplot';
import 'uplot/dist/uPlot.min.css';
import './Chart.css';
import type { ChartExclusion, History } from '@rapthooker/shared';
import { useUnits } from '../units';
import { useTheme } from '../theme';
import { dateTime, fixed, timeOnly } from '../format';
import { t, tk } from '../i18n';
import { Icon } from './Icon';
import type { ChartAnnotation } from './annotations';
import {
  clampWindow,
  isZoomed,
  MIN_SPAN_MS,
  panWindow,
  pinchWindow,
  skipImplausible,
  smoothColumn,
  splitImplausible,
  stackLabels,
  windowFromSelection,
  zoomWindow,
  type TimeWindow,
} from './chartMath';
import { exportChartPng, type PngLegendItem } from './pngExport';
import { bridgeAt, excludeColumn, mergeWindows, type Bridge } from './exclusions';
import {
  axisDecimals,
  axisLayout,
  axisWidth,
  extentOf,
  labelGap,
  pickLineColors,
  STRIP_GAP,
  STRIP_W,
  unionRange,
  type AxisPlan,
  type ScaleRange,
  type ScaleRanges,
} from './chartScales';
import { ScaleStrip } from './ScaleStrip';

export type { ChartAnnotation } from './annotations';
export type { TimeWindow } from './chartMath';
export type { ScaleRanges } from './chartScales';

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
  /**
   * Smooths the lines as drawn: a moving average over this many ms, centred on each reading (0: the readings as they
   * are). Only the drawing changes; the legend still shows the readings.
   */
  smoothMs?: number;
  /** Ranges left out: their readings are hidden, and a curve from the readings either side is drawn instead. */
  exclusions?: ChartExclusion[];
  /** Lets the user put an excluded range back, from its label on the chart. */
  onRemoveExclusion?: (exclusion: ChartExclusion) => void;
  /** Scales the user has set (gravity in SG, temperature in °C); the others scale themselves to the readings in view. */
  scaleRanges?: ScaleRanges;
  /** Lets the user set the scales, with a button next to the zoom buttons. */
  onScaleRangesChange?: (next: ScaleRanges) => void;
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
  /** The readings as they are, for the legend, when `values` are smoothed. */
  actual?: (number | null | undefined)[];
  /** Curves standing in for the readings in excluded ranges. */
  bridges?: Bridge[];
}

/** An excluded range's label on the chart, CSS px within the chart. */
interface BandLabel {
  id: string;
  /** Middle of the visible part of the range. */
  x: number;
  /** The label's top (`below` false: it sits at the top of the plot) or bottom edge. */
  y: number;
  narrow: boolean;
  below: boolean;
}

/** Lines with curves through excluded ranges; the pill's own values (dotted, for comparison) just break there. */
const BRIDGED: ReadonlySet<ColKey> = new Set<ColKey>(['gravity', 'temperature', 'velocity', 'battery', 'rssi', 'tilt']);

/** A scale's selector beside its numbers, CSS px within the chart. */
interface AxisBox {
  key: SeriesKey;
  x: number;
  top: number;
  height: number;
  /** The scale's range now. */
  min: number;
  max: number;
}

/** uPlot's layout of an axis: `_pos` is its edge nearest the plot, CSS px from the canvas's left. */
type AxisInternals = { _pos?: number; _size?: number; _show?: boolean };

/** The uPlot scale each line uses. */
const SCALE_OF: Record<SeriesKey, string> = {
  gravity: 'g',
  temperature: 't',
  velocity: 'velocity',
  battery: 'battery',
  rssi: 'rssi',
  tilt: 'tilt',
};

const lineOf = (k: ColKey): SeriesKey => (k === 'pillGravity' || k === 'implausible' ? 'gravity' : k === 'pillVelocity' ? 'velocity' : k);

/** Phones: only the first scale on each side shows its numbers, until the scales are being set. */
const isNarrow = () => window.matchMedia?.('(max-width: 639px)').matches ?? false;
const axesSignature = (plan: AxisPlan[]) => plan.map((a) => `${a.key}:${a.side}:${a.numbers}:${a.strip}`).join(',');

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

/**
 * Each line's colour (canvas-ready). Gravity is the pill's colour; with gravity on the chart, a line that would look
 * like it gets another colour.
 */
export function lineColors(gravityColor: string | undefined, withGravity: boolean): Record<SeriesKey, string> {
  const themeGravity = cssVar('--series-gravity');
  const gravity = resolveColor(gravityColor, themeGravity);
  const theme = Object.fromEntries(SERIES.map((s) => [s.key, s.key === 'gravity' ? gravity : cssVar(s.color)])) as Record<
    SeriesKey,
    string
  >;
  return withGravity ? pickLineColors(gravity, theme, themeGravity) : theme;
}

/** lineColors, following the theme and palette. */
export function useLineColors(gravityColor: string | undefined, withGravity: boolean): Record<SeriesKey, string> {
  const { look } = useTheme();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => lineColors(gravityColor, withGravity), [gravityColor, withGravity, look]);
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
  smoothMs = 0,
  exclusions,
  onRemoveExclusion,
  scaleRanges,
  onScaleRangesChange,
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
  const hintId = useId();
  const u = useUnits();
  const [bandLabels, setBandLabels] = useState<BandLabel[]>([]);
  const [openBand, setOpenBand] = useState<string | null>(null);
  /** Excluded ranges shown in full (shaded, with their label): pointed at, tapped, focused or open. */
  const [hot, setHot] = useState<string[]>([]);
  const zoomable = !compact && onZoom !== undefined;
  const scalable = !compact && onScaleRangesChange !== undefined;
  /** The scales' selectors are open (the cog). */
  const [editing, setEditing] = useState(false);
  const [axisBoxes, setAxisBoxes] = useState<AxisBox[]>([]);
  /** A scale being dragged, in the units shown, until it's let go. */
  const [draft, setDraft] = useState<{ key: SeriesKey; range: ScaleRange } | null>(null);
  /** Bumped when a resize changes which scales fit, to rebuild the plot. */
  const [relayout, setRelayout] = useState(0);
  const editingScales = scalable && editing;

  const active = useMemo(() => SERIES.filter((s) => series.includes(s.key)).map((s) => s.key), [series]);
  const colors = useLineColors(gravityColor, active.includes('gravity'));

  // Custom scales in the units shown.
  const ranges = useMemo<ScaleRanges>(() => {
    const out: ScaleRanges = {};
    for (const k of active) {
      const r = scaleRanges?.[k];
      if (!r) continue;
      if (k === 'gravity') out[k] = [u.gravityValue(r[0]), u.gravityValue(r[1])];
      else if (k === 'temperature') out[k] = [u.tempValue(r[0]), u.tempValue(r[1])];
      else out[k] = r;
    }
    if (draft && active.includes(draft.key)) out[draft.key] = draft.range;
    return out;
  }, [active, scaleRanges, draft, u]);
  const rangesKey = JSON.stringify(ranges);

  // Live updates bring a new pill (and array) with every reading: only a change to the ranges counts.
  const exclusionKey = (exclusions ?? []).map((e) => `${e.id}:${e.from}-${e.to}`).join(',');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const excluded = useMemo(() => [...(exclusions ?? [])].sort((a, b) => a.from - b.from), [exclusionKey]);

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
    // Excluded readings go first, so they neither show nor smear into their neighbours when smoothed; the curves
    // through them are worked out from the lines as drawn.
    const windows = mergeWindows(excluded);
    const smoothing = smoothMs > 0;
    if (windows.length === 0 && !smoothing) return out;
    return out.map((c) => {
      let values = c.values;
      let raw = c.raw;
      if (windows.length) {
        const r = excludeColumn(h.ts, values, windows, false);
        values = r.values;
        raw = raw?.map((v, i) => (r.hidden[i] ? null : v));
      }
      const smooth = smoothing && c.key !== 'implausible';
      const actual = smooth ? values : undefined;
      if (smooth) values = smoothColumn(h.ts, values, smoothMs);
      const bridges = windows.length && BRIDGED.has(c.key) ? excludeColumn(h.ts, values, windows).bridges : [];
      return { ...c, values, raw, actual, bridges: bridges.length ? bridges : undefined };
    });
  }, [history, active, u, excluded, smoothMs]);

  const data = useMemo<AlignedData>(
    () => [history ? history.ts.map((t) => t / 1000) : [], ...cols.map((c) => c.values)] as AlignedData,
    [history, cols],
  );
  const hasData = (history?.ts.length ?? 0) > 0;
  const hasG = active.includes('gravity');
  const fadedAuto = useMemo(
    () => cols.some((c) => c.key === 'implausible') && !cols.find((c) => c.key === 'gravity')?.values.some(finite),
    [cols],
  );
  const ogShown = og != null && hasG ? u.gravityValue(og) : null;
  const targetShown = targetFg != null && hasG ? u.gravityValue(targetFg) : null;

  // How far each scale's selector reaches: all the readings loaded (and the OG and target lines), padded like the
  // automatic scale, so showing all of them is one end-to-end drag.
  const tracks = useMemo(() => {
    const out: Partial<Record<SeriesKey, TimeWindow>> = {};
    if (!editingScales) return out;
    const plato = u.gravity === 'plato';
    for (const key of active) {
      const columns: ArrayLike<number | null | undefined>[] = [];
      for (const c of cols) {
        if (lineOf(c.key) !== key) continue;
        if (c.key === 'implausible') {
          if (fadedAuto) columns.push(c.values);
          continue;
        }
        columns.push(c.values);
        if (c.actual) columns.push(c.actual);
        for (const b of c.bridges ?? []) columns.push(Array.from({ length: 25 }, (_, k) => b.at(b.from + ((b.to - b.from) * k) / 24)));
      }
      if (key === 'gravity') columns.push([ogShown, targetShown]);
      const e = extentOf(columns);
      if (!e) continue;
      const [lo, hi] =
        key === 'gravity'
          ? padRange(e[0], e[1], 0.08, plato ? 0.8 : 0.003, [e[0], e[1]])
          : key === 'temperature'
            ? padRange(e[0], e[1], 0.15, 1, [e[0], e[1]])
            : uPlot.rangeNum(e[0], e[1], 0.1, true);
      if (finite(lo) && finite(hi) && hi > lo) out[key] = { from: lo, to: hi };
    }
    return out;
  }, [editingScales, active, cols, fadedAuto, ogShown, targetShown, u.gravity]);

  // What the uPlot hooks and gesture handlers need, without rebuilding the plot.
  const latest = useRef({
    data,
    cols,
    view: { from, to } as TimeWindow,
    bounds: bounds ?? { from, to },
    onZoom,
    onResetZoom,
    liveZoom: bounds !== undefined,
    zoomable,
    lines: { og: null as number | null, target: null as number | null },
    annotations: [] as ChartAnnotation[],
    excluded: [] as ChartExclusion[],
    bandKey: '',
    // Which excluded range the pointer is over (on the plot or on its label), has keyboard focus, or is open.
    hoverId: null as string | null,
    labelId: null as string | null,
    focusId: null as string | null,
    openBand: null as string | null,
    hot: [] as string[],
    refreshHot: () => {},
    ranges: {} as ScaleRanges,
    axisPlan: [] as AxisPlan[],
    editing: false,
    axisKey: '',
    colors: {} as Record<SeriesKey, string>,
  });
  const L = latest.current;
  L.data = data;
  L.cols = cols;
  L.bounds = bounds ?? { from, to };
  L.onZoom = onZoom;
  L.onResetZoom = onResetZoom;
  L.liveZoom = bounds !== undefined;
  L.zoomable = zoomable;
  L.lines = { og: ogShown, target: targetShown };
  L.annotations = annotations ?? [];
  L.excluded = excluded;
  L.openBand = openBand;
  L.ranges = ranges;
  L.editing = editingScales;
  L.colors = colors;

  // Colours come from CSS variables, so a theme or palette change rebuilds the chart too.
  const { look } = useTheme();
  const key = `${cols.map((c) => c.key).join(',')}|${fadedAuto}|${u.gravity}|${u.temperature}|${gravityColor ?? ''}|${compact}|${zoomable}|${look}|${editingScales}|${relayout}|${Object.values(colors).join(',')}`;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const muted = cssVar('--muted');
    const grid = cssVar('--grid');
    const gColor = gravityColor ?? cssVar('--series-gravity');
    const colorOf = latest.current.colors;
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
        const col = latest.current.cols[i];
        const real = col?.raw ?? col?.actual;
        const shown = real && idx !== null ? (real[idx] ?? null) : v;
        if (shown == null && idx !== null && col?.bridges) {
          const at = (latest.current.data[0] as number[])[idx];
          const b = at === undefined ? undefined : bridgeAt(col.bridges, at * 1000);
          if (b && at !== undefined) return `≈ ${fmt[c.key](b.at(at * 1000))}`;
        }
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
          const color = colorOf.temperature;
          const name = t('Temperature');
          return { s: { ...base, label: name, scale: 't', stroke: color, width: 1.8 }, png: { label: name, color } };
        }
        case 'velocity': {
          const color = colorOf.velocity;
          const name = has('pillVelocity') ? t('Velocity (RaptHooker)') : t('Velocity');
          return {
            s: { ...base, label: name, scale: 'velocity', stroke: color, width: 1.4, dash: [5, 4] },
            png: { label: name, color, dash: true },
          };
        }
        case 'pillVelocity': {
          const color = alpha(colorOf.velocity, 0.8);
          const name = t("Pill's own velocity");
          return {
            s: { ...base, label: name, scale: 'velocity', stroke: color, width: 1.1, dash: [2, 4] },
            png: { label: name, color, dash: true },
          };
        }
        default: {
          const meta = SERIES.find((x) => x.key === c.key)!;
          const color = colorOf[meta.key];
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
    // A line's curve through an excluded range: its own colour, dashed.
    const curveStyle = built.map((b) => ({ color: typeof b.s.stroke === 'string' ? b.s.stroke : gColor, width: b.s.width ?? 1.4 }));

    /** Widens a scale's data range to take in the curves through excluded ranges in view. */
    const widen = (p: uPlot, scale: string, min: number | null, max: number | null): [number | null, number | null] => {
      const { cols: cs, view } = latest.current;
      let lo = min;
      let hi = max;
      cs.forEach((c, i) => {
        const s = p.series[i + 1];
        if (!c.bridges || !s || s.show === false || s.scale !== scale) return;
        for (const b of c.bridges) {
          const a = Math.max(b.from, view.from);
          const z = Math.min(b.to, view.to);
          if (z < a) continue;
          for (let k = 0; k <= 24; k++) {
            const v = b.at(a + ((z - a) * k) / 24);
            lo = lo === null || v < lo ? v : lo;
            hi = hi === null || v > hi ? v : hi;
          }
        }
      });
      return [lo, hi];
    };
    const numRange =
      (scale: string): Range.Function =>
      (p, min, max) => {
        const [lo, hi] = widen(p, scale, min, max);
        return lo === null || hi === null ? [null, null] : uPlot.rangeNum(lo, hi, 0.1, true);
      };
    /** A scale the user has set stays put; the others follow the readings in view. */
    const userRange =
      (key: SeriesKey, auto: Range.Function): Range.Function =>
      (p, min, max, scale) => {
        const r = latest.current.ranges[key];
        return r ? [r[0], r[1]] : auto(p, min, max, scale);
      };

    const editingNow = latest.current.editing;
    const plotWidth = () => Math.max(260, el.clientWidth);
    const planFor = (width: number) =>
      axisLayout(SERIES.map((s) => s.key).filter(has), { narrow: compact || isNarrow(), editing: editingNow, width });
    const plan = planFor(plotWidth());
    latest.current.axisPlan = plan;
    const lineColor = (key: SeriesKey) => (key === 'gravity' ? gColor : colorOf[key]);
    const tickText: Record<SeriesKey, (v: number, incr: number) => string> = {
      gravity: (v, incr) => (plato ? fixed(v, incr < 0.1 ? 2 : 1) : fixed(v, incr < 0.001 ? 4 : 3)),
      // As it always was; the 2 decimals are only for a range set very small.
      temperature: (v, incr) => `${fixed(v, incr < 0.1 ? 2 : incr < 1 ? 1 : 0)}°`,
      velocity: (v, incr) => fixed(v, axisDecimals(incr)),
      battery: (v, incr) => `${fixed(v, axisDecimals(incr))}%`,
      rssi: (v, incr) => fixed(v, axisDecimals(incr)),
      tilt: (v, incr) => `${fixed(v, axisDecimals(incr))}°`,
    };
    /** Each line's numbers, in its colour; while the scales are being set, its selector sits between them and the plot. */
    const yAxis = (a: AxisPlan): uPlot.Axis => ({
      ...axisBase,
      scale: SCALE_OF[a.key],
      side: a.side === 'left' ? 3 : 1,
      show: a.numbers || a.strip,
      size: axisWidth(a),
      gap: labelGap(a),
      stroke: lineColor(a.key),
      grid: a.grid ? axisBase.grid : { show: false },
      values: (_p: uPlot, vals: number[], _a: number, _s: number, incr: number) =>
        vals.map((v) => (a.numbers ? tickText[a.key](v, incr) : '')),
    });

    /** Puts each scale's selector next to the plot side of its numbers. */
    const placeAxes = (p: uPlot) => {
      const l = latest.current;
      const w = wrap.current;
      if (!w) return;
      const boxes: AxisBox[] = [];
      if (l.editing) {
        const r = w.getBoundingClientRect();
        const o = p.over.getBoundingClientRect();
        const left = p.ctx.canvas.getBoundingClientRect().left - r.left;
        l.axisPlan.forEach((plan, i) => {
          const a = p.axes[i + 1] as (uPlot.Axis & AxisInternals) | undefined;
          const sc = a?.scale ? p.scales[a.scale] : undefined;
          const min = sc?.min;
          const max = sc?.max;
          if (!plan.strip || !a?._show || a._pos == null || a._size == null || !finite(min) || !finite(max)) return;
          const x = plan.side === 'left' ? left + a._pos - STRIP_GAP - STRIP_W : left + a._pos + STRIP_GAP;
          boxes.push({ key: plan.key, x, top: o.top - r.top, height: o.height, min, max });
        });
      }
      const k = boxes.map((b) => `${b.key}:${Math.round(b.x)}:${Math.round(b.top)}:${Math.round(b.height)}:${b.min}:${b.max}`).join('|');
      if (k !== l.axisKey) {
        l.axisKey = k;
        setAxisBoxes(boxes);
      }
    };

    /** The excluded range under `left` (CSS px across the plot), with narrow ones widened so they can be pointed at. */
    const bandAt = (p: uPlot, left: number): string | null => {
      if (compact || left < 0) return null;
      for (const e of latest.current.excluded) {
        let a = p.valToPos(e.from / 1000, 'x');
        let b = p.valToPos(e.to / 1000, 'x');
        if (b - a < 12) {
          const mid = (a + b) / 2;
          a = mid - 6;
          b = mid + 6;
        }
        if (left >= a && left <= b) return e.id;
      }
      return null;
    };

    /** Follows the pointer (or a tap) over excluded ranges; only the one it's on is shown in full. */
    const trackHover = (p: uPlot) => {
      const l = latest.current;
      if (l.excluded.length === 0 && l.hoverId === null) return;
      const id = bandAt(p, p.cursor.left ?? -1);
      p.over.style.cursor = id ? 'pointer' : '';
      if (id === l.hoverId) return;
      l.hoverId = id;
      l.refreshHot();
    };

    /** Excluded ranges being pointed at (see `hot`): shaded and hatched, under the grid and the lines. */
    const drawBands = (p: uPlot) => {
      const { excluded: all, hot: shown } = latest.current;
      const ex = all.filter((e) => shown.includes(e.id));
      if (ex.length === 0) return;
      const dpr = devicePixelRatio;
      const ctx = p.ctx;
      const { left, top, width, height } = p.bbox;
      const xMin = p.scales.x?.min ?? -Infinity;
      const xMax = p.scales.x?.max ?? Infinity;
      ctx.save();
      ctx.beginPath();
      ctx.rect(left, top, width, height);
      ctx.clip();
      ctx.fillStyle = muted;
      ctx.strokeStyle = muted;
      ctx.lineWidth = dpr;
      for (const e of ex) {
        if (e.to / 1000 < xMin || e.from / 1000 > xMax) continue;
        let x0 = p.valToPos(e.from / 1000, 'x', true);
        let x1 = p.valToPos(e.to / 1000, 'x', true);
        if (x1 - x0 < 3 * dpr) {
          const mid = (x0 + x1) / 2;
          x0 = mid - 1.5 * dpr;
          x1 = mid + 1.5 * dpr;
        }
        const a = Math.max(x0, left);
        const b = Math.min(x1, left + width);
        ctx.globalAlpha = 0.07;
        ctx.fillRect(a, top, b - a, height);
        // Hatching, fixed to the range so it moves with it.
        ctx.save();
        ctx.beginPath();
        ctx.rect(a, top, b - a, height);
        ctx.clip();
        ctx.globalAlpha = 0.13;
        ctx.beginPath();
        const step = 7 * dpr;
        let x = x0 - height;
        if (x < a - height) x += Math.ceil((a - height - x) / step) * step;
        for (; x < b; x += step) {
          ctx.moveTo(x, top + height);
          ctx.lineTo(x + height, top);
        }
        ctx.stroke();
        ctx.restore();
        ctx.globalAlpha = 0.45;
        ctx.setLineDash([3 * dpr, 3 * dpr]);
        ctx.beginPath();
        for (const edge of [x0, x1]) {
          if (edge < left || edge > left + width) continue;
          ctx.moveTo(Math.round(edge) + 0.5, top);
          ctx.lineTo(Math.round(edge) + 0.5, top + height);
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();
    };

    /** Curves standing in for the readings in excluded ranges, dashed: estimates, not readings. */
    const drawBridges = (p: uPlot) => {
      const cs = latest.current.cols;
      if (!cs.some((c) => c.bridges)) return;
      const dpr = devicePixelRatio;
      const ctx = p.ctx;
      const { top, height } = p.bbox;
      const xMin = p.scales.x?.min ?? -Infinity;
      const xMax = p.scales.x?.max ?? Infinity;
      cs.forEach((c, i) => {
        const s = p.series[i + 1];
        const style = curveStyle[i];
        if (!c.bridges || !s || s.show === false || !s.scale || !style) return;
        const scale = s.scale;
        // uPlot nudges each line (its fill and gaps too) by half its odd part of a pixel to keep strokes crisp; the curve
        // takes the same nudge so its fill meets the line's without a seam.
        const lineWidth = Math.round((s.width ?? 1) * uPlot.pxRatio * 1000) / 1000;
        const nudge = s.pxAlign === 0 ? 0 : (lineWidth % 2) / 2;
        ctx.translate(nudge, nudge);
        for (const b of c.bridges) {
          const t0 = Math.max(b.from / 1000, xMin);
          const t1 = Math.min(b.to / 1000, xMax);
          if (!(t1 > t0)) continue;
          const n = Math.max(2, Math.min(600, Math.ceil((p.valToPos(t1, 'x', true) - p.valToPos(t0, 'x', true)) / (2 * dpr))));
          const pts: [number, number][] = [];
          for (let k = 0; k <= n; k++) {
            const x = t0 + ((t1 - t0) * k) / n;
            pts.push([p.valToPos(x, 'x', true), p.valToPos(b.at(x * 1000), scale, true)]);
          }
          if (c.key === 'gravity') {
            // The same fill as the line's, so only the dashes set the range apart until it's pointed at.
            const grad = ctx.createLinearGradient(0, top, 0, top + height);
            grad.addColorStop(0, alpha(style.color, 0.28));
            grad.addColorStop(1, alpha(style.color, 0));
            ctx.fillStyle = grad;
            ctx.beginPath();
            // Whole pixels at the ends, as uPlot draws the line's own fill, so no seam shows where they meet.
            ctx.moveTo(Math.round(pts[0]![0]), top + height);
            ctx.lineTo(Math.round(pts[0]![0]), pts[0]![1]);
            for (const [x, y] of pts) ctx.lineTo(x, y);
            ctx.lineTo(Math.round(pts[n]![0]), pts[n]![1]);
            ctx.lineTo(Math.round(pts[n]![0]), top + height);
            ctx.closePath();
            ctx.fill();
          }
          ctx.strokeStyle = style.color;
          ctx.lineWidth = style.width * dpr;
          ctx.setLineDash([5 * dpr, 4 * dpr]);
          ctx.lineCap = 'round';
          ctx.globalAlpha = 0.85;
          ctx.beginPath();
          pts.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
          ctx.stroke();
          ctx.globalAlpha = 1;
          ctx.lineCap = 'butt';
          ctx.setLineDash([]);
        }
        ctx.translate(-nudge, -nudge);
      });
    };

    /** Puts each visible excluded range's label at the bottom of the plot, or the top when a curve runs low there. */
    const placeBands = (p: uPlot) => {
      const l = latest.current;
      const w = wrap.current;
      if (compact || !w) return;
      const xMin = p.scales.x?.min ?? -Infinity;
      const xMax = p.scales.x?.max ?? Infinity;
      const o = p.over.getBoundingClientRect();
      const r = w.getBoundingClientRect();
      const labels: BandLabel[] = [];
      for (const e of l.excluded) {
        if (e.to / 1000 < xMin || e.from / 1000 > xMax) continue;
        const a = Math.max(0, p.valToPos(e.from / 1000, 'x'));
        const b = Math.min(o.width, p.valToPos(e.to / 1000, 'x'));
        const mid = (a + b) / 2;
        const at = p.posToVal(mid, 'x') * 1000;
        const low = l.cols.some((c, i) => {
          const s = p.series[i + 1];
          const br = s?.show !== false && s?.scale ? bridgeAt(c.bridges, at) : undefined;
          return br !== undefined && p.valToPos(br.at(at), s!.scale!) > o.height - 40;
        });
        labels.push({ id: e.id, x: o.left - r.left + mid, y: o.top - r.top + (low ? 6 : o.height - 6), below: low, narrow: b - a < 96 });
      }
      const k = labels.map((x) => `${x.id}:${Math.round(x.x)}:${Math.round(x.y)}:${x.narrow}`).join('|');
      if (k !== l.bandKey) {
        l.bandKey = k;
        setBandLabels(labels);
      }
    };

    const drawExtras = (p: uPlot) => {
      const dpr = devicePixelRatio;
      const ctx = p.ctx;
      const { left, top, width, height } = p.bbox;
      const { lines, annotations: anns } = latest.current;
      ctx.save();
      ctx.beginPath();
      ctx.rect(left, top, width, height);
      ctx.clip();
      drawBridges(p);
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
      ctx.restore();
      placeBands(p);
    };

    let tapTimer = 0;
    const reset = () => {
      const l = latest.current;
      window.clearTimeout(tapTimer);
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
      width: plotWidth(),
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
        g: {
          auto: true,
          range: userRange('gravity', (p, min, max) => {
            const [lo, hi] = widen(p, 'g', min, max);
            return padRange(lo, hi, 0.08, plato ? 0.8 : 0.003, plato ? [0, 12] : [1, 1.05]);
          }),
        },
        t: {
          auto: true,
          range: userRange('temperature', (p, min, max) => {
            const [lo, hi] = widen(p, 't', min, max);
            return padRange(lo, hi, 0.15, 1, [15, 25]);
          }),
        },
        ...Object.fromEntries(
          (['velocity', 'battery', 'rssi', 'tilt'] as const).filter(has).map((k) => [k, { auto: true, range: userRange(k, numRange(k)) }]),
        ),
      },
      axes: [{ ...axisBase, space: 70 }, ...plan.map(yAxis)],
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
        drawClear: [drawBands],
        draw: [drawExtras, placeAxes],
        setCursor: [legendToLatest, trackHover],
      },
    };

    ignoreSelect.current = true;
    const cur = latest.current;
    const chart = new uPlot(opts, cur.data, el);
    chart.setScale('x', { min: cur.view.from / 1000, max: cur.view.to / 1000 });
    plot.current = chart;
    const ready = window.setTimeout(() => (ignoreSelect.current = false));

    // Which excluded ranges are shown in full, worked out a frame later: moving from the plot onto a range's label
    // leaves one and enters the other, and it should stay shown throughout.
    let hotRaf = 0;
    cur.refreshHot = () => {
      if (hotRaf) return;
      hotRaf = window.requestAnimationFrame(() => {
        hotRaf = 0;
        const l = latest.current;
        const ids = l.excluded.map((e) => e.id);
        const next = ids.filter((id) => id === l.hoverId || id === l.labelId || id === l.focusId || id === l.openBand);
        if (next.join() === l.hot.join()) return;
        l.hot = next;
        setHot(next);
        chart.redraw(false, false);
      });
    };

    // Zooming and panning: the plot follows straight away; the parent hears about it as it goes (when it zooms on the
    // client) or once the gesture ends.
    let raf = 0;
    let pending: TimeWindow | null = null;
    let wheelTimer = 0;
    const show = (win: TimeWindow) => {
      latest.current.view = win;
      chart.setScale('x', { min: win.from / 1000, max: win.to / 1000 });
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

    // A click or tap on an excluded range opens its details (the only way in on a touch screen); anywhere else closes
    // them. It waits a moment, so a double click or tap zooms out without anything popping up first.
    const scheduleTap = (x: number, ms: number) => {
      window.clearTimeout(tapTimer);
      const band = bandAt(chart, x);
      if (band) tapTimer = window.setTimeout(() => setOpenBand(band), ms);
      else setOpenBand(null);
    };

    // Mouse: uPlot handles drag-to-zoom; a plain click is a tap.
    let downAt: { x: number; y: number } | null = null;
    let lastTouchUp = 0;
    const onMouseDown = (e: MouseEvent) => {
      downAt = { x: e.clientX, y: e.clientY };
    };
    const onClick = (e: MouseEvent) => {
      if (performance.now() - lastTouchUp < 800) return;
      if (e.detail > 1) return window.clearTimeout(tapTimer);
      if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4) return;
      scheduleTap(local(e).x, 250);
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
          scheduleTap(p.x, 360);
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
      const w = plotWidth();
      if (w === chart.width) return;
      // Wider or narrower, more or fewer scales may fit beside the plot.
      if (axesSignature(planFor(w)) !== axesSignature(plan)) setRelayout((n) => n + 1);
      else chart.setSize({ width: w, height: plotHeight(compact) });
    });
    ro.observe(el);
    return () => {
      window.clearTimeout(ready);
      window.clearTimeout(wheelTimer);
      window.clearTimeout(tapTimer);
      window.cancelAnimationFrame(raf);
      window.cancelAnimationFrame(hotRaf);
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
      cur.bandKey = '';
      setBandLabels([]);
      cur.axisKey = '';
      setAxisBoxes([]);
      cur.refreshHot = () => {};
      cur.hoverId = null;
      cur.hot = [];
      setHot([]);
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
    const t = window.setTimeout(() => (ignoreSelect.current = false));
    return () => window.clearTimeout(t);
  }, [data]);

  useEffect(() => {
    const next = { from, to };
    if (sameWindow(next, latest.current.view)) return;
    latest.current.view = next;
    plot.current?.setScale('x', { min: from / 1000, max: to / 1000 });
  }, [from, to]);

  const annKey = (annotations ?? []).map((a) => `${a.ts}:${a.label}:${a.color ?? ''}`).join('|');
  useEffect(() => {
    plot.current?.redraw(false, false);
  }, [og, targetFg, annKey]);

  // A scale set, dragged or put back to automatic: setting the time scale again re-ranges the others.
  useLayoutEffect(() => {
    const chart = plot.current;
    if (!chart) return;
    const v = latest.current.view;
    chart.setScale('x', { min: v.from / 1000, max: v.to / 1000 });
  }, [rangesKey]);

  const changeScale = (key: SeriesKey, w: TimeWindow, done: boolean) => {
    if (!done) {
      setDraft({ key, range: [w.from, w.to] });
      return;
    }
    setDraft(null);
    const stored: ScaleRange =
      key === 'gravity'
        ? [u.gravityFromDisplay(w.from), u.gravityFromDisplay(w.to)]
        : key === 'temperature'
          ? [u.tempFromDisplay(w.from), u.tempFromDisplay(w.to)]
          : [w.from, w.to];
    onScaleRangesChange?.({ ...scaleRanges, [key]: stored });
  };
  const resetScale = (key: SeriesKey) => {
    setDraft(null);
    if (!scaleRanges?.[key]) return;
    const next = { ...scaleRanges };
    delete next[key];
    onScaleRangesChange?.(next);
  };
  const scaleName = (key: SeriesKey) =>
    key === 'gravity' ? t('Gravity ({unit})', { unit: u.gravityLabel }) : t(SERIES.find((s) => s.key === key)!.label);
  const scaleColor = (key: SeriesKey) => colors[key];
  const scaleText = (key: SeriesKey, v: number) => {
    switch (key) {
      case 'gravity':
        return u.gravity === 'plato' ? `${fixed(v, 1)} °P` : fixed(v, 3);
      case 'temperature':
        return `${fixed(v, 1)} ${u.tempLabel}`;
      case 'velocity':
        return t('{n} pts/day', { n: fixed(v, 1) });
      case 'battery':
        return `${fixed(v, 0)}%`;
      case 'rssi':
        return `${fixed(v, 0)} dBm`;
      case 'tilt':
        return `${fixed(v, 1)}°`;
    }
  };
  const anyCustom = Object.keys(ranges).length > 0;

  // The excluded range's popover closes on a click or tap anywhere else (on the plot, the tap handler decides).
  useEffect(() => {
    latest.current.refreshHot();
    if (!openBand) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target instanceof Element) || e.target.closest('.chart-band-pop, .chart-band-label')) return;
      if (wrap.current?.contains(e.target) && e.target.closest('.u-over')) return;
      setOpenBand(null);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [openBand]);

  useImperativeHandle(
    ref,
    () => ({
      exportPng: async ({ title, subtitle, fileName }) => {
        const chart = plot.current;
        if (!chart) throw new Error(t('The chart is still loading'));
        const legend = legendItems.current.filter((_l, i) => chart.series[i + 1]?.show !== false);
        if (latest.current.bandKey) legend.push({ label: t('Excluded (estimated)'), color: cssVar('--muted'), dash: true });
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
    if (e.key === 'ArrowLeft') panBy(-0.25);
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

  const openLabel = bandLabels.find((b) => b.id === openBand);
  const openExclusion = openLabel ? excluded.find((e) => e.id === openLabel.id) : undefined;
  const rangeText = (e: ChartExclusion) =>
    t('{from} to {to}', {
      from: dateTime(e.from),
      to: new Date(e.from).toDateString() === new Date(e.to).toDateString() ? timeOnly(e.to) : dateTime(e.to),
    });
  return (
    <div
      ref={wrap}
      className={`chart-wrap${zoomable ? ' interactive' : ''}${zoomable && hasData ? ' zoomable' : ''}${scalable && hasData ? ' scalable' : ''}`}
      tabIndex={zoomable ? 0 : undefined}
      role="group"
      aria-label={label}
      aria-describedby={zoomable ? hintId : undefined}
      onKeyDown={zoomable ? onKeyDown : undefined}
    >
      <div ref={box} />
      {!hasData && <div className="chart-empty">{t('No readings in this range yet')}</div>}
      {zoomable && (
        <span id={hintId} className="chart-sr">
          {t('Arrow keys move along the chart, plus and minus zoom, 0 shows it all.')}
        </span>
      )}
      {(zoomable || scalable) && hasData && (
        <div className="chart-zoom">
          {zoomable && (
            <span className="chart-zoom-btns" role="group" aria-label={t('Zoom')}>
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
            </span>
          )}
          {scalable && (
            <button
              type="button"
              className={`icon-btn chart-scales-btn${anyCustom ? ' custom' : ''}`}
              aria-label={t('Scales')}
              title={anyCustom ? t('Scales (some set by you)') : t('Scales')}
              aria-pressed={editing}
              onClick={() => {
                setDraft(null);
                setEditing((on) => !on);
              }}
            >
              <Icon name="settings" size={15} />
            </button>
          )}
        </div>
      )}
      {editingScales &&
        axisBoxes.map((b) => {
          const r = ranges[b.key];
          const value = r ? { from: r[0], to: r[1] } : { from: b.min, to: b.max };
          const track = unionRange(tracks[b.key], value);
          if (!track || !(track.to > track.from)) return null;
          return (
            <ScaleStrip
              key={b.key}
              name={scaleName(b.key)}
              color={scaleColor(b.key)}
              track={track}
              value={value}
              custom={r !== undefined}
              left={b.x}
              top={b.top}
              height={b.height}
              format={(v) => scaleText(b.key, v)}
              onChange={(w, done) => changeScale(b.key, w, done)}
              onCancel={() => setDraft(null)}
              onReset={() => resetScale(b.key)}
            />
          );
        })}
      {bandLabels.map((b) => {
        const e = excluded.find((x) => x.id === b.id);
        if (!e) return null;
        const open = openBand === b.id;
        const mark = (key: 'labelId' | 'focusId', on: boolean) => {
          const l = latest.current;
          if (on) l[key] = b.id;
          else if (l[key] === b.id) l[key] = null;
          l.refreshHot();
        };
        return (
          <button
            key={b.id}
            type="button"
            className={`chart-band-label${b.narrow ? ' narrow' : ''}${b.below ? ' top' : ''}${open ? ' open' : ''}${hot.includes(b.id) ? ' shown' : ''}`}
            style={{ left: b.x, top: b.y }}
            aria-label={t('Excluded range: {range}', { range: rangeText(e) })}
            title={t('Excluded range: {range}', { range: rangeText(e) })}
            aria-expanded={open}
            onPointerEnter={() => mark('labelId', true)}
            onPointerLeave={() => mark('labelId', false)}
            onFocus={() => mark('focusId', true)}
            onBlur={() => mark('focusId', false)}
            onClick={() => setOpenBand(open ? null : b.id)}
          >
            <Icon name="eyeOff" size={12} />
            {!b.narrow && <span>{t('Excluded')}</span>}
          </button>
        );
      })}
      {openLabel && openExclusion && (
        <div
          className={`chart-pick chart-band-pop${openLabel.below ? ' below' : ''}`}
          style={{
            left: `clamp(8.5rem, ${openLabel.x}px, calc(100% - 8.5rem))`,
            top: openLabel.below ? openLabel.y + 22 : openLabel.y - 22,
          }}
          role="dialog"
          aria-label={t('Excluded range')}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setOpenBand(null);
              wrap.current?.focus();
            }
          }}
        >
          <div className="chart-pick-head">
            <strong>{t('Excluded range')}</strong>
            <button type="button" className="icon-btn" aria-label={t('Close')} onClick={() => setOpenBand(null)}>
              <Icon name="x" size={14} />
            </button>
          </div>
          <p className="chart-band-when">{rangeText(openExclusion)}</p>
          <p className="chart-band-what">{t('Drawn as a curve from the readings either side. The readings themselves are kept.')}</p>
          {onRemoveExclusion && (
            <div className="chart-pick-actions">
              <button
                type="button"
                className="btn small"
                autoFocus
                onClick={() => {
                  setOpenBand(null);
                  onRemoveExclusion(openExclusion);
                }}
              >
                <Icon name="undo" size={14} /> {t('Remove exclusion')}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
