import {
  SCREEN_FORMATS,
  SCREEN_ITEMS,
  SCREEN_MAX_SIZE,
  SCREEN_MIN_SIZE,
  SCREEN_RANGES,
  type ScreenFormat,
  type ScreenItem,
  type ScreenRange,
} from '@rapthooker/shared';
import { tk } from '../i18n';

/** Choices for a screen image (components/ImageLink.tsx): screen sizes, what to show, and what's remembered between visits. */

export interface SizePreset {
  id: string;
  /** English, marked with tk: show with t(). */
  label: string;
  width: number;
  height: number;
  /** The file type the screen needs, if it's particular. */
  format?: ScreenFormat;
}

export const SIZE_PRESETS: SizePreset[] = [
  // An ESP8266 with a 240×240 screen: it decodes JPEG, not PNG.
  { id: 'geekmagic', label: tk('GeekMagic mini screen'), width: 240, height: 240, format: 'jpg' },
  { id: 'tft-320', label: tk('Small TFT screen'), width: 320, height: 240 },
  { id: 'tft-480', label: tk('3.5″ screen'), width: 480, height: 320 },
  { id: 'lcd-800', label: tk('7″ screen'), width: 800, height: 480 },
  { id: 'lcd-1024', label: tk('7″ HD screen'), width: 1024, height: 600 },
  { id: 'epaper-296', label: tk('2.9″ e-paper'), width: 296, height: 128 },
  { id: 'epaper-400', label: tk('4.2″ e-paper'), width: 400, height: 300 },
  { id: 'epaper-800', label: tk('7.5″ e-paper'), width: 800, height: 480 },
  { id: 'hd', label: tk('HD TV (720p)'), width: 1280, height: 720 },
  { id: 'fhd', label: tk('Full HD TV (1080p)'), width: 1920, height: 1080 },
];

export const CUSTOM = 'custom';

export interface ContentPreset {
  id: string;
  label: string;
  hint: string;
  items: ScreenItem[];
}

export const CONTENT_PRESETS: ContentPreset[] = [
  { id: 'readings', label: tk('Readings'), hint: tk('Name, gravity and temperature'), items: ['name', 'status', 'gravity', 'temperature'] },
  { id: 'big', label: tk('Big numbers'), hint: tk('Just the readings, as big as they go'), items: ['gravity', 'temperature'] },
  {
    id: 'brew',
    label: tk('Brew'),
    hint: tk('Readings with the brew and its progress'),
    items: ['name', 'status', 'gravity', 'temperature', 'brew', 'progress'],
  },
  {
    id: 'graph',
    label: tk('Brew and graph'),
    hint: tk('Readings, the brew and its graph'),
    items: ['name', 'status', 'gravity', 'temperature', 'brew', 'chart'],
  },
  { id: 'everything', label: tk('Everything'), hint: tk('All of it, as space allows'), items: [...SCREEN_ITEMS] },
];

/** What each item is called in the list of things to show. */
export const ITEM_LABELS: Record<ScreenItem, string> = {
  header: tk('Hub name and time'),
  name: tk('Name'),
  status: tk('Online and last reading'),
  gravity: tk('Gravity'),
  temperature: tk('Temperature'),
  brew: tk('Brew and day'),
  progress: tk('Fermentation progress'),
  chart: tk('Graph'),
  stats: tk('Battery, signal and more'),
};

export const RANGE_LABELS: Record<ScreenRange, string> = {
  brew: tk('The brew so far'),
  '1d': tk('Last 24 h'),
  '3d': tk('Last 3 days'),
  '7d': tk('Last 7 days'),
};

export const FORMAT_LABELS: Record<ScreenFormat, string> = { png: 'PNG', jpg: 'JPEG', bmp: 'BMP' };

/** The content preset these items make up, or null for a mix of one's own. */
export function contentPreset(items: readonly ScreenItem[]): ContentPreset | null {
  const set = new Set(items);
  return CONTENT_PRESETS.find((p) => p.items.length === set.size && p.items.every((i) => set.has(i))) ?? null;
}

/** The size preset with these dimensions (keeping `preferred` when it matches, as two presets can share a size). */
export function sizePreset(width: number, height: number, preferred?: string): SizePreset | null {
  const fits = (p: SizePreset) => p.width === width && p.height === height;
  return SIZE_PRESETS.find((p) => p.id === preferred && fits(p)) ?? SIZE_PRESETS.find(fits) ?? null;
}

export const clampSize = (n: number): number =>
  Number.isFinite(n) ? Math.min(SCREEN_MAX_SIZE, Math.max(SCREEN_MIN_SIZE, Math.round(n))) : SCREEN_MIN_SIZE;

/** What the image dialog remembers in this browser. The look and units start from the browser's own each time. */
export interface ImageLinkSettings {
  /** A size preset's id, or CUSTOM. */
  size: string;
  width: number;
  height: number;
  format: ScreenFormat;
  show: ScreenItem[];
  range: ScreenRange;
  brewing: boolean;
  /** The hub address to put in the link (an origin), or null for the best guess. */
  host: string | null;
}

export const IMAGE_LINK_KEY = 'rapthooker.imageLink';

export const DEFAULT_IMAGE_LINK: ImageLinkSettings = {
  size: 'geekmagic',
  width: 240,
  height: 240,
  format: 'jpg',
  show: CONTENT_PRESETS.find((p) => p.id === 'graph')!.items,
  range: 'brew',
  brewing: false,
  host: null,
};

export function parseImageLinkSettings(raw: string | null): ImageLinkSettings {
  try {
    const v = JSON.parse(raw ?? '{}') as Partial<Record<keyof ImageLinkSettings, unknown>> | null;
    const d = DEFAULT_IMAGE_LINK;
    const width = typeof v?.width === 'number' ? clampSize(v.width) : d.width;
    const height = typeof v?.height === 'number' ? clampSize(v.height) : d.height;
    const named = typeof v?.size === 'string' ? v.size : undefined;
    const size = named === CUSTOM ? CUSTOM : (sizePreset(width, height, named)?.id ?? CUSTOM);
    const show = Array.isArray(v?.show) ? SCREEN_ITEMS.filter((i) => (v.show as unknown[]).includes(i)) : d.show;
    return {
      size,
      width,
      height,
      format: SCREEN_FORMATS.find((f) => f === v?.format) ?? d.format,
      show,
      range: SCREEN_RANGES.find((r) => r === v?.range) ?? d.range,
      brewing: v?.brewing === true,
      host: typeof v?.host === 'string' && /^https?:\/\/[^/?#\s]+$/.test(v.host) ? v.host : null,
    };
  } catch {
    return DEFAULT_IMAGE_LINK;
  }
}

export const serializeImageLinkSettings = (s: ImageLinkSettings): string => JSON.stringify(s);

/** This browser's time zone, for the clock on the picture. */
export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}
