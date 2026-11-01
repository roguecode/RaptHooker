import { createHash } from 'node:crypto';
import { loadFirmwareFiles } from './firmware-files.js';

/**
 * The firmware RaptHooker puts on screens (firmware/screen, built into bin/ and shipped inside the server), and the
 * checks an image has to pass before it's sent anywhere: the stock firmware on a new screen does no checking at all.
 */

export interface FirmwareImage {
  model: string;
  version: string;
  size: number;
  md5: string;
  data: Buffer;
}

/** The stock firmware drops everything past this and installs the rest anyway, which would brick the screen. */
export const STOCK_OTA_LIMIT = 0x80000;
/** What RaptHooker sends to a stock screen at most, leaving a margin. */
export const STOCK_SAFE_SIZE = 0x7c000;

const MARKER = 'RHSCREEN-FW:';

/** The model and version written into a RaptHooker firmware image, or null if it hasn't got them. */
export function imageMarker(data: Uint8Array): { model: string; version: string } | null {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const at = buf.indexOf(MARKER);
  if (at < 0) return null;
  const end = buf.indexOf(0, at);
  const m = /^RHSCREEN-FW:([a-z0-9-]+):(\d+\.\d+\.\d+[0-9A-Za-z.-]*)/.exec(buf.subarray(at, end < 0 ? at + 80 : end).toString('latin1'));
  return m ? { model: m[1]!, version: m[2]! } : null;
}

/** CRC-32 as eboot and elf2bin work it out: MSB first, polynomial 0x04C11DB7, no final inversion. */
export function crc8266(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const c of data) {
    for (let i = 0x80; i > 0; i >>= 1) {
      let bit = (crc & 0x80000000) !== 0;
      if (c & i) bit = !bit;
      crc = (crc << 1) >>> 0;
      if (bit) crc = (crc ^ 0x04c11db7) >>> 0;
    }
  }
  return crc >>> 0;
}

const u32 = (d: Uint8Array, at: number) => (d[at]! | (d[at + 1]! << 8) | (d[at + 2]! << 16) | (d[at + 3]! << 24)) >>> 0;

function walk(d: Uint8Array, at: number, end: number, app: boolean, problems: string[]): { sum: number; checksumAt: number } {
  const segs = d[at + 1]!;
  const entry = u32(d, at + 4);
  const iramEnd = app ? 0x4010c000 : 0x40110000;
  if (!segs || segs > 16) problems.push('bad segment count');
  if (entry < 0x40100000 || entry >= iramEnd) problems.push('bad entry point');
  let pos = at + 8;
  let sum = 0xef;
  for (let s = 0; s < segs && !problems.length; s++) {
    if (pos + 8 > end) {
      problems.push(app ? 'segment past the end' : 'boot loader too big');
      break;
    }
    const addr = u32(d, pos);
    const len = u32(d, pos + 4);
    const ok =
      (app && addr >= 0x40201010 && addr < 0x40300000 && len <= 0x40300000 - addr) ||
      (addr >= 0x40100000 && addr < iramEnd && len <= iramEnd - addr) ||
      (addr >= 0x3ffe8000 && addr < 0x40000000 && len <= 0x40000000 - addr);
    if (!ok) problems.push('segment out of range');
    else if (pos + 8 + len > end) problems.push(app ? 'segment past the end' : 'boot loader too big');
    else for (let i = pos + 8; i < pos + 8 + len; i++) sum ^= d[i]!;
    pos += 8 + len;
  }
  while ((pos + 1) % 16) pos++;
  return { sum, checksumAt: pos };
}

/**
 * What's wrong with an ESP8266 Arduino firmware image (empty if nothing): the boot loader and app headers, every
 * segment's place and the checksums, the length, and the CRC that elf2bin adds to core 3 builds. The same checks as
 * the screen firmware's own ImageCheck (firmware/screen/src/image.cpp).
 */
export function imageProblems(d: Uint8Array): string[] {
  const problems: string[] = [];
  if (d.length < 0x1020 || d[0] !== 0xe9) return ['not ESP8266 firmware'];
  const mode = d[2]!;
  const sizeCode = d[3]! >> 4;
  if (mode > 3) problems.push('bad flash mode');
  const boot = walk(d, 0, 0x1000, false, problems);
  if (problems.length) return problems;
  if (boot.checksumAt >= 0x1000) return ['boot loader too big'];
  if (d[boot.checksumAt] !== boot.sum) return ['bad boot loader checksum'];
  if (d[0x1000] !== 0xe9) return ['no app at 0x1000'];
  if (d[0x1002] !== mode || d[0x1003]! >> 4 !== sizeCode) return ['headers disagree'];
  const app = walk(d, 0x1000, d.length, true, problems);
  if (problems.length) return problems;
  if (app.checksumAt !== d.length - 1) return ['length does not match the segments'];
  const crcLen = u32(d, 0x1010);
  const crcVal = u32(d, 0x1014);
  const hasCrc = crcLen === d.length;
  let crcXor = 0;
  for (let i = 0x1010; i < 0x1018; i++) crcXor ^= d[i]!;
  // elf2bin works the app's checksum out before it fills in the length and CRC words.
  if (d[app.checksumAt] !== app.sum && !(hasCrc && d[app.checksumAt] === (app.sum ^ crcXor))) problems.push('bad checksum');
  if (hasCrc) {
    const zeroed = Buffer.from(d);
    zeroed.fill(0, 0x1010, 0x1018);
    if (crc8266(zeroed) !== crcVal) problems.push("CRC doesn't match");
  }
  return problems;
}

/** Why an image mustn't go to a stock screen's OTA (empty if it may): on top of imageProblems, the stock's own limits. */
export function stockProblems(d: Uint8Array, model: string): string[] {
  const problems = imageProblems(d);
  if (d.length > STOCK_SAFE_SIZE) problems.push(`${d.length} bytes is over the ${STOCK_SAFE_SIZE} the stock firmware can take`);
  if (d[2] !== 2) problems.push('not DIO flash mode');
  if (d[3]! >> 4 !== 4) problems.push('not built for 4 MB of flash');
  if (u32(d, 0x1010) !== d.length) problems.push('no build CRC');
  if (imageMarker(d)?.model !== model) problems.push(`not RaptHooker firmware for ${model}`);
  return problems;
}

/** Compares dotted versions (1.2.10 > 1.2.9). A pre-release (1.0.0-beta) comes before its release. */
export function compareVersions(a: string, b: string): number {
  const [ma = '', pa = ''] = a.split('-', 2);
  const [mb = '', pb = ''] = b.split('-', 2);
  const na = ma.split('.').map(Number);
  const nb = mb.split('.').map(Number);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (na[i] ?? 0) - (nb[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (pa === pb) return 0;
  if (!pa) return 1;
  if (!pb) return -1;
  return pa < pb ? -1 : 1;
}

export const md5 = (data: Uint8Array) => createHash('md5').update(data).digest('hex');

/** The firmware for each model, from the images themselves. An image that fails its own checks is left out. */
export function loadFirmware(files: Uint8Array[] = loadFirmwareFiles()): Map<string, FirmwareImage> {
  const out = new Map<string, FirmwareImage>();
  for (const raw of files) {
    const data = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    const marker = imageMarker(data);
    if (!marker || imageProblems(data).length) continue;
    out.set(marker.model, { ...marker, size: data.length, md5: md5(data), data });
  }
  return out;
}
