import wasm from '@resvg/resvg-wasm/index_bg.wasm';
import regular from './fonts/Inter-Regular.ttf';
import semiBold from './fonts/Inter-SemiBold.ttf';
import bold from './fonts/Inter-Bold.ttf';
import extraBold from './fonts/Inter-ExtraBold.ttf';
import type { ScreenAssets } from './assets.js';

/** The built server: the renderer and fonts are inside the server file (tsup.config.ts swaps this in for assets-files.ts). */
export function loadScreenAssets(): ScreenAssets {
  // In FONT_FILES order.
  return { wasm, fonts: [regular, semiBold, bold, extraBold] };
}
