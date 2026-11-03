import { z } from 'zod';
import type { DeviceKind } from './types.js';
import type { WifiStatus } from './screens.js';
import { platoToSg } from './units.js';

/**
 * iSpindel: a Wi-Fi hydrometer (an ESP8266 in a floating tube) that wakes up every so often and posts its readings.
 * Set to the "HTTP" service it posts JSON to a server, port and path of your choosing (see docs/ispindel.md):
 *
 *   {"name":"iSpindel000","ID":6592575,"token":"…","angle":52.3,"temperature":20.1,"temp_units":"C",
 *    "battery":4.13,"gravity":1.045,"interval":900,"RSSI":-61}
 *
 * ID is the ESP8266's chip id (the last three bytes of its MAC address), which never changes. battery is in volts,
 * gravity is whatever the iSpindel's own formula gives (SG or °Plato) and RSSI is its Wi-Fi signal.
 */

/** Where iSpindels post their readings on the hub. */
export const ISPINDEL_PATH = '/api/ispindel';

/** Device addresses of iSpindels: never confused with a Bluetooth address. */
export const ISPINDEL_PREFIX = 'ISPINDEL:';

/** Kinds of device that measure gravity (a RAPT Thermometer doesn't). */
export const measuresGravity = (kind: DeviceKind | string | undefined): boolean => kind === 'pill' || kind === 'ispindel';

export const isIspindelAddress = (address: string): boolean => address.trim().toUpperCase().startsWith(ISPINDEL_PREFIX);

/** An iSpindel's chip id as the hex in its address (6592575 → "64983F"). */
export function chipIdHex(id: number): string {
  return Math.trunc(id).toString(16).toUpperCase().padStart(6, '0');
}

/** The device address for an iSpindel's chip id. */
export const ispindelAddress = (id: number): string => `${ISPINDEL_PREFIX}${chipIdHex(id)}`;

/** The device id for an iSpindel address ("ISPINDEL:64983F" → "ispindel-64983f"). */
export const ispindelId = (address: string): string => `ispindel-${address.trim().slice(ISPINDEL_PREFIX.length).toLowerCase()}`;

/**
 * The chip id an iSpindel will post, from the address of its setup hotspot: an ESP8266's hotspot uses its own MAC
 * address with the "locally administered" bit set, and the chip id is the last three bytes of it.
 */
export function chipIdFromBssid(bssid: string): string | null {
  const hex = bssid.replace(/[^0-9a-f]/gi, '');
  return hex.length === 12 ? hex.slice(-6).toUpperCase() : null;
}

/** An iSpindel's setup hotspot: open, and named "iSpindel" (older firmware) or "iSpindel_<name or chip id>". */
export function isIspindelHotspot(ssid: string, secure: boolean): boolean {
  return !secure && /^iSpindel(_.*)?$/i.test(ssid.trim());
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

/**
 * Text with HTML character references decoded. iSpindel firmware writes its settings into its setup page as &#NN; for
 * every byte that isn't a letter or digit (so a non-ASCII character is several of them, one per UTF-8 byte), and when
 * its setup mode times out without a save it posts its name and token that way too.
 */
export function decodeHtmlEntities(s: string): string {
  if (!s.includes('&')) return s;
  const re = /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi;
  const parts: (string | number)[] = [];
  let at = 0;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    parts.push(s.slice(at, m.index));
    const e = m[1]!;
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      parts.push(Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? code : m[0]);
    } else {
      parts.push(NAMED_ENTITIES[e.toLowerCase()] ?? m[0]);
    }
    at = re.lastIndex;
  }
  parts.push(s.slice(at));
  // Numbers under 256 are taken as UTF-8 bytes, as the firmware means them; if that isn't valid UTF-8, as characters.
  // (Percent-encoded, decodeURIComponent checks and decodes UTF-8 with nothing but the language itself.)
  try {
    return decodeURIComponent(
      parts
        .map((p) =>
          typeof p !== 'number'
            ? encodeURIComponent(p)
            : p < 256
              ? `%${p.toString(16).padStart(2, '0')}`
              : encodeURIComponent(String.fromCodePoint(p)),
        )
        .join(''),
    );
  } catch {
    return parts.map((p) => (typeof p === 'number' ? String.fromCodePoint(p) : p)).join('');
  }
}

/**
 * An estimate of how full an iSpindel's battery is (an 18650 Li-ion cell), %, from its voltage at rest. Rough: it
 * follows a typical cell's discharge curve.
 */
const BATTERY_CURVE: readonly [number, number][] = [
  [3.3, 0],
  [3.6, 10],
  [3.7, 20],
  [3.75, 30],
  [3.79, 40],
  [3.83, 50],
  [3.87, 60],
  [3.92, 70],
  [3.97, 80],
  [4.05, 90],
  [4.15, 100],
];

export function batteryPercentFromVolts(volts: number): number {
  const first = BATTERY_CURVE[0]!;
  const last = BATTERY_CURVE[BATTERY_CURVE.length - 1]!;
  if (volts <= first[0]) return 0;
  if (volts >= last[0]) return 100;
  for (let i = 1; i < BATTERY_CURVE.length; i++) {
    const [v1, p1] = BATTERY_CURVE[i]!;
    const [v0, p0] = BATTERY_CURVE[i - 1]!;
    if (volts <= v1) return Math.round((p0 + ((volts - v0) / (v1 - v0)) * (p1 - p0)) * 10) / 10;
  }
  return 100;
}

const num = z
  .union([
    z.number(),
    z
      .string()
      .trim()
      .regex(/^-?\d+(\.\d+)?$/)
      .transform(Number),
  ])
  .pipe(z.number().finite());

/**
 * What an iSpindel posts (HTTP service). Lenient: firmware versions and forks add fields (ignored) and some send
 * numbers as text. The hub's iSpindel token can be in `token` (the iSpindel's Token field). A name and token sent
 * HTML-encoded (as an iSpindel does after its setup mode times out) are decoded.
 */
export const ispindelPostSchema = z.object({
  name: z
    .string()
    .max(400)
    .transform((s) => decodeHtmlEntities(s).slice(0, 64))
    .optional(),
  ID: z.union([
    z.number().int().nonnegative().max(0xffffffff),
    z
      .string()
      .regex(/^\d{1,10}$/)
      .transform(Number),
  ]),
  token: z.string().max(400).transform(decodeHtmlEntities).optional(),
  angle: num.optional(),
  tilt: num.optional(),
  temperature: num,
  temp_units: z.string().max(8).optional(),
  battery: num.optional(),
  gravity: num.optional(),
  /** GravityMon (firmware for the same hardware) says which unit the gravity is in: G (SG) or P (°Plato). */
  'gravity-unit': z.string().max(8).optional(),
  interval: num.optional(),
  RSSI: num.optional(),
});
export type IspindelPost = z.infer<typeof ispindelPostSchema>;

/** A post's temperature in °C. */
export function ispindelTempC(temperature: number, units: string | undefined): number {
  const u = (units ?? 'C').trim().toUpperCase();
  const c = u === 'F' ? ((temperature - 32) * 5) / 9 : u === 'K' ? temperature - 273.15 : temperature;
  return Math.round(c * 1e4) / 1e4;
}

/**
 * A post's gravity as SG, or null when there's none. Its own formula can give °Plato: GravityMon says so, otherwise a
 * value no SG could be (over 1.5) is taken as °Plato.
 */
export function ispindelGravitySg(gravity: number | undefined, unit: string | undefined): number | null {
  if (gravity === undefined || !Number.isFinite(gravity) || gravity <= 0) return null;
  const u = unit?.trim().toUpperCase();
  const plato = u === 'P' || (u !== 'G' && gravity > 1.5);
  const sg = plato ? platoToSg(gravity) : gravity;
  return Number.isFinite(sg) ? Math.round(sg * 1e6) / 1e6 : null;
}

/** Tilts that mean it isn't floating: lying on its side, or standing up. */
export const ispindelFloating = (tilt: number | null): boolean => tilt === null || (tilt > 5 && tilt < 85);

/** An iSpindel in setup mode, heard by the hub's Wi-Fi. */
export interface IspindelHotspot {
  ssid: string;
  bssid: string;
  /** The chip id it will post as (from the hotspot's address), hex. */
  chipId: string | null;
  /** Percent. */
  signal: number;
  channel: number;
  /** When the hub last saw it. */
  seenAt: number;
}

/** Where an iSpindel should post to reach this hub. */
export interface IspindelServer {
  /** The hub's IP address on the network (an iSpindel can't look up .local names), or null if it doesn't know. */
  host: string | null;
  /** Every LAN address the hub has, in case the first isn't the one. */
  hosts: string[];
  port: number;
  path: string;
}

export type IspindelSetupStep = 'hotspot' | 'read' | 'configure' | 'back' | 'reading' | 'done';

export const ISPINDEL_SETUP_STEPS: readonly IspindelSetupStep[] = ['hotspot', 'read', 'configure', 'back', 'reading', 'done'];

export type IspindelSetupError =
  'no-wifi-control' | 'busy' | 'no-password' | 'no-address' | 'hotspot-failed' | 'not-ispindel' | 'save-failed';

/** What the hub wrote to the iSpindel, to show. */
export interface IspindelWritten {
  name: string;
  ssid: string;
  server: string;
  port: number;
  path: string;
  interval: number;
}

export interface IspindelSetupProgress {
  id: string;
  hotspot: string;
  chipId: string | null;
  step: IspindelSetupStep;
  state: 'running' | 'done' | 'failed';
  error: IspindelSetupError | null;
  detail: string | null;
  /** The device once it's been added (when its first reading arrived). */
  deviceId: string | null;
  /** Done, but no reading yet: it's added as soon as one comes (for a while). */
  waiting: boolean;
  written: IspindelWritten | null;
  /** The hub got back on its own network (false: it may be unreachable). */
  hubBack: boolean;
  startedAt: number;
  updatedAt: number;
  steps: { step: IspindelSetupStep; at: number }[];
}

/** Everything the Add device dialog's iSpindel tab shows. */
export interface IspindelInfo {
  /** The token iSpindels send; only the owner gets it. */
  token: string | null;
  server: IspindelServer;
  wifi: WifiStatus;
  hotspots: IspindelHotspot[];
  scannedAt: number | null;
  setup: IspindelSetupProgress | null;
}

export const ISPINDEL_INTERVALS = [300, 600, 900, 1800, 3600] as const;

export const ispindelSetupSchema = z.object({
  /** The iSpindel's hotspot. */
  hotspot: z.string().trim().min(1).max(32),
  /** The Wi-Fi it should join, or '' to keep the one it has. */
  ssid: z.string().max(32).default(''),
  /** Empty for the hub's own network uses the password the hub has. */
  password: z.string().max(64).default(''),
  /** Its new name, or '' to keep its own. */
  name: z.string().trim().max(32).default(''),
  /** Seconds between readings. */
  interval: z.number().int().min(60).max(3600).default(900),
});
export type IspindelSetupInput = z.infer<typeof ispindelSetupSchema>;
