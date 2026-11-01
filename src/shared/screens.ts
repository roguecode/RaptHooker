import { z } from 'zod';
import { SCREEN_ITEMS, SCREEN_PALETTES, SCREEN_RANGES, SCREEN_THEMES, type ScreenOptions } from './screen.js';

/**
 * Screens: small Wi-Fi displays RaptHooker sets up (it puts its own firmware on them over their hotspot) and then
 * looks after over the network. Each shows a picture from /api/screens/:id/image.jpg, drawn the same way as an image
 * link, and fetches it again every `interval` seconds.
 */

export interface ScreenModel {
  id: string;
  name: string;
  width: number;
  height: number;
}

/** The screens RaptHooker can set up. `id` is the firmware's model (RH_MODEL); `name` is shown as it is (not translated). */
export const SCREEN_MODELS: readonly ScreenModel[] = [
  { id: 'sdpro-240', name: 'Geekmagic Ultra/Smart weather clock', width: 240, height: 240 },
];

export const screenModel = (id: string): ScreenModel | undefined => SCREEN_MODELS.find((m) => m.id === id);

/** How a screen's picture looks: an image link's options apart from the size, which is the screen's own. */
export type ScreenLook = Omit<ScreenOptions, 'width' | 'height'>;

export type ScreenState = 'online' | 'late' | 'offline' | 'unknown';

export interface ScreenStatus {
  /** online: fetched its picture lately; late: missed a few; offline: not for a while; unknown: not since the hub started. */
  state: ScreenState;
  /** When it last fetched its picture. */
  lastSeenAt: number | null;
  /** Wi-Fi signal, dBm. */
  rssi: number | null;
  /** Seconds since it started. */
  uptime: number | null;
  /** Pictures it couldn't fetch in a row, as it last said. */
  failures: number | null;
  /** A newer firmware this hub has for it, or null. */
  update: string | null;
  /** RaptHooker is putting new firmware on it right now. */
  updating: boolean;
  /** The last thing that went wrong talking to it, or null. */
  error: string | null;
}

export interface ScreenDevice {
  /** Its MAC address, lower-case hex without colons. Never changes. */
  id: string;
  name: string;
  /** A ScreenModel id. */
  model: string;
  /** AA:BB:CC:DD:EE:FF */
  mac: string;
  /** Its mDNS name without .local, e.g. rh-screen-1c1802. */
  hostname: string;
  ip: string | null;
  /** The pill (or other device) it shows, or null for all of them. */
  pillId: string | null;
  look: ScreenLook;
  /** Seconds between pictures. */
  interval: number;
  /** Backlight, percent. */
  brightness: number;
  /** The firmware version it last reported. */
  firmware: string | null;
  createdAt: number;
  status: ScreenStatus;
}

/** What it is, going by a Wi-Fi network's name: a screen's own hotspot, or nothing RaptHooker knows. */
export type HotspotKind = 'sdpro' | 'rapthooker';

/** Stock "Smart weather clock" hotspots ("… Pro" on some), and RaptHooker firmware's own. */
export function hotspotKind(ssid: string): HotspotKind | null {
  if (/^smart weather clock/i.test(ssid)) return 'sdpro';
  if (/^RaptHooker-Screen-[0-9A-F]{6}$/i.test(ssid)) return 'rapthooker';
  return null;
}

/** The hotspot RaptHooker firmware opens: named after the last three bytes of the MAC address. */
export function screenHotspot(mac: string): string {
  return `RaptHooker-Screen-${mac
    .replace(/[^0-9a-f]/gi, '')
    .slice(-6)
    .toUpperCase()}`;
}

export interface WifiNetwork {
  ssid: string;
  bssid: string;
  /** Percent. */
  signal: number;
  channel: number;
  /** GHz: 2.4, 5 or 6. Screens only use 2.4. */
  band: number;
  secure: boolean;
  kind: HotspotKind | null;
  /** The hub is on it now. */
  current: boolean;
}

export interface WifiStatus {
  /** The hub can switch Wi-Fi networks itself, so it can set screens up. */
  canSetUp: boolean;
  /** Why not, when it can't. */
  reason: string | null;
  /** The hub's own Wi-Fi network, if it's on one. */
  ssid: string | null;
  /** Its channel (a screen joining the same network is moved to it first). */
  channel: number | null;
  /** Setting a screen up takes the hub off the network for a minute (Wi-Fi is its only connection). */
  goesOffline: boolean;
  /** The hub can fill in its own network's password. */
  knowsPassword: boolean;
}

export type ScreenSetupStep = 'hotspot' | 'identify' | 'install' | 'restart' | 'screen' | 'wifi' | 'back' | 'find' | 'done';

export const SCREEN_SETUP_STEPS: readonly ScreenSetupStep[] = [
  'hotspot',
  'identify',
  'install',
  'restart',
  'screen',
  'wifi',
  'back',
  'find',
  'done',
];

/** Why a set-up failed, for the app to explain in its own words. `detail` has the specifics. */
export type ScreenSetupError =
  | 'busy'
  | 'no-wifi-control'
  | 'hotspot-failed'
  | 'not-supported'
  | 'install-failed'
  | 'no-restart'
  | 'on-network'
  | 'screen-unreachable'
  | 'wrong-password'
  | 'network-not-found'
  | 'no-address'
  | 'wifi-failed'
  | 'not-found'
  | 'no-password'
  | 'failed';

/** What a screen's failed try at joining a network (its /api/setup "error") means. */
export function screenTrialError(error: string): ScreenSetupError {
  if (/password/i.test(error)) return 'wrong-password';
  if (/not found/i.test(error)) return 'network-not-found';
  if (/address|dhcp/i.test(error)) return 'no-address';
  return 'wifi-failed';
}

export interface ScreenSetupProgress {
  id: string;
  /** The hotspot it started from. */
  hotspot: string;
  step: ScreenSetupStep;
  state: 'running' | 'done' | 'failed';
  error: ScreenSetupError | null;
  /** Specifics: what the screen or the network said. */
  detail: string | null;
  /** The new screen, once it's saved. */
  screenId: string | null;
  /** Whether the hub got back on its own network (false only if something is badly wrong). */
  hubBack: boolean;
  startedAt: number;
  updatedAt: number;
  /** The steps reached, in order. */
  steps: { step: ScreenSetupStep; at: number }[];
}

/** A RaptHooker screen heard on the network (mDNS) that this hub doesn't have. */
export interface FoundScreen {
  id: string;
  model: string;
  firmware: string;
  api: number;
  ip: string;
  hostname: string;
  /** Another hub (or a lost database) has it: adding it takes the code it shows. */
  claimed: boolean;
}

/** The firmware this hub has for a model. */
export interface ScreenFirmware {
  model: string;
  version: string;
  size: number;
  md5: string;
}

/** The hub's half of a set-up done from a browser (POST /api/screens/manual). */
export interface ScreenManualStart {
  /** For /api/screens/manual/done. */
  pending: string;
  /** The screen's key for its API. */
  token: string;
  /** The hub's id, for the screen. */
  hub: string;
  /** Where screens fetch pictures, before the screen's id (…/api/screens/), or null if the hub has no LAN address. */
  imageBase: string | null;
  firmware: ScreenFirmware[];
}

const lookFields = {
  theme: z.enum(SCREEN_THEMES),
  palette: z.enum(SCREEN_PALETTES),
  show: z.array(z.enum(SCREEN_ITEMS)).max(SCREEN_ITEMS.length),
  range: z.enum(SCREEN_RANGES),
  gravity: z.enum(['sg', 'plato']),
  temperature: z.enum(['C', 'F']),
  lang: z.string().max(35),
  tz: z.string().max(64).nullable(),
  brewing: z.boolean(),
};

export const screenLookSchema = z.object(lookFields).partial();

export const screenPatchSchema = z.object({
  name: z.string().trim().min(1).max(32).optional(),
  pillId: z.string().min(1).max(64).nullable().optional(),
  look: screenLookSchema.optional(),
  interval: z.number().int().min(15).max(86_400).optional(),
  brightness: z.number().int().min(1).max(100).optional(),
});
export type ScreenPatch = z.infer<typeof screenPatchSchema>;

export const screenSetupSchema = z.object({
  /** The screen's hotspot. */
  hotspot: z.string().min(1).max(32),
  /** The network the screen joins. */
  ssid: z.string().min(1).max(32),
  /** Its password. Empty: the hub's own saved one (when ssid is the hub's network). */
  password: z.string().max(64).default(''),
  name: z.string().trim().min(1).max(32),
  pillId: z.string().min(1).max(64).nullable().default(null),
  look: screenLookSchema.default({}),
});
export type ScreenSetupInput = z.infer<typeof screenSetupSchema>;

export const screenAdoptSchema = z.object({
  id: z.string().regex(/^[0-9a-f]{12}$/),
  /** The code the screen shows. Without it, the screen is asked to show one. */
  code: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
  name: z.string().trim().min(1).max(32).optional(),
  look: screenLookSchema.optional(),
});

/** Set-up from this browser, for hubs that can't switch Wi-Fi: the hub's half, before and after. */
export const screenManualSchema = z.object({
  name: z.string().trim().min(1).max(32),
  pillId: z.string().min(1).max(64).nullable().default(null),
  look: screenLookSchema.default({}),
});

export const screenManualDoneSchema = z.object({
  /** The pending set-up's id from /api/screens/manual. */
  pending: z.string().min(1).max(64),
  /** What the screen said at /api/info on its hotspot. */
  id: z.string().regex(/^[0-9a-f]{12}$/),
  model: z.string().min(1).max(32),
  ip: z.string().max(64).nullable().default(null),
});
