import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import type * as DbusNext from 'dbus-next';
import type { MessageBus, Message as DbusMessage } from 'dbus-next';
import type { BleStatus, ScanMode } from '@rapthooker/shared';
import type { Logger } from '../log.js';
import { KEG_COMPANY_ID, RAPT_COMPANY_ID } from './rapt.js';
import type { Advert, Scanner } from './scanner.js';

/** dbus-next, or a stand-in with the same shape (the tests hand in a fake system bus). */
export type Dbus = Pick<typeof DbusNext, 'systemBus' | 'Message' | 'Variant' | 'MessageType'>;
type Props = Record<string, unknown>;
type Objects = Record<string, Record<string, Props>>;

/** 'auto' listens passively when BlueZ allows it and scans actively otherwise; 'passive' and 'active' insist. */
export type ScanModeSetting = 'auto' | ScanMode;

export interface BluezOptions {
  /** Adapters to scan with (hci0, hci1...). Empty: `adapter`, or every adapter found. */
  adapters?: string[];
  /** The older single-adapter setting. */
  adapter?: string;
  scanMode?: ScanModeSetting;
  /**
   * Whether this radio ought to be hearing pills: ones being recorded and heard (by anyone) in the last day, unless lately
   * only relays hear them (CompositeScanner.radioExpects). Silence then means trouble: the watchdog tries active scanning,
   * then a reset. Without it, pills heard here before count.
   */
  expectPills?: () => boolean;
  dbus?: Dbus;
  now?: () => number;
  /** How long BlueZ gets to switch a monitor on before passive scanning counts as unavailable. */
  activateTimeoutMs?: number;
  /** The service's data folder, where a request to reset a stuck adapter goes (and the helper leaves its result). */
  dataDir?: string;
  /** The root helper's path unit, installed by setup.d/25-bluetooth-reset.sh. Default /etc/systemd/system/rapthooker-bt-reset.path. */
  resetUnit?: string;
}

/** The scanner asks for the adapter to be reset by creating this file in the data folder; rapthooker-bt-reset.path notices it. */
export const RESET_REQUEST_FILE = 'bt-reset-request';
/** Written by deploy/pi/bt-reset.sh when it has finished: { at, ok, error }. */
export const RESET_STATUS_FILE = 'bt-reset-status.json';
/** Switching the radio off and on by hand, for hubs without the helper. */
export const RESET_COMMAND = 'sudo rfkill block bluetooth && sleep 2 && sudo rfkill unblock bluetooth && sudo systemctl restart rapthooker';

const BLUEZ = 'org.bluez';
const DEVICE = 'org.bluez.Device1';
const ADAPTER = 'org.bluez.Adapter1';
const MONITOR_MANAGER = 'org.bluez.AdvertisementMonitorManager1';
const MONITOR = 'org.bluez.AdvertisementMonitor1';
const PROPS = 'org.freedesktop.DBus.Properties';
const OBJECT_MANAGER = 'org.freedesktop.DBus.ObjectManager';
/** The D-Bus header flag on calls that want no reply (BlueZ's Activate, Release, DeviceFound...). */
const NO_REPLY_EXPECTED = 0x1;
/** Where the advertisement monitors are exported on our connection. */
const APP_ROOT = '/org/rapthooker/monitor';
const MAX_WATCHED = 256;
/** If pills are known but none has been heard for this long, discovery is restarted in case BlueZ stalled. */
const SILENCE_RESTART_MS = 15 * 60_000;
/**
 * In 'auto' mode, when pills are expected but a passive monitor stays silent this long (or 4 pill intervals), active
 * scanning is tried for as long again. If that hears them, it stays active; if not, the pills are simply away and it goes
 * back to passive (and doesn't try again until something is heard).
 */
const PASSIVE_GIVE_UP_MS = 2 * 3_600_000;
/**
 * Pills being recorded but unheard for this long (or 5 of their intervals), after restarting the listening didn't help:
 * Bluetooth may be stuck below BlueZ, and the root helper is asked to reset the adapter.
 */
const STUCK_MS = 15 * 60_000;
/** The least time between adapter resets: one an hour at most, and longer when they don't help. */
const RESET_BACKOFF_MS = [1, 3, 6].map((h) => h * 3_600_000);
/** BlueZ failing to start discovery this many times in a row (Busy, Failed...) also means Bluetooth is stuck. */
const DISCOVERY_FAILURES = 3;
/** The helper takes seconds; without an answer after this long, it isn't there. */
const RESET_ANSWER_MS = 5 * 60_000;
const RESET_UNIT = '/etc/systemd/system/rapthooker-bt-reset.path';
/** Adverts further apart than this belong to different transmissions (a pill sends a burst every interval). */
const BURST_GAP_MS = 20_000;
const ACTIVATE_TIMEOUT_MS = 10_000;
/** A hung BlueZ (or a D-Bus connection that ended: dbus-next never fails calls that were waiting) mustn't hang the scanner. */
const CALL_TIMEOUT_MS = 15_000;
/** Setting up on a D-Bus connection that has since been replaced (or after stopping) stops there. */
const REPLACED = 'The D-Bus connection was replaced';
const MANAGER_MISSING = "BlueZ's experimental features are off, so it can't listen passively (running the Pi setup again switches them on)";

/**
 * The advertisement monitor's "or_patterns": (start position, AD type, bytes). BlueZ and the kernel match manufacturer
 * data (AD type 0xFF) with its company id included, and company ids go on air little-endian, so RAPT's 0x4152 is
 * "RA" (0x52 0x41) and the firmware adverts' 0x454B is "KE" (0x4B 0x45).
 */
export const MONITOR_PATTERNS: ReadonlyArray<readonly [number, number, readonly number[]]> = [RAPT_COMPANY_ID, KEG_COMPANY_ID].map(
  (id) => [0, 0xff, [id & 0xff, id >> 8]] as const,
);

interface Registration {
  /** The application root given to RegisterMonitor (answers GetManagedObjects). */
  root: string;
  /** The monitor object under it. */
  path: string;
  state: 'pending' | 'active' | 'released' | 'closing';
  settle: ((err?: Error) => void) | null;
}

interface AdapterState {
  name: string;
  path: string;
  mode: ScanMode | null;
  /** Why it's scanning actively when passive was wanted. */
  reason: string | null;
  /** Passive scanning was unavailable only because the monitor manager hadn't appeared: try again when it does. */
  retryPassive: boolean;
  /** When active scanning started as a check on a silent passive monitor (null when not checking). */
  probeSince: number | null;
  /** That check heard nothing either: don't check again until something is heard. */
  probeFailed: boolean;
  reg: Registration | null;
  /** RAPT devices seen through this adapter. */
  devices: Set<string>;
  since: number;
  lastAdvertAt: number | null;
  /** Recent gaps between transmissions, to tell a pill with a long interval from a monitor that went quiet. */
  gaps: number[];
  lastRestartAt: number;
  /** DeviceFound calls from BlueZ (passive mode), for the logs. */
  found: number;
}

const unwrap = (v: unknown): unknown =>
  v !== null && typeof v === 'object' && 'signature' in v && 'value' in v ? (v as { value: unknown }).value : v;

const addressFromPath = (path: string): string | null => {
  const m = /\/dev_([0-9A-F]{2}(?:_[0-9A-F]{2}){5})$/i.exec(path);
  return m ? m[1]!.replace(/_/g, ':').toUpperCase() : null;
};

const nameOf = (path: string): string => path.split('/').pop() ?? path;

/** A D-Bus error says what went wrong and its error name says where; keep both. */
function describe(err: unknown): string {
  const e = err as { type?: string; text?: string; message?: string } | null;
  if (e?.type && e.text) return `${e.text} (${e.type})`;
  return e?.message ?? String(err);
}

export function manufacturerMap(value: unknown): Map<number, Uint8Array> | null {
  const raw = unwrap(value);
  if (raw === null || typeof raw !== 'object') return null;
  const map = new Map<number, Uint8Array>();
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    const bytes = unwrap(entry);
    if (bytes instanceof Uint8Array) map.set(Number(key), bytes);
    else if (Array.isArray(bytes)) map.set(Number(key), Uint8Array.from(bytes as number[]));
  }
  return map;
}

const isRapt = (map: Map<number, Uint8Array> | null) => !!map && (map.has(RAPT_COMPANY_ID) || map.has(KEG_COMPANY_ID));

/** Why passive scanning can't be used on this adapter, judging by what BlueZ exports for it, or null if it can. */
function passiveUnavailable(ifaces: Record<string, Props> | undefined): string | null {
  const manager = ifaces?.[MONITOR_MANAGER];
  if (!manager) return MANAGER_MISSING;
  const types = unwrap(manager.SupportedMonitorTypes);
  if (Array.isArray(types) && !types.includes('or_patterns')) return "this BlueZ can't watch for advert patterns";
  return null;
}

/**
 * Listens to BlueZ over the system D-Bus for RAPT Pill advertisements, on one or more adapters.
 *
 * Passive (preferred): an advertisement monitor (org.bluez.AdvertisementMonitor1, BlueZ experimental) asks BlueZ to
 * listen without discovery. The radio never transmits scan requests and only devices with RAPT manufacturer data are
 * reported, which leaves a Pi 3's shared Wi-Fi/Bluetooth radio far more time for Wi-Fi.
 * Active (fallback): LE discovery with duplicate reports, as before.
 *
 * Either way the readings arrive as device PropertiesChanged signals. Only RAPT device paths are subscribed to, so
 * dbus-daemon drops everyone else's adverts before they reach Node.
 */
export class BluezScanner extends EventEmitter implements Scanner {
  private dbus: Dbus | undefined;
  private bus: MessageBus | undefined;
  private readonly adapters = new Map<string, AdapterState>();
  private readonly watched = new Set<string>();
  private readonly matched = new Set<string>();
  private readonly wanted: string[];
  private readonly scanMode: ScanModeSetting;
  private readonly now: () => number;
  private watchdog: NodeJS.Timeout | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private attempt = 0;
  private stopped = false;
  /** The setup running now, and one more asked for meanwhile (it runs after, on the connection current then). */
  private setupRun: Promise<void> | null = null;
  private setupQueued: Promise<void> | null = null;
  /**
   * Each adapter's last state, for what it learned to outlive setting it up again (after a reset, BlueZ restarting...):
   * the pills' interval, and that an active check heard nothing either (so a reset doesn't bring on another 2-hour check).
   */
  private readonly learned = new Map<string, Pick<AdapterState, 'gaps' | 'probeFailed'>>();
  private checks = 0;
  private generation = 0;
  /** When a pill was last heard (or listening started), on any adapter: for noticing Bluetooth gone stuck. */
  private heardAt: number;
  /**
   * Adapter resets asked for (or suggested) since a pill was last heard, and when the last one was. They belong to the
   * scanner rather than an adapter, so setting an adapter up again after a reset keeps the backoff going.
   */
  private resets = 0;
  private resetAskedAt: number | null = null;
  /** A reset request the helper hasn't answered yet (when it was made). */
  private pendingReset: number | null = null;
  /** StartDiscovery failures in a row. */
  private discoveryFailures = 0;
  private _status: BleStatus = {
    state: 'starting',
    adapter: null,
    adapters: [],
    mode: null,
    modeReason: null,
    error: null,
    lastAdvertAt: null,
    lastResetAt: null,
    since: Date.now(),
    relays: [],
  };

  constructor(
    private readonly log: Logger,
    private readonly opts: BluezOptions = {},
  ) {
    super();
    const listed = (opts.adapters ?? []).map((a) => a.trim()).filter(Boolean);
    const single = opts.adapter?.trim();
    this.wanted = listed.length ? listed : single ? [single] : [];
    this.scanMode = opts.scanMode ?? 'auto';
    this.now = opts.now ?? Date.now;
    this.heardAt = this.now();
    // The last reset (from before a restart too), shown in Settings and counted for the rate limit.
    const last = this.resetResult();
    if (last) {
      this._status.lastResetAt = last.at;
      if (last.at <= this.heardAt) this.resetAskedAt = last.at;
    }
  }

  get status(): BleStatus {
    return this._status;
  }

  private get initializing(): boolean {
    return this.setupRun !== null;
  }

  private setStatus(patch: Partial<BleStatus>): void {
    const next = { ...this._status, ...patch };
    const key = (s: BleStatus) =>
      JSON.stringify([s.state, s.error, s.adapter, s.adapters, s.mode, s.modeReason ?? null, s.lastResetAt ?? null]);
    if (key(next) === key(this._status)) {
      this._status = next;
      return;
    }
    if (next.state !== this._status.state || next.error !== this._status.error || next.adapter !== this._status.adapter) {
      next.since = this.now();
    }
    this._status = next;
    this.emit('status', next);
  }

  async start(): Promise<void> {
    this.stopped = false;
    this.heardAt = this.now();
    this.dbus = this.opts.dbus ?? (await import('dbus-next'));
    await this.connect();
    this.watchdog = setInterval(() => void this.check(), 60_000);
    this.watchdog.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.watchdog);
    clearTimeout(this.reconnectTimer);
    const bus = this.bus;
    this.bus = undefined;
    const adapters = [...this.adapters.values()];
    this.adapters.clear();
    if (bus) {
      await Promise.allSettled(
        adapters.map(async (ad) => {
          if (ad.mode === 'active') await this.call(bus, ad.path, ADAPTER, 'StopDiscovery');
          await this.unregister(bus, ad);
        }),
      );
    }
    bus?.disconnect();
  }

  private async connect(): Promise<void> {
    if (this.stopped || !this.dbus) return;
    const bus = this.dbus.systemBus();
    this.bus = bus;
    this.watched.clear();
    this.matched.clear();
    this.adapters.clear();
    const lost = (err: unknown) => {
      if (this.bus !== bus) return;
      this.dropBus(bus);
      this.fail(`Lost the D-Bus connection: ${(err as Error)?.message ?? err}`);
    };
    bus.on('error', lost);
    (bus as unknown as { _connection?: EventEmitter })._connection?.on('end', () => lost(new Error('connection closed')));
    bus.on('message', (msg) => {
      if (this.bus === bus) this.onMessage(msg);
    });
    // BlueZ calls into our advertisement monitors (GetManagedObjects, Activate, Release, DeviceFound...).
    bus.addMethodHandler((msg: DbusMessage) => this.onMethodCall(bus, msg));
    try {
      await this.init(bus);
    } catch (err) {
      // A failure on a connection that has since been replaced is the new connection's business.
      if (this.bus === bus) this.fail(describe(err));
    }
  }

  private dropBus(bus: MessageBus): void {
    if (this.bus === bus) this.bus = undefined;
    try {
      bus.disconnect();
    } catch {
      // already gone
    }
  }

  private fail(error: string): void {
    this.log.warn({ error }, 'bluetooth problem');
    this.setStatus({ state: 'error', error, adapters: [], mode: null, modeReason: null });
    if (this.stopped) return;
    clearTimeout(this.reconnectTimer);
    const delay = Math.min(60_000, 2000 * 2 ** this.attempt++);
    this.reconnectTimer = setTimeout(() => {
      // Retry on the same connection a few times, then start over with a fresh one in case it's the problem.
      if (this.bus && this.attempt <= 3) {
        this.reinit(this.bus);
      } else {
        if (this.bus) this.dropBus(this.bus);
        void this.connect();
      }
    }, delay);
  }

  /** A method call on BlueZ. A hung BlueZ mustn't hang the scanner, so calls time out. */
  private call(
    bus: MessageBus,
    path: string,
    iface: string,
    member: string,
    signature?: string,
    body?: unknown[],
  ): Promise<DbusMessage | null> {
    const { Message } = this.dbus!;
    return this.timed(bus.call(new Message({ destination: BLUEZ, path, interface: iface, member, signature, body })), `BlueZ ${member}`);
  }

  private timed<T>(promise: Promise<T>, what: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out`)), CALL_TIMEOUT_MS);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  /** Subscribes to signals; each rule is added once per connection (dbus-daemon doesn't merge duplicates). */
  private async addMatch(bus: MessageBus, rule: string): Promise<void> {
    if (this.matched.has(rule)) return;
    const { Message } = this.dbus!;
    await this.timed(
      bus.call(
        new Message({
          destination: 'org.freedesktop.DBus',
          path: '/org/freedesktop/DBus',
          interface: 'org.freedesktop.DBus',
          member: 'AddMatch',
          signature: 's',
          body: [rule],
        }),
      ),
      'Subscribing to Bluetooth signals',
    );
    this.matched.add(rule);
  }

  private async managedObjects(bus: MessageBus): Promise<Objects> {
    const reply = await this.call(bus, '/', OBJECT_MANAGER, 'GetManagedObjects');
    return (reply?.body[0] ?? {}) as Objects;
  }

  private isWanted(path: string): boolean {
    if (!/^\/org\/bluez\/[^/]+$/.test(path)) return false;
    return this.wanted.length === 0 || this.wanted.includes(nameOf(path));
  }

  /** The adapters to use: the configured ones that exist, or every one BlueZ has. */
  private chooseAdapters(objects: Objects): string[] {
    const present = Object.keys(objects)
      .filter((p) => objects[p]![ADAPTER])
      .sort();
    if (this.wanted.length === 0) {
      if (present.length === 0) throw new Error('No Bluetooth adapter found');
      return present;
    }
    const usable = present.filter((p) => this.isWanted(p));
    if (usable.length === 0) {
      throw new Error(`Bluetooth adapter${this.wanted.length > 1 ? 's' : ''} ${this.wanted.join(', ')} not found`);
    }
    const missing = this.wanted.filter((n) => !usable.includes(`/org/bluez/${n}`));
    if (missing.length) this.log.warn({ missing }, 'some Bluetooth adapters in the config were not found');
    return usable;
  }

  private adapterOf(path: string): AdapterState | undefined {
    for (const ad of this.adapters.values()) if (path.startsWith(`${ad.path}/`)) return ad;
    return undefined;
  }

  private inUse(): AdapterState[] {
    return [...this.adapters.values()].filter((a) => a.mode !== null).sort((a, b) => a.name.localeCompare(b.name));
  }

  private refreshStatus(): void {
    const used = this.inUse();
    if (used.length === 0) return;
    const reasons = used
      .filter((a) => a.mode === 'active' && a.reason)
      .map((a) => (used.length > 1 ? `${a.name}: ${a.reason}` : a.reason!));
    this.setStatus({
      state: 'scanning',
      error: null,
      adapter: used[0]!.name,
      adapters: used.map((a) => a.name),
      mode: used.every((a) => a.mode === 'passive') ? 'passive' : 'active',
      modeReason: reasons.length ? reasons.join('; ') : null,
    });
  }

  private describeAdapter(a: AdapterState): string {
    if (a.mode === 'passive') return `${a.name} (passive)`;
    if (a.reason) return `${a.name} (active, because ${a.reason})`;
    return `${a.name} (active${this.scanMode === 'active' ? ', as configured' : ''})`;
  }

  /**
   * Finds the adapters and sets each one scanning: passive if it can (and should), otherwise active. A setup asked for
   * while one is running runs after it (once, however many asked), on the connection current by then: returning early
   * instead would leave a new connection never set up. A setup whose connection is replaced meanwhile gives up.
   */
  private init(bus: MessageBus): Promise<void> {
    if (this.setupRun) {
      this.setupQueued ??= this.setupRun.then(
        () => this.initAgain(),
        () => this.initAgain(),
      );
      return this.setupQueued;
    }
    const run: Promise<void> = this.setUp(bus).finally(() => {
      if (this.setupRun === run) this.setupRun = null;
    });
    this.setupRun = run;
    return run;
  }

  private initAgain(): Promise<void> {
    this.setupQueued = null;
    if (!this.bus || this.stopped) return Promise.reject(new Error(REPLACED));
    return this.init(this.bus);
  }

  /** Sets up again on this connection, retrying with the usual backoff if that fails. */
  private reinit(bus: MessageBus): void {
    this.init(bus).catch((err: unknown) => {
      if (this.bus === bus) this.fail(describe(err));
    });
  }

  private async setUp(bus: MessageBus): Promise<void> {
    const current = () => {
      if (this.bus !== bus || this.stopped) throw new Error(REPLACED);
    };
    current();
    this.setStatus({ state: 'starting', error: null });
    const objects = await this.managedObjects(bus);
    current();
    const chosen = this.chooseAdapters(objects);

    await this.addMatch(bus, `type='signal',sender='${BLUEZ}',interface='${OBJECT_MANAGER}',member='InterfacesAdded'`);
    await this.addMatch(bus, `type='signal',sender='${BLUEZ}',interface='${OBJECT_MANAGER}',member='InterfacesRemoved'`);
    await this.addMatch(
      bus,
      `type='signal',sender='org.freedesktop.DBus',interface='org.freedesktop.DBus',member='NameOwnerChanged',arg0='${BLUEZ}'`,
    );
    current();

    // Setting up again (BlueZ restarted, an adapter was switched off...): drop the monitors the last setup registered.
    const before = new Map(this.adapters);
    this.adapters.clear();
    await Promise.allSettled([...before.values()].map((ad) => this.unregister(bus, ad)));

    const problems: string[] = [];
    for (const path of chosen) {
      current();
      try {
        await this.setupAdapter(bus, path, objects, before.get(path)?.mode ?? null);
      } catch (err) {
        problems.push(chosen.length > 1 ? `${nameOf(path)}: ${describe(err)}` : describe(err));
      }
    }
    current();
    if (this.adapters.size === 0) throw new Error(problems.join('; ') || 'No Bluetooth adapter could be used');
    for (const problem of problems) this.log.warn({ problem }, 'a Bluetooth adapter could not be used');
    this.refreshStatus();
    this.attempt = 0;
    // Set up after all, so a retry still waiting would only set everything up again.
    clearTimeout(this.reconnectTimer);
    const summary = this.inUse()
      .map((a) => this.describeAdapter(a))
      .join(', ');
    this.log.info(
      { adapters: this._status.adapters, mode: this._status.mode, scanMode: this.scanMode },
      `scanning for RAPT Pills with ${summary}`,
    );
  }

  /** Powers the adapter on, picks up RAPT devices BlueZ already knows and starts listening. */
  private async setupAdapter(bus: MessageBus, path: string, objects: Objects, previous: ScanMode | null): Promise<AdapterState> {
    const { Variant } = this.dbus!;
    const learned = this.learned.get(path);
    const ad: AdapterState = {
      name: nameOf(path),
      path,
      mode: null,
      reason: null,
      retryPassive: false,
      probeSince: null,
      probeFailed: learned?.probeFailed ?? false,
      reg: null,
      devices: new Set(),
      since: this.now(),
      lastAdvertAt: null,
      gaps: learned?.gaps ?? [],
      lastRestartAt: 0,
      found: 0,
    };
    this.adapters.set(path, ad);
    this.learned.set(path, ad);
    try {
      await this.addMatch(bus, `type='signal',sender='${BLUEZ}',path='${path}',interface='${PROPS}',member='PropertiesChanged'`);
      if (unwrap(objects[path]?.[ADAPTER]?.Powered) !== true) {
        this.log.info({ adapter: ad.name }, 'powering on the Bluetooth adapter');
        await this.call(bus, path, PROPS, 'Set', 'ssv', [ADAPTER, 'Powered', new Variant('b', true)]);
      }
      for (const [devicePath, ifaces] of Object.entries(objects)) {
        const props = ifaces[DEVICE];
        if (props && devicePath.startsWith(`${path}/`)) await this.onDevice(bus, devicePath, props, true);
      }

      let reason: string | null = null;
      if (this.scanMode !== 'active') {
        reason = passiveUnavailable(objects[path]);
        if (!reason) {
          try {
            await this.startPassive(bus, ad);
          } catch (err) {
            reason = `BlueZ wouldn't start passive scanning: ${describe(err)}`;
          }
        }
        if (reason && this.scanMode === 'passive') {
          throw new Error(`Passive scanning isn't available (${reason}). Set bluetooth.scanMode to "auto" to scan actively instead.`);
        }
      }
      if (!reason && this.scanMode !== 'active') {
        ad.mode = 'passive';
        if (previous === 'active') await this.call(bus, path, ADAPTER, 'StopDiscovery').catch(() => undefined);
      } else {
        await this.startActive(bus, ad);
        ad.reason = reason;
        ad.retryPassive = reason === MANAGER_MISSING && this.scanMode === 'auto';
      }
      return ad;
    } catch (err) {
      if (this.adapters.get(path) === ad) this.adapters.delete(path);
      await this.unregister(bus, ad);
      throw err;
    }
  }

  private async startActive(bus: MessageBus, ad: AdapterState): Promise<void> {
    const { Variant } = this.dbus!;
    await this.call(bus, ad.path, ADAPTER, 'SetDiscoveryFilter', 'a{sv}', [
      { Transport: new Variant('s', 'le'), DuplicateData: new Variant('b', true) },
    ]);
    await this.startDiscovery(bus, ad.path);
    ad.mode = 'active';
  }

  private async startDiscovery(bus: MessageBus, adapterPath: string): Promise<void> {
    try {
      await this.call(bus, adapterPath, ADAPTER, 'StartDiscovery');
      this.discoveryFailures = 0;
    } catch (err) {
      const name = String((err as { type?: string }).type ?? (err as Error).message);
      // Discovery that BlueZ says is busy or under way, while the adapter isn't discovering, can mean the controller is stuck.
      if (/InProgress|Busy|Failed/i.test(name) && ++this.discoveryFailures >= DISCOVERY_FAILURES) {
        this.askForReset(this.now(), `BlueZ couldn't start scanning ${this.discoveryFailures} times in a row: ${describe(err)}`);
      }
      if (!/InProgress/i.test(name)) throw err;
    }
  }

  /**
   * Registers an advertisement monitor for RAPT manufacturer data and waits for BlueZ to switch it on. BlueZ asks the
   * application root for its monitors (GetManagedObjects) while handling RegisterMonitor, so the objects are answered
   * for from the moment the registration exists. RSSI thresholds are left unset (absent), so every matching advert is
   * reported however weak it is.
   */
  private async startPassive(bus: MessageBus, ad: AdapterState): Promise<void> {
    const root = `${APP_ROOT}/${ad.name.replace(/[^A-Za-z0-9_]/g, '_')}_${++this.generation}`;
    const reg: Registration = { root, path: `${root}/rapt`, state: 'pending', settle: null };
    const activated = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("BlueZ didn't switch the monitor on")),
        this.opts.activateTimeoutMs ?? ACTIVATE_TIMEOUT_MS,
      );
      reg.settle = (err) => {
        clearTimeout(timer);
        reg.settle = null;
        if (err) reject(err);
        else resolve();
      };
    });
    activated.catch(() => undefined);
    ad.reg = reg;
    let registered = false;
    try {
      await this.call(bus, ad.path, MONITOR_MANAGER, 'RegisterMonitor', 'o', [root]);
      registered = true;
      await activated;
    } catch (err) {
      reg.settle?.(err as Error);
      if (ad.reg === reg) ad.reg = null;
      reg.state = 'closing';
      if (registered) await this.call(bus, ad.path, MONITOR_MANAGER, 'UnregisterMonitor', 'o', [root]).catch(() => undefined);
      throw err;
    }
  }

  private async unregister(bus: MessageBus, ad: AdapterState): Promise<void> {
    const reg = ad.reg;
    if (!reg) return;
    ad.reg = null;
    reg.settle?.(new Error('Stopped'));
    reg.state = 'closing';
    await this.call(bus, ad.path, MONITOR_MANAGER, 'UnregisterMonitor', 'o', [reg.root]).catch(() => undefined);
  }

  /** Registers the monitor again (it went quiet or BlueZ released it). In 'auto' mode, active scanning takes over if that fails. */
  private async restartPassive(bus: MessageBus, ad: AdapterState): Promise<void> {
    await this.unregister(bus, ad);
    try {
      await this.startPassive(bus, ad);
      ad.mode = 'passive';
    } catch (err) {
      const reason = `BlueZ wouldn't restart passive scanning: ${describe(err)}`;
      if (this.scanMode !== 'auto') throw new Error(`Passive scanning stopped on ${ad.name}: ${reason}`, { cause: err });
      await this.switchToActive(bus, ad, reason);
    }
  }

  private async switchToActive(bus: MessageBus, ad: AdapterState, reason: string): Promise<void> {
    await this.unregister(bus, ad);
    await this.startActive(bus, ad);
    ad.reason = reason;
    ad.retryPassive = false;
    this.refreshStatus();
    this.log.warn({ adapter: ad.name, reason }, `${ad.name} switched to active scanning`);
  }

  /** Back to passive scanning (the monitor manager turned up late, or an active check heard nothing either). */
  private async toPassive(bus: MessageBus, ad: AdapterState, why: string): Promise<void> {
    try {
      await this.startPassive(bus, ad);
    } catch (err) {
      ad.reason = `BlueZ wouldn't start passive scanning: ${describe(err)}`;
      this.refreshStatus();
      this.log.info({ adapter: ad.name, reason: ad.reason }, `${ad.name} stays on active scanning`);
      return;
    }
    // Passive before stopping discovery, so the Discovering change isn't taken as discovery stalling.
    ad.mode = 'passive';
    ad.reason = null;
    ad.lastRestartAt = this.now();
    await this.call(bus, ad.path, ADAPTER, 'StopDiscovery').catch(() => undefined);
    this.refreshStatus();
    this.log.info({ adapter: ad.name }, `${ad.name} switched to passive scanning: ${why}`);
  }

  /** The monitor manager turned up after the adapter was set up (BlueZ was still starting): go passive after all. */
  private async upgradeToPassive(bus: MessageBus, ad: AdapterState): Promise<void> {
    if (ad.mode !== 'active' || !ad.retryPassive) return;
    ad.retryPassive = false;
    await this.toPassive(bus, ad, 'BlueZ is ready for it now');
  }

  private registrationAt(path: string): { ad: AdapterState; reg: Registration; root: boolean } | null {
    for (const ad of this.adapters.values()) {
      const reg = ad.reg;
      if (reg && reg.root === path) return { ad, reg, root: true };
      if (reg && reg.path === path) return { ad, reg, root: false };
    }
    return null;
  }

  private monitorProps(): Record<string, InstanceType<Dbus['Variant']>> {
    const { Variant } = this.dbus!;
    return {
      Type: new Variant('s', 'or_patterns'),
      Patterns: new Variant(
        'a(yyay)',
        MONITOR_PATTERNS.map(([position, type, bytes]) => [position, type, Buffer.from(bytes)]),
      ),
    };
  }

  /** Answers BlueZ's calls to our monitor objects. Anything else on the bus is left to dbus-next. */
  private onMethodCall(bus: MessageBus, msg: DbusMessage): boolean {
    const dbus = this.dbus;
    if (!dbus || msg.type !== dbus.MessageType.METHOD_CALL || !msg.path?.startsWith(`${APP_ROOT}/`)) return false;
    const wantsReply = !(msg.flags & NO_REPLY_EXPECTED);
    const reply = (signature?: string, body?: unknown[]) => {
      if (wantsReply) bus.send(dbus.Message.newMethodReturn(msg, signature, body));
    };
    try {
      const hit = this.registrationAt(msg.path);
      if (msg.interface === OBJECT_MANAGER && msg.member === 'GetManagedObjects') {
        const objects = hit?.root && hit.reg.state !== 'closing' ? { [hit.reg.path]: { [MONITOR]: this.monitorProps() } } : {};
        reply('a{oa{sa{sv}}}', [objects]);
        return true;
      }
      if (msg.interface === MONITOR) {
        // Calls for a monitor that has since been replaced are acknowledged and ignored.
        if (hit && !hit.root) this.onMonitorCall(bus, hit.ad, hit.reg, msg.member);
        reply();
        return true;
      }
      if (msg.interface === PROPS && hit && !hit.root) {
        const [iface, name] = msg.body as [string, string | undefined];
        const props = iface === MONITOR ? this.monitorProps() : {};
        if (msg.member === 'GetAll') {
          reply('a{sv}', [props]);
          return true;
        }
        if (msg.member === 'Get' && name && name in props) {
          reply('v', [props[name]]);
          return true;
        }
      }
    } catch (err) {
      this.log.warn({ err: describe(err), member: msg.member }, 'could not answer BlueZ');
    }
    return false;
  }

  private onMonitorCall(bus: MessageBus, ad: AdapterState, reg: Registration, member: string): void {
    if (member === 'Activate') {
      if (reg.state === 'pending') {
        reg.state = 'active';
        reg.settle?.();
      }
    } else if (member === 'Release') {
      const was = reg.state;
      reg.state = 'released';
      if (was === 'pending')
        reg.settle?.(new Error("BlueZ couldn't switch the monitor on (the kernel may not support advertisement monitoring)"));
      else if (was === 'active') this.monitorLost(bus, ad, reg);
    } else if (member === 'DeviceFound') {
      ad.found++;
    }
  }

  private monitorLost(bus: MessageBus, ad: AdapterState, reg: Registration): void {
    this.log.warn({ adapter: ad.name }, 'BlueZ released the passive scanning monitor; registering it again');
    setTimeout(() => {
      if (this.bus !== bus || this.stopped || this.initializing || this._status.state !== 'scanning') return;
      if (this.adapters.get(ad.path) !== ad || ad.reg !== reg) return;
      this.restartPassive(bus, ad).catch((err: unknown) => this.fail(describe(err)));
    }, 2000).unref();
  }

  private async watch(bus: MessageBus, path: string): Promise<void> {
    if (this.watched.has(path) || this.watched.size >= MAX_WATCHED) return;
    this.watched.add(path);
    await this.addMatch(bus, `type='signal',sender='${BLUEZ}',path='${path}',interface='${PROPS}',member='PropertiesChanged'`).catch(
      (err: Error) => {
        this.watched.delete(path);
        this.log.warn({ path, err: err.message }, 'could not subscribe to a device');
      },
    );
  }

  private async onDevice(bus: MessageBus, path: string, props: Props, cached: boolean): Promise<void> {
    const manufacturer = manufacturerMap(props.ManufacturerData);
    if (!isRapt(manufacturer)) return;
    this.adapterOf(path)?.devices.add(path);
    await this.watch(bus, path);
    const address = (unwrap(props.Address) as string | undefined)?.toUpperCase() ?? addressFromPath(path);
    if (!address) return;
    const rssi = unwrap(props.RSSI);
    this.advert(path, { address, rssi: typeof rssi === 'number' ? rssi : null, manufacturer, cached });
  }

  private advert(path: string, a: Omit<Advert, 'at' | 'mono' | 'source'>): void {
    const at = this.now();
    const ad = this.adapterOf(path);
    if (!a.cached) {
      this._status = { ...this._status, lastAdvertAt: at };
      this.heardAt = at;
      this.discoveryFailures = 0;
      if (this.resets > 0) {
        this.log.info('RAPT adverts are coming in again');
        this.resets = 0;
      }
      if (ad) {
        if (ad.lastAdvertAt !== null && at - ad.lastAdvertAt > BURST_GAP_MS) ad.gaps = [...ad.gaps, at - ad.lastAdvertAt].slice(-10);
        ad.lastAdvertAt = at;
        ad.probeFailed = false;
        if (ad.probeSince !== null && ad.mode === 'active') {
          ad.probeSince = null;
          ad.reason = 'passive scanning stopped hearing the pills, but active scanning hears them';
          this.refreshStatus();
          this.log.warn({ adapter: ad.name }, `${ad.name} stays on active scanning: it hears pills that passive scanning missed`);
        }
      }
    }
    this.emit('advert', {
      ...a,
      at,
      mono: performance.now(),
      source: ad?.name ?? nameOf(path.replace(/\/dev_[^/]+$/, '')),
    } satisfies Advert);
  }

  private onMessage(msg: DbusMessage): void {
    const bus = this.bus;
    if (!bus || !this.dbus || msg.type !== this.dbus.MessageType.SIGNAL) return;
    try {
      if (msg.member === 'InterfacesAdded' && msg.interface === OBJECT_MANAGER) {
        const [path, ifaces] = msg.body as [string, Record<string, Props>];
        const props = ifaces[DEVICE];
        if (props) {
          if (this.adapterOf(path)) void this.onDevice(bus, path, props, false);
          return;
        }
        if (ifaces[ADAPTER] && this.isWanted(path) && !this.adapters.has(path)) {
          this.adapterAdded(bus, path);
        } else if (ifaces[MONITOR_MANAGER]) {
          const ad = this.adapters.get(path);
          if (ad && !this.initializing) this.upgradeToPassive(bus, ad).catch((err: unknown) => this.fail(describe(err)));
        }
        return;
      }
      if (msg.member === 'InterfacesRemoved' && msg.interface === OBJECT_MANAGER) {
        const [path, ifaces] = msg.body as [string, string[]];
        if (ifaces.includes(ADAPTER)) this.adapterRemoved(path);
        return;
      }
      if (msg.member === 'NameOwnerChanged') {
        const [, , newOwner] = msg.body as [string, string, string];
        if (newOwner) {
          // Match rules use the well-known name, so they still apply to the new bluetoothd.
          this.log.info('BlueZ restarted; setting up again');
          this.reinit(bus);
        } else {
          // Retried with the usual backoff. Asking BlueZ for its objects starts bluetoothd again through D-Bus
          // (bluetooth.service is dbus-org.bluez.service) if systemd hasn't already.
          this.fail('BlueZ (bluetoothd) stopped');
        }
        return;
      }
      if (msg.member !== 'PropertiesChanged' || msg.interface !== PROPS) return;
      const [iface, changed] = msg.body as [string, Props, string[]];
      if (iface === ADAPTER) {
        const ad = this.adapters.get(msg.path);
        if (ad) this.onAdapterChange(bus, ad, changed);
        // An adapter that couldn't be used came back on (after a reset, say): set it up now rather than at the next retry.
        else if (unwrap(changed.Powered) === true && this.isWanted(msg.path)) this.adapterAdded(bus, msg.path);
        return;
      }
      if (iface !== DEVICE) return;
      const address = addressFromPath(msg.path);
      if (!address) return;
      const rssi = unwrap(changed.RSSI);
      const manufacturer = 'ManufacturerData' in changed ? manufacturerMap(changed.ManufacturerData) : null;
      if (manufacturer === null && typeof rssi !== 'number') return;
      this.advert(msg.path, {
        address,
        rssi: typeof rssi === 'number' ? rssi : null,
        manufacturer: isRapt(manufacturer) ? manufacturer : null,
        cached: false,
      });
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'could not read a Bluetooth signal');
    }
  }

  /** A wanted adapter was plugged in (a USB dongle, or the built-in one coming back). */
  private adapterAdded(bus: MessageBus, path: string): void {
    // While setting up, or with nothing set up, set everything up (again, after a setup that's under way).
    if (this.initializing || this.adapters.size === 0) {
      clearTimeout(this.reconnectTimer);
      this.reinit(bus);
      return;
    }
    this.addAdapter(bus, path).catch((err: unknown) =>
      this.log.warn({ adapter: nameOf(path), err: describe(err) }, 'could not use a new Bluetooth adapter'),
    );
  }

  private async addAdapter(bus: MessageBus, path: string, objects?: Objects): Promise<void> {
    if (this.adapters.has(path)) return;
    const all = objects ?? (await this.managedObjects(bus));
    if (!all[path]?.[ADAPTER] || this.adapters.has(path) || this.bus !== bus) return;
    const ad = await this.setupAdapter(bus, path, all, null);
    this.refreshStatus();
    this.log.info({ adapters: this._status.adapters }, `now also scanning with ${this.describeAdapter(ad)}`);
  }

  private adapterRemoved(path: string): void {
    const ad = this.adapters.get(path);
    if (!ad) return;
    this.adapters.delete(path);
    if (ad.reg) {
      ad.reg.settle?.(new Error('The adapter was removed'));
      ad.reg.state = 'closing';
      ad.reg = null;
    }
    this.log.warn({ adapter: ad.name }, 'a Bluetooth adapter was removed');
    if (this.adapters.size === 0) this.fail(`The Bluetooth adapter ${ad.name} was removed`);
    else this.refreshStatus();
  }

  private onAdapterChange(bus: MessageBus, ad: AdapterState, changed: Props): void {
    if ('Powered' in changed && unwrap(changed.Powered) === false) {
      this.setStatus({ state: 'error', error: `The Bluetooth adapter was switched off${this.adapters.size > 1 ? ` (${ad.name})` : ''}` });
      this.reinit(bus);
      return;
    }
    if ('Discovering' in changed && unwrap(changed.Discovering) === false && !this.stopped && ad.mode === 'active') {
      // Something else stopped discovery (or BlueZ timed it out): start it again.
      setTimeout(() => {
        if (this.bus === bus && ad.mode === 'active' && this.adapters.get(ad.path) === ad) {
          this.startDiscovery(bus, ad.path).catch((err: unknown) => this.fail(describe(err)));
        }
      }, 2000).unref();
    }
  }

  /** The watchdog (every minute): still listening, nothing missed, no suspiciously long silence. */
  async check(): Promise<void> {
    try {
      this.followReset(this.now());
    } catch (err) {
      this.log.warn({ err: describe(err) }, "couldn't read how the Bluetooth reset went");
    }
    const bus = this.bus;
    if (!bus || this.initializing || this._status.state !== 'scanning') return;
    try {
      const now = this.now();
      for (const ad of [...this.adapters.values()]) {
        if (this.bus !== bus || this.adapters.get(ad.path) !== ad) continue;
        if (ad.mode === 'active') await this.checkActive(bus, ad, now);
        else if (ad.mode === 'passive') await this.checkPassive(bus, ad, now);
      }
      if (this.bus === bus) this.checkStuck(now);
      if (++this.checks % 5 === 0 && this.bus === bus) await this.rescan(bus);
    } catch (err) {
      this.fail(describe(err));
    }
  }

  private async checkActive(bus: MessageBus, ad: AdapterState, now: number): Promise<void> {
    const reply = await this.call(bus, ad.path, PROPS, 'Get', 'ss', [ADAPTER, 'Discovering']);
    if (unwrap(reply?.body[0]) !== true) {
      this.log.warn({ adapter: ad.name }, 'discovery had stopped; restarting it');
      await this.startDiscovery(bus, ad.path);
    }
    const last = ad.lastAdvertAt ?? ad.since;
    const limit = this.restartAfter(ad);
    if (ad.devices.size > 0 && now - last > limit && now - ad.lastRestartAt > limit) {
      ad.lastRestartAt = now;
      this.log.warn({ adapter: ad.name }, 'no RAPT adverts for a while; restarting discovery');
      await this.call(bus, ad.path, ADAPTER, 'StopDiscovery').catch(() => undefined);
      await this.startDiscovery(bus, ad.path);
    }
    if (ad.probeSince !== null && now - ad.probeSince > this.giveUpMs(ad)) {
      ad.probeSince = null;
      ad.probeFailed = true;
      await this.toPassive(bus, ad, 'active scanning heard nothing either, so the pills are just away or switched off');
    }
  }

  /** The longest recent gap between transmissions heard here: roughly the slowest pill's interval. */
  private interval(ad: AdapterState): number {
    return Math.max(0, ...ad.gaps);
  }

  /** How long pills heard here before may go unheard before the listening is restarted. */
  private restartAfter(ad: AdapterState): number {
    return ad.mode === 'passive' ? Math.max(SILENCE_RESTART_MS, 2 * this.interval(ad)) : SILENCE_RESTART_MS;
  }

  /** How long a passive monitor may stay silent (while pills are expected) before active scanning is tried. */
  private giveUpMs(ad: AdapterState): number {
    return Math.max(PASSIVE_GIVE_UP_MS, 4 * this.interval(ad));
  }

  /**
   * Whether these adapters ought to be hearing pills: ones being recorded and heard in the last day, unless lately only
   * relays hear them; without that to go on, pills heard here before. Silence then means trouble (an active check, a
   * reset); otherwise the pills are just away.
   */
  private expectingPills(ads: AdapterState[]): boolean {
    if (!this.opts.expectPills) return ads.some((a) => a.devices.size > 0);
    try {
      return this.opts.expectPills();
    } catch (err) {
      this.log.warn({ err: describe(err) }, "couldn't tell which pills Bluetooth should be hearing");
      return false;
    }
  }

  private async checkPassive(bus: MessageBus, ad: AdapterState, now: number): Promise<void> {
    if (ad.reg?.state !== 'active') {
      this.log.warn({ adapter: ad.name }, 'the passive scanning monitor was off; registering it again');
      await this.restartPassive(bus, ad);
      return;
    }
    // Pills being recorded that this radio should hear (in case passive scanning never heard a thing).
    const expecting = this.expectingPills([ad]);
    const silent = now - (ad.lastAdvertAt ?? ad.since);
    if (expecting && this.scanMode === 'auto' && !ad.probeFailed && silent > this.giveUpMs(ad)) {
      await this.switchToActive(
        bus,
        ad,
        `nothing was heard for ${Math.round(silent / 60_000)} min with passive scanning, so it's trying active`,
      );
      ad.probeSince = now;
      return;
    }
    const limit = this.restartAfter(ad);
    if (ad.devices.size > 0 && silent > limit && now - ad.lastRestartAt > limit) {
      ad.lastRestartAt = now;
      this.log.warn({ adapter: ad.name, found: ad.found }, 'no RAPT adverts for a while; registering the passive scanning monitor again');
      await this.restartPassive(bus, ad);
    }
  }

  /**
   * Bluetooth can get stuck below BlueZ. On a Pi 3, restarting bluetoothd during active discovery left the controller
   * refusing to scan while the kernel believed it was scanning: monitors registered fine and nothing was heard until the
   * radio was switched off and on (rfkill), which needs root. So when pills are being recorded but no adapter has heard
   * any for about 5 of their intervals (at least 15 minutes) beyond the restarts above, the root helper is asked to
   * reset the adapter.
   */
  private checkStuck(now: number): void {
    const used = this.inUse();
    if (used.length === 0 || !this.expectingPills(used)) return;
    const interval = Math.max(0, ...used.map((a) => this.interval(a)));
    // Listening is restarted first where pills were heard before (checkActive, checkPassive); give that time to work.
    const restart = Math.max(0, ...used.filter((a) => a.devices.size > 0).map((a) => this.restartAfter(a)));
    const silent = now - this.heardAt;
    if (silent <= restart + Math.max(STUCK_MS, 5 * interval)) return;
    // And every adapter has listened for a while since it was (last) set up.
    if (used.some((a) => now - (a.lastAdvertAt ?? a.since) <= STUCK_MS)) return;
    this.askForReset(now, `nothing heard for ${Math.round(silent / 60_000)} min`);
  }

  /** Asks the root helper to switch the radio off and on (or suggests it, without the helper): hourly at most, backing off. */
  private askForReset(now: number, why: string): void {
    const wait = RESET_BACKOFF_MS[Math.min(Math.max(this.resets - 1, 0), RESET_BACKOFF_MS.length - 1)]!;
    if (this.resetAskedAt !== null && now - this.resetAskedAt < wait) return;
    this.resetAskedAt = now;
    this.resets++;
    const request = this.resetRequestFile();
    if (!request) {
      this.log.warn(
        { command: RESET_COMMAND },
        `Bluetooth looks stuck (${why}). Running the Pi setup again adds a helper that resets it by itself; or by hand: ${RESET_COMMAND}`,
      );
      return;
    }
    try {
      writeFileSync(`${request}.tmp`, JSON.stringify({ requestedAt: now, reason: why }));
      renameSync(`${request}.tmp`, request);
    } catch (err) {
      this.log.warn({ err: describe(err), command: RESET_COMMAND }, `Bluetooth looks stuck (${why}) but couldn't ask for a reset`);
      return;
    }
    this.pendingReset = now;
    this.setStatus({ lastResetAt: now });
    this.log.warn({ resets: this.resets }, `Bluetooth looked stuck (${why}); asked the system to reset the adapter`);
  }

  /** Where to ask for a reset, if the root helper (setup.d/25-bluetooth-reset.sh) watches this hub's data folder. */
  private resetRequestFile(): string | null {
    if (!this.opts.dataDir) return null;
    const file = join(this.opts.dataDir, RESET_REQUEST_FILE);
    try {
      return readFileSync(this.opts.resetUnit ?? RESET_UNIT, 'utf8').includes(file) ? file : null;
    } catch {
      return null;
    }
  }

  /** What the helper left after its last reset. */
  private resetResult(): { at: number; ok: boolean; error: string | null } | null {
    if (!this.opts.dataDir) return null;
    try {
      const raw = JSON.parse(readFileSync(join(this.opts.dataDir, RESET_STATUS_FILE), 'utf8')) as Record<string, unknown>;
      if (typeof raw.at !== 'number') return null;
      return { at: raw.at, ok: raw.ok === true, error: typeof raw.error === 'string' ? raw.error : null };
    } catch {
      return null;
    }
  }

  /** Logs how a reset went, and withdraws a request nothing picked up. */
  private followReset(now: number): void {
    const asked = this.pendingReset;
    if (asked === null || !this.opts.dataDir) return;
    const result = this.resetResult();
    if (result && result.at >= asked) {
      this.pendingReset = null;
      if (result.ok) this.log.info('the Bluetooth adapter was reset');
      else this.log.warn({ error: result.error }, "resetting the Bluetooth adapter didn't work");
      return;
    }
    if (now - asked < RESET_ANSWER_MS) return;
    this.pendingReset = null;
    const request = join(this.opts.dataDir, RESET_REQUEST_FILE);
    if (existsSync(request)) {
      rmSync(request, { force: true });
      this.log.warn(
        { command: RESET_COMMAND },
        `nothing picked up the request to reset Bluetooth (is rapthooker-bt-reset.path running?). By hand: ${RESET_COMMAND}`,
      );
    }
  }

  /** Every few minutes: RAPT devices BlueZ found that we missed, adapters plugged in, and a late monitor manager. */
  private async rescan(bus: MessageBus): Promise<void> {
    const objects = await this.managedObjects(bus);
    for (const [path, ifaces] of Object.entries(objects)) {
      const props = ifaces[DEVICE];
      if (props && this.adapterOf(path) && !this.watched.has(path)) await this.onDevice(bus, path, props, true);
    }
    const added = Object.keys(objects)
      .filter((p) => objects[p]![ADAPTER] && this.isWanted(p) && !this.adapters.has(p))
      .sort();
    for (const path of added) {
      await this.addAdapter(bus, path, objects).catch((err: unknown) =>
        this.log.warn({ adapter: nameOf(path), err: describe(err) }, 'could not use a new Bluetooth adapter'),
      );
    }
    for (const ad of [...this.adapters.values()]) {
      if (ad.retryPassive && objects[ad.path]?.[MONITOR_MANAGER]) await this.upgradeToPassive(bus, ad);
    }
  }
}
