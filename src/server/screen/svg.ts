import { FONT_FAMILY, type FontWeight } from './assets.js';
import { mix, paint } from './palette.js';

/** Building blocks for the SVG a screen image is drawn from. */

export const n = (v: number): number => +v.toFixed(2);

export const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Gradients, filters and clip paths go in <defs>, each with its own id. */
export class Defs {
  private readonly items: string[] = [];
  private next = 0;

  add(prefix: string, make: (id: string) => string): string {
    const id = `${prefix}${++this.next}`;
    this.items.push(make(id));
    return id;
  }

  toString(): string {
    return this.items.length ? `<defs>${this.items.join('')}</defs>` : '';
  }
}

export interface TextOptions {
  size: number;
  weight: FontWeight;
  /** Letter spacing in em. */
  spacing?: number;
  /** A colour, or a fill="..." attribute string from paint() or url(#id). */
  fill: string;
  anchor?: 'start' | 'middle' | 'end';
  opacity?: number;
}

/** Fill attributes for a colour or a url(#gradient). */
const fillAttr = (fill: string, opacity = 1) =>
  fill.startsWith('url(') ? `fill="${fill}"${opacity < 1 ? ` fill-opacity="${opacity}"` : ''}` : paint('fill', fill, opacity);

export function textAttrs(o: TextOptions): string {
  const spacing = o.spacing ? ` letter-spacing="${n(o.spacing * o.size)}"` : '';
  const anchor = o.anchor && o.anchor !== 'start' ? ` text-anchor="${o.anchor}"` : '';
  return `font-family="${FONT_FAMILY}" font-size="${n(o.size)}" font-weight="${o.weight}"${spacing}${anchor} ${fillAttr(o.fill, o.opacity)}`;
}

/** One line of text with its baseline at y. `inner` is already-escaped markup (tspans) to use instead of `content`. */
export function text(x: number, y: number, content: string, o: TextOptions, inner?: string): string {
  return `<text x="${n(x)}" y="${n(y)}" ${textAttrs(o)}>${inner ?? esc(content)}</text>`;
}

export function tspan(content: string, attrs = ''): string {
  return `<tspan${attrs ? ` ${attrs}` : ''}>${esc(content)}</tspan>`;
}

/** The baseline that centres a line of digits and capitals of `size` on y. */
export const baseline = (centerY: number, size: number): number => centerY + size * 0.36;

/** 24×24 stroke icons from the app (components/Icon.tsx, mostly Lucide: ISC licence). */
const ICONS = {
  thermometer: '<path d="M14 4v10.54a4 4 0 1 1-4 0V4a2 2 0 0 1 4 0Z"/>',
  beer: '<path d="M17 11h1a3 3 0 0 1 0 6h-1"/><path d="M9 12v6M13 12v6"/><path d="M14 7.5c-1 0-1.44.5-3 .5s-2-.5-3-.5-1.72.5-2.5.5a2.5 2.5 0 0 1 0-5c.78 0 1.57.5 2.5.5S9.44 2 11 2s2 1.5 3 1.5 1.72-.5 2.5-.5a2.5 2.5 0 0 1 0 5c-.78 0-1.5-.5-2.5-.5Z"/><path d="M5 8v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8"/>',
  battery: '<rect x="2" y="7" width="16" height="10" rx="2"/><path d="M22 11v2"/>',
  signal: '<path d="M2 20h.01M7 20v-4M12 20v-8M17 20V8M22 4v16"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4M12 17h.01"/>',
  percent: '<path d="M19 5 5 19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  down: '<path d="m22 17-8.5-8.5-5 5L2 7"/><path d="M16 17h6v-6"/>',
};
export type IconName = keyof typeof ICONS;

/** An icon `size` pixels across with its top left corner at x, y. */
export function icon(name: IconName, x: number, y: number, size: number, color: string, strokeWidth = 2): string {
  const s = size / 24;
  return `<g transform="translate(${n(x)} ${n(y)}) scale(${n(s * 1000) / 1000})" fill="none" ${paint('stroke', color)} stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</g>`;
}

/** The app's RAPT Pill figure (components/PillFigure.tsx), floating at its tilt. */
export function pillFigure(
  defs: Defs,
  x: number,
  y: number,
  size: number,
  color: string,
  tilt: number | null | undefined,
  offline: boolean,
): string {
  const angle = tilt === null || tilt === undefined ? 30 : Math.max(0, Math.min(90, tilt));
  const body = defs.add(
    'pb',
    (id) =>
      `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity="0.9"/><stop offset="0.35" stop-color="${color}"/><stop offset="1" stop-color="#3b82f6"/></linearGradient>`,
  );
  const water = defs.add(
    'pw',
    (id) =>
      `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#60a5fa" stop-opacity="0.35"/><stop offset="1" stop-color="#60a5fa" stop-opacity="0"/></linearGradient>`,
  );
  return (
    `<g transform="translate(${n(x)} ${n(y)}) scale(${n(size / 100)})">` +
    `<rect x="2" y="56" width="96" height="42" rx="8" fill="url(#${water})"/>` +
    '<path d="M4 57c8-3 14 3 23 0s15-3 23 0 15 3 23 0 14-3 23 0" fill="none" stroke="#93c5fd" stroke-opacity="0.6" stroke-width="1.6"/>' +
    `<g transform="rotate(${n(angle)} 50 56)"${offline ? ' opacity="0.55"' : ''}>` +
    `<rect x="38" y="18" width="24" height="64" rx="12" fill="url(#${body})"/>` +
    '<rect x="42.5" y="24" width="4" height="22" rx="2" fill="#ffffff" fill-opacity="0.5"/>' +
    '<path d="M38 56h24v14a12 12 0 0 1-24 0z" fill="#1e3a8a" fill-opacity="0.35"/>' +
    '</g></g>'
  );
}

/** A RAPT Thermometer's round badge (the app's .thermo-badge). */
export function thermometerBadge(defs: Defs, x: number, y: number, size: number, color: string, offline: boolean): string {
  const fill = defs.add(
    'tb',
    (id) =>
      `<radialGradient id="${id}" cx="0.3" cy="0.25" r="0.75"><stop offset="0" stop-color="${mix(color, '#ffffff', 0.45)}"/><stop offset="0.93" stop-color="${color}"/></radialGradient>`,
  );
  const r = size / 2;
  return (
    `<g${offline ? ' opacity="0.7"' : ''}>` +
    `<circle cx="${n(x + r)}" cy="${n(y + r)}" r="${n(r)}" fill="url(#${fill})"/>` +
    icon('thermometer', x + size * 0.225, y + size * 0.225, size * 0.55, '#ffffff') +
    '</g>'
  );
}

/** The app's icon (public/icons/icon.svg). */
export function appIcon(defs: Defs, x: number, y: number, size: number): string {
  const bg = defs.add(
    'ib',
    (id) =>
      `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#241466"/><stop offset="1" stop-color="#0b1b52"/></linearGradient>`,
  );
  const pill = defs.add(
    'ip',
    (id) =>
      `<linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#d8ccff"/><stop offset=".45" stop-color="#8b5cf6"/><stop offset="1" stop-color="#3b82f6"/></linearGradient>`,
  );
  const glow = defs.add(
    'ig',
    (id) =>
      `<radialGradient id="${id}" cx=".3" cy=".25" r=".8"><stop offset="0" stop-color="#8b5cf6" stop-opacity=".55"/><stop offset="1" stop-color="#8b5cf6" stop-opacity="0"/></radialGradient>`,
  );
  return (
    `<g transform="translate(${n(x)} ${n(y)}) scale(${n((size / 512) * 1000) / 1000})">` +
    `<rect width="512" height="512" rx="116" fill="url(#${bg})"/><rect width="512" height="512" rx="116" fill="url(#${glow})"/>` +
    '<g transform="rotate(-32 256 270)"><path d="M256 92v-28a26 26 0 0 1 52 0" fill="none" stroke="#c4b5fd" stroke-width="20" stroke-linecap="round"/>' +
    `<rect x="186" y="92" width="140" height="330" rx="70" fill="url(#${pill})"/>` +
    '<path d="M186 262h140v90a70 70 0 0 1-140 0z" fill="#1d4ed8" fill-opacity=".45"/><rect x="208" y="122" width="22" height="104" rx="11" fill="#fff" fill-opacity=".45"/></g>' +
    '<circle cx="380" cy="168" r="18" fill="#93c5fd" fill-opacity=".9"/><circle cx="410" cy="112" r="11" fill="#c4b5fd" fill-opacity=".85"/><circle cx="356" cy="104" r="8" fill="#a5b4fc" fill-opacity=".7"/>' +
    '</g>'
  );
}
