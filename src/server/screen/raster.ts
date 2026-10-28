import { initWasm, Resvg } from '@resvg/resvg-wasm';
import jpeg from 'jpeg-js';
import type { ScreenFormat } from '@rapthooker/shared';
import { FONT_FAMILY, type ScreenAssets } from './assets.js';

/** Turns the SVG into the picture a screen asked for: PNG, baseline JPEG (what ESP8266 screens decode) or 24-bit BMP. */

export const CONTENT_TYPES: Record<ScreenFormat, string> = { png: 'image/png', jpg: 'image/jpeg', bmp: 'image/bmp' };

let ready: Promise<void> | null = null;

/** Starts the WebAssembly renderer once (it can only be started once per process). */
function start(assets: ScreenAssets): Promise<void> {
  ready ??= initWasm(assets.wasm).catch((err: unknown) => {
    ready = null;
    throw err;
  });
  return ready;
}

/** RGBA pixels on an opaque background as a 24-bit bottom-up BMP. */
export function encodeBmp(width: number, height: number, rgba: Uint8Array): Buffer {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const size = 54 + rowSize * height;
  const out = Buffer.alloc(size);
  out.write('BM', 0, 'ascii');
  out.writeUInt32LE(size, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(rowSize * height, 34);
  out.writeInt32LE(2835, 38);
  out.writeInt32LE(2835, 42);
  for (let y = 0; y < height; y++) {
    const src = (height - 1 - y) * width * 4;
    const dst = 54 + y * rowSize;
    for (let x = 0; x < width; x++) {
      out[dst + x * 3] = rgba[src + x * 4 + 2]!;
      out[dst + x * 3 + 1] = rgba[src + x * 4 + 1]!;
      out[dst + x * 3 + 2] = rgba[src + x * 4]!;
    }
  }
  return out;
}

export async function rasterize(svg: string, format: ScreenFormat, assets: ScreenAssets, background: string): Promise<Buffer> {
  await start(assets);
  const resvg = new Resvg(svg, {
    font: { fontBuffers: assets.fonts, defaultFontFamily: FONT_FAMILY, sansSerifFamily: FONT_FAMILY },
    background,
    shapeRendering: 2,
    textRendering: 1,
  });
  try {
    const image = resvg.render();
    try {
      if (format === 'png') return Buffer.from(image.asPng());
      const { width, height } = image;
      const pixels = image.pixels;
      if (format === 'bmp') return encodeBmp(width, height, pixels);
      return Buffer.from(jpeg.encode({ data: pixels, width, height }, 90).data);
    } finally {
      image.free();
    }
  } finally {
    resvg.free();
  }
}
