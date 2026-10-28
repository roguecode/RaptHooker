import type { ScreenPalette, ScreenTheme } from '@rapthooker/shared';

/**
 * The app's colours for each palette and theme: the CSS variables of styles.css (Violet) and palettes.css (the rest),
 * with what a palette doesn't change taken from Violet. screen.test.ts checks they still match the CSS.
 */
export interface ScreenColors {
  bg: string;
  glow1: string;
  glow2: string;
  glow3: string;
  surface: string;
  surface2: string;
  surface3: string;
  border: string;
  borderStrong: string;
  grid: string;
  text: string;
  muted: string;
  faint: string;
  violet: string;
  violet2: string;
  blue: string;
  cyan: string;
  success: string;
  warning: string;
  danger: string;
  seriesTemp: string;
  /** A CSS linear-gradient. */
  accent: string;
  /** A CSS linear-gradient of see-through colours. */
  accentSoft: string;
  onAccent: string;
}

/** The CSS variable behind each colour. */
export const CSS_VARS: Record<keyof ScreenColors, string> = {
  bg: 'bg',
  glow1: 'bg-glow-1',
  glow2: 'bg-glow-2',
  glow3: 'bg-glow-3',
  surface: 'surface',
  surface2: 'surface-2',
  surface3: 'surface-3',
  border: 'border',
  borderStrong: 'border-strong',
  grid: 'grid',
  text: 'text',
  muted: 'muted',
  faint: 'faint',
  violet: 'violet',
  violet2: 'violet-2',
  blue: 'blue',
  cyan: 'cyan',
  success: 'success',
  warning: 'warning',
  danger: 'danger',
  seriesTemp: 'series-temp',
  accent: 'accent',
  accentSoft: 'accent-soft',
  onAccent: 'on-accent',
};

export const SCREEN_COLORS: Record<ScreenPalette, Record<ScreenTheme, ScreenColors>> = {
  violet: {
    dark: {
      bg: '#08071c',
      glow1: 'rgba(124, 58, 237, 0.28)',
      glow2: 'rgba(37, 99, 235, 0.24)',
      glow3: 'rgba(34, 211, 238, 0.08)',
      surface: 'rgba(24, 21, 58, 0.66)',
      surface2: 'rgba(41, 36, 92, 0.55)',
      surface3: 'rgba(62, 55, 130, 0.5)',
      border: 'rgba(167, 139, 250, 0.13)',
      borderStrong: 'rgba(167, 139, 250, 0.28)',
      grid: 'rgba(167, 139, 250, 0.08)',
      text: '#f0edff',
      muted: '#a9a3d6',
      faint: '#8f8ac4',
      violet: '#8b5cf6',
      violet2: '#a78bfa',
      blue: '#3b82f6',
      cyan: '#22d3ee',
      success: '#34d399',
      warning: '#fbbf24',
      danger: '#fb7185',
      seriesTemp: '#f472b6',
      accent: 'linear-gradient(135deg, #c4b5fd 0%, #8b5cf6 38%, #6366f1 64%, #3b82f6 100%)',
      accentSoft: 'linear-gradient(135deg, rgba(139, 92, 246, 0.22), rgba(59, 130, 246, 0.18))',
      onAccent: '#ffffff',
    },
    light: {
      bg: '#f4f2ff',
      glow1: 'rgba(139, 92, 246, 0.16)',
      glow2: 'rgba(59, 130, 246, 0.14)',
      glow3: 'rgba(34, 211, 238, 0.07)',
      surface: 'rgba(255, 255, 255, 0.78)',
      surface2: 'rgba(237, 233, 254, 0.7)',
      surface3: 'rgba(221, 214, 254, 0.75)',
      border: 'rgba(76, 29, 149, 0.12)',
      borderStrong: 'rgba(76, 29, 149, 0.24)',
      grid: 'rgba(76, 29, 149, 0.1)',
      text: '#1d1846',
      muted: '#4f4987',
      faint: '#5f5896',
      violet: '#7c3aed',
      violet2: '#6d28d9',
      blue: '#2563eb',
      cyan: '#0e7490',
      success: '#047857',
      warning: '#9a4708',
      danger: '#be123c',
      seriesTemp: '#db2777',
      accent: 'linear-gradient(135deg, #8b5cf6 0%, #7c3aed 38%, #4f46e5 64%, #2563eb 100%)',
      accentSoft: 'linear-gradient(135deg, rgba(139, 92, 246, 0.16), rgba(59, 130, 246, 0.12))',
      onAccent: '#ffffff',
    },
  },
  ocean: {
    dark: {
      bg: '#031019',
      glow1: 'rgba(6, 182, 212, 0.22)',
      glow2: 'rgba(37, 99, 235, 0.24)',
      glow3: 'rgba(45, 212, 191, 0.08)',
      surface: 'rgba(12, 38, 56, 0.64)',
      surface2: 'rgba(20, 62, 88, 0.55)',
      surface3: 'rgba(30, 88, 122, 0.5)',
      border: 'rgba(103, 232, 249, 0.13)',
      borderStrong: 'rgba(103, 232, 249, 0.28)',
      grid: 'rgba(103, 232, 249, 0.08)',
      text: '#e9f8ff',
      muted: '#9ac3d6',
      faint: '#80abc0',
      violet: '#0891b2',
      violet2: '#22d3ee',
      blue: '#3b82f6',
      cyan: '#22d3ee',
      success: '#34d399',
      warning: '#fbbf24',
      danger: '#fb7185',
      seriesTemp: '#f472b6',
      accent: 'linear-gradient(135deg, #a5f3fc 0%, #22d3ee 38%, #0ea5e9 64%, #3b82f6 100%)',
      accentSoft: 'linear-gradient(135deg, rgba(6, 182, 212, 0.22), rgba(59, 130, 246, 0.18))',
      onAccent: '#ffffff',
    },
    light: {
      bg: '#eff9fc',
      glow1: 'rgba(6, 182, 212, 0.16)',
      glow2: 'rgba(59, 130, 246, 0.13)',
      glow3: 'rgba(45, 212, 191, 0.08)',
      surface: 'rgba(255, 255, 255, 0.78)',
      surface2: 'rgba(224, 242, 254, 0.75)',
      surface3: 'rgba(186, 230, 253, 0.7)',
      border: 'rgba(8, 51, 68, 0.12)',
      borderStrong: 'rgba(8, 51, 68, 0.24)',
      grid: 'rgba(8, 51, 68, 0.1)',
      text: '#0b2433',
      muted: '#3b5f72',
      faint: '#4b6f82',
      violet: '#0891b2',
      violet2: '#0e7490',
      blue: '#2563eb',
      cyan: '#0e7490',
      success: '#047857',
      warning: '#9a4708',
      danger: '#be123c',
      seriesTemp: '#db2777',
      accent: 'linear-gradient(135deg, #0891b2 0%, #0e7490 38%, #0369a1 64%, #2563eb 100%)',
      accentSoft: 'linear-gradient(135deg, rgba(6, 182, 212, 0.16), rgba(59, 130, 246, 0.12))',
      onAccent: '#ffffff',
    },
  },
  hops: {
    dark: {
      bg: '#06110a',
      glow1: 'rgba(132, 204, 22, 0.2)',
      glow2: 'rgba(16, 185, 129, 0.2)',
      glow3: 'rgba(250, 204, 21, 0.06)',
      surface: 'rgba(18, 42, 28, 0.64)',
      surface2: 'rgba(30, 66, 44, 0.55)',
      surface3: 'rgba(46, 94, 62, 0.5)',
      border: 'rgba(187, 247, 208, 0.13)',
      borderStrong: 'rgba(187, 247, 208, 0.27)',
      grid: 'rgba(187, 247, 208, 0.08)',
      text: '#eefcf2',
      muted: '#a4c8b0',
      faint: '#88ae95',
      violet: '#84cc16',
      violet2: '#a3e635',
      blue: '#10b981',
      cyan: '#22d3ee',
      success: '#34d399',
      warning: '#fbbf24',
      danger: '#fb7185',
      seriesTemp: '#f472b6',
      accent: 'linear-gradient(135deg, #ecfccb 0%, #a3e635 38%, #4ade80 64%, #10b981 100%)',
      accentSoft: 'linear-gradient(135deg, rgba(132, 204, 22, 0.2), rgba(16, 185, 129, 0.16))',
      onAccent: '#052e16',
    },
    light: {
      bg: '#f3f8ec',
      glow1: 'rgba(132, 204, 22, 0.16)',
      glow2: 'rgba(16, 185, 129, 0.12)',
      glow3: 'rgba(234, 179, 8, 0.07)',
      surface: 'rgba(255, 255, 255, 0.8)',
      surface2: 'rgba(230, 244, 214, 0.75)',
      surface3: 'rgba(208, 234, 186, 0.7)',
      border: 'rgba(20, 83, 45, 0.12)',
      borderStrong: 'rgba(20, 83, 45, 0.24)',
      grid: 'rgba(20, 83, 45, 0.1)',
      text: '#11261a',
      muted: '#415e4c',
      faint: '#52705d',
      violet: '#4d7c0f',
      violet2: '#3f6212',
      blue: '#047857',
      cyan: '#0e7490',
      success: '#047857',
      warning: '#9a4708',
      danger: '#be123c',
      seriesTemp: '#db2777',
      accent: 'linear-gradient(135deg, #4d7c0f 0%, #3f6212 38%, #15803d 64%, #047857 100%)',
      accentSoft: 'linear-gradient(135deg, rgba(101, 163, 13, 0.16), rgba(4, 120, 87, 0.12))',
      onAccent: '#ffffff',
    },
  },
  amber: {
    dark: {
      bg: '#130c06',
      glow1: 'rgba(245, 158, 11, 0.2)',
      glow2: 'rgba(234, 88, 12, 0.2)',
      glow3: 'rgba(251, 191, 36, 0.06)',
      surface: 'rgba(46, 30, 16, 0.64)',
      surface2: 'rgba(74, 48, 24, 0.52)',
      surface3: 'rgba(106, 68, 32, 0.48)',
      border: 'rgba(253, 216, 160, 0.13)',
      borderStrong: 'rgba(253, 216, 160, 0.27)',
      grid: 'rgba(253, 216, 160, 0.08)',
      text: '#fff6ea',
      muted: '#d4b896',
      faint: '#bc9e7c',
      violet: '#f59e0b',
      violet2: '#fbbf24',
      blue: '#ea580c',
      cyan: '#22d3ee',
      success: '#34d399',
      warning: '#fb923c',
      danger: '#fb7185',
      seriesTemp: '#f472b6',
      accent: 'linear-gradient(135deg, #fef3c7 0%, #fbbf24 38%, #f59e0b 64%, #ea580c 100%)',
      accentSoft: 'linear-gradient(135deg, rgba(245, 158, 11, 0.2), rgba(234, 88, 12, 0.16))',
      onAccent: '#241405',
    },
    light: {
      bg: '#fdf7ef',
      glow1: 'rgba(245, 158, 11, 0.16)',
      glow2: 'rgba(234, 88, 12, 0.11)',
      glow3: 'rgba(250, 204, 21, 0.08)',
      surface: 'rgba(255, 255, 255, 0.8)',
      surface2: 'rgba(254, 240, 214, 0.75)',
      surface3: 'rgba(253, 222, 176, 0.7)',
      border: 'rgba(120, 53, 15, 0.12)',
      borderStrong: 'rgba(120, 53, 15, 0.24)',
      grid: 'rgba(120, 53, 15, 0.1)',
      text: '#2b1a0a',
      muted: '#6b4d2f',
      faint: '#7a5b3c',
      violet: '#d97706',
      violet2: '#92400e',
      blue: '#c2410c',
      cyan: '#0e7490',
      success: '#047857',
      warning: '#c2410c',
      danger: '#be123c',
      seriesTemp: '#db2777',
      accent: 'linear-gradient(135deg, #d97706 0%, #b45309 38%, #c2410c 64%, #9a3412 100%)',
      accentSoft: 'linear-gradient(135deg, rgba(245, 158, 11, 0.18), rgba(234, 88, 12, 0.12))',
      onAccent: '#ffffff',
    },
  },
  rose: {
    dark: {
      bg: '#14070f',
      glow1: 'rgba(236, 72, 153, 0.24)',
      glow2: 'rgba(249, 115, 22, 0.14)',
      glow3: 'rgba(168, 85, 247, 0.1)',
      surface: 'rgba(50, 18, 38, 0.64)',
      surface2: 'rgba(82, 30, 62, 0.52)',
      surface3: 'rgba(114, 44, 86, 0.48)',
      border: 'rgba(251, 207, 232, 0.13)',
      borderStrong: 'rgba(251, 207, 232, 0.27)',
      grid: 'rgba(251, 207, 232, 0.08)',
      text: '#fff0f7',
      muted: '#d7a9c0',
      faint: '#c28ea8',
      violet: '#ec4899',
      violet2: '#f472b6',
      blue: '#f97316',
      cyan: '#22d3ee',
      success: '#34d399',
      warning: '#fbbf24',
      danger: '#f87171',
      seriesTemp: '#fb923c',
      accent: 'linear-gradient(135deg, #fbcfe8 0%, #f472b6 38%, #fb7185 64%, #fb923c 100%)',
      accentSoft: 'linear-gradient(135deg, rgba(236, 72, 153, 0.22), rgba(249, 115, 22, 0.14))',
      onAccent: '#ffffff',
    },
    light: {
      bg: '#fdf2f7',
      glow1: 'rgba(236, 72, 153, 0.14)',
      glow2: 'rgba(249, 115, 22, 0.1)',
      glow3: 'rgba(168, 85, 247, 0.07)',
      surface: 'rgba(255, 255, 255, 0.8)',
      surface2: 'rgba(252, 231, 243, 0.75)',
      surface3: 'rgba(251, 207, 232, 0.7)',
      border: 'rgba(131, 24, 67, 0.12)',
      borderStrong: 'rgba(131, 24, 67, 0.24)',
      grid: 'rgba(131, 24, 67, 0.1)',
      text: '#2d0f1f',
      muted: '#6d3c54',
      faint: '#7c4b63',
      violet: '#db2777',
      violet2: '#be185d',
      blue: '#ea580c',
      cyan: '#0e7490',
      success: '#047857',
      warning: '#9a4708',
      danger: '#b91c1c',
      seriesTemp: '#ea580c',
      accent: 'linear-gradient(135deg, #ec4899 0%, #db2777 38%, #e11d48 64%, #ea580c 100%)',
      accentSoft: 'linear-gradient(135deg, rgba(236, 72, 153, 0.14), rgba(249, 115, 22, 0.1))',
      onAccent: '#ffffff',
    },
  },
  graphite: {
    dark: {
      bg: '#0a0a0c',
      glow1: 'rgba(161, 161, 170, 0.12)',
      glow2: 'rgba(113, 113, 122, 0.12)',
      glow3: 'rgba(244, 244, 245, 0.04)',
      surface: 'rgba(30, 30, 34, 0.66)',
      surface2: 'rgba(48, 48, 54, 0.55)',
      surface3: 'rgba(70, 70, 78, 0.5)',
      border: 'rgba(228, 228, 231, 0.1)',
      borderStrong: 'rgba(228, 228, 231, 0.22)',
      grid: 'rgba(228, 228, 231, 0.07)',
      text: '#fafafa',
      muted: '#a1a1aa',
      faint: '#8d8d96',
      violet: '#a1a1aa',
      violet2: '#e4e4e7',
      blue: '#71717a',
      cyan: '#22d3ee',
      success: '#34d399',
      warning: '#fbbf24',
      danger: '#fb7185',
      seriesTemp: '#f472b6',
      accent: 'linear-gradient(135deg, #ffffff 0%, #e4e4e7 38%, #a1a1aa 100%)',
      accentSoft: 'linear-gradient(135deg, rgba(244, 244, 245, 0.1), rgba(161, 161, 170, 0.08))',
      onAccent: '#09090b',
    },
    light: {
      bg: '#f4f4f5',
      glow1: 'rgba(113, 113, 122, 0.1)',
      glow2: 'rgba(161, 161, 170, 0.12)',
      glow3: 'rgba(24, 24, 27, 0.03)',
      surface: 'rgba(255, 255, 255, 0.8)',
      surface2: 'rgba(228, 228, 231, 0.6)',
      surface3: 'rgba(212, 212, 216, 0.65)',
      border: 'rgba(24, 24, 27, 0.11)',
      borderStrong: 'rgba(24, 24, 27, 0.22)',
      grid: 'rgba(24, 24, 27, 0.08)',
      text: '#18181b',
      muted: '#52525b',
      faint: '#5f5f68',
      violet: '#52525b',
      violet2: '#27272a',
      blue: '#71717a',
      cyan: '#0e7490',
      success: '#047857',
      warning: '#9a4708',
      danger: '#be123c',
      seriesTemp: '#db2777',
      accent: 'linear-gradient(135deg, #71717a 0%, #3f3f46 38%, #27272a 64%, #09090b 100%)',
      accentSoft: 'linear-gradient(135deg, rgba(24, 24, 27, 0.08), rgba(82, 82, 91, 0.06))',
      onAccent: '#ffffff',
    },
  },
};

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** A #rgb, #rrggbb, rgb() or rgba() colour. */
export function parseColor(css: string): Rgba {
  const s = css.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(s)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
    return { r: parseInt(full.slice(0, 2), 16), g: parseInt(full.slice(2, 4), 16), b: parseInt(full.slice(4, 6), 16), a: 1 };
  }
  const fn = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
  if (fn) return { r: Number(fn[1]), g: Number(fn[2]), b: Number(fn[3]), a: fn[4] === undefined ? 1 : Number(fn[4]) };
  return { r: 128, g: 128, b: 128, a: 1 };
}

const hex2 = (n: number) =>
  Math.round(Math.max(0, Math.min(255, n)))
    .toString(16)
    .padStart(2, '0');

/** #rrggbb, dropping the alpha. */
export const toHex = (c: Rgba): string => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;

/** `a` blended towards `b` by `t` (0 is all a), like color-mix(). */
export function mix(a: string, b: string, t: number): string {
  const x = parseColor(a);
  const y = parseColor(b);
  return toHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t, a: 1 });
}

/** Fill or stroke attributes for a colour that may be see-through (rgba). */
export function paint(attr: 'fill' | 'stroke' | 'stop-color', css: string, opacity = 1): string {
  const c = parseColor(css);
  const a = c.a * opacity;
  const op = attr === 'stop-color' ? 'stop-opacity' : `${attr}-opacity`;
  return a >= 0.999 ? `${attr}="${toHex(c)}"` : `${attr}="${toHex(c)}" ${op}="${+a.toFixed(3)}"`;
}

/** The colour stops of a CSS linear-gradient(angle, colour offset%, ...). */
export function gradientStops(css: string): { offset: number; color: string }[] {
  const inner = /linear-gradient\((.*)\)\s*$/.exec(css.trim())?.[1] ?? '';
  const parts = inner.split(/,(?![^(]*\))/).map((p) => p.trim());
  const stops = parts.filter((p) => !/deg$|^to /.test(p));
  return stops.map((p, i) => {
    const m = /^(.*?)\s+([\d.]+)%$/.exec(p);
    return { color: (m ? m[1]! : p).trim(), offset: m ? Number(m[2]) / 100 : i / Math.max(1, stops.length - 1) };
  });
}
