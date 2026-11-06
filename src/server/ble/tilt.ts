/**
 * Tilt hydrometers broadcast an Apple iBeacon (company id 0x004C) every few seconds. The format is public and used by
 * Tilt's own apps and by Home Assistant's tilt-ble (Bluetooth-Devices/tilt-ble, MIT), which this follows:
 *
 *   02 15  uuid:16  major:u16  minor:u16  power:i8      (big-endian)
 *
 * The UUID says the Tilt's colour (A495BB10-C5B1-4B44-B512-1370F02D74DE is red, …20… green, up to …80… pink). major
 * is the temperature in °F and minor the gravity × 1000; a Tilt Pro sends both with one more digit (°F × 10 and
 * SG × 10000), which shows as a minor of 5000 or more. Tilts also send a beacon now and then with a temperature of 999
 * that isn't a reading; it's left out like any temperature no fermentation could have. What the power byte means
 * depends on the firmware (transmit power, or weeks since the battery was changed), so it isn't used.
 */

import { APPLE_COMPANY_ID } from './rapt.js';

export const TILT_COLORS = ['Red', 'Green', 'Black', 'Purple', 'Orange', 'Blue', 'Yellow', 'Pink'] as const;
export type TiltColor = (typeof TILT_COLORS)[number];

/** After the company id: the iBeacon type (02 15), then the first three bytes every Tilt UUID starts with. */
export const TILT_PREFIX: readonly number[] = [0x02, 0x15, 0xa4, 0x95, 0xbb];
/** The rest of a Tilt's UUID after the colour byte (C5B1-4B44-B512-1370F02D74DE). */
const TILT_UUID_TAIL = [0xc5, 0xb1, 0x4b, 0x44, 0xb5, 0x12, 0x13, 0x70, 0xf0, 0x2d, 0x74, 0xde];

export interface TiltMetrics {
  color: TiltColor;
  pro: boolean;
  /** °C */
  temp: number;
  sg: number;
}

export type TiltAdvert = { kind: 'tilt'; metrics: TiltMetrics; fingerprint: string };

/** The colour of a Tilt's iBeacon (manufacturer data under Apple's company id), or null if it isn't one. */
export function tiltColorOf(data: Uint8Array | undefined): TiltColor | null {
  if (!data || data.length !== 23 || !TILT_PREFIX.every((b, i) => data[i] === b)) return null;
  if (!TILT_UUID_TAIL.every((b, i) => data[6 + i] === b)) return null;
  const c = data[5]!;
  return (c & 0x0f) === 0 ? (TILT_COLORS[(c >> 4) - 1] ?? null) : null;
}

export const isTiltBeacon = (data: Uint8Array | undefined): boolean => tiltColorOf(data) !== null;

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

export function decodeTilt(companyId: number, data: Uint8Array): TiltAdvert | null {
  if (companyId !== APPLE_COMPANY_ID) return null;
  const color = tiltColorOf(data);
  if (!color) return null;
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const major = buf.readUInt16BE(18);
  const minor = buf.readUInt16BE(20);
  const pro = minor >= 5000;
  const tempF = major / (pro ? 10 : 1);
  const sg = minor / (pro ? 10000 : 1000);
  const temp = round(((tempF - 32) * 5) / 9, 4);
  // 999 °F (a beacon that isn't a reading), or something no fermentation could be at.
  if (!(temp >= -40 && temp <= 125) || !(sg > 0)) return null;
  const metrics: TiltMetrics = { color, pro, temp, sg: round(sg, 5) };
  return { kind: 'tilt', metrics, fingerprint: `${sg}|${temp}` };
}

/** A Tilt's iBeacon as BlueZ presents it (under Apple's company id); used by the simulator and tests. */
export function encodeTilt(m: { color: TiltColor; pro?: boolean; tempF: number; sg: number; power?: number }): Buffer {
  const buf = Buffer.alloc(23);
  Buffer.from([...TILT_PREFIX, (TILT_COLORS.indexOf(m.color) + 1) << 4, ...TILT_UUID_TAIL]).copy(buf);
  buf.writeUInt16BE(Math.round(m.tempF * (m.pro ? 10 : 1)), 18);
  buf.writeUInt16BE(Math.round(m.sg * (m.pro ? 10000 : 1000)), 20);
  buf.writeInt8(m.power ?? -59, 22);
  return buf;
}
