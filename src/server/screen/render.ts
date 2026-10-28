import { cToF, plausibleGravity, sgToPlato, type Brew, type History, type Pill, type ScreenOptions } from '@rapthooker/shared';
import type { TextMeasure, TextStyle } from './assets.js';
import { chart, type ChartInput } from './chart.js';
import { SCREEN_COLORS, gradientStops, mix, paint, parseColor, type ScreenColors } from './palette.js';
import type { ScreenStrings } from './strings.js';
import { appIcon, Defs, esc, icon, n, pillFigure, text, thermometerBadge, tspan, type IconName } from './svg.js';

/**
 * Draws a screen image as SVG: the hub's pills as cards (or compact rows when many share a small screen), or one pill
 * filling the picture, in the app's look. Sizes follow from the picture: everything in a card is measured in its base
 * text size `f`, which is as big as the space allows; what doesn't fit at a readable size is left out, least
 * important first.
 */

export interface ScreenDevice {
  pill: Pill;
  /** Readings for the chart, when it's shown. */
  history: History | null;
  /** The chart's time span. */
  from: number;
  to: number;
  /** A thermometer's lowest and highest temperature over the last day (for its stats). */
  day: { min: number; max: number } | null;
}

export interface ScreenScene {
  hubName: string;
  now: number;
  /** One device's picture rather than all of them (a missing device is null). */
  single: boolean;
  devices: ScreenDevice[];
  /** All devices only: just the brewing ones were asked for. */
  brewingOnly?: boolean;
}

export interface RenderContext {
  measure: TextMeasure;
  strings: ScreenStrings;
}

const DAY = 86_400_000;

// ---------- What each card says ----------

interface Big {
  main: string;
  tail: string;
  unit: string;
  label: string;
}

interface Stat {
  icon: IconName;
  label: string;
  value: string;
  unit?: string;
  danger?: boolean;
}

interface BrewInfo {
  name: string;
  day: string;
  abv: string | null;
  pct: number | null;
  og: string;
  fg: string;
  there: string;
}

interface Content {
  pill: Pill;
  thermometer: boolean;
  online: boolean;
  status: string;
  timeAgo: string;
  big: Big | null;
  second: string | null;
  implausible: boolean;
  /** Brew details make sense for this device (it's a pill). */
  brewable: boolean;
  brew: BrewInfo | null;
  stats: Stat[];
  chart: ChartInput | null;
}

/** Where a brew is between its original and target final gravity (as the app's fermentation bar). */
function fermentProgress(brew: Brew): { pct: number; target: number } | null {
  const { og, gravity } = brew.stats;
  if (og === null || gravity === null || og <= 1) return null;
  const target = brew.targetFg ?? og - (og - 1) * 0.75;
  if (og - target <= 0) return null;
  return { pct: Math.max(0, Math.min(100, ((og - gravity) / (og - target)) * 100)), target };
}

function describe(d: ScreenDevice, opts: ScreenOptions, s: ScreenStrings, c: ScreenColors, now: number): Content {
  const { t, tc, num } = s;
  const pill = d.pill;
  const r = pill.live.latest;
  const plato = opts.gravity === 'plato';
  const fahrenheit = opts.temperature === 'F';
  const temp = (v: number) => (fahrenheit ? cToF(v) : v);
  const tempUnit = `°${opts.temperature}`;
  const tempText = (v: number | null | undefined) =>
    v === null || v === undefined || !Number.isFinite(v) ? '–' : `${num(temp(v), 1)} ${tempUnit}`;
  const gravityText = (sg: number | null | undefined) =>
    sg === null || sg === undefined || !Number.isFinite(sg) ? '–' : plato ? `${num(sgToPlato(sg), 1)} °P` : num(sg, 4);
  const thermometer = pill.kind === 'thermometer';
  const show = new Set(opts.show);

  let big: Big | null = null;
  let second: string | null = null;
  const tempBig = (): Big => ({ main: r ? num(temp(r.temperature), 1) : '–', tail: '', unit: tempUnit, label: t('Temperature') });
  if (!thermometer && show.has('gravity')) {
    const sg = r?.gravity;
    if (sg === null || sg === undefined || !Number.isFinite(sg))
      big = { main: '–', tail: '', unit: plato ? '°P' : 'SG', label: t('Gravity') };
    else if (plato) big = { main: num(sgToPlato(sg), 1), tail: '', unit: '°P', label: t('Gravity') };
    else {
      const full = num(sg, 4);
      big = { main: full.slice(0, -1), tail: full.slice(-1), unit: 'SG', label: t('Gravity') };
    }
    if (show.has('temperature')) second = tempText(r?.temperature);
  } else if (show.has('temperature') || (thermometer && show.has('gravity'))) big = tempBig();

  const brew = !thermometer ? pill.brew : null;
  let brewInfo: BrewInfo | null = null;
  if (brew) {
    const p = fermentProgress(brew);
    brewInfo = {
      name: brew.name,
      day: t('Day {n}', { n: Math.max(1, Math.floor((now - brew.startedAt) / DAY) + 1) }),
      abv: brew.stats.abv === null ? null : t('{abv}% ABV', { abv: num(brew.stats.abv, 1) }),
      pct: p?.pct ?? null,
      og: t('OG {gravity}', { gravity: gravityText(brew.stats.og) }),
      fg: brew.targetFg
        ? t('FG {gravity}', { gravity: gravityText(p?.target ?? brew.targetFg) })
        : t('~FG {gravity}', { gravity: gravityText(p?.target ?? brew.targetFg) }),
      there: p ? t('{pct}% there', { pct: num(p.pct, 0) }) : t('Waiting for readings'),
    };
  }

  const rssi = pill.live.rssi;
  const signal =
    rssi === null || !Number.isFinite(rssi)
      ? '–'
      : rssi >= -65
        ? tc('signal', 'Excellent')
        : rssi >= -75
          ? tc('signal', 'Good')
          : rssi >= -85
            ? tc('signal', 'OK')
            : rssi >= -93
              ? tc('signal', 'Weak')
              : tc('signal', 'Very weak');
  const stats: Stat[] = thermometer
    ? [
        {
          icon: 'activity',
          label: t('Last 24 h'),
          value: d.day ? `${num(temp(d.day.min), 1)}–${num(temp(d.day.max), 1)}` : '–',
          unit: d.day ? tempUnit : undefined,
        },
        { icon: 'signal', label: t('Signal'), value: signal },
      ]
    : [
        { icon: 'percent', label: 'ABV', value: brew?.stats.abv == null ? '–' : `${num(brew.stats.abv, 1)}%` },
        {
          icon: 'activity',
          label: t('Velocity'),
          value: r?.velocity == null ? '–' : `${r.velocity > 0 ? '+' : ''}${num(r.velocity, 1)}`,
          unit: r?.velocity == null ? undefined : t('pts/day'),
        },
        {
          icon: 'battery',
          label: t('Battery'),
          value: r?.battery == null ? '–' : `${Math.round(r.battery)}%`,
          danger: r?.battery != null && r.battery < 20,
        },
        { icon: 'signal', label: t('Signal'), value: signal },
      ];

  let chartInput: ChartInput | null = null;
  const h = d.history;
  if (show.has('chart') && h) {
    const tempSeries = (color: string, minSpan: number) => ({
      values: h.temperature.map((v) => (v === null ? null : temp(v))),
      color,
      minSpan: fahrenheit ? minSpan * 1.8 : minSpan,
      format: (v: number) => `${num(v, 0)}°`,
    });
    chartInput = thermometer
      ? { ts: h.ts, from: d.from, to: d.to, main: tempSeries(pill.color, 2) }
      : {
          ts: h.ts,
          from: d.from,
          to: d.to,
          main: {
            values: plato ? h.gravity.map((v) => (v === null ? null : sgToPlato(v))) : h.gravity,
            skip: h.implausible,
            color: pill.color,
            minSpan: plato ? 1 : 0.004,
            format: (v: number) => (plato ? num(v, 1) : num(v, 3)),
          },
          second: tempSeries(c.seriesTemp, 3),
        };
  }

  return {
    pill,
    thermometer,
    online: pill.live.online,
    status: pill.live.online ? t('Online') : t('Offline'),
    timeAgo: s.timeAgo(pill.live.lastReadingAt, now),
    big,
    second,
    implausible: !thermometer && !!r && ((r.gravity !== null && !plausibleGravity(r.gravity)) || !r.plausible),
    brewable: !thermometer,
    brew: brewInfo,
    stats,
    chart: chartInput,
  };
}

// ---------- Fitting a card ----------

type Part = 'name' | 'figure' | 'status' | 'labels' | 'big' | 'second' | 'brew' | 'progress' | 'chart' | 'stats';

/** Sizes in units of the card's base text size. */
const U = {
  pad: 1.1,
  gap: 0.8,
  name: 1.15,
  nameLine: 1.45,
  sub: 0.8,
  subLine: 1.2,
  figure: 2.8,
  label: 0.7,
  labelLine: 1.2,
  big: 2.9,
  unit: 0.4,
  second: 1.8,
  brew: 0.86,
  brewLine: 1.4,
  ferment: 4.55,
  progress: 2.15,
  scale: 0.72,
  chartMin: 3.6,
  stat: 3.15,
  statGap: 0.45,
  statMinWidth: 5.8,
};

/** Smallest base size each part is still worth showing at (px); parts are left out in this order to make room. */
const MIN_F: Partial<Record<Part, number>> = { labels: 11, figure: 9, stats: 10, progress: 9.5, chart: 6, status: 8.5, brew: 8, second: 5 };
const DROP_ORDER: Part[] = ['labels', 'figure', 'stats', 'progress', 'chart', 'status', 'brew', 'second'];
/** Parts that only decorate: leaving them out doesn't count against a layout. */
const DECORATION = new Set<Part>(['labels', 'figure']);

interface Needs {
  /** Widths at a base size of 1. */
  big: number;
  second: number;
  hasBrew: boolean;
  statCount: number;
}

interface Plan {
  f: number;
  parts: Set<Part>;
  stacked: boolean;
  statCols: number;
  grow: number;
  /** Parts asked for that didn't fit. */
  dropped: number;
}

const BIG_STYLE = (size: number): TextStyle => ({ size, weight: 800, spacing: -0.04 });
const UNIT_STYLE = (size: number): TextStyle => ({ size: size * U.unit, weight: 600 });
const SECOND_STYLE = (size: number): TextStyle => ({ size, weight: 700, spacing: -0.03 });

function bigWidth(m: TextMeasure, b: Big, size: number): number {
  const unit = b.unit ? m.width(b.unit, UNIT_STYLE(size)) + size * U.unit * 0.3 : 0;
  return m.width(b.main + b.tail, BIG_STYLE(size)) + unit;
}

function heightUnits(p: Set<Part>, stacked: boolean, statCols: number, grow: number, needs: Needs): number {
  const sections: number[] = [];
  if (p.has('name')) sections.push(Math.max(p.has('figure') ? U.figure : 0, U.nameLine + (p.has('status') ? U.subLine : 0)));
  if (p.has('big')) {
    let h = (p.has('labels') ? U.labelLine : 0) + U.big * grow;
    if (p.has('second') && stacked) h += U.gap * 0.35 + U.second * grow * 1.05;
    sections.push(h);
  }
  const brew = p.has('brew');
  const progress = p.has('progress') && needs.hasBrew;
  if (brew || progress) sections.push(brew && progress ? U.ferment : brew ? U.brewLine : U.progress);
  if (p.has('chart')) sections.push(U.chartMin);
  if (p.has('stats')) {
    const rows = Math.ceil(needs.statCount / statCols);
    sections.push(rows * U.stat + (rows - 1) * U.statGap);
  }
  if (p.has('status') && !p.has('name')) sections.push(U.subLine);
  return 2 * U.pad + sections.reduce((a, b) => a + b, 0) + U.gap * Math.max(0, sections.length - 1);
}

function widthUnits(p: Set<Part>, stacked: boolean, statCols: number, grow: number, needs: Needs): number {
  let w = 4;
  if (p.has('big')) {
    const big = needs.big * U.big * grow;
    const second = p.has('second') ? needs.second * U.second * grow : 0;
    w = Math.max(w, stacked ? Math.max(big, second + U.second * grow * 1.0) : big + (second ? 1.2 + second : 0));
  }
  if (p.has('name')) w = Math.max(w, (p.has('figure') ? U.figure + 0.7 : 0) + 4);
  if (p.has('stats')) w = Math.max(w, statCols * U.statMinWidth + (statCols - 1) * U.statGap);
  return 2 * U.pad + w;
}

function bestArrangement(w: number, h: number, parts: Set<Part>, needs: Needs): Omit<Plan, 'dropped'> {
  let best: Omit<Plan, 'dropped'> | null = null;
  for (const stacked of parts.has('second') ? [false, true] : [false]) {
    for (const statCols of parts.has('stats') ? [Math.min(4, needs.statCount), 2] : [4]) {
      const f = Math.min(h / heightUnits(parts, stacked, statCols, 1, needs), w / widthUnits(parts, stacked, statCols, 1, needs));
      if (!best || f > best.f + 1e-6) best = { f, parts: new Set(parts), stacked, statCols, grow: 1 };
    }
  }
  return best!;
}

function fitCard(w: number, h: number, wanted: Set<Part>, needs: Needs): Plan {
  const parts = new Set(wanted);
  let plan = bestArrangement(w, h, parts, needs);
  for (;;) {
    const victim = DROP_ORDER.find((p) => parts.has(p) && plan.f < (MIN_F[p] ?? 0));
    if (!victim) break;
    parts.delete(victim);
    plan = bestArrangement(w, h, parts, needs);
  }
  // Without a chart to take the spare height, the readings grow into it.
  if (!parts.has('chart') && parts.has('big')) {
    let grow = 1;
    for (let g = 1.6; g > 1; g -= 0.05) {
      if (
        heightUnits(parts, plan.stacked, plan.statCols, g, needs) * plan.f <= h &&
        widthUnits(parts, plan.stacked, plan.statCols, g, needs) * plan.f <= w
      ) {
        grow = g;
        break;
      }
    }
    plan.grow = grow;
  }
  const dropped = [...wanted].filter((p) => !parts.has(p) && !DECORATION.has(p)).length;
  return { ...plan, dropped };
}

// ---------- Drawing ----------

interface Draw {
  defs: Defs;
  c: ScreenColors;
  m: TextMeasure;
  s: ScreenStrings;
  theme: ScreenOptions['theme'];
}

const blur = (d: Draw, std: number) =>
  d.defs.add(
    'bl',
    (id) => `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${n(std)}"/></filter>`,
  );

function gradient(d: Draw, css: string, vertical = false): string {
  const stops = gradientStops(css)
    .map((st) => `<stop offset="${n(st.offset)}" ${paint('stop-color', st.color)}/>`)
    .join('');
  const id = d.defs.add('ag', (id) => `<linearGradient id="${id}" x1="0" y1="0" x2="${vertical ? 0 : 1}" y2="1">${stops}</linearGradient>`);
  return `url(#${id})`;
}

function statusDot(d: Draw, cx: number, cy: number, r: number, on: boolean): string {
  if (!on) return `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" ${paint('fill', d.c.faint)}/>`;
  const glow = d.defs.add(
    'dg',
    (id) =>
      `<radialGradient id="${id}"><stop offset="0.3" ${paint('stop-color', d.c.success, 0.55)}/><stop offset="1" ${paint('stop-color', d.c.success, 0)}/></radialGradient>`,
  );
  return (
    `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r * 2.4)}" fill="url(#${glow})"/>` +
    `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" ${paint('fill', d.c.success)}/>`
  );
}

/** A panel like the app's: a soft shadow, the glassy surface, a hairline border and the device's colour glowing in a corner. */
function panel(d: Draw, x: number, y: number, w: number, h: number, radius: number, f: number, color: string | null): string {
  let out = '';
  if (f >= 6) {
    // A soft shadow from a few widening, fading layers: a blur filter looks the same here but costs ten times as much
    // to draw, which matters on a Pi.
    const layers = 5;
    const step = f * 0.22;
    const color = d.theme === 'dark' ? '#000000' : d.c.text;
    const total = d.theme === 'dark' ? 0.4 : 0.1;
    for (let i = layers; i >= 1; i--) {
      const grow = step * i;
      out += `<rect x="${n(x + f * 0.25 - grow)}" y="${n(y + f * 0.55 - grow * 0.6)}" width="${n(w - f * 0.5 + grow * 2)}" height="${n(h - f * 0.2 + grow * 1.6)}" rx="${n(radius + grow)}" ${paint('fill', color, total / layers)}/>`;
    }
  }
  // The surface is see-through in the app; over the background here it's drawn solid so the shadow doesn't show through.
  const surface = parseColor(d.c.surface);
  out += `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(radius)}" ${paint('fill', d.c.bg)}/>`;
  out += `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(radius)}" ${paint('fill', d.c.surface)}/>`;
  if (color) {
    const glow = d.defs.add(
      'pg',
      (id) =>
        `<radialGradient id="${id}" cx="1" cy="0" r="0.8"><stop offset="0" ${paint('stop-color', color, surface.a > 0.7 && d.theme === 'light' ? 0.2 : 0.26)}/><stop offset="0.75" ${paint('stop-color', color, 0)}/></radialGradient>`,
    );
    out += `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(radius)}" fill="url(#${glow})"/>`;
  }
  const stroke = Math.max(1, f * 0.07);
  out += `<rect x="${n(x + stroke / 2)}" y="${n(y + stroke / 2)}" width="${n(w - stroke)}" height="${n(h - stroke)}" rx="${n(radius - stroke / 2)}" fill="none" ${paint('stroke', d.c.border)} stroke-width="${n(stroke)}"/>`;
  return out;
}

const saturate = (d: Draw) => d.defs.add('sat', (id) => `<filter id="${id}"><feColorMatrix type="saturate" values="0.6"/></filter>`);

function bigValue(d: Draw, ct: Content, b: Big, x: number, baseline: number, size: number): string {
  const fill = d.defs.add(
    'bv',
    (id) =>
      `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0.1" ${paint('stop-color', d.c.text)}/><stop offset="1" ${paint('stop-color', mix(d.c.text, ct.pill.color, 0.82))}/></linearGradient>`,
  );
  const unitSize = size * U.unit;
  const inner =
    esc(b.main) +
    (b.tail ? tspan(b.tail, 'fill-opacity="0.55"') : '') +
    (b.unit
      ? tspan(
          b.unit,
          `font-size="${n(unitSize)}" font-weight="600" letter-spacing="0" dx="${n(unitSize * 0.3)}" ${paint('fill', d.c.muted)}`,
        )
      : '');
  return text(x, baseline, '', { ...BIG_STYLE(size), fill: `url(#${fill})` }, inner);
}

function smallCaps(d: Draw, x: number, y: number, label: string, size: number, anchor: 'start' | 'end' = 'start'): string {
  return text(x, y, label.toLocaleUpperCase(d.s.locale), { size, weight: 700, spacing: 0.08, fill: d.c.faint, anchor });
}

/** One device as a card, laid out by `plan`. */
function card(d: Draw, ct: Content, x: number, y: number, w: number, h: number, plan: Plan): string {
  const { f, parts } = plan;
  const g = plan.grow;
  const pad = U.pad * f;
  const x0 = x + pad;
  const iw = w - 2 * pad;
  const radius = Math.min(f * 1.35, Math.min(w, h) * 0.12);

  // The sections this card has, top to bottom, with their heights.
  type Block = { kind: 'head' | 'readings' | 'brew' | 'chart' | 'stats' | 'footer'; h: number };
  const blocks: Block[] = [];
  const has = (p: Part) => parts.has(p);
  if (has('name'))
    blocks.push({ kind: 'head', h: f * Math.max(has('figure') ? U.figure : 0, U.nameLine + (has('status') ? U.subLine : 0)) });
  const second = has('second') && ct.second !== null;
  if (has('big') && ct.big) {
    let bh = (has('labels') ? U.labelLine : 0) + U.big * g;
    if (second && plan.stacked) bh += U.gap * 0.35 + U.second * g * 1.05;
    blocks.push({ kind: 'readings', h: bh * f });
  }
  const showBrew = has('brew') && ct.brewable;
  const showProgress = has('progress') && ct.brew !== null;
  if (showBrew || showProgress)
    blocks.push({ kind: 'brew', h: f * (showBrew && showProgress && ct.brew ? U.ferment : showBrew ? U.brewLine : U.progress) });
  if (has('chart') && ct.chart) blocks.push({ kind: 'chart', h: U.chartMin * f });
  if (has('stats')) {
    const cols = Math.min(plan.statCols, ct.stats.length);
    const rows = Math.ceil(ct.stats.length / cols);
    blocks.push({ kind: 'stats', h: f * (rows * U.stat + (rows - 1) * U.statGap) });
  }
  if (has('status') && !has('name')) blocks.push({ kind: 'footer', h: U.subLine * f });

  const used = blocks.reduce((a, b) => a + b.h, 0) + U.gap * f * Math.max(0, blocks.length - 1);
  const spare = Math.max(0, h - 2 * pad - used);
  const chartBlock = blocks.find((b) => b.kind === 'chart');
  let extraGap = 0;
  let top = y + pad;
  if (chartBlock) chartBlock.h += spare;
  else if (blocks.length > 1) extraGap = spare / (blocks.length - 1);
  else top += spare / 2;

  let out = panel(d, x, y, w, h, radius, f, ct.pill.color);
  for (const b of blocks) {
    switch (b.kind) {
      case 'head':
        out += head(d, ct, x0, top, iw, b.h, f, has('figure'), has('status'));
        break;
      case 'readings':
        out += readings(d, ct, x0, top, iw, f, g, has('labels'), second, plan.stacked);
        break;
      case 'brew':
        out += brewBlock(d, ct, x0, top, iw, f, showBrew, showProgress);
        break;
      case 'chart':
        out += chart(d.defs, x0, top, iw, b.h, ct.chart!, {
          f,
          faint: d.c.faint,
          grid: d.c.grid,
          empty: d.s.t('Waiting for readings'),
          measure: (label, size) => d.m.width(label, { size, weight: 600 }),
        });
        break;
      case 'stats':
        out += statsBlock(d, ct, x0, top, iw, f, plan.statCols);
        break;
      case 'footer':
        out += statusLine(d, ct, x0, top, iw, b.h, f);
        break;
    }
    top += b.h + U.gap * f + extraGap;
  }
  return ct.online ? out : `<g filter="url(#${saturate(d)})">${out}</g>`;
}

function statusLine(d: Draw, ct: Content, x: number, top: number, w: number, h: number, f: number): string {
  const size = U.sub * f;
  const r = size * 0.3;
  const cy = top + h / 2;
  const line = d.m.fit(`${ct.status} · ${ct.timeAgo}`, w - r * 2 - size * 0.45, { size, weight: 400 });
  return (
    statusDot(d, x + r, cy, r, ct.online) + text(x + r * 2 + size * 0.45, cy + size * 0.36, line, { size, weight: 400, fill: d.c.muted })
  );
}

function head(d: Draw, ct: Content, x: number, top: number, w: number, h: number, f: number, figure: boolean, status: boolean): string {
  let out = '';
  let tx = x;
  if (figure) {
    const size = U.figure * f;
    const fy = top + (h - size) / 2;
    out += ct.thermometer
      ? thermometerBadge(d.defs, x + size * 0.06, fy + size * 0.06, size * 0.88, ct.pill.color, !ct.online)
      : pillFigure(d.defs, x, fy, size, ct.pill.color, ct.pill.live.latest?.tilt, !ct.online);
    tx += size + 0.7 * f;
  }
  const tw = x + w - tx;
  const block = (U.nameLine + (status ? U.subLine : 0)) * f;
  const ty = top + (h - block) / 2;
  const nameSize = U.name * f;
  const name = d.m.fit(ct.pill.name, tw, { size: nameSize, weight: 700, spacing: -0.02 });
  out += text(tx, ty + (U.nameLine * f) / 2 + nameSize * 0.36, name, { size: nameSize, weight: 700, spacing: -0.02, fill: d.c.text });
  if (status) out += statusLine(d, ct, tx, ty + U.nameLine * f, tw, U.subLine * f, f);
  return out;
}

function readings(
  d: Draw,
  ct: Content,
  x: number,
  top: number,
  w: number,
  f: number,
  g: number,
  labels: boolean,
  second: boolean,
  stacked: boolean,
): string {
  const b = ct.big!;
  let out = '';
  const labelSize = U.label * f;
  if (labels) {
    out += smallCaps(d, x, top + labelSize * 1.05, b.label, labelSize);
    if (second && !stacked) out += smallCaps(d, x + w, top + labelSize * 1.05, d.s.t('Temperature'), labelSize, 'end');
    top += U.labelLine * f;
  }
  const size = U.big * f * g;
  const base = top + size * 0.86;
  out += bigValue(d, ct, b, x, base, size);
  if (ct.implausible) {
    const iconSize = Math.max(8, size * U.unit);
    const at = x + bigWidth(d.m, b, size) + iconSize * 0.4;
    const secondW = second && !stacked ? d.m.width(ct.second!, SECOND_STYLE(U.second * f * g)) + f : 0;
    if (at + iconSize <= x + w - secondW) out += icon('alert', at, base - iconSize, iconSize, d.c.warning);
  }
  if (second) {
    const s2 = U.second * f * g;
    if (stacked) {
      const rowTop = top + size + U.gap * 0.35 * f;
      const rowBase = rowTop + s2 * 0.86;
      const iconSize = s2 * 0.8;
      out += icon('thermometer', x - iconSize * 0.12, rowBase - s2 * 0.78, iconSize, d.c.muted, 2.2);
      out += text(x + iconSize * 0.95, rowBase, ct.second!, { ...SECOND_STYLE(s2), fill: d.c.text });
    } else {
      out += text(x + w, base, ct.second!, { ...SECOND_STYLE(s2), fill: d.c.text, anchor: 'end' });
    }
  }
  return out;
}

function bar(d: Draw, x: number, y: number, w: number, h: number, pct: number | null): string {
  let out = `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" rx="${n(h / 2)}" ${paint('fill', d.c.surface3)}/>`;
  if (pct !== null && pct > 0) {
    const fw = Math.max(h, (w * pct) / 100);
    out += `<rect x="${n(x)}" y="${n(y)}" width="${n(fw)}" height="${n(h)}" rx="${n(h / 2)}" fill="${gradient(d, d.c.accent)}"/>`;
  }
  return out;
}

function brewBlock(d: Draw, ct: Content, x: number, top: number, w: number, f: number, showBrew: boolean, showProgress: boolean): string {
  const brew = ct.brew;
  const size = U.brew * f;
  const scaleSize = U.scale * f;
  let out = '';
  const topLine = (lx: number, cy: number, lw: number) => {
    let line = '';
    const iconSize = size * 1.1;
    line += icon('beer', lx, cy - iconSize / 2, iconSize, d.c.violet2);
    const tx = lx + iconSize + size * 0.4;
    if (!brew)
      return (
        line +
        text(tx, cy + size * 0.36, d.m.fit(d.s.t('No brew running'), lx + lw - tx, { size, weight: 600 }), {
          size,
          weight: 600,
          fill: d.c.muted,
        })
      );
    // The day and ABV on the right when they fit beside the name, else just the day.
    const rightOptions = [[brew.day, brew.abv].filter(Boolean).join(' · '), brew.day];
    const right = rightOptions.find((r) => d.m.width(r, { size, weight: 700 }) < lw * 0.55) ?? '';
    const rw = right ? d.m.width(right, { size, weight: 700 }) : 0;
    if (right) line += text(lx + lw, cy + size * 0.36, right, { size, weight: 700, fill: d.c.text, anchor: 'end' });
    const nameW = lx + lw - tx - (right ? rw + size : 0);
    line += text(tx, cy + size * 0.36, d.m.fit(brew.name, nameW, { size, weight: 600 }), { size, weight: 600, fill: d.c.text });
    return line;
  };
  const progress = (px: number, py: number, pw: number) => {
    let p = bar(d, px, py, pw, 0.45 * f, brew?.pct ?? null);
    const sy = py + 0.45 * f + 0.4 * f + scaleSize * 0.95;
    const style = { size: scaleSize, weight: 400 as const, fill: d.c.muted };
    const there = d.m.width(brew!.there, style);
    const og = d.m.fit(brew!.og, (pw - there) / 2 - f * 0.4, style);
    const fg = d.m.fit(brew!.fg, (pw - there) / 2 - f * 0.4, style);
    p +=
      text(px, sy, og, style) +
      text(px + pw / 2, sy, brew!.there, { ...style, anchor: 'middle' }) +
      text(px + pw, sy, fg, { ...style, anchor: 'end' });
    return p;
  };
  if (showBrew && showProgress && brew) {
    const boxH = U.ferment * f;
    const ip = 0.65 * f;
    out += `<rect x="${n(x)}" y="${n(top)}" width="${n(w)}" height="${n(boxH)}" rx="${n(f * 0.85)}" fill="${gradient(d, d.c.accentSoft)}"/>`;
    out += `<rect x="${n(x)}" y="${n(top)}" width="${n(w)}" height="${n(boxH)}" rx="${n(f * 0.85)}" fill="none" ${paint('stroke', d.c.borderStrong)} stroke-width="${n(Math.max(1, f * 0.07))}"/>`;
    out += topLine(x + ip, top + ip + 0.6 * f, w - 2 * ip);
    out += progress(x + ip, top + ip + 1.55 * f, w - 2 * ip);
  } else if (showBrew) out += topLine(x, top + (U.brewLine * f) / 2, w);
  else if (brew) out += progress(x, top + 0.1 * f, w);
  return out;
}

function statsBlock(d: Draw, ct: Content, x: number, top: number, w: number, f: number, statCols: number): string {
  const cols = Math.min(statCols, ct.stats.length);
  const gap = U.statGap * f;
  const bw = (w - gap * (cols - 1)) / cols;
  const bh = U.stat * f;
  const labelSize = 0.62 * f;
  const valueSize = 1.0 * f;
  let out = '';
  ct.stats.forEach((st, i) => {
    const bx = x + (i % cols) * (bw + gap);
    const by = top + Math.floor(i / cols) * (bh + gap);
    out += `<rect x="${n(bx)}" y="${n(by)}" width="${n(bw)}" height="${n(bh)}" rx="${n(f * 0.6)}" ${paint('fill', d.c.surface2)}/>`;
    out += `<rect x="${n(bx)}" y="${n(by)}" width="${n(bw)}" height="${n(bh)}" rx="${n(f * 0.6)}" fill="none" ${paint('stroke', d.c.border)} stroke-width="${n(Math.max(1, f * 0.06))}"/>`;
    const ip = 0.55 * f;
    const iconSize = labelSize * 1.15;
    const ly = by + ip + labelSize * 0.9;
    out += icon(st.icon, bx + ip, ly - iconSize * 0.85, iconSize, d.c.faint, 2.4);
    const lx = bx + ip + iconSize + labelSize * 0.35;
    const labelStyle = { size: labelSize, weight: 600 as const, spacing: 0.05 };
    out += text(lx, ly, d.m.fit(st.label.toLocaleUpperCase(d.s.locale), bx + bw - ip - lx, labelStyle), { ...labelStyle, fill: d.c.faint });
    const vy = by + bh - ip - valueSize * 0.22;
    const vw = bw - 2 * ip;
    const unitSize = valueSize * 0.62;
    const unitW = st.unit ? d.m.width(st.unit, { size: unitSize, weight: 600 }) + unitSize * 0.3 : 0;
    const withUnit = st.unit !== undefined && unitW < vw * 0.45;
    const value = d.m.fit(st.value, vw - (withUnit ? unitW : 0), { size: valueSize, weight: 700 });
    const inner =
      esc(value) +
      (withUnit
        ? tspan(st.unit!, `font-size="${n(unitSize)}" font-weight="600" dx="${n(unitSize * 0.3)}" ${paint('fill', d.c.muted)}`)
        : '');
    out += text(bx + ip, vy, '', { size: valueSize, weight: 700, fill: st.danger ? d.c.danger : d.c.text }, inner);
  });
  return out;
}

// ---------- Compact rows (many devices on a small or wide screen) ----------

const R = {
  padY: 0.55,
  padX: 0.85,
  swatch: 0.32,
  name: 1.05,
  nameLine: 1.35,
  subLine: 1.15,
  big: 1.9,
  second: 1.25,
  sparkMin: 4,
  sparkGap: 0.9,
};

interface RowPlan {
  f: number;
  sub: boolean;
  /** Width of the name column (px); a sparkline, if any, takes the space between it and the values. */
  textW: number;
  spark: boolean;
  dropped: number;
  bigW: number;
  secondW: number;
}

const NAME_STYLE = (f: number): TextStyle => ({ size: R.name * f, weight: 700, spacing: -0.02 });
const SUB_STYLE = (f: number): TextStyle => ({ size: U.sub * f, weight: 400 });

/** The line under a row's name: the brew and its day, else when the last reading came (the dot says online or not). */
function rowSub(ct: Content, show: Set<string>, s: ScreenStrings): string {
  if (show.has('brew') && ct.brewable) return ct.brew ? `${ct.brew.name} · ${ct.brew.day}` : s.t('No brew');
  return show.has('status') ? ct.timeAgo : '';
}

function fitRows(w: number, h: number, count: number, gap: number, contents: Content[], opts: ScreenOptions, d: Draw): RowPlan {
  const { m } = d;
  const show = new Set<string>(opts.show);
  const sub = show.has('status') || (show.has('brew') && contents.some((c) => c.brewable));
  const rh = (h - gap * (count - 1)) / count;
  const hUnits = 2 * R.padY + Math.max(R.nameLine + (sub ? R.subLine : 0), R.big);
  const bigW = Math.max(0, ...contents.map((c) => (c.big ? bigWidth(m, c.big, 1) : 0)));
  const secondW = Math.max(0, ...contents.map((c) => (c.second ? m.width(c.second, SECOND_STYLE(1)) : 0)));
  const values = bigW * R.big + (secondW ? 1.1 + secondW * R.second : 0);
  const wUnits = 2 * R.padX + R.swatch + 0.75 + 5 + 1.2 + values;
  const f = Math.min(rh / hUnits, w / wUnits);
  // The same name column on every row, as wide as the longest name or sub line needs if there's room for it.
  const room = w - (2 * R.padX + R.swatch + 0.75 + 1.2 + values) * f;
  const natural = Math.max(
    ...contents.map((c) =>
      Math.max(m.width(c.pill.name, NAME_STYLE(f)), sub ? m.width(rowSub(c, show, d.s), SUB_STYLE(f)) + U.sub * f * 1.1 : 0),
    ),
  );
  const charts = show.has('chart') && contents.some((c) => c.chart);
  // Text gets what it needs if a sparkline still fits beside it; else at least half the room, the sparkline the rest
  // when that's wide enough to read.
  const sparkNeeds = (R.sparkMin + R.sparkGap) * f;
  const textW = room - natural >= sparkNeeds ? natural : Math.max(room * 0.55, room - sparkNeeds);
  const spark = charts && room - textW >= sparkNeeds;
  const dropped = (['progress', 'stats'] as const).filter((p) => show.has(p)).length + (charts && !spark ? 1 : 0);
  return { f, sub, textW: spark ? textW : room, spark, dropped, bigW, secondW };
}

function row(d: Draw, ct: Content, x: number, y: number, w: number, h: number, plan: RowPlan, opts: ScreenOptions): string {
  const { f } = plan;
  const show = new Set<string>(opts.show);
  let out = panel(d, x, y, w, h, Math.min(f * 0.9, h * 0.3), f, null);
  const px = x + R.padX * f;
  const sw = R.swatch * f;
  const sh = h - 2 * R.padY * f;
  const swGlow = blur(d, Math.max(1, f * 0.4));
  out += `<rect x="${n(px)}" y="${n(y + R.padY * f)}" width="${n(sw)}" height="${n(sh)}" rx="${n(sw / 2)}" ${paint('fill', ct.pill.color, 0.6)} filter="url(#${swGlow})"/>`;
  out += `<rect x="${n(px)}" y="${n(y + R.padY * f)}" width="${n(sw)}" height="${n(sh)}" rx="${n(sw / 2)}" ${paint('fill', ct.pill.color)}/>`;

  // Values on the right, in columns shared by every row.
  const right = x + w - R.padX * f;
  const cy = y + h / 2;
  const secondSize = R.second * f;
  const bigSize = R.big * f;
  const bigRight = plan.secondW ? right - plan.secondW * secondSize - 1.1 * f : right;
  if (ct.second) out += text(right, cy + secondSize * 0.36, ct.second, { ...SECOND_STYLE(secondSize), fill: d.c.text, anchor: 'end' });
  if (ct.big) out += bigValue(d, ct, ct.big, bigRight - bigWidth(d.m, ct.big, bigSize), cy + bigSize * 0.36, bigSize);
  const valuesLeft = bigRight - plan.bigW * bigSize;

  // The name and its sub line on the left; a sparkline between them and the values when there's room.
  const nx = px + sw + 0.75 * f;
  if (plan.spark && ct.chart) {
    const sx = nx + plan.textW + R.sparkGap * f;
    out += chart(
      d.defs,
      sx,
      y + R.padY * f * 1.2,
      valuesLeft - 1.2 * f - sx,
      h - 2.4 * R.padY * f,
      { ...ct.chart, second: undefined },
      { f: f * 0.8, faint: d.c.faint, grid: d.c.grid, empty: '', measure: () => 0, bare: true },
    );
  }
  const nameStyle = NAME_STYLE(f);
  const subStyle = SUB_STYLE(f);
  const blockH = (R.nameLine + (plan.sub ? R.subLine : 0)) * f;
  const ty = cy - blockH / 2;
  out += text(nx, ty + (R.nameLine * f) / 2 + nameStyle.size * 0.36, d.m.fit(ct.pill.name, plan.textW, nameStyle), {
    ...nameStyle,
    fill: d.c.text,
  });
  if (plan.sub) {
    const scy = ty + R.nameLine * f + (R.subLine * f) / 2;
    const r = subStyle.size * 0.3;
    let sx = nx;
    if (show.has('status')) {
      out += statusDot(d, nx + r, scy, r, ct.online);
      sx += r * 2 + subStyle.size * 0.45;
    }
    const line = rowSub(ct, show, d.s) || ct.status;
    out += text(sx, scy + subStyle.size * 0.36, d.m.fit(line, nx + plan.textW - sx, subStyle), { ...subStyle, fill: d.c.muted });
  }
  return ct.online ? out : `<g filter="url(#${saturate(d)})">${out}</g>`;
}

// ---------- The whole picture ----------

function background(d: Draw, w: number, h: number): string {
  const glow = (cx: number, cy: number, r: number, color: string) => {
    const id = d.defs.add(
      'bg',
      (id) =>
        `<radialGradient id="${id}" cx="${cx}" cy="${cy}" r="${r}"><stop offset="0" ${paint('stop-color', color)}/><stop offset="0.6" ${paint('stop-color', color, 0)}/></radialGradient>`,
    );
    return `<rect width="${w}" height="${h}" fill="url(#${id})"/>`;
  };
  return (
    `<rect width="${w}" height="${h}" ${paint('fill', d.c.bg)}/>` +
    glow(0.08, -0.1, 0.9, d.c.glow1) +
    glow(1.05, 0.1, 0.85, d.c.glow2) +
    glow(0.5, 1.2, 0.75, d.c.glow3)
  );
}

function header(d: Draw, hub: string, now: number, x: number, y: number, w: number, hh: number): string {
  const size = hh * 0.6;
  const iconSize = hh * 0.92;
  const clock = d.s.time(now);
  const clockStyle = { size: hh * 0.6, weight: 700 as const, spacing: -0.01 };
  const clockW = d.m.width(clock, clockStyle);
  let out = appIcon(d.defs, x, y + (hh - iconSize) / 2, iconSize);
  const nameX = x + iconSize + hh * 0.35;
  const nameStyle = { size, weight: 800 as const, spacing: -0.02 };
  const name = d.m.fit(hub, x + w - clockW - hh * 0.6 - nameX, nameStyle);
  out += text(nameX, y + hh / 2 + size * 0.36, name, { ...nameStyle, fill: gradient(d, d.c.accent) });
  out += text(x + w, y + hh / 2 + clockStyle.size * 0.36, clock, { ...clockStyle, fill: d.c.muted, anchor: 'end' });
  return out;
}

function message(d: Draw, x: number, y: number, w: number, h: number, title: string, body: string): string {
  const size = Math.max(10, Math.min(w / 16, h / 6));
  const titleStyle = { size, weight: 700 as const, spacing: -0.02 };
  const bodyStyle = { size: size * 0.6, weight: 400 as const };
  return (
    text(x + w / 2, y + h / 2 - size * 0.1, d.m.fit(title, w * 0.9, titleStyle), { ...titleStyle, fill: d.c.text, anchor: 'middle' }) +
    text(x + w / 2, y + h / 2 + size * 1.0, d.m.fit(body, w * 0.9, bodyStyle), { ...bodyStyle, fill: d.c.muted, anchor: 'middle' })
  );
}

/** The SVG for a screen image. */
export function renderScreen(scene: ScreenScene, opts: ScreenOptions, ctx: RenderContext): string {
  const { width: W, height: H } = opts;
  const c = SCREEN_COLORS[opts.palette][opts.theme];
  const d: Draw = { defs: new Defs(), c, m: ctx.measure, s: ctx.strings, theme: opts.theme };
  const { t } = ctx.strings;
  const show = new Set(opts.show);

  let body = background(d, W, H);
  const P = Math.max(4, Math.min(28, Math.min(W, H) * 0.035));
  let top = P;
  if (show.has('header')) {
    const hh = Math.max(14, Math.min(72, Math.min(W, H) * 0.08));
    body += header(d, scene.hubName, scene.now, P, P, W - 2 * P, hh);
    top = P + hh + P * 0.8;
  }
  const area = { x: P, y: top, w: W - 2 * P, h: H - top - P };
  const contents = scene.devices.map((dev) => describe(dev, opts, ctx.strings, c, scene.now));

  if (contents.length === 0) {
    body += scene.single
      ? message(d, area.x, area.y, area.w, area.h, t('Pill not found'), t('It may have been removed.'))
      : scene.brewingOnly
        ? message(d, area.x, area.y, area.w, area.h, t('No brews on the go'), t("Start a brew from a pill's page to track it here."))
        : message(d, area.x, area.y, area.w, area.h, t('No pills yet'), t('Add a pill on the dashboard and its readings show up here.'));
  } else {
    const wanted = new Set<Part>();
    if (show.has('name')) wanted.add('name').add('figure');
    if (show.has('status')) wanted.add('status');
    if (contents.some((ct) => ct.big)) wanted.add('big').add('labels');
    if (contents.some((ct) => ct.second)) wanted.add('second');
    if (show.has('brew') && contents.some((ct) => ct.brewable)) wanted.add('brew');
    if (show.has('progress') && contents.some((ct) => ct.brew)) wanted.add('progress');
    if (show.has('chart') && contents.some((ct) => ct.chart)) wanted.add('chart');
    if (show.has('stats')) wanted.add('stats');
    const needs: Needs = {
      big: Math.max(0, ...contents.map((ct) => (ct.big ? bigWidth(d.m, ct.big, 1) : 0))),
      second: Math.max(0, ...contents.map((ct) => (ct.second ? d.m.width(ct.second, SECOND_STYLE(1)) : 0))),
      hasBrew: contents.some((ct) => ct.brew),
      statCount: Math.max(...contents.map((ct) => ct.stats.length)),
    };
    const gap = P;
    const count = contents.length;
    // Every grid shape, and compact rows, scored on text size and on leaving nothing out.
    const score = (f: number, dropped: number, empty: number) => Math.min(f, 18) * (1 - 0.15 * dropped) * (1 - 0.02 * empty);
    let best: { score: number; draw: () => string } | null = null;
    for (let cols = 1; cols <= count; cols++) {
      const rows = Math.ceil(count / cols);
      if (cols > 1 && Math.ceil(count / (cols - 1)) === rows) continue;
      const tw = (area.w - gap * (cols - 1)) / cols;
      const th = (area.h - gap * (rows - 1)) / rows;
      if (tw < 8 || th < 8) continue;
      const plan = fitCard(tw, th, wanted, needs);
      const sc = score(plan.f, plan.dropped, cols * rows - count);
      if (!best || sc > best.score + 1e-6) {
        best = {
          score: sc,
          draw: () =>
            contents
              .map((ct, i) => card(d, ct, area.x + (i % cols) * (tw + gap), area.y + Math.floor(i / cols) * (th + gap), tw, th, plan))
              .join(''),
        };
      }
    }
    if (count > 1) {
      const rowGap = gap * 0.6;
      const plan = fitRows(area.w, area.h, count, rowGap, contents, opts, d);
      const rh = (area.h - rowGap * (count - 1)) / count;
      const sc = score(plan.f, plan.dropped, 0);
      if (!best || sc > best.score + 1e-6) {
        best = {
          score: sc,
          draw: () => contents.map((ct, i) => row(d, ct, area.x, area.y + i * (rh + rowGap), area.w, rh, plan, opts)).join(''),
        };
      }
    }
    body += best?.draw() ?? '';
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${d.defs.toString()}${body}</svg>`;
}
