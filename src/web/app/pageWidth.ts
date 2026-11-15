import { readStored, useStored, writeStored } from './storage';

/**
 * How wide pages get in this browser. Standard keeps them to a comfortable width; Wide and Full use more of a big or
 * ultrawide screen (styles.css), and charts grow taller with them (plotHeight in components/chartMath.ts).
 */
export type PageWidth = 'standard' | 'wide' | 'full';

export const PAGE_WIDTH_KEY = 'rapthooker.width';
export const PAGE_WIDTHS: readonly PageWidth[] = ['standard', 'wide', 'full'];

export function parsePageWidth(raw: string | null | undefined): PageWidth {
  return raw === 'wide' || raw === 'full' ? raw : 'standard';
}

function apply(): void {
  document.documentElement.dataset.width = parsePageWidth(readStored(PAGE_WIDTH_KEY));
}

let started = false;

/** Applies the saved width to <html data-width> and follows other tabs. Call once before the first render. */
export function startPageWidth(): void {
  if (started) return;
  started = true;
  window.addEventListener('storage', (e) => (e.key === PAGE_WIDTH_KEY || e.key === null) && apply());
  apply();
}

export function setPageWidth(width: PageWidth): void {
  writeStored(PAGE_WIDTH_KEY, width === 'standard' ? null : width);
  apply();
}

/** The width pages have now, for drawings that size themselves (charts). */
export const currentPageWidth = (): PageWidth => parsePageWidth(document.documentElement.dataset.width);

export function usePageWidth(): [PageWidth, (width: PageWidth) => void] {
  const [width] = useStored(PAGE_WIDTH_KEY, parsePageWidth);
  return [width, setPageWidth];
}
