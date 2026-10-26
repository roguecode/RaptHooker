import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DBusError, Message, MessageType, Variant, type MessageBus } from 'dbus-next';
import {
  BluezScanner,
  MONITOR_PATTERNS,
  RESET_COMMAND,
  RESET_REQUEST_FILE,
  RESET_STATUS_FILE,
  type BluezOptions,
  type Dbus,
} from '../ble/bluez.js';
import { CompositeScanner } from '../ble/composite.js';
import { RAPT_COMPANY_ID } from '../ble/rapt.js';
import { RelayHub } from '../ble/relays.js';
import { UnavailableScanner, type Advert } from '../ble/scanner.js';
import type { Logger } from '../log.js';
import { CAPTURED, silent } from './helpers.js';

const OBJECT_MANAGER = 'org.freedesktop.DBus.ObjectManager';
const PROPS = 'org.freedesktop.DBus.Properties';
const MANAGER = 'org.bluez.AdvertisementMonitorManager1';
const MONITOR = 'org.bluez.AdvertisementMonitor1';
const PILL_PATH = '/org/bluez/hci0/dev_08_B6_1F_00_00_66';

type Ifaces = Record<string, Record<string, unknown>>;
interface Call {
  path: string;
  iface: string;
  member: string;
  body: unknown[];
}

/** The system bus as the scanner sees it: method calls go to FakeBluez, and BlueZ can call back into the scanner. */
class FakeBus extends EventEmitter {
  name = ':1.42';
  private handlers: ((msg: Message) => boolean)[] = [];
  private serial = 1;
  private readonly replies = new Map<number, (msg: Message) => void>();

  constructor(private readonly bluez: FakeBluez) {
    super();
  }

  async call(msg: Message): Promise<Message> {
    // As with dbus-next once the connection has gone: the call never gets an answer.
    if (this.bluez.hang?.(msg, this)) return new Promise<Message>(() => undefined);
    const body = await this.bluez.handle(msg, this);
    return { body } as unknown as Message;
  }

  send(msg: Message): void {
    const waiting = this.replies.get(Number(msg.replySerial));
    if (waiting) {
      this.replies.delete(Number(msg.replySerial));
      waiting(msg);
    }
  }

  addMethodHandler(fn: (msg: Message) => boolean): void {
    this.handlers.push(fn);
  }

  removeMethodHandler(fn: (msg: Message) => boolean): void {
    this.handlers = this.handlers.filter((h) => h !== fn);
  }

  disconnect(): void {}

  /** BlueZ calling a method on the scanner's connection. Resolves with the reply, or null for no-reply calls. */
  callScanner(path: string, iface: string, member: string, signature = '', body: unknown[] = [], noReply = false): Promise<Message | null> {
    const msg = new Message({ type: MessageType.METHOD_CALL, path, interface: iface, member, signature, body, destination: this.name });
    msg.serial = this.serial++;
    msg.sender = ':1.7';
    if (noReply) msg.flags = 1 as Message['flags'];
    const reply = noReply ? Promise.resolve(null) : new Promise<Message>((resolve) => this.replies.set(msg.serial!, resolve));
    this.emit('message', msg);
    if (!this.handlers.some((h) => h(msg))) throw new Error(`nobody answered ${iface}.${member} on ${path}`);
    return reply;
  }

  signal(path: string, iface: string, member: string, signature: string, body: unknown[]): void {
    this.emit('message', Message.newSignal(path, iface, member, signature, body));
  }
}

/** Just enough of bluetoothd: adapters, discovery and advertisement monitors. */
class FakeBluez {
  /** Every connection the scanner opened; the last is the one it uses. */
  readonly buses: FakeBus[] = [];
  readonly objects: Record<string, Ifaces> = {};
  readonly calls: Call[] = [];
  readonly discovering = new Map<string, boolean>();
  /** Monitor apps by adapter path: the root registered, the monitor object found under it, and over which connection. */
  readonly apps = new Map<string, { root: string; monitor: string; props: Record<string, Variant>; bus: FakeBus }>();
  /** What bluetoothd does once it has read the monitor. */
  onRegister: 'activate' | 'release' | 'nothing' | 'refuse' = 'activate';
  /** The radio is switched off (rfkill): adapters can't be powered on. */
  blocked = false;
  /** StartDiscovery fails with this D-Bus error (and discovery doesn't start). */
  discoveryError: string | null = null;
  /** Calls that never get an answer. */
  hang: ((msg: Message, bus: FakeBus) => boolean) | null = null;

  readonly dbus = { systemBus: () => this.connect() as unknown as MessageBus, Message, Variant, MessageType } as unknown as Dbus;

  /** The scanner's connection. */
  get bus(): FakeBus {
    return this.buses[this.buses.length - 1] ?? this.connect();
  }

  private connect(): FakeBus {
    const bus = new FakeBus(this);
    this.buses.push(bus);
    return bus;
  }

  addAdapter(name: string, opts: { monitor?: boolean; powered?: boolean } = {}): void {
    const ifaces: Ifaces = { 'org.bluez.Adapter1': { Powered: new Variant('b', opts.powered ?? true) } };
    if (opts.monitor ?? true) {
      ifaces[MANAGER] = { SupportedMonitorTypes: new Variant('as', ['or_patterns']), SupportedFeatures: new Variant('as', []) };
    }
    this.objects[`/org/bluez/${name}`] = ifaces;
  }

  callsTo(member: string, path?: string): Call[] {
    return this.calls.filter((c) => c.member === member && (!path || c.path === path));
  }

  async handle(msg: Message, bus: FakeBus): Promise<unknown[]> {
    if (msg.destination === 'org.freedesktop.DBus') return [];
    this.calls.push({ path: msg.path, iface: msg.interface, member: msg.member, body: msg.body });
    switch (`${msg.interface}.${msg.member}`) {
      case `${OBJECT_MANAGER}.GetManagedObjects`:
        return [this.objects];
      case `${PROPS}.Get`:
        return [new Variant('b', this.discovering.get(msg.path) ?? false)];
      case `${PROPS}.Set`:
        if (msg.body[1] === 'Powered' && this.blocked) throw new DBusError('org.bluez.Error.Blocked', 'Blocked through rfkill');
        return [];
      case 'org.bluez.Adapter1.SetDiscoveryFilter':
        return [];
      case 'org.bluez.Adapter1.StartDiscovery':
        if (this.discoveryError) throw new DBusError(this.discoveryError, 'Operation already in progress');
        this.discovering.set(msg.path, true);
        return [];
      case 'org.bluez.Adapter1.StopDiscovery':
        this.discovering.set(msg.path, false);
        return [];
      case `${MANAGER}.RegisterMonitor`:
        return this.register(msg.path, msg.body[0] as string, bus);
      case `${MANAGER}.UnregisterMonitor`: {
        const app = this.apps.get(msg.path);
        if (!app || app.root !== msg.body[0]) throw new DBusError('org.bluez.Error.DoesNotExist', 'Does Not Exist');
        this.apps.delete(msg.path);
        void app.bus.callScanner(app.monitor, MONITOR, 'Release', '', [], true);
        return [];
      }
      default:
        throw new DBusError('org.freedesktop.DBus.Error.UnknownMethod', `${msg.interface}.${msg.member}`);
    }
  }

  /** Like bluetoothd: reads the application's monitors before replying, then switches them on (or doesn't). */
  private async register(adapter: string, root: string, bus: FakeBus): Promise<unknown[]> {
    if (!this.objects[adapter]?.[MANAGER]) throw new DBusError('org.freedesktop.DBus.Error.UnknownMethod', 'No such interface');
    if (this.onRegister === 'refuse') throw new DBusError('org.bluez.Error.Failed', 'Failed to create Adv Monitor app');
    const reply = await bus.callScanner(root, OBJECT_MANAGER, 'GetManagedObjects');
    const objects = reply!.body[0] as Record<string, Record<string, Record<string, Variant>>>;
    const [monitor, ifaces] = Object.entries(objects)[0]!;
    this.apps.set(adapter, { root, monitor, props: ifaces[MONITOR]!, bus });
    const behaviour = this.onRegister;
    setTimeout(() => {
      if (behaviour === 'activate') void bus.callScanner(monitor, MONITOR, 'Activate', '', [], true);
      if (behaviour === 'release') void bus.callScanner(monitor, MONITOR, 'Release', '', [], true);
    }, 1);
    return [];
  }

  /** A pill turning up (BlueZ creates a device object for it). */
  deviceAdded(path: string, data: string, companyId = RAPT_COMPANY_ID, rssi = -70): void {
    this.bus.signal('/', OBJECT_MANAGER, 'InterfacesAdded', 'oa{sa{sv}}', [
      path,
      {
        'org.bluez.Device1': {
          Address: new Variant('s', path.slice(-17).replace(/_/g, ':')),
          RSSI: new Variant('n', rssi),
          ManufacturerData: new Variant('a{qv}', { [companyId]: new Variant('ay', Buffer.from(data, 'hex')) }),
        },
      },
    ]);
  }

  deviceChanged(path: string, data: string, rssi?: number): void {
    const changed: Record<string, Variant> = {
      ManufacturerData: new Variant('a{qv}', { [RAPT_COMPANY_ID]: new Variant('ay', Buffer.from(data, 'hex')) }),
    };
    if (rssi !== undefined) changed.RSSI = new Variant('n', rssi);
    this.bus.signal(path, PROPS, 'PropertiesChanged', 'sa{sv}as', ['org.bluez.Device1', changed, []]);
  }

  /** The adapter switching off or on (rfkill, bluetoothctl power...). */
  setPowered(name: string, powered: boolean): void {
    const path = `/org/bluez/${name}`;
    this.objects[path]!['org.bluez.Adapter1']!.Powered = new Variant('b', powered);
    this.bus.signal(path, PROPS, 'PropertiesChanged', 'sa{sv}as', ['org.bluez.Adapter1', { Powered: new Variant('b', powered) }, []]);
  }

  /** The adapter going away (its monitors with it), as it can while it's reset. */
  removeAdapter(name: string): void {
    const path = `/org/bluez/${name}`;
    delete this.objects[path];
    this.apps.delete(path);
    this.bus.signal('/', OBJECT_MANAGER, 'InterfacesRemoved', 'oas', [path, ['org.bluez.Adapter1', MANAGER]]);
  }

  /** ...and coming back. */
  restoreAdapter(name: string, opts: { monitor?: boolean } = {}): void {
    this.addAdapter(name, opts);
    const path = `/org/bluez/${name}`;
    this.bus.signal('/', OBJECT_MANAGER, 'InterfacesAdded', 'oa{sa{sv}}', [path, this.objects[path]!]);
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
const MIN = 60_000;
const HOUR = 60 * MIN;
const START = Date.UTC(2026, 9, 1, 12);

let scanner: BluezScanner | undefined;
const dirs: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await scanner?.stop();
  scanner = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function start(fake: FakeBluez, opts: Omit<BluezOptions, 'dbus'> = {}, log: Logger = silent) {
  let now = START;
  scanner = new BluezScanner(log, { dbus: fake.dbus, now: () => now, activateTimeoutMs: 100, ...opts });
  const adverts: Advert[] = [];
  scanner.on('advert', (a) => adverts.push(a));
  await scanner.start();
  return { scanner, adverts, advance: (ms: number) => (now += ms), clock: () => now };
}

/** A data folder, with the reset helper's path unit watching it (unless it isn't installed). */
function resetHelper(installed = true) {
  const dir = mkdtempSync(join(tmpdir(), 'rapthooker-bt-'));
  dirs.push(dir);
  const unit = join(dir, 'rapthooker-bt-reset.path');
  const request = join(dir, RESET_REQUEST_FILE);
  if (installed) writeFileSync(unit, `[Path]\nPathExists=${request}\nUnit=rapthooker-bt-reset.service\n`);
  return {
    opts: { dataDir: dir, resetUnit: unit },
    request,
    status: join(dir, RESET_STATUS_FILE),
    /** The request the scanner left, taken away as bt-reset.sh does. */
    take(): { requestedAt: number; reason: string } | null {
      if (!existsSync(request)) return null;
      const body = JSON.parse(readFileSync(request, 'utf8')) as { requestedAt: number; reason: string };
      rmSync(request);
      return body;
    },
  };
}

/** A logger that keeps what's logged. */
function recorder() {
  const lines: { level: string; msg: string }[] = [];
  const at =
    (level: string) =>
    (a: unknown, b?: unknown): void => {
      lines.push({ level, msg: typeof a === 'string' ? a : typeof b === 'string' ? b : '' });
    };
  const log = { trace: at('trace'), debug: at('debug'), info: at('info'), warn: at('warn'), error: at('error'), fatal: at('fatal') };
  return { log: { ...log, child: () => log } as unknown as Logger, lines, warnings: () => lines.filter((l) => l.level === 'warn') };
}

describe('BlueZ scanner, passive', () => {
  it('registers an advertisement monitor for RAPT manufacturer data instead of discovering', async () => {
    const fake = new FakeBluez();
    fake.addAdapter('hci0');
    const { scanner } = await start(fake);

    expect(scanner.status).toMatchObject({ state: 'scanning', mode: 'passive', adapter: 'hci0', adapters: ['hci0'], modeReason: null });
    expect(fake.callsTo('StartDiscovery')).toHaveLength(0);
    expect(fake.callsTo('SetDiscoveryFilter')).toHaveLength(0);
    const app = fake.apps.get('/org/bluez/hci0')!;
    expect(app.monitor.startsWith(`${app.root}/`)).toBe(true);
    // RSSI thresholds stay unset (absent), so weak pills are still reported.
    expect(Object.keys(app.props).sort()).toEqual(['Patterns', 'Type']);
    expect(app.props.Type!.value).toBe('or_patterns');
    expect(app.props.Patterns!.signature).toBe('a(yyay)');
    const patterns = (app.props.Patterns!.value as [number, number, Buffer][]).map(([pos, type, bytes]) => [pos, type, [...bytes]]);
    // 'RA' and 'KE': company ids 0x4152 and 0x454B as they go on air (little-endian), at the start of the AD data;
    // then the RAPT Thermometer's iBeacon: Apple's 0x004C, the iBeacon type and "Keg".
    expect(patterns).toEqual([
      [0, 0xff, [0x52, 0x41]],
      [0, 0xff, [0x4b, 0x45]],
      [0, 0xff, [0x4c, 0x00, 0x02, 0x15, 0x4b, 0x65, 0x67]],
    ]);
    expect(MONITOR_PATTERNS).toHaveLength(3);

    // The monitor's properties can be read the usual way too.
    const all = await fake.bus.callScanner(app.monitor, PROPS, 'GetAll', 's', [MONITOR]);
    expect(Object.keys(all!.body[0] as object).sort()).toEqual(['Patterns', 'Type']);

    await scanner.stop();
    expect(fake.callsTo('UnregisterMonitor')[0]?.body).toEqual([app.root]);
  });

  it('hands on adverts from new devices and property changes, and ignores other devices', async () => {
    const fake = new FakeBluez();
    fake.addAdapter('hci0');
    const { adverts } = await start(fake);

    fake.deviceAdded(PILL_PATH, CAPTURED.metricsFalling, RAPT_COMPANY_ID, -77);
    await settle();
    fake.deviceChanged(PILL_PATH, CAPTURED.metricsRising, -60);
    // An iPhone's Apple data is ignored; a RAPT Thermometer's iBeacon (under Apple's id too) isn't.
    fake.deviceAdded('/org/bluez/hci0/dev_02_00_00_00_00_01', '1005031c0e5b2a', 0x004c);
    fake.deviceAdded('/org/bluez/hci0/dev_D0_26_25_B4_48_95', CAPTURED.thermometerRest, 0x004c, -45);
    await settle();
    // BlueZ's monitor reporting each advert: for a RAPT device it knows, that it was heard again; anything else, nothing.
    const monitor = fake.apps.get('/org/bluez/hci0')!.monitor;
    await fake.bus.callScanner(monitor, MONITOR, 'DeviceFound', 'o', ['/org/bluez/hci0/dev_D0_26_25_B4_48_95'], true);
    await fake.bus.callScanner(monitor, MONITOR, 'DeviceFound', 'o', ['/org/bluez/hci0/dev_02_00_00_00_00_01'], true);

    expect(adverts).toHaveLength(4);
    expect(adverts[0]).toMatchObject({ address: '08:B6:1F:00:00:66', rssi: -77, cached: false, source: 'hci0' });
    expect(Buffer.from(adverts[0]!.manufacturer!.get(RAPT_COMPANY_ID)!).toString('hex')).toBe(CAPTURED.metricsFalling);
    expect(adverts[1]).toMatchObject({ address: '08:B6:1F:00:00:66', rssi: -60 });
    expect(Buffer.from(adverts[1]!.manufacturer!.get(RAPT_COMPANY_ID)!).toString('hex')).toBe(CAPTURED.metricsRising);
    expect(adverts[2]).toMatchObject({ address: 'D0:26:25:B4:48:95', rssi: -45 });
    expect(Buffer.from(adverts[2]!.manufacturer!.get(0x004c)!).toString('hex')).toBe(CAPTURED.thermometerRest);
    expect(adverts[3]).toMatchObject({ address: 'D0:26:25:B4:48:95', rssi: null, manufacturer: null, cached: false, source: 'hci0' });
  });

  it('picks up RAPT devices BlueZ already knows', async () => {
    const fake = new FakeBluez();
    fake.addAdapter('hci0');
    fake.objects[PILL_PATH] = {
      'org.bluez.Device1': {
        Address: new Variant('s', '08:B6:1F:00:00:66'),
        ManufacturerData: new Variant('a{qv}', { [RAPT_COMPANY_ID]: new Variant('ay', Buffer.from(CAPTURED.metricsFalling, 'hex')) }),
      },
    };
    const { adverts } = await start(fake);
    expect(adverts).toHaveLength(1);
    expect(adverts[0]).toMatchObject({ cached: true, rssi: null });
  });
});

describe('BlueZ scanner, falling back to active', () => {
  it('scans actively when BlueZ has no advertisement monitor (experimental features off)', async () => {
    const fake = new FakeBluez();
    fake.addAdapter('hci0', { monitor: false });
    const { scanner, adverts } = await start(fake);
    expect(scanner.status).toMatchObject({ state: 'scanning', mode: 'active', adapters: ['hci0'] });
    expect(scanner.status.modeReason).toMatch(/experimental/);
    expect(fake.callsTo('RegisterMonitor')).toHaveLength(0);
    expect(fake.callsTo('SetDiscoveryFilter')[0]!.body).toEqual([
      { Transport: new Variant('s', 'le'), DuplicateData: new Variant('b', true) },
    ]);
    expect(fake.callsTo('StartDiscovery')).toHaveLength(1);

    fake.deviceAdded(PILL_PATH, CAPTURED.metricsFalling);
    await settle();
    expect(adverts).toHaveLength(1);
  });

  it.each([
    ['refuses the monitor', 'refuse', /Failed to create/],
    ['releases it straight away', 'release', /couldn't switch the monitor on/],
    ['never switches it on', 'nothing', /didn't switch the monitor on/],
  ] as const)('scans actively when BlueZ %s', async (_what, behaviour, reason) => {
    const fake = new FakeBluez();
    fake.addAdapter('hci0');
    fake.onRegister = behaviour;
    const { scanner } = await start(fake);
    expect(scanner.status).toMatchObject({ state: 'scanning', mode: 'active' });
    expect(scanner.status.modeReason).toMatch(reason);
    expect(fake.callsTo('StartDiscovery')).toHaveLength(1);
    // A monitor BlueZ accepted but didn't use isn't left behind.
    if (behaviour !== 'refuse') expect(fake.apps.size).toBe(0);
  });

  it("reports an error rather than scanning actively when passive is insisted on but isn't available", async () => {
    const fake = new FakeBluez();
    fake.addAdapter('hci0', { monitor: false });
    const { scanner } = await start(fake, { scanMode: 'passive' });
    expect(scanner.status.state).toBe('error');
    expect(scanner.status.error).toMatch(/Passive scanning isn't available/);
    expect(fake.callsTo('StartDiscovery')).toHaveLength(0);
  });

  it('scans actively when told to, even if passive is available', async () => {
    const fake = new FakeBluez();
    fake.addAdapter('hci0');
    const { scanner } = await start(fake, { scanMode: 'active' });
    expect(scanner.status).toMatchObject({ mode: 'active', modeReason: null });
    expect(fake.callsTo('RegisterMonitor')).toHaveLength(0);
  });

  it('goes passive when the monitor manager turns up late (BlueZ still starting)', async () => {
    const fake = new FakeBluez();
    fake.addAdapter('hci0', { monitor: false });
    const { scanner } = await start(fake);
    expect(scanner.status.mode).toBe('active');
    fake.objects['/org/bluez/hci0']![MANAGER] = { SupportedMonitorTypes: new Variant('as', ['or_patterns']) };
    fake.bus.signal('/', OBJECT_MANAGER, 'InterfacesAdded', 'oa{sa{sv}}', ['/org/bluez/hci0', { [MANAGER]: {} }]);
    await settle();
    await settle();
    expect(scanner.status).toMatchObject({ mode: 'passive', modeReason: null });
    expect(fake.callsTo('StopDiscovery')).toHaveLength(1);
  });
});

describe('BlueZ scanner, several adapters', () => {
  it('uses every adapter, each in the best mode it has', async () => {
    const fake = new FakeBluez();
    fake.addAdapter('hci0');
    fake.addAdapter('hci1', { monitor: false, powered: false });
    const { scanner, adverts } = await start(fake);
    expect(scanner.status).toMatchObject({ state: 'scanning', adapter: 'hci0', adapters: ['hci0', 'hci1'], mode: 'active' });
    expect(scanner.status.modeReason).toMatch(/^hci1: /);
    expect(fake.callsTo('Set', '/org/bluez/hci1')).toHaveLength(1);
    expect(fake.callsTo('RegisterMonitor', '/org/bluez/hci0')).toHaveLength(1);
    expect(fake.callsTo('StartDiscovery', '/org/bluez/hci1')).toHaveLength(1);

    fake.deviceAdded('/org/bluez/hci1/dev_08_B6_1F_00_00_66', CAPTURED.metricsFalling);
    fake.deviceAdded(PILL_PATH, CAPTURED.metricsFalling);
    await settle();
    expect(adverts.map((a) => a.source)).toEqual(['hci1', 'hci0']);
  });

  it('uses only the adapters listed, and the older single setting', async () => {
    const fake = new FakeBluez();
    fake.addAdapter('hci0');
    fake.addAdapter('hci1');
    const { scanner } = await start(fake, { adapters: ['hci1'] });
    expect(scanner.status.adapters).toEqual(['hci1']);
    await scanner.stop();

    const other = await start(fake, { adapter: 'hci0' });
    expect(other.scanner.status.adapters).toEqual(['hci0']);
    await other.scanner.stop();

    const missing = await start(fake, { adapters: ['hci5'] });
    expect(missing.scanner.status).toMatchObject({ state: 'error', error: 'Bluetooth adapter hci5 not found' });
  });

  it('adds an adapter plugged in later and drops one that goes away', async () => {
    const fake = new FakeBluez();
    fake.addAdapter('hci0');
    const { scanner } = await start(fake);
    fake.addAdapter('hci1');
    fake.bus.signal('/', OBJECT_MANAGER, 'InterfacesAdded', 'oa{sa{sv}}', ['/org/bluez/hci1', fake.objects['/org/bluez/hci1']!]);
    await settle();
    await settle();
    expect(scanner.status.adapters).toEqual(['hci0', 'hci1']);

    fake.bus.signal('/', OBJECT_MANAGER, 'InterfacesRemoved', 'oas', ['/org/bluez/hci0', ['org.bluez.Adapter1', MANAGER]]);
    expect(scanner.status).toMatchObject({ state: 'scanning', adapters: ['hci1'], adapter: 'hci1' });
  });
});

describe('BlueZ scanner watchdog', () => {
  it('restarts discovery that stopped or went quiet (active)', async () => {
    const fake = new FakeBluez();
    fake.addAdapter('hci0', { monitor: false });
    const { scanner, advance } = await start(fake);
    fake.deviceAdded(PILL_PATH, CAPTURED.metricsFalling);
    await settle();

    fake.discovering.set('/org/bluez/hci0', false);
    await scanner.check();
    expect(fake.callsTo('StartDiscovery')).toHaveLength(2);

    advance(16 * 60_000);
    await scanner.check();
    expect(fake.callsTo('StopDiscovery')).toHaveLength(1);
    expect(fake.callsTo('StartDiscovery')).toHaveLength(3);
    // Not again straight away.
    await scanner.check();
    expect(fake.callsTo('StartDiscovery')).toHaveLength(3);
  });

  it('registers the monitor again when BlueZ releases it or it goes quiet (passive)', async () => {
    const fake = new FakeBluez();
    fake.addAdapter('hci0');
    const { scanner, advance } = await start(fake);
    fake.deviceAdded(PILL_PATH, CAPTURED.metricsFalling);
    await settle();
    const first = fake.apps.get('/org/bluez/hci0')!;

    // BlueZ releases the monitor (e.g. the kernel dropped it): the watchdog registers a new one.
    await fake.bus.callScanner(first.monitor, MONITOR, 'Release', '', [], true);
    await scanner.check();
    const second = fake.apps.get('/org/bluez/hci0')!;
    expect(second.root).not.toBe(first.root);
    expect(scanner.status.mode).toBe('passive');

    // Nothing heard for a while although a pill was: register again.
    advance(16 * 60_000);
    await scanner.check();
    const third = fake.apps.get('/org/bluez/hci0')!;
    expect(third.root).not.toBe(second.root);
    expect(fake.callsTo('UnregisterMonitor').map((c) => c.body[0])).toContain(second.root);
    expect(fake.callsTo('StartDiscovery')).toHaveLength(0);
    expect(scanner.status.mode).toBe('passive');
  });

  it('tries active scanning when passive stays silent for hours, and goes back if that hears nothing either', async () => {
    const fake = new FakeBluez();
    fake.addAdapter('hci0');
    const { scanner, advance } = await start(fake, { expectPills: () => true });

    advance(2 * 3_600_000 + 60_000);
    await scanner.check();
    expect(scanner.status.mode).toBe('active');
    expect(scanner.status.modeReason).toMatch(/nothing was heard/);
    expect(fake.callsTo('StartDiscovery')).toHaveLength(1);

    advance(2 * 3_600_000 + 60_000);
    await scanner.check();
    expect(scanner.status).toMatchObject({ mode: 'passive', modeReason: null });
    expect(fake.callsTo('StopDiscovery').length).toBeGreaterThan(0);
    // It doesn't keep trying while the pills are away.
    advance(3 * 3_600_000);
    await scanner.check();
    expect(scanner.status.mode).toBe('passive');
  });

  it('stays active when active scanning hears pills that passive scanning missed', async () => {
    const fake = new FakeBluez();
    fake.addAdapter('hci0');
    const { scanner, advance } = await start(fake, { expectPills: () => true });
    advance(2 * 3_600_000 + 60_000);
    await scanner.check();
    fake.deviceAdded(PILL_PATH, CAPTURED.metricsFalling);
    await settle();
    expect(scanner.status.mode).toBe('active');
    expect(scanner.status.modeReason).toMatch(/active scanning hears them/);
    advance(3 * 3_600_000);
    fake.discovering.set('/org/bluez/hci0', true);
    await scanner.check();
    expect(scanner.status.mode).toBe('active');
  });

  it('sets everything up again when BlueZ restarts', async () => {
    const fake = new FakeBluez();
    fake.addAdapter('hci0');
    const { scanner } = await start(fake);
    fake.apps.clear();
    fake.bus.signal('/org/freedesktop/DBus', 'org.freedesktop.DBus', 'NameOwnerChanged', 'sss', ['org.bluez', '', ':1.99']);
    await settle();
    expect(scanner.status).toMatchObject({ state: 'scanning', mode: 'passive' });
    expect(fake.callsTo('RegisterMonitor')).toHaveLength(2);
    expect(fake.apps.size).toBe(1);
  });
});

describe('BlueZ scanner, a stuck adapter', () => {
  it("asks for the adapter to be reset when registering the monitor again didn't help", async () => {
    const helper = resetHelper();
    const rec = recorder();
    const fake = new FakeBluez();
    fake.addAdapter('hci0');
    const { scanner, advance } = await start(fake, { ...helper.opts, expectPills: () => true }, rec.log);
    fake.deviceAdded(PILL_PATH, CAPTURED.metricsFalling);
    await settle();

    // First the monitor is registered again...
    advance(16 * MIN);
    await scanner.check();
    expect(fake.callsTo('RegisterMonitor')).toHaveLength(2);
    expect(helper.take()).toBeNull();
    advance(14 * MIN);
    await scanner.check();
    expect(helper.take()).toBeNull();

    // ...and when that hasn't helped 15 minutes later, the adapter is reset.
    advance(2 * MIN);
    await scanner.check();
    expect(helper.take()).toEqual({ requestedAt: START + 32 * MIN, reason: 'nothing heard for 32 min' });
    expect(scanner.status.lastResetAt).toBe(START + 32 * MIN);
    expect(rec.warnings().map((l) => l.msg)).toContain(
      'Bluetooth looked stuck (nothing heard for 32 min); asked the system to reset the adapter',
    );
  });

  it("waits about 5 of the pills' intervals", async () => {
    const helper = resetHelper();
    const fake = new FakeBluez();
    fake.addAdapter('hci0');
    const { scanner, advance } = await start(fake, { ...helper.opts, expectPills: () => true });
    // A pill heard every 10 minutes.
    fake.deviceAdded(PILL_PATH, CAPTURED.metricsFalling);
    await settle();
    advance(10 * MIN);
    fake.deviceChanged(PILL_PATH, CAPTURED.metricsRising);
    advance(10 * MIN);
    fake.deviceChanged(PILL_PATH, CAPTURED.metricsFalling);
    await settle();

    // Registered again after 2 intervals, reset 5 intervals after that.
    advance(21 * MIN);
    await scanner.check();
    expect(fake.callsTo('RegisterMonitor')).toHaveLength(2);
    advance(48 * MIN);
    await scanner.check();
    expect(helper.take()).toBeNull();
    advance(2 * MIN);
    await scanner.check();
    expect(helper.take()?.reason).toBe('nothing heard for 71 min');
  });

  it("resets after 15 minutes when nothing at all has been heard since starting (a controller that won't scan)", async () => {
    const helper = resetHelper();
    const fake = new FakeBluez();
    fake.addAdapter('hci0');
    const { scanner, advance } = await start(fake, { ...helper.opts, scanMode: 'passive', expectPills: () => true });
    advance(14 * MIN);
    await scanner.check();
    expect(helper.take()).toBeNull();
    advance(2 * MIN);
    await scanner.check();
    expect(helper.take()?.reason).toBe('nothing heard for 16 min');
    // Nothing had been heard here to register the monitor again for.
    expect(fake.callsTo('RegisterMonitor')).toHaveLength(1);
  });

  it('leaves Bluetooth alone while no pills are being recorded', async () => {
    const helper = resetHelper();
    const fake = new FakeBluez();
    fake.addAdapter('hci0');
    const { scanner, advance } = await start(fake, { ...helper.opts, scanMode: 'passive', expectPills: () => false });
    // A pill was heard once (a neighbour's, or one that's archived).
    fake.deviceAdded(PILL_PATH, CAPTURED.metricsFalling);
    await settle();
    for (let i = 0; i < 18; i++) {
      advance(10 * MIN);
      await scanner.check();
    }
    expect(helper.take()).toBeNull();
    expect(scanner.status.lastResetAt).toBeNull();
  });

  it('resets at most hourly, backing off to 3 and then every 6 hours, until pills are heard again', async () => {
    const helper = resetHelper();
    const fake = new FakeBluez();
    fake.addAdapter('hci0');
    const { scanner, advance } = await start(fake, { ...helper.opts, scanMode: 'passive', expectPills: () => true });
    const asked: number[] = [];
    let at = 0;
    const tick = async (minutes: number) => {
      advance(minutes * MIN);
      at += minutes;
      await scanner.check();
      const request = helper.take();
      if (request) asked.push((request.requestedAt - START) / MIN);
    };

    await tick(16);
    while (at < 1096) await tick(10);
    expect(asked).toEqual([16, 76, 256, 616, 976]);

    // Heard again: the next time it goes quiet, resets start at hourly again.
    fake.deviceAdded(PILL_PATH, CAPTURED.metricsFalling);
    await settle();
    while (at < 1406) await tick(10);
    expect(asked).toEqual([16, 76, 256, 616, 976, 1136, 1196, 1376]);
  });

  it("only suggests the command when the reset helper isn't installed", async () => {
    const rec = recorder();
    const fake = new FakeBluez();
    fake.addAdapter('hci0');
    const missing = resetHelper(false);
    const { scanner, advance } = await start(fake, { ...missing.opts, scanMode: 'passive', expectPills: () => true }, rec.log);
    const hints = () => rec.warnings().filter((l) => l.msg.includes(RESET_COMMAND));

    advance(16 * MIN);
    await scanner.check();
    expect(existsSync(missing.request)).toBe(false);
    expect(scanner.status.lastResetAt).toBeNull();
    expect(hints()).toHaveLength(1);
    expect(hints()[0]!.msg).toMatch(/^Bluetooth looks stuck \(nothing heard for 16 min\)/);
    // Not every minute.
    advance(10 * MIN);
    await scanner.check();
    expect(hints()).toHaveLength(1);
    await scanner.stop();

    // A helper watching some other data folder doesn't count either.
    const other = resetHelper();
    const elsewhere = await start(fake, { dataDir: missing.opts.dataDir, resetUnit: other.opts.resetUnit, expectPills: () => true });
    elsewhere.advance(16 * MIN);
    await elsewhere.scanner.check();
    expect(existsSync(missing.request)).toBe(false);
    expect(existsSync(other.request)).toBe(false);
  });

  it('asks for a reset when BlueZ keeps failing to start discovery', async () => {
    const helper = resetHelper();
    const fake = new FakeBluez();
    fake.addAdapter('hci0', { monitor: false });
    // BlueZ says discovery is under way, but the adapter isn't discovering.
    fake.discoveryError = 'org.bluez.Error.InProgress';
    const { scanner } = await start(fake, helper.opts);
    expect(scanner.status).toMatchObject({ state: 'scanning', mode: 'active' });
    await scanner.check();
    expect(helper.take()).toBeNull();
    await scanner.check();
    expect(fake.callsTo('StartDiscovery')).toHaveLength(3);
    expect(helper.take()?.reason).toMatch(/^BlueZ couldn't start scanning 3 times in a row: Operation already in progress/);
  });

  it('logs how the reset went, and withdraws a request nothing picks up', async () => {
    const helper = resetHelper();
    const rec = recorder();
    const fake = new FakeBluez();
    fake.addAdapter('hci0');
    const { scanner, advance } = await start(fake, { ...helper.opts, scanMode: 'passive', expectPills: () => true }, rec.log);
    advance(16 * MIN);
    await scanner.check();
    const first = helper.take()!;
    writeFileSync(helper.status, JSON.stringify({ at: first.requestedAt + 3000, ok: true, error: null }));
    advance(MIN);
    await scanner.check();
    expect(rec.lines).toContainEqual({ level: 'info', msg: 'the Bluetooth adapter was reset' });

    advance(61 * MIN);
    await scanner.check();
    expect(existsSync(helper.request)).toBe(true);
    advance(6 * MIN);
    await scanner.check();
    expect(existsSync(helper.request)).toBe(false);
    expect(rec.warnings().some((l) => l.msg.startsWith('nothing picked up the request to reset Bluetooth'))).toBe(true);
  });

  it('shows the last reset after a restart, and counts it for the hourly limit', async () => {
    const helper = resetHelper();
    writeFileSync(helper.status, JSON.stringify({ at: START - 30 * MIN, ok: true, error: null }));
    const fake = new FakeBluez();
    fake.addAdapter('hci0');
    const { scanner, advance } = await start(fake, { ...helper.opts, scanMode: 'passive', expectPills: () => true });
    expect(scanner.status.lastResetAt).toBe(START - 30 * MIN);
    advance(16 * MIN);
    await scanner.check();
    expect(helper.take()).toBeNull();
    advance(15 * MIN);
    await scanner.check();
    expect(helper.take()?.requestedAt).toBe(START + 31 * MIN);
  });
});

describe('BlueZ scanner, after an adapter reset', () => {
  it.each([
    ['passive', true],
    ['active', false],
  ] as const)('sets up again (%s) when the adapter goes away and comes back', async (mode, monitor) => {
    const fake = new FakeBluez();
    fake.addAdapter('hci0', { monitor });
    const { scanner, adverts } = await start(fake);
    expect(scanner.status.mode).toBe(mode);
    const first = fake.apps.get('/org/bluez/hci0');

    fake.removeAdapter('hci0');
    expect(scanner.status.state).toBe('error');
    fake.restoreAdapter('hci0', { monitor });
    await settle();
    await settle();
    expect(scanner.status).toMatchObject({ state: 'scanning', mode, adapters: ['hci0'] });
    if (monitor) {
      expect(fake.callsTo('RegisterMonitor')).toHaveLength(2);
      expect(fake.apps.get('/org/bluez/hci0')!.root).not.toBe(first!.root);
    } else {
      expect(fake.callsTo('StartDiscovery')).toHaveLength(2);
    }
    fake.deviceAdded(PILL_PATH, CAPTURED.metricsFalling);
    await settle();
    expect(adverts).toHaveLength(1);
  });

  it('sets up again as soon as the adapter is back on after rfkill switched it off', async () => {
    const fake = new FakeBluez();
    fake.addAdapter('hci0');
    const { scanner, adverts } = await start(fake);

    fake.blocked = true;
    fake.setPowered('hci0', false);
    await settle();
    await settle();
    expect(scanner.status.state).toBe('error');
    expect(scanner.status.error).toMatch(/Blocked through rfkill/);

    // bluetoothd switches it back on when it's unblocked.
    fake.blocked = false;
    fake.setPowered('hci0', true);
    await settle();
    await settle();
    expect(scanner.status).toMatchObject({ state: 'scanning', mode: 'passive' });
    expect(fake.callsTo('RegisterMonitor')).toHaveLength(2);
    fake.deviceAdded(PILL_PATH, CAPTURED.metricsFalling);
    await settle();
    expect(adverts).toHaveLength(1);
  });
});

/** What bt-reset.sh does to the adapter: rfkill switches it off, then bluetoothd switches it back on. */
async function rfkill(fake: FakeBluez, name = 'hci0') {
  fake.blocked = true;
  fake.setPowered(name, false);
  await settle();
  await settle();
  fake.blocked = false;
  fake.setPowered(name, true);
  await settle();
  await settle();
}

const bluetoothd = (fake: FakeBluez, oldOwner: string, newOwner: string) =>
  fake.bus.signal('/org/freedesktop/DBus', 'org.freedesktop.DBus', 'NameOwnerChanged', 'sss', ['org.bluez', oldOwner, newOwner]);

describe('BlueZ scanner, bluetoothd and D-Bus going away', () => {
  it('starts bluetoothd again and sets up when it stops without notice (a crash)', async () => {
    const fake = new FakeBluez();
    fake.addAdapter('hci0');
    const { scanner } = await start(fake);
    vi.useFakeTimers();

    // bluetoothd dies: its name goes, and its objects with it (it doesn't get to say they're gone).
    fake.apps.clear();
    bluetoothd(fake, ':1.7', '');
    expect(scanner.status).toMatchObject({ state: 'error', error: 'BlueZ (bluetoothd) stopped' });

    // The retry asks BlueZ for its objects, which starts bluetoothd again through D-Bus, and sets everything up.
    await vi.advanceTimersByTimeAsync(2_100);
    expect(fake.callsTo('GetManagedObjects', '/')).toHaveLength(2);
    expect(scanner.status).toMatchObject({ state: 'scanning', mode: 'passive' });
    expect(fake.apps.size).toBe(1);
  });

  it('sets up once when bluetoothd is back before the retry', async () => {
    const fake = new FakeBluez();
    fake.addAdapter('hci0');
    const { scanner } = await start(fake);
    vi.useFakeTimers();
    fake.apps.clear();
    bluetoothd(fake, ':1.7', '');
    bluetoothd(fake, '', ':1.99');
    await vi.advanceTimersByTimeAsync(10);
    expect(scanner.status).toMatchObject({ state: 'scanning', mode: 'passive' });
    // The retry that was waiting isn't needed any more.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.callsTo('RegisterMonitor')).toHaveLength(2);
  });

  it('still sets up on a new D-Bus connection when the old one ended mid-setup', async () => {
    vi.useFakeTimers();
    const fake = new FakeBluez();
    fake.addAdapter('hci0');
    // The first connection's subscriptions never get an answer: it has ended, and dbus-next doesn't fail waiting calls.
    fake.hang = (msg, bus) => bus === fake.buses[0] && msg.member === 'AddMatch';
    scanner = new BluezScanner(silent, { dbus: fake.dbus, activateTimeoutMs: 100 });
    const started = scanner.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(scanner.status.state).toBe('starting');

    fake.buses[0]!.emit('error', new Error('connection reset'));
    expect(scanner.status.state).toBe('error');
    // The retry opens a second connection. Its setup waits for the first one's to give up (a timeout), then runs.
    await vi.advanceTimersByTimeAsync(20_000);
    await started;
    await vi.advanceTimersByTimeAsync(100);
    expect(fake.buses).toHaveLength(2);
    expect(scanner.status).toMatchObject({ state: 'scanning', mode: 'passive', adapters: ['hci0'] });
    expect(fake.apps.get('/org/bluez/hci0')?.bus).toBe(fake.buses[1]);
  });
});

describe('BlueZ scanner, pills the radio should hear', () => {
  const address = '08:B6:1F:00:00:66';
  const fromRelay = (relays: RelayHub, at = address) =>
    relays.ingest('shed', [{ address: at, rssi: -80, manufacturerData: { [RAPT_COMPANY_ID]: CAPTURED.metricsFalling } }]);

  it("counts recorded pills heard lately, but not ones only relays hear or nobody's heard for a day", () => {
    let now = START;
    const radio = new UnavailableScanner('test');
    const relays = new RelayHub(silent, () => now);
    const composite = new CompositeScanner(radio, relays, () => now);
    const fromRadio = (at = address, cached = false) =>
      radio.emit('advert', { address: at, rssi: -70, manufacturer: null, at: now, mono: now, cached, source: 'hci0' } satisfies Advert);
    const pill = { address, lastHeardAt: START - HOUR };

    // Heard an hour ago (before a restart, say): the radio should hear it.
    expect(composite.radioExpects([pill])).toBe(true);
    expect(composite.radioExpects([])).toBe(false);
    // Only a relay hears it now: it's out of the radio's range.
    fromRelay(relays);
    expect(composite.radioExpects([pill])).toBe(false);
    // The radio hears it too. The relay's copy of the same transmission arriving a little later doesn't matter.
    now += 10 * MIN;
    fromRadio();
    now += 5_000;
    fromRelay(relays);
    expect(composite.radioExpects([pill])).toBe(true);
    // The radio stops hearing it while the relay carries on.
    now += 10 * MIN;
    fromRelay(relays);
    expect(composite.radioExpects([pill])).toBe(false);

    // A pill only the radio hears, switched off: expected for a day, then not. BlueZ's memory of it doesn't count.
    const off = { address: '08:B6:1F:00:00:67', lastHeardAt: null };
    fromRadio(off.address);
    now += 23 * HOUR;
    fromRadio(off.address, true);
    expect(composite.radioExpects([off])).toBe(true);
    now += 2 * HOUR;
    expect(composite.radioExpects([off])).toBe(false);
  });

  it('leaves Bluetooth alone for a pill only a relay hears', async () => {
    const helper = resetHelper();
    const fake = new FakeBluez();
    fake.addAdapter('hci0');
    const pill = { address, lastHeardAt: START };
    // Wired as main.ts does: the composite is made around the scanner, and asked once the watchdog runs.
    const { scanner, advance, clock } = await start(fake, { ...helper.opts, expectPills: () => composite.radioExpects([pill]) });
    const relays = new RelayHub(silent, clock);
    const composite = new CompositeScanner(scanner, relays, clock);
    // The hub heard the pill itself once, before it went into the shed.
    fake.deviceAdded(PILL_PATH, CAPTURED.metricsFalling);
    await settle();

    for (let i = 0; i < 6 * 12; i++) {
      advance(10 * MIN);
      fromRelay(relays);
      await scanner.check();
    }
    expect(helper.take()).toBeNull();
    expect(scanner.status.mode).toBe('passive');
    expect(fake.callsTo('StartDiscovery')).toHaveLength(0);
  });

  it('stops resetting Bluetooth for a pill nobody has heard for a day (switched off between brews)', async () => {
    const helper = resetHelper();
    const fake = new FakeBluez();
    fake.addAdapter('hci0');
    const pill = { address, lastHeardAt: START };
    const { scanner, advance, clock } = await start(fake, {
      ...helper.opts,
      scanMode: 'passive',
      expectPills: () => composite.radioExpects([pill]),
    });
    const composite = new CompositeScanner(scanner, new RelayHub(silent, clock), clock);
    fake.deviceAdded(PILL_PATH, CAPTURED.metricsFalling);
    await settle();

    const asked: number[] = [];
    for (let i = 0; i < 6 * 48; i++) {
      advance(10 * MIN);
      await scanner.check();
      const request = helper.take();
      if (request) asked.push((request.requestedAt - START) / MIN);
    }
    // Backing off as usual for the first day, then not at all.
    expect(asked).toEqual([40, 100, 280, 640, 1000, 1360]);
  });

  it('remembers through a reset that an active check heard nothing', async () => {
    const fake = new FakeBluez();
    fake.addAdapter('hci0');
    const { scanner, advance } = await start(fake, { expectPills: () => true });
    advance(2 * HOUR + MIN);
    await scanner.check();
    expect(scanner.status.mode).toBe('active');
    advance(2 * HOUR + MIN);
    await scanner.check();
    expect(scanner.status.mode).toBe('passive');

    await rfkill(fake);
    expect(scanner.status).toMatchObject({ state: 'scanning', mode: 'passive' });
    advance(3 * HOUR);
    await scanner.check();
    expect(scanner.status.mode).toBe('passive');
    expect(fake.callsTo('StartDiscovery')).toHaveLength(1);
  });

  it('keeps backing off through the resets themselves', async () => {
    const helper = resetHelper();
    const fake = new FakeBluez();
    fake.addAdapter('hci0');
    const { scanner, advance } = await start(fake, { ...helper.opts, scanMode: 'passive', expectPills: () => true });
    const asked: number[] = [];
    for (let i = 0; i < 70; i++) {
      advance(10 * MIN);
      await scanner.check();
      const request = helper.take();
      if (!request) continue;
      asked.push((request.requestedAt - START) / MIN);
      await rfkill(fake);
      expect(scanner.status.state).toBe('scanning');
    }
    expect(asked).toEqual([20, 80, 260, 620]);
  });
});
