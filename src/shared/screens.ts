import { z } from 'zod';
import { decimalsSchema } from './schemas.js';
import { SCREEN_ITEMS, SCREEN_PALETTES, SCREEN_RANGES, SCREEN_THEMES, type ScreenOptions } from './screen.js';

/**
 * Screens: small Wi-Fi displays RaptHooker sets up (it puts its own firmware on them, over their hotspot or over USB)
 * and then looks after over the network. Each shows a picture from /api/screens/:id/image.jpg, drawn the same way as
 * an image link, and fetches it again every `interval` seconds.
 */

export interface ScreenModel {
  id: string;
  name: string;
  width: number;
  height: number;
  /** The chip its firmware is built for. */
  chip: 'esp8266' | 'esp32';
  /**
   * How RaptHooker first puts its firmware on: 'hotspot' over the screen's own Wi-Fi and its stock firmware's update
   * page; 'usb' plugged into the hub (ESP32 boards, which come with no firmware worth keeping).
   */
  install: 'hotspot' | 'usb';
  /** Its panel can be turned, mirrored and have its colours fixed from RaptHooker (boards whose panels vary). */
  panel: boolean;
  /**
   * Shop listings users have bought one from that then worked with RaptHooker. Shown as just that: not endorsements,
   * and a listing can change what it sends. Screens set up over their hotspot have theirs in SCREEN_STOCKS instead.
   */
  confirmed: readonly { url: string; site: string }[];
}

/** The screens RaptHooker can set up. `id` is the firmware's model (RH_MODEL); `name` is shown as it is (not translated). */
export const SCREEN_MODELS: readonly ScreenModel[] = [
  {
    id: 'sdpro-240',
    name: 'Smart weather clock / GeekMagic Ultra',
    width: 240,
    height: 240,
    chip: 'esp8266',
    install: 'hotspot',
    panel: false,
    confirmed: [],
  },
  {
    id: 'esp32-2432s028',
    name: 'ESP32-2432S028 2.8" (Cheap Yellow Display)',
    width: 320,
    height: 240,
    chip: 'esp32',
    install: 'usb',
    panel: true,
    confirmed: [{ url: 'https://www.aliexpress.com/item/1005010399042230.html', site: 'AliExpress' }],
  },
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
  /** Corrections to its panel (SCREEN_PANEL bits), or null for a model that has none. */
  panel: number | null;
  createdAt: number;
  status: ScreenStatus;
}

/** The "panel" setting's bits, on top of what the firmware picked for the panel it found. */
export const SCREEN_PANEL = { flip: 1, mirror: 2, swap: 4, invert: 8 } as const;

/** The firmware a Wi-Fi screen comes with, which RaptHooker installs its own over. */
export type StockKind = 'sdpro' | 'geekmagic';

/** What it is, going by a Wi-Fi network's name: a screen's own hotspot, or nothing RaptHooker knows. */
export type HotspotKind = StockKind | 'rapthooker';

export interface ScreenStock {
  kind: StockKind;
  /** What it's sold as, shown as it is (not translated). */
  name: string;
  /** The ScreenModel RaptHooker's firmware for it is: the same hardware, whichever firmware it came with. */
  model: string;
  /** The Wi-Fi network it opens when it's new. */
  hotspot: string;
  /** Someone has set one up with RaptHooker and it worked. */
  tested: boolean;
  /** Shop listings users have bought one from that then worked with RaptHooker (as ScreenModel's). */
  confirmed: readonly { url: string; site: string }[];
}

/**
 * The stock firmwares RaptHooker can install over. The unbranded "Smart weather clock" runs "SD Pro" firmware; a
 * genuine GeekMagic Ultra runs GeekMagic's own, on the same hardware (an ESP8266 with a 240 × 240 ST7789).
 */
export const SCREEN_STOCKS: readonly ScreenStock[] = [
  {
    kind: 'sdpro',
    name: 'Smart weather clock',
    model: 'sdpro-240',
    hotspot: 'Smart weather clock',
    tested: true,
    confirmed: [{ url: 'https://www.aliexpress.com/item/1005011924447121.html', site: 'AliExpress' }],
  },
  {
    kind: 'geekmagic',
    name: 'GeekMagic Ultra',
    model: 'sdpro-240',
    hotspot: 'GIFTV',
    tested: true,
    confirmed: [{ url: 'https://www.aliexpress.com/item/1005007542991850.html', site: 'AliExpress' }],
  },
];

export const screenStock = (kind: StockKind): ScreenStock => SCREEN_STOCKS.find((s) => s.kind === kind)!;

/** What a GeekMagic Ultra's own firmware calls the model at /v.json. Other GeekMagic models (the Pro is an ESP32) differ. */
export const GEEKMAGIC_ULTRA = 'SmallTV-Ultra';

/**
 * Stock "Smart weather clock" hotspots ("… Pro" on some), a GeekMagic's own ("GIFTV"), and RaptHooker firmware's own.
 */
export function hotspotKind(ssid: string): HotspotKind | null {
  if (/^smart weather clock/i.test(ssid)) return 'sdpro';
  if (/^GIFTV/i.test(ssid)) return 'geekmagic';
  if (/^RaptHooker-Screen-[0-9A-F]{6}$/i.test(ssid)) return 'rapthooker';
  return null;
}

/** A screen's address on the network as people type it ("http://192.168.1.50/"), or null if it isn't one. */
export function screenAddress(text: string): string | null {
  const host = text
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
  return /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?$/i.test(host) ? host : null;
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
  /** Its channel (a screen joining the same network is moved to it first, when it's 2.4 GHz). */
  channel: number | null;
  /** Its band in GHz (2.4, 5 or 6). A network can have the same name on several. */
  band: number | null;
  /** Setting a screen up takes the hub off the network for a minute (Wi-Fi is its only connection). */
  goesOffline: boolean;
  /** The hub can fill in its own network's password. */
  knowsPassword: boolean;
}

export type ScreenSetupStep = 'hotspot' | 'identify' | 'install' | 'restart' | 'screen' | 'wifi' | 'back' | 'find' | 'done';

/** The steps of a set-up over the screen's hotspot. */
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

/** The steps of a set-up over USB. */
export const SCREEN_USB_STEPS: readonly ScreenSetupStep[] = ['identify', 'install', 'restart', 'wifi', 'find', 'done'];

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
  /** An ESP32 board without RaptHooker's flash layout: it can't keep its settings. */
  | 'no-store'
  | 'not-found'
  | 'no-password'
  | 'no-usb'
  | 'usb-failed'
  | 'usb-busy'
  | 'wrong-board'
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
  /** Over the screen's hotspot, or over USB. Missing from hubs before USB set-up: 'wifi'. */
  via?: 'wifi' | 'usb';
  /** The hotspot it started from, the USB port, or its address on the network. */
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
  /** How far the current step has got, when it's a long one (installing over USB), else null. */
  percent?: number | null;
}

/** A serial port on the hub: where a board plugged into its USB turns up. */
export interface UsbPort {
  /** COM7, /dev/ttyUSB0 */
  path: string;
  /** What the system calls it: "USB-SERIAL CH340 (COM7)", "CP2102 USB to UART Bridge Controller". */
  name: string;
  /** USB vendor and product ids (hex), when the system says. */
  vid: string | null;
  pid: string | null;
  /** A USB-to-serial chip ESP32 boards use: very likely a board. */
  likely: boolean;
  /**
   * What the board on it says it is, asked over the port without restarting it (RaptHooker firmware 1.1.1 and later),
   * or null when it didn't answer (other firmware, older firmware, busy).
   */
  board?: UsbBoardId | null;
}

/** A RaptHooker screen on one of the hub's USB ports, as it answers "?RHSCREEN". */
export interface UsbBoardId {
  /** Its MAC address, lower-case hex without colons: a ScreenDevice id. */
  id: string;
  model: string;
  firmware: string;
  name: string;
  /** The hub it was set up by. */
  hub: string;
  claimed: boolean;
}

export interface UsbStatus {
  /** The hub can put firmware on a board over USB (it has esptool and pyserial). */
  canSetUp: boolean;
  /** Why not, when it can't: 'off', 'no-python', 'no-esptool', 'no-pyserial'. */
  reason: string | null;
  /** The esptool version the hub would use. */
  esptool: string | null;
  ports: UsbPort[];
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
  gravityDecimals: decimalsSchema.nullable(),
  temperatureDecimals: decimalsSchema.nullable(),
  lang: z.string().max(35),
  tz: z.string().max(64).nullable(),
  brewing: z.boolean(),
  alerts: z.boolean(),
};

export const screenLookSchema = z.object(lookFields).partial();

export const screenPatchSchema = z.object({
  name: z.string().trim().min(1).max(32).optional(),
  pillId: z.string().min(1).max(64).nullable().optional(),
  look: screenLookSchema.optional(),
  interval: z.number().int().min(15).max(86_400).optional(),
  brightness: z.number().int().min(1).max(100).optional(),
  /** SCREEN_PANEL bits, for models with `panel`. */
  panel: z.number().int().min(0).max(15).optional(),
});
export type ScreenPatch = z.infer<typeof screenPatchSchema>;

export const screenSetupSchema = z
  .object({
    /** The screen's hotspot. Empty when it's set up from its `address`. */
    hotspot: z.string().max(32).default(''),
    /**
     * Where it is on the hub's network, for a GeekMagic Ultra on its own firmware that has joined it already: the hub
     * installs RaptHooker there instead of on the screen's hotspot, then carries on on RaptHooker's hotspot.
     */
    address: z.string().max(260).optional(),
    /** The network the screen joins. */
    ssid: z.string().min(1).max(32),
    /** Its password. Empty: the hub's own saved one (when ssid is the hub's network). */
    password: z.string().max(64).default(''),
    name: z.string().trim().min(1).max(32),
    pillId: z.string().min(1).max(64).nullable().default(null),
    look: screenLookSchema.default({}),
  })
  .transform((input, ctx) => {
    if (input.address === undefined) {
      if (!input.hotspot) ctx.addIssue({ code: 'custom', path: ['hotspot'], message: 'Pick the screen’s hotspot' });
      return input;
    }
    const address = screenAddress(input.address);
    if (!address) ctx.addIssue({ code: 'custom', path: ['address'], message: 'Not an address on the network' });
    return { ...input, address: address ?? input.address };
  });
export type ScreenSetupInput = z.infer<typeof screenSetupSchema>;

/** Installing RaptHooker on a GeekMagic Ultra on the hub's network, for a browser to finish setting it up. */
export const screenInstallSchema = z.object({
  address: z
    .string()
    .max(260)
    .transform((text, ctx) => {
      const address = screenAddress(text);
      if (!address) ctx.addIssue({ code: 'custom', message: 'Not an address on the network' });
      return address ?? text;
    }),
});

/** What /api/screens/install did: which screen it found there, and the firmware it put on. */
export interface ScreenInstallResult {
  /** What the screen called itself ("SmallTV-Ultra") and its firmware ("Ultra-V9.0.50"). */
  found: { model: string; version: string };
  /** The RaptHooker firmware now on it. */
  firmware: ScreenFirmware;
  /** The screen said it took it; false when it restarted before saying (it may still have). */
  confirmed: boolean;
}

/** Setting up a board plugged into the hub's USB. */
export const screenUsbSetupSchema = z.object({
  /** The serial port it's on (a UsbPort's path). */
  port: z.string().min(1).max(128),
  /** A ScreenModel id with install 'usb'. */
  model: z.string().min(1).max(32),
  ssid: z.string().min(1).max(32),
  /** Empty: the hub's own saved one (when ssid is the hub's network). */
  password: z.string().max(64).default(''),
  name: z.string().trim().min(1).max(32),
  pillId: z.string().min(1).max(64).nullable().default(null),
  look: screenLookSchema.default({}),
});
export type ScreenUsbSetupInput = z.infer<typeof screenUsbSetupSchema>;

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
