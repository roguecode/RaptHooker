/**
 * RAPT Pill Bluetooth advertisements, as documented by KegLand ("Pill Hydrometer Bluetooth Transmissions",
 * gitlab.com/rapt.io/public wiki) and cross-checked with sairon/rapt-ble (MIT).
 *
 * BlueZ gives manufacturer data keyed by the 16-bit company id with the id itself removed, so for the "RA"
 * company id (0x4152) the data starts with "PT" (the rest of "RAPT"). Everything is big-endian:
 *
 *   v1: "PT" 01 mac[6] temp:u16 gravity:f32 x:i16 y:i16 z:i16 battery:u16
 *   v2: "PT" 02 00 velocityValid:u8 velocity:f32 temp:u16 gravity:f32 x:i16 y:i16 z:i16 battery:u16
 *
 * temp is Kelvin × 128, gravity is SG × 1000, x/y/z are raw accelerometer × 16 and battery is % × 256.
 * Every 10th transmission also carries "PTd" + device type (e.g. PillG1) under 0x4152, and "G" + firmware version
 * under 0x454B (the "KE" of "KEG"; company ids are little-endian, so "RA" is 0x4152 and "KE" is 0x454B).
 *
 * The RAPT Bluetooth Thermometer (KL24334) broadcasts an Apple iBeacon (company id 0x004C) about once a second. KegLand
 * doesn't document it; this was worked out from a thermometer at rest, in warm water and in iced water:
 *
 *   02 15  uuid:16  temp:u16  ?:u16  power:i8      (uuid = "Keg" + 9 bytes + "Land"; the 9 bytes never changed)
 *
 * temp is Kelvin × 64, in 0.1 °C steps. What the second u16 (always 0x4000 so far) and the power byte mean isn't known.
 */

export const RAPT_COMPANY_ID = 0x4152;
/** "KE" (0x4B, 0x45 on air, read little-endian like every company id). */
export const KEG_COMPANY_ID = 0x454b;
/** Apple's company id, which iBeacons (and so the RAPT Bluetooth Thermometer) broadcast under. */
export const APPLE_COMPANY_ID = 0x004c;
/** The start of a RAPT Thermometer's manufacturer data after the company id: iBeacon (02 15), then "Keg". */
export const THERMOMETER_PREFIX: readonly number[] = [0x02, 0x15, 0x4b, 0x65, 0x67];
const LAND = [0x4c, 0x61, 0x6e, 0x64];

export interface RaptMetrics {
  version: number;
  /** Registration MAC (v1 only). */
  mac: string | null;
  sg: number;
  temp: number;
  velocity: number | null;
  battery: number;
  x: number;
  y: number;
  z: number;
}

export type RaptAdvert =
  | { kind: 'metrics'; metrics: RaptMetrics; fingerprint: string }
  | { kind: 'deviceType'; deviceType: string }
  | { kind: 'firmware'; firmware: string }
  /** A RAPT Bluetooth Thermometer's temperature, °C. */
  | { kind: 'thermometer'; temp: number };

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

const ascii = (bytes: Uint8Array) =>
  Buffer.from(bytes)
    .toString('latin1')
    .replace(/[^\x20-\x7e]/g, '')
    .trim();

/** Identifies a reading by its values, so repeats (and the previous reading re-sent before each new one) are skipped. */
export function fingerprintOf(m: {
  sg: number | null;
  temp: number;
  battery: number | null;
  x: number | null;
  y: number | null;
  z: number | null;
  velocity: number | null;
}): string {
  return [m.sg, m.temp, m.battery, m.x, m.y, m.z, m.velocity ?? '-'].join('|');
}

/** Whether manufacturer data under Apple's company id is a RAPT Thermometer's iBeacon. */
export function isThermometerBeacon(data: Uint8Array | undefined): boolean {
  return !!data && data.length === 23 && THERMOMETER_PREFIX.every((b, i) => data[i] === b) && LAND.every((b, i) => data[14 + i] === b);
}

export function decodeRapt(companyId: number, data: Uint8Array): RaptAdvert | null {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (companyId === APPLE_COMPANY_ID) {
    if (!isThermometerBeacon(data)) return null;
    const temp = Math.round((buf.readUInt16BE(18) / 64 - 273.15) * 10) / 10 || 0;
    // Outside what the thermometer can measure: not a reading.
    return temp >= -40 && temp <= 125 ? { kind: 'thermometer', temp } : null;
  }
  if (companyId === KEG_COMPANY_ID) {
    if (buf.length < 2 || buf[0] !== 0x47) return null;
    const firmware = ascii(buf.subarray(1));
    return firmware ? { kind: 'firmware', firmware } : null;
  }
  if (companyId !== RAPT_COMPANY_ID || buf.length < 3 || buf[0] !== 0x50 || buf[1] !== 0x54) return null;

  if (buf[2] === 0x64) {
    const deviceType = ascii(buf.subarray(3));
    return deviceType ? { kind: 'deviceType', deviceType } : null;
  }
  if (buf.length !== 23) return null;

  const version = buf[2]!;
  let mac: string | null = null;
  let velocity: number | null = null;
  if (version === 1) {
    mac = [...buf.subarray(3, 9)].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
  } else if (version >= 2) {
    // A version newer than 2 is read like v2 (as rapt-ble does); its layout may differ.
    velocity = buf[4] === 1 ? buf.readFloatBE(5) : null;
  } else {
    return null;
  }

  const sg = buf.readFloatBE(11) / 1000;
  const temp = buf.readUInt16BE(9) / 128 - 273.15;
  // Out of liquid the pill still sends a gravity worked out from its tilt, which can be anything (0.2, 1.3...).
  // That's what it reported, so it's kept; only values that aren't numbers at all are dropped.
  if (!Number.isFinite(sg)) return null;

  const metrics: RaptMetrics = {
    version,
    mac,
    sg: round(sg, 6),
    temp: round(temp, 4),
    velocity: velocity === null || !Number.isFinite(velocity) ? null : round(velocity, 4),
    battery: round(buf.readUInt16BE(21) / 256, 2),
    x: buf.readInt16BE(15) / 16,
    y: buf.readInt16BE(17) / 16,
    z: buf.readInt16BE(19) / 16,
  };
  return { kind: 'metrics', metrics, fingerprint: fingerprintOf(metrics) };
}

/** Builds a v2 metrics payload (as BlueZ presents it); used by the simulator and tests. */
export function encodeRaptV2(m: {
  sg: number;
  temp: number;
  velocity: number | null;
  battery: number;
  x: number;
  y: number;
  z: number;
}): Buffer {
  const buf = Buffer.alloc(23);
  buf.write('PT', 0, 'latin1');
  buf[2] = 2;
  buf[3] = 0;
  buf[4] = m.velocity === null ? 0 : 1;
  buf.writeFloatBE(m.velocity ?? 0, 5);
  buf.writeUInt16BE(Math.round((m.temp + 273.15) * 128), 9);
  buf.writeFloatBE(m.sg * 1000, 11);
  buf.writeInt16BE(Math.round(m.x * 16), 15);
  buf.writeInt16BE(Math.round(m.y * 16), 17);
  buf.writeInt16BE(Math.round(m.z * 16), 19);
  buf.writeUInt16BE(Math.max(0, Math.min(65535, Math.round(m.battery * 256))), 21);
  return buf;
}

/** The UUID heard from a real RAPT Thermometer (its middle 9 bytes may differ between thermometers). */
const THERMOMETER_UUID = '4b6567b722314977852625b74c616e64';

/** Builds a RAPT Thermometer iBeacon (as BlueZ presents it, under Apple's company id); used by the simulator and tests. */
export function encodeRaptThermometer(temp: number): Buffer {
  const buf = Buffer.alloc(23);
  buf[0] = 0x02;
  buf[1] = 0x15;
  buf.write(THERMOMETER_UUID, 2, 'hex');
  buf.writeUInt16BE(Math.round((temp + 273.15) * 64), 18);
  buf.writeUInt16BE(0x4000, 20);
  return buf;
}
