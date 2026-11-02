/**
 * The screen firmware's settings sector (firmware/screen/src/store.cpp): "RHS1", the JSON's length and its CRC-32,
 * then the JSON, in 4 KB. Over USB the hub writes it straight into an ESP32 board's rhscreen partition, so the
 * firmware starts already set up.
 */

const MAGIC = 0x31534852;
export const SECTOR = 0x1000;
const HEADER = 12;

/** The settings the firmware reads (Settings in store.h). Keys it doesn't know are kept when it saves. */
export interface SectorSettings {
  v: 1;
  ssid: string;
  pass: string;
  token: string;
  hub: string;
  name: string;
  imageUrl: string;
  interval: number;
  brightness: number;
  panel?: number;
}

let table: Uint32Array | null = null;

/** CRC-32 (IEEE, as zlib), the same as the firmware's. */
export function crc32(data: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of data) c = table[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function settingsSector(settings: SectorSettings): Buffer {
  const body = Buffer.from(JSON.stringify(settings), 'utf8');
  if (body.length > SECTOR - HEADER) throw new Error('settings too big');
  const out = Buffer.alloc(SECTOR, 0xff);
  out.writeUInt32LE(MAGIC, 0);
  out.writeUInt32LE(body.length, 4);
  out.writeUInt32LE(crc32(body), 8);
  body.copy(out, HEADER);
  return out;
}

/** The settings in a sector, or null if it hasn't got any (or they're damaged). */
export function readSettingsSector(sector: Uint8Array): Record<string, unknown> | null {
  const b = Buffer.from(sector.buffer, sector.byteOffset, sector.byteLength);
  if (b.length < HEADER || b.readUInt32LE(0) !== MAGIC) return null;
  const len = b.readUInt32LE(4);
  if (!len || len > SECTOR - HEADER || HEADER + len > b.length) return null;
  const body = b.subarray(HEADER, HEADER + len);
  if (crc32(body) !== b.readUInt32LE(8)) return null;
  try {
    return JSON.parse(body.toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}
