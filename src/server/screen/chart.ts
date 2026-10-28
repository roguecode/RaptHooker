import { type Defs, n, text } from './svg.js';
import { paint } from './palette.js';

/** The gravity (or a thermometer's temperature) over time as a filled line, with the temperature as a faint dashed one. */

export interface ChartSeries {
  values: (number | null)[];
  /** Points to leave out without breaking the line (the pill wasn't floating). */
  skip?: (boolean | null)[];
  color: string;
  /** Smallest range shown, so sensor noise on a flat line isn't blown up. */
  minSpan: number;
  format: (v: number) => string;
}

export interface ChartInput {
  ts: number[];
  from: number;
  to: number;
  main: ChartSeries;
  second?: ChartSeries;
}

interface Built {
  line: string;
  area: string;
  min: number;
  max: number;
  y: (v: number) => number;
}

function build(
  ts: number[],
  s: ChartSeries,
  from: number,
  to: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
  pad: number,
): Built | null {
  const usable = (i: number) => s.skip?.[i] !== true;
  let min = Infinity;
  let max = -Infinity;
  let count = 0;
  for (let i = 0; i < s.values.length; i++) {
    const v = s.values[i];
    if (v === null || v === undefined || !usable(i)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
    count++;
  }
  if (count < 2) return null;
  const span = Math.max(s.minSpan, 1e-6);
  if (max - min < span) {
    const mid = (min + max) / 2;
    min = mid - span / 2;
    max = mid + span / 2;
  }
  const xOf = (t: number) => x0 + ((t - from) / Math.max(1, to - from)) * w;
  const y = (v: number) => y0 + pad + (1 - (v - min) / (max - min)) * (h - pad * 2);
  const bottom = y0 + h;
  let line = '';
  let area = '';
  let segStart: number | null = null;
  let lastX = 0;
  for (let i = 0; i < s.values.length; i++) {
    const v = s.values[i];
    if (v !== null && v !== undefined && !usable(i)) continue;
    if (v === null || v === undefined) {
      if (segStart !== null) area += `L${n(lastX)},${n(bottom)}L${n(segStart)},${n(bottom)}Z`;
      segStart = null;
      continue;
    }
    const px = xOf(ts[i]!);
    const py = y(v);
    const cmd = segStart === null ? 'M' : 'L';
    line += `${cmd}${n(px)},${n(py)}`;
    area += `${cmd}${n(px)},${n(py)}`;
    if (segStart === null) segStart = px;
    lastX = px;
  }
  if (segStart !== null) area += `L${n(lastX)},${n(bottom)}L${n(segStart)},${n(bottom)}Z`;
  return { line, area, min, max, y };
}

export interface ChartStyle {
  /** The tile's base text size. */
  f: number;
  faint: string;
  grid: string;
  empty: string;
  /** Width of a label in the chart's label style. */
  measure: (label: string, size: number) => number;
  /** Leave out the axis labels and grid even when there's room (sparklines). */
  bare?: boolean;
}

/** Draws the chart into the box x, y, w, h. */
export function chart(defs: Defs, x: number, y: number, w: number, h: number, input: ChartInput, style: ChartStyle): string {
  const { f } = style;
  const labelSize = Math.max(6, f * 0.64);
  // Axis labels only when there's room for them to be read.
  const axes = !style.bare && w >= f * 16 && h >= f * 3.2;
  let gutterL = 0;
  let gutterR = 0;
  const probe = build(input.ts, input.main, input.from, input.to, 0, 0, 1, 1, 0);
  const probe2 = input.second ? build(input.ts, input.second, input.from, input.to, 0, 0, 1, 1, 0) : null;
  if (!probe) {
    if (h < f * 1.4) return '';
    return text(x + w / 2, y + h / 2 + labelSize * 0.36, style.empty, {
      size: Math.max(7, f * 0.78),
      weight: 600,
      fill: style.faint,
      anchor: 'middle',
    });
  }
  const mainLabels = axes ? [input.main.format(probe.max), input.main.format(probe.min)] : [];
  const secondLabels = axes && probe2 && input.second ? [input.second.format(probe2.max), input.second.format(probe2.min)] : [];
  const widest = (labels: string[]) => Math.max(...labels.map((l) => style.measure(l, labelSize)));
  if (mainLabels.length) gutterL = widest(mainLabels) + f * 0.5;
  if (secondLabels.length) gutterR = widest(secondLabels) + f * 0.5;
  const px = x + gutterL;
  const pw = Math.max(1, w - gutterL - gutterR);
  const pad = Math.max(2, h * 0.08);
  const main = build(input.ts, input.main, input.from, input.to, px, y, pw, h, pad)!;
  const second = input.second ? build(input.ts, input.second, input.from, input.to, px, y, pw, h, pad + h * 0.06) : null;

  let out = '';
  if (axes) {
    const stroke = Math.max(1, f * 0.06);
    for (const v of [main.max, (main.max + main.min) / 2, main.min]) {
      const gy = n(main.y(v));
      out += `<path d="M${n(px)},${gy}H${n(px + pw)}" ${paint('stroke', style.grid)} stroke-width="${n(stroke)}"/>`;
    }
    const at = (yy: number) => yy + labelSize * 0.36;
    out += text(px - f * 0.4, at(main.y(main.max)), mainLabels[0]!, { size: labelSize, weight: 600, fill: style.faint, anchor: 'end' });
    out += text(px - f * 0.4, at(main.y(main.min)), mainLabels[1]!, { size: labelSize, weight: 600, fill: style.faint, anchor: 'end' });
    if (second && secondLabels.length) {
      const c = input.second!.color;
      out += text(px + pw + f * 0.4, at(second.y(second.max)), secondLabels[0]!, { size: labelSize, weight: 600, fill: c, opacity: 0.8 });
      out += text(px + pw + f * 0.4, at(second.y(second.min)), secondLabels[1]!, { size: labelSize, weight: 600, fill: c, opacity: 0.8 });
    }
  }
  const fade = defs.add(
    'cf',
    (id) =>
      `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" ${paint('stop-color', input.main.color, 0.35)}/><stop offset="1" ${paint('stop-color', input.main.color, 0)}/></linearGradient>`,
  );
  if (second?.line) {
    const dash = n(Math.max(2, f * 0.24));
    out += `<path d="${second.line}" fill="none" ${paint('stroke', input.second!.color, 0.5)} stroke-width="${n(Math.max(1, f * 0.085))}" stroke-dasharray="${dash} ${dash}" stroke-linejoin="round"/>`;
  }
  if (main.area) out += `<path d="${main.area}" fill="url(#${fade})"/>`;
  if (main.line) {
    out += `<path d="${main.line}" fill="none" ${paint('stroke', input.main.color)} stroke-width="${n(Math.max(1.3, f * 0.14))}" stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  return out;
}
