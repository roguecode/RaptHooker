import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { FONT_FILES, type ScreenAssets } from './assets.js';

/**
 * Running from source (the dev server and tests): the renderer from node_modules and the fonts next to this file. The
 * build puts assets-embedded.ts in this module's place, so the hub still only needs its one server file.
 */
export function loadScreenAssets(): ScreenAssets {
  const wasm = readFileSync(createRequire(import.meta.url).resolve('@resvg/resvg-wasm/index_bg.wasm'));
  const fonts = FONT_FILES.map((name) => new Uint8Array(readFileSync(fileURLToPath(new URL(`./fonts/${name}`, import.meta.url)))));
  return { wasm: new Uint8Array(wasm), fonts };
}
