/** How TV mode lays pills out on the screen. */

export interface KioskLayout {
  cols: number;
  rows: number;
  /** Pills per screen. */
  perPage: number;
  /** Screens to rotate through. */
  pages: number;
}

export interface TileSize {
  width: number;
  height: number;
}

/** Smallest tile that's still readable from across a room. */
export const KIOSK_MIN_TILE: TileSize = { width: 340, height: 280 };

/**
 * As many pills per screen as fit at a readable size, spread evenly over the screens (5 pills that fit 4 at a time
 * show 3 then 2). The grid picked gives the biggest text. `max` limits the pills per screen.
 */
export function kioskLayout(
  width: number,
  height: number,
  count: number,
  opts: { min?: TileSize; gap?: number; max?: number } = {},
): KioskLayout {
  const min = opts.min ?? KIOSK_MIN_TILE;
  const gap = opts.gap ?? 16;
  const n = Math.max(1, Math.floor(count));
  const maxCols = Math.max(1, Math.floor((width + gap) / (min.width + gap)));
  const maxRows = Math.max(1, Math.floor((height + gap) / (min.height + gap)));
  const capacity = Math.max(1, Math.min(maxCols * maxRows, opts.max ?? Infinity));
  const pages = Math.ceil(n / capacity);
  const perPage = Math.ceil(n / pages);

  const fallbackCols = Math.min(perPage, maxCols);
  let best = { cols: fallbackCols, rows: Math.ceil(perPage / fallbackCols), score: -Infinity };
  for (let cols = 1; cols <= Math.min(perPage, maxCols); cols++) {
    const rows = Math.ceil(perPage / cols);
    if (rows > maxRows) continue;
    const w = (width - gap * (cols - 1)) / cols;
    const h = (height - gap * (rows - 1)) / rows;
    // Tile text scales with the tile's shorter side, so make that as big as possible, then avoid empty cells.
    const score = Math.min(w, h) - (cols * rows - perPage) * 0.5;
    if (score > best.score) best = { cols, rows, score };
  }
  return { cols: best.cols, rows: best.rows, perPage, pages };
}

/** The items on screen `page` (wrapping round). */
export function pageItems<T>(items: readonly T[], page: number, perPage: number): T[] {
  if (items.length === 0) return [];
  const size = Math.max(1, perPage);
  const pages = Math.ceil(items.length / size);
  const p = ((page % pages) + pages) % pages;
  return items.slice(p * size, p * size + size);
}

/** Days since a brew started, counting the first day as day 1. */
export const brewDay = (startedAt: number, now: number): number => Math.max(1, Math.floor((now - startedAt) / 86_400_000) + 1);

export const ROTATE_SECONDS = [10, 20, 30, 60] as const;

export interface KioskSettings {
  /** Seconds per screen when not every pill fits. */
  seconds: number;
  /** One pill per screen, as big as it gets. */
  one: boolean;
}

export function parseKioskSettings(raw: string | null): KioskSettings {
  try {
    const v = JSON.parse(raw ?? '{}') as Partial<Record<keyof KioskSettings, unknown>> | null;
    const seconds = ROTATE_SECONDS.find((s) => s === v?.seconds) ?? 20;
    return { seconds, one: v?.one === true };
  } catch {
    return { seconds: 20, one: false };
  }
}

export const serializeKioskSettings = (s: KioskSettings): string => JSON.stringify(s);
