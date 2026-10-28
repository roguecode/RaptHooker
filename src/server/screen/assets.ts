/** The fonts screen images are drawn with, and how wide text set in them is. */

export interface ScreenAssets {
  /** resvg's WebAssembly renderer. */
  wasm: Uint8Array;
  /** TrueType fonts, in FONT_FILES order. */
  fonts: Uint8Array[];
}

export const FONT_FAMILY = 'Inter';
/** Inter (SIL Open Font License, fonts/OFL.txt), cut down to Latin, Greek and Cyrillic. Same order as FONT_WEIGHTS. */
export const FONT_FILES = ['Inter-Regular.ttf', 'Inter-SemiBold.ttf', 'Inter-Bold.ttf', 'Inter-ExtraBold.ttf'] as const;
export const FONT_WEIGHTS = [400, 600, 700, 800] as const;
export type FontWeight = (typeof FONT_WEIGHTS)[number];

/** Advance widths of one font, enough to measure a line of text (kerning is left out, so it errs on the wide side). */
class FontMetrics {
  private constructor(
    private readonly unitsPerEm: number,
    private readonly advances: Map<number, number>,
    private readonly fallback: number,
  ) {}

  static parse(data: Uint8Array): FontMetrics {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const tables = new Map<string, number>();
    const count = view.getUint16(4);
    for (let i = 0; i < count; i++) {
      const at = 12 + i * 16;
      const tag = String.fromCharCode(data[at]!, data[at + 1]!, data[at + 2]!, data[at + 3]!);
      tables.set(tag, view.getUint32(at + 8));
    }
    const table = (tag: string) => {
      const at = tables.get(tag);
      if (at === undefined) throw new Error(`font has no ${tag} table`);
      return at;
    };
    const unitsPerEm = view.getUint16(table('head') + 18);
    const longMetrics = view.getUint16(table('hhea') + 34);
    const hmtx = table('hmtx');
    const advanceOf = (glyph: number) => view.getUint16(hmtx + Math.min(glyph, longMetrics - 1) * 4);

    const advances = new Map<number, number>();
    const cmap = table('cmap');
    const subtables = view.getUint16(cmap + 2);
    let format4: number | null = null;
    let format12: number | null = null;
    for (let i = 0; i < subtables; i++) {
      const platform = view.getUint16(cmap + 4 + i * 8);
      const encoding = view.getUint16(cmap + 6 + i * 8);
      const at = cmap + view.getUint32(cmap + 8 + i * 8);
      const format = view.getUint16(at);
      if (format === 12 && (platform === 0 || (platform === 3 && encoding === 10))) format12 = at;
      if (format === 4 && (platform === 0 || (platform === 3 && encoding === 1))) format4 = at;
    }
    if (format12 !== null) {
      const groups = view.getUint32(format12 + 12);
      for (let g = 0; g < groups; g++) {
        const at = format12 + 16 + g * 12;
        const start = view.getUint32(at);
        const end = view.getUint32(at + 4);
        const glyph = view.getUint32(at + 8);
        for (let c = start; c <= end; c++) advances.set(c, advanceOf(glyph + c - start));
      }
    } else if (format4 !== null) {
      const segments = view.getUint16(format4 + 6) / 2;
      const ends = format4 + 14;
      const starts = ends + segments * 2 + 2;
      const deltas = starts + segments * 2;
      const ranges = deltas + segments * 2;
      for (let s = 0; s < segments; s++) {
        const end = view.getUint16(ends + s * 2);
        const start = view.getUint16(starts + s * 2);
        const delta = view.getInt16(deltas + s * 2);
        const range = view.getUint16(ranges + s * 2);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          let glyph: number;
          if (range === 0) glyph = (c + delta) & 0xffff;
          else {
            glyph = view.getUint16(ranges + s * 2 + range + (c - start) * 2);
            if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
          }
          if (glyph !== 0) advances.set(c, advanceOf(glyph));
        }
      }
    }
    return new FontMetrics(unitsPerEm, advances, advances.get(0x6f) ?? unitsPerEm * 0.55);
  }

  /** Width in em of `text` with `letterSpacing` (em) after each character. */
  width(text: string, letterSpacing = 0): number {
    let units = 0;
    let chars = 0;
    for (const ch of text) {
      units += this.advances.get(ch.codePointAt(0)!) ?? this.fallback;
      chars++;
    }
    return units / this.unitsPerEm + chars * letterSpacing;
  }
}

export interface TextStyle {
  size: number;
  weight: FontWeight;
  /** In em, like CSS letter-spacing: -0.04em. */
  spacing?: number;
}

/** Measures text in each of the fonts. */
export class TextMeasure {
  private readonly fonts: Map<FontWeight, FontMetrics>;

  constructor(fonts: Uint8Array[]) {
    this.fonts = new Map(FONT_WEIGHTS.map((w, i) => [w, FontMetrics.parse(fonts[i]!)]));
  }

  width(text: string, style: TextStyle): number {
    return this.fonts.get(style.weight)!.width(text, style.spacing ?? 0) * style.size;
  }

  /** `text` cut short with an ellipsis to fit `max` pixels (empty when not even the ellipsis fits). */
  fit(text: string, max: number, style: TextStyle): string {
    if (this.width(text, style) <= max) return text;
    const chars = [...text];
    let lo = 0;
    let hi = chars.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (this.width(`${chars.slice(0, mid).join('').trimEnd()}…`, style) <= max) lo = mid;
      else hi = mid - 1;
    }
    if (lo === 0) return this.width('…', style) <= max ? '…' : '';
    return `${chars.slice(0, lo).join('').trimEnd()}…`;
  }
}
