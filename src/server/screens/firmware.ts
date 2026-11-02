import { createHash } from 'node:crypto';
import { screenModel } from '@rapthooker/shared';
import { loadFirmwareFiles, type FirmwareFile } from './firmware-files.js';

/**
 * The firmware RaptHooker puts on screens (firmware/screen, built into bin/ and shipped inside the server), and the
 * checks an image has to pass before it's sent anywhere: the stock firmware on a new screen does no checking at all.
 */

export interface FirmwareImage {
  model: string;
  chip: 'esp8266' | 'esp32';
  version: string;
  size: number;
  md5: string;
  data: Buffer;
  /**
   * ESP32 boards: the flash from ESP32_BOOT_AT up to the app (boot loader, partition table, an empty NVS and OTA data
   * that starts app0), written with the app the first time over USB. Null where there's none (or it failed its checks).
   */
  boot: Buffer | null;
}

/** Where things go in an ESP32 board's flash (firmware/screen/partitions-esp32.csv). */
export const ESP32_BOOT_AT = 0x1000;
export const ESP32_APP_AT = 0x10000;
export const ESP32_APP_SIZE = 0x1e0000;
export const ESP32_SETTINGS_AT = 0x3d0000;
const ESP32_PARTITIONS_AT = 0x8000;

/** The stock firmware drops everything past this and installs the rest anyway, which would brick the screen. */
export const STOCK_OTA_LIMIT = 0x80000;
/** What RaptHooker sends to a stock screen at most, leaving a margin. */
export const STOCK_SAFE_SIZE = 0x7c000;

const MARKER = 'RHSCREEN-FW:';

/**
 * The model and version written into a RaptHooker firmware image, or null if it hasn't got them. The firmware also
 * carries the marker without a version (what an update has to have), so every one is tried.
 */
export function imageMarker(data: Uint8Array): { model: string; version: string } | null {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  for (let at = buf.indexOf(MARKER); at >= 0; at = buf.indexOf(MARKER, at + 1)) {
    const end = buf.indexOf(0, at);
    const m = /^RHSCREEN-FW:([a-z0-9-]+):(\d+\.\d+\.\d+[0-9A-Za-z.-]*)/.exec(buf.subarray(at, end < 0 ? at + 80 : end).toString('latin1'));
    if (m) return { model: m[1]!, version: m[2]! };
  }
  return null;
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

/**
 * What's wrong with an ESP32 app image (empty if nothing): the header (ESP32, SHA-256 appended), every segment inside
 * the file, the checksum, the SHA-256, and that it fits the app partition. The board's own update code checks the
 * same again before it starts it.
 */
export function esp32ImageProblems(d: Uint8Array): string[] {
  if (d.length < 64 || d[0] !== 0xe9) return ['not ESP32 firmware'];
  if ((d[12]! | (d[13]! << 8)) !== 0) return ['not for the ESP32'];
  const segs = d[1]!;
  if (!segs || segs > 16) return ['bad segment count'];
  if (d[23] !== 1) return ['no SHA-256'];
  let pos = 24;
  let sum = 0xef;
  for (let s = 0; s < segs; s++) {
    if (pos + 8 > d.length) return ['segment past the end'];
    const len = u32(d, pos + 4);
    if (pos + 8 + len > d.length) return ['segment past the end'];
    for (let i = pos + 8; i < pos + 8 + len; i++) sum ^= d[i]!;
    pos += 8 + len;
  }
  while ((pos + 1) % 16) pos++;
  if (d[pos] !== sum) return ['bad checksum'];
  if (pos + 1 + 32 !== d.length) return ['length does not match the segments'];
  const digest = createHash('sha256')
    .update(d.subarray(0, pos + 1))
    .digest();
  if (!digest.equals(Buffer.from(d.subarray(pos + 1)))) return ["SHA-256 doesn't match"];
  if (d.length > ESP32_APP_SIZE) return [`${d.length} bytes is over the ${ESP32_APP_SIZE} the app partition holds`];
  return [];
}

/** An ESP32 partition table's entries (stops at the first that isn't one). */
export function partitionTable(d: Uint8Array): { label: string; type: number; subtype: number; offset: number; size: number }[] {
  const out: { label: string; type: number; subtype: number; offset: number; size: number }[] = [];
  for (let at = 0; at + 32 <= d.length && d[at] === 0xaa && d[at + 1] === 0x50; at += 32) {
    const label = Buffer.from(d.subarray(at + 12, at + 28))
      .toString('latin1')
      .replace(/\0.*$/s, '');
    out.push({ label, type: d[at + 2]!, subtype: d[at + 3]!, offset: u32(d, at + 4), size: u32(d, at + 8) });
  }
  return out;
}

/**
 * What's wrong with an ESP32 boot blob (empty if nothing): a boot loader image at its start, and a partition table
 * with the layout the firmware expects: app0 and app1 big enough, rhscreen where the hub writes the settings.
 */
export function esp32BootProblems(d: Uint8Array): string[] {
  if (d.length !== ESP32_APP_AT - ESP32_BOOT_AT) return ['wrong size'];
  if (d[0] !== 0xe9) return ['no boot loader'];
  const table = d.subarray(ESP32_PARTITIONS_AT - ESP32_BOOT_AT, ESP32_PARTITIONS_AT - ESP32_BOOT_AT + 0xc00);
  const parts = partitionTable(table);
  const md5At = parts.length * 32;
  if (table[md5At] === 0xeb && table[md5At + 1] === 0xeb) {
    const want = Buffer.from(table.subarray(md5At + 16, md5At + 32));
    if (!createHash('md5').update(table.subarray(0, md5At)).digest().equals(want)) return ["partition table MD5 doesn't match"];
  }
  const find = (label: string) => parts.find((p) => p.label === label);
  const app0 = find('app0');
  const app1 = find('app1');
  const settings = find('rhscreen');
  if (!app0 || app0.offset !== ESP32_APP_AT || app0.size < ESP32_APP_SIZE || !app1 || app1.size < ESP32_APP_SIZE)
    return ['unexpected app partitions'];
  if (!settings || settings.offset !== ESP32_SETTINGS_AT || settings.subtype !== 0x40) return ['no rhscreen partition'];
  return [];
}

/** Why an image can't be a screen's firmware (empty if it can), by the chip its model is built for. */
export function firmwareProblems(d: Uint8Array, chip: 'esp8266' | 'esp32'): string[] {
  return chip === 'esp32' ? esp32ImageProblems(d) : imageProblems(d);
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

const buffer = (raw: Uint8Array) => Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);

/**
 * The firmware for each model, from the images themselves (and, for ESP32 boards, <model>.boot.bin beside them). An
 * image that fails its own checks is left out, and a boot blob that does is ignored (the model then can't be set up
 * over USB, but its screens still get updates).
 */
export function loadFirmware(files: FirmwareFile[] = loadFirmwareFiles()): Map<string, FirmwareImage> {
  const out = new Map<string, FirmwareImage>();
  for (const file of files) {
    if (file.name.endsWith('.boot.bin')) continue;
    const data = buffer(file.data);
    const marker = imageMarker(data);
    if (!marker) continue;
    const chip = screenModel(marker.model)?.chip ?? (data[12] === 0 && data[13] === 0 && data[23] === 1 ? 'esp32' : 'esp8266');
    if (firmwareProblems(data, chip).length) continue;
    let boot: Buffer | null = null;
    if (chip === 'esp32') {
      const blob = files.find((f) => f.name === `${marker.model}.boot.bin`);
      if (blob && !esp32BootProblems(blob.data).length) boot = buffer(blob.data);
    }
    out.set(marker.model, { ...marker, chip, size: data.length, md5: md5(data), data, boot });
  }
  return out;
}
