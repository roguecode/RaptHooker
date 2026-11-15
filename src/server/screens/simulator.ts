import { createHash, randomInt } from 'node:crypto';
import { EventEmitter } from 'node:events';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  hotspotKind,
  screenHotspot,
  screenModel,
  type StockKind,
  type UsbBoardId,
  type UsbPort,
  type UsbStatus,
  type WifiNetwork,
  type WifiStatus,
} from '@rapthooker/shared';
import { request, screenProof } from './client.js';
import { ESP32_APP_AT, ESP32_SETTINGS_AT, imageMarker } from './firmware.js';
import { readSettingsSector } from './usb/sector.js';
import { UsbError, type FlashRegion, type UsbBoard, type UsbFlasher } from './usb/types.js';
import { tidyNetworks, type HotspotLink, type WifiController } from './wifi/types.js';

/**
 * A pretend screen and a pretend Wi-Fi, for tests, the end-to-end tests and the development server: a "Smart weather
 * clock" (or a GeekMagic Ultra) that starts on its stock firmware and becomes a RaptHooker screen when it's sent the
 * firmware, then fetches its picture from the hub like a real one. Its web server answers like both firmwares do.
 * MockUsb is a pretend ESP32 board plugged into the hub, which becomes a FakeScreen when it's written to.
 */

interface FakeSettings {
  ssid: string;
  pass: string;
  token: string;
  hub: string;
  name: string;
  imageUrl: string;
  interval: number;
  brightness: number;
  panel: number;
}

const EMPTY: FakeSettings = { ssid: '', pass: '', token: '', hub: '', name: '', imageUrl: '', interval: 60, brightness: 80, panel: 0 };

export interface FakeScreenOptions {
  mac?: string;
  /** Its ScreenModel (default the "Smart weather clock"). */
  model?: string;
  /** Starts on the stock firmware (default) or already on RaptHooker's. */
  stock?: boolean;
  /**
   * Which stock firmware: the "Smart weather clock"'s SD Pro (default), or a genuine GeekMagic's own ("GIFTV", /v.json
   * and the Arduino core's /update).
   */
  stockKind?: StockKind;
  /** What a GeekMagic says it is at /v.json (default the Ultra; a "SmallTV-Pro" is an ESP32). */
  geekmagicModel?: string;
  /** A GeekMagic that has joined a network with its own firmware, so has no hotspot open (it's reached by address). */
  stockOnNetwork?: boolean;
  firmware?: string;
  /** Wi-Fi networks it can join, with their passwords. */
  networks?: Record<string, string>;
  /** Milliseconds a restart takes. */
  restartMs?: number;
  /** Fetch the picture (once set up); off in unit tests that drive fetches themselves. */
  fetchPictures?: boolean;
  /**
   * What the stock firmware's update page does with RaptHooker's firmware: takes it and says OK; takes it and
   * restarts without answering (as real screens sometimes do); refuses it (FAIL); or refuses it without answering.
   */
  stockOta?: 'ok' | 'no-reply' | 'refuse' | 'refuse-quietly';
  /** Firmware from before "proof": it can't prove it has its key. */
  legacy?: boolean;
  /**
   * An ESP32 board whose firmware went on without RaptHooker's flash layout (as an update over ESPHome): nowhere to
   * keep its settings, so it joins a network at set-up but never saves it.
   */
  noStore?: boolean;
}

/** What a GeekMagic Ultra's own firmware sends back from its update page (POST /update). */
const GEEKMAGIC_UPDATED = '<META http-equiv="refresh" content="15;URL=/">Update Success! Rebooting...';
/** The space a GeekMagic Ultra on V9.0.50 has for an update: (free sketch space - 4 KB), as the Arduino updater works it out. */
const GEEKMAGIC_SPACE = 0x83000;

export class FakeScreen extends EventEmitter {
  readonly mac: string;
  readonly id: string;
  readonly model: string;
  stock: boolean;
  readonly stockKind: StockKind;
  firmware: string;
  settings: FakeSettings = { ...EMPTY };
  /** Restarting: the hotspot and web server don't answer. */
  down = false;
  /** Set up, but can't join its network (a wrong password, written over USB). */
  lost = false;
  trial: { state: 'idle' | 'testing' | 'connected' | 'failed'; error: string; ip?: string; saved: boolean } = {
    state: 'idle',
    error: '',
    saved: false,
  };
  /** Things that happened, for tests to check. */
  readonly events: string[] = [];
  /** Every Authorization header it was sent, for tests to check where keys went. */
  readonly keysSeen: string[] = [];
  pairingCode: string | null = null;
  /** MD5 of the firmware it was last sent, which it reports as its sketch's. */
  sketchMd5 = 'stock';
  private server: http.Server | null = null;
  private timer: NodeJS.Timeout | null = null;
  port = 0;
  private readonly opts: Required<
    Omit<
      FakeScreenOptions,
      'mac' | 'model' | 'stock' | 'stockKind' | 'firmware' | 'legacy' | 'geekmagicModel' | 'stockOnNetwork' | 'noStore'
    >
  >;
  legacy: boolean;
  /** Nowhere to keep its settings. */
  noStore: boolean;
  /** What a GeekMagic says it is at /v.json. */
  geekmagicModel: string;
  /** A GeekMagic on its own firmware that's on a network: no hotspot. */
  stockOnNetwork: boolean;

  constructor(opts: FakeScreenOptions = {}) {
    super();
    // Locally administered (02:?), so it can't be taken for a real screen on the network.
    this.mac = (opts.mac ?? '02:52:48:00:00:01').toUpperCase();
    this.id = this.mac.replace(/:/g, '').toLowerCase();
    this.model = opts.model ?? 'sdpro-240';
    this.stock = opts.stock ?? true;
    this.stockKind = opts.stockKind ?? 'sdpro';
    this.geekmagicModel = opts.geekmagicModel ?? 'SmallTV-Ultra';
    this.stockOnNetwork = opts.stockOnNetwork ?? false;
    this.firmware = opts.firmware ?? '1.0.0';
    this.legacy = opts.legacy ?? false;
    this.noStore = opts.noStore ?? false;
    this.opts = {
      networks: opts.networks ?? {},
      restartMs: opts.restartMs ?? 300,
      fetchPictures: opts.fetchPictures ?? true,
      stockOta: opts.stockOta ?? 'ok',
    };
  }

  get address(): string {
    return `127.0.0.1:${this.port}`;
  }

  /** The hotspot it has open now, or null (on its network, or restarting). */
  get hotspot(): string | null {
    if (this.down) return null;
    if (this.stock) return this.stockKind === 'geekmagic' ? (this.stockOnNetwork ? null : 'GIFTV') : 'Smart weather clock';
    return this.settings.ssid && this.trial.state !== 'connected' ? null : screenHotspot(this.mac);
  }

  /**
   * A GeekMagic's hotspot address: an ESP8266's access point has its own MAC address, which differs from the station's
   * only in the first byte. (Other fake screens get a made-up one from MockWifi.)
   */
  get bssid(): string | undefined {
    return this.stockKind === 'geekmagic' ? `06${this.mac.slice(2)}`.toLowerCase() : undefined;
  }

  /** On the LAN (set up and online). */
  get online(): boolean {
    return !this.down && !this.stock && !!this.settings.ssid && !this.lost;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
    this.schedule();
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = null;
  }

  get restartMs(): number {
    return this.opts.restartMs;
  }

  /** Starts again, as after being written to over USB. */
  powerCycle(): void {
    this.restart();
  }

  private restart(then: () => void = () => undefined): void {
    this.down = true;
    setTimeout(() => {
      then();
      if (this.noStore) this.settings = { ...EMPTY };
      this.down = false;
      this.trial = { state: 'idle', error: '', saved: false };
      this.events.push('restarted');
      this.emit('restarted');
      this.schedule(1);
    }, this.opts.restartMs);
  }

  /** Fetches its picture like the firmware does, with the same headers. */
  async fetchPicture(): Promise<number> {
    const url = new URL(this.settings.imageUrl);
    const res = await request(url.host, url.pathname + url.search, {
      headers: {
        'X-Screen-Id': this.id,
        'X-Screen-Firmware': `${this.model}/${this.firmware}`,
        'X-Screen-Status': `rssi=-58;up=${Math.round(process.uptime())};heap=36000;fail=0`,
      },
    });
    this.events.push(`picture ${res.status}`);
    return res.status;
  }

  private schedule(seconds?: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.opts.fetchPictures || !this.online || !this.settings.imageUrl) return;
    this.timer = setTimeout(
      () => {
        void this.fetchPicture()
          .catch(() => undefined)
          .finally(() => this.schedule());
      },
      (seconds ?? this.settings.interval) * 1000,
    );
    this.timer.unref();
  }

  private send(res: ServerResponse, status: number, body: unknown, type = 'application/json', cors = true): void {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': type,
      'Content-Length': Buffer.byteLength(text),
      ...(cors ? { 'Access-Control-Allow-Origin': '*' } : {}),
    });
    res.end(text);
  }

  private async body(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  }

  private authorized(req: IncomingMessage): boolean {
    return !this.settings.token || req.headers.authorization === `Bearer ${this.settings.token}`;
  }

  /** The file part of a multipart body. */
  private filePart(body: Buffer, type: string | undefined): Buffer | null {
    const boundary = /boundary=(.+)$/.exec(type ?? '')?.[1];
    if (!boundary) return null;
    const start = body.indexOf('\r\n\r\n');
    const end = body.lastIndexOf(`\r\n--${boundary}`);
    return start < 0 || end < start ? null : body.subarray(start + 4, end);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.down) {
      req.socket.destroy();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://screen');
    const path = url.pathname;
    const body = await this.body(req);
    if (req.headers.authorization) this.keysSeen.push(req.headers.authorization);
    if (this.stock) return this.handleStock(path, req, res, body);
    const json = (): Record<string, unknown> => {
      try {
        return JSON.parse(body.toString('utf8')) as Record<string, unknown>;
      } catch {
        return {};
      }
    };
    if (path === '/api/info') {
      const challenge = url.searchParams.get('challenge');
      return this.send(res, 200, {
        firmware: 'rapthooker-screen',
        version: this.firmware,
        api: 1,
        model: this.model,
        id: this.id,
        mac: this.mac,
        hostname: `rh-screen-${this.id.slice(-6)}`,
        name: this.settings.name,
        hub: this.settings.hub,
        claimed: !!this.settings.token,
        state: this.settings.ssid ? 'online' : 'setup',
        safeMode: false,
        updating: false,
        features: [
          'ota',
          'setup',
          'settings',
          'adopt',
          ...(this.legacy ? [] : ['proof']),
          ...(screenModel(this.model)?.panel ? ['panel', 'test-pattern'] : []),
        ],
        proof: challenge && this.settings.token && !this.legacy ? screenProof(this.settings.token, this.id, challenge) : undefined,
        wifi: {
          ssid: this.settings.ssid,
          ip: this.online ? '127.0.0.1' : undefined,
          rssi: -58,
          channel: 1,
          hotspot: screenHotspot(this.mac),
          hotspotOn: !this.settings.ssid,
          reason: '',
        },
        image: {
          url: this.settings.imageUrl,
          interval: this.settings.interval,
          shown: true,
          ageMs: 1000,
          failures: 0,
          error: '',
          bytes: 15000,
        },
        setup: { trial: this.trial.state, error: this.trial.error, ip: this.trial.ip, saved: this.trial.saved },
        display: {
          width: screenModel(this.model)?.width ?? 240,
          height: screenModel(this.model)?.height ?? 240,
          brightness: this.settings.brightness,
          ...(screenModel(this.model)?.panel ? { controller: '8181b3', profile: '8181b3', panel: this.settings.panel } : {}),
        },
        system: {
          uptime: 10,
          heap: 36000,
          sketchSize: 419840,
          freeSketch: 600000,
          sketchMd5: this.sketchMd5,
          resetReason: 'Software/System restart',
          store: !this.noStore,
        },
      });
    }
    if (path === '/api/setup' && req.method === 'GET') {
      return this.send(res, 200, {
        trial: this.trial.state,
        error: this.trial.error,
        ip: this.trial.ip,
        saved: this.trial.saved,
        channel: 1,
      });
    }
    if (path === '/api/adopt' && req.method === 'POST') {
      const b = json();
      if (!b.code) {
        this.pairingCode = String(randomInt(0, 1_000_000)).padStart(6, '0');
        this.events.push('pairing code');
        return this.send(res, 202, { ok: true, expiresIn: 120 });
      }
      if (b.code !== this.pairingCode) return this.send(res, 403, { ok: false, error: 'wrong code' });
      this.pairingCode = null;
      this.settings = {
        ...this.settings,
        token: String(b.token),
        hub: String(b.hub ?? this.settings.hub),
        name: String(b.name ?? this.settings.name),
      };
      if (typeof b.imageUrl === 'string') this.settings.imageUrl = b.imageUrl;
      // As the firmware does: the new key is taken, then it can't be kept.
      if (this.noStore) return this.send(res, 500, { ok: false, error: "couldn't save" });
      this.events.push('adopted');
      this.schedule(1);
      return this.send(res, 200, { ok: true });
    }
    if (!this.authorized(req)) return this.send(res, 401, { ok: false, error: 'not allowed' });
    if (path === '/api/setup' && req.method === 'POST') {
      const b = json();
      const ssid = String(b.ssid ?? '');
      this.trial = { state: 'testing', error: '', saved: false };
      this.events.push(`setup ${ssid} on channel ${Number(b.channel ?? 0)}`);
      setTimeout(() => {
        if (!(ssid in this.opts.networks)) this.trial = { state: 'failed', error: 'network not found', saved: false };
        else if (this.opts.networks[ssid] !== b.password) this.trial = { state: 'failed', error: 'wrong password', saved: false };
        else {
          this.settings = {
            ssid,
            pass: String(b.password),
            token: String(b.token),
            hub: String(b.hub ?? ''),
            name: String(b.name ?? ''),
            imageUrl: String(b.imageUrl ?? ''),
            interval: Number(b.interval ?? 60),
            brightness: Number(b.brightness ?? 80),
            panel: 0,
          };
          this.trial = { state: 'connected', error: '', ip: this.address, saved: !this.noStore };
        }
      }, 50);
      return this.send(res, 202, { ok: true, trial: 'testing', channel: Number(b.channel ?? 0) });
    }
    if (path === '/api/setup/finish') {
      if (!this.trial.saved) return this.send(res, 409, { ok: false, error: 'not joined a network yet' });
      this.events.push('finish');
      this.send(res, 200, { ok: true });
      return this.restart();
    }
    if (path === '/api/settings') {
      if (req.method === 'POST') {
        const b = json();
        const network = typeof b.ssid === 'string' && (b.ssid !== this.settings.ssid || b.password !== this.settings.pass);
        for (const k of ['name', 'hub', 'imageUrl', 'token'] as const) if (typeof b[k] === 'string') this.settings[k] = b[k];
        for (const k of ['interval', 'brightness', 'panel'] as const) if (typeof b[k] === 'number') this.settings[k] = b[k];
        if (typeof b.ssid === 'string') {
          this.settings.ssid = b.ssid;
          this.settings.pass = String(b.password ?? '');
        }
        this.events.push(`settings ${Object.keys(b).sort().join(',')}`);
        this.send(res, 200, { ok: true, ...this.settings, pass: undefined, token: undefined, reboot: network });
        if (network) this.restart();
        else this.schedule(1);
        return;
      }
      return this.send(res, 200, { ok: true, ...this.settings, pass: undefined, token: undefined });
    }
    if (path === '/api/ota') {
      const data = this.filePart(body, req.headers['content-type']);
      const md5 = createHash('md5')
        .update(data ?? Buffer.alloc(0))
        .digest('hex');
      if (!data || md5 !== url.searchParams.get('md5') || data.length !== Number(url.searchParams.get('size'))) {
        return this.send(res, 400, { ok: false, error: 'MD5 verification failed' });
      }
      const marker = imageMarker(data);
      if (!marker && url.searchParams.get('force') !== '1')
        return this.send(res, 400, { ok: false, error: 'not RaptHooker firmware for this screen' });
      this.events.push(`ota ${marker?.version ?? 'stock'}`);
      this.sketchMd5 = md5;
      this.send(res, 200, { ok: true });
      return this.restart(() => {
        if (marker) this.firmware = marker.version;
        else {
          // Like the firmware: other firmware going on wipes RaptHooker's settings.
          this.stock = true;
          this.settings = { ...EMPTY };
        }
      });
    }
    if (path === '/api/reset') {
      this.events.push('reset');
      this.send(res, 200, { ok: true });
      return this.restart(() => (this.settings = { ...EMPTY }));
    }
    if (path === '/api/test-pattern' && screenModel(this.model)?.panel) {
      this.events.push('test-pattern');
      return this.send(res, 200, { ok: true });
    }
    if (['/api/identify', '/api/refresh', '/api/reboot'].includes(path)) {
      this.events.push(path.slice(5));
      this.send(res, 200, { ok: true });
      if (path === '/api/reboot') this.restart();
      if (path === '/api/refresh') this.schedule(0);
      return;
    }
    if (path === '/api/log') return this.send(res, 200, `[0:00:01] fake screen ${this.id}\n`, 'text/plain');
    return this.send(res, 404, { ok: false, error: 'not found' });
  }

  private handleStock(path: string, req: IncomingMessage, res: ServerResponse, body: Buffer): void {
    if (this.stockKind === 'geekmagic') return this.handleGeekmagic(path, req, res, body);
    if (path === '/mac') return this.send(res, 200, this.mac, 'text/plain');
    if (path === '/config') {
      return this.send(res, 200, { gifnum: 4, theme: 0, brightness: 52, ssid: 'K500', weatherkey: 'x', freespace: 1253376 });
    }
    if (path === '/update_ota' && req.method === 'POST') {
      const data = this.filePart(body, req.headers['content-type']);
      const marker = data ? imageMarker(data) : null;
      const how = this.opts.stockOta;
      if (!data || !marker || data.length > 0x80000 || how === 'refuse' || how === 'refuse-quietly') {
        if (how === 'refuse-quietly') res.socket?.destroy();
        else this.send(res, 500, 'FAIL', 'text/plain');
        return this.restart();
      }
      this.events.push(`stock ota ${marker.version}`);
      this.sketchMd5 = createHash('md5').update(data).digest('hex');
      // RaptHooker's settings, if it was on this screen before, are still in their flash sector.
      if (how === 'no-reply') res.socket?.destroy();
      else this.send(res, 200, 'OK', 'text/plain');
      return this.restart(() => {
        this.stock = false;
        this.firmware = marker.version;
      });
    }
    return this.send(
      res,
      200,
      '<!DOCTYPE html><html><head><title>Smart Weather Clock - WiFi Setup</title></head><body></body></html>',
      'text/html',
    );
  }

  /**
   * A genuine GeekMagic Ultra on its own firmware (V9.0.50, going by its image): /v.json says what it is, without CORS
   * headers; /update is the Arduino core's updater, which GeekMagic's answers with them. It takes any whole ESP8266
   * image that fits, and says "Update error: …" (still 200) for one that doesn't.
   */
  private handleGeekmagic(path: string, req: IncomingMessage, res: ServerResponse, body: Buffer): void {
    if (path === '/v.json') return this.send(res, 200, `{"m": "${this.geekmagicModel}","v":"Ultra-V9.0.50"}`, 'text/json', false);
    if (path === '/update' && req.method === 'POST') {
      const data = this.filePart(body, req.headers['content-type']);
      const how = this.opts.stockOta;
      const error =
        !data || data[0] !== 0xe9
          ? 'ERROR[6]: Magic byte is not 0xE9'
          : data.length > GEEKMAGIC_SPACE
            ? 'ERROR[4]: Not Enough Space'
            : how === 'refuse' || how === 'refuse-quietly'
              ? 'ERROR[2]: Flash Write Failed'
              : null;
      if (error) {
        if (how === 'refuse-quietly') res.socket?.destroy();
        else this.send(res, 200, `Update error: ${error}`, 'text/html');
        return;
      }
      const marker = imageMarker(data!);
      this.events.push(`geekmagic ota ${marker?.version ?? 'other'}`);
      this.sketchMd5 = createHash('md5').update(data!).digest('hex');
      if (how === 'no-reply') res.socket?.destroy();
      else this.send(res, 200, GEEKMAGIC_UPDATED, 'text/html');
      return this.restart(() => {
        if (!marker) return;
        this.stock = false;
        this.firmware = marker.version;
      });
    }
    if (path === '/update') return this.send(res, 200, '<form method="POST" action="" enctype="multipart/form-data">', 'text/html', false);
    return this.send(res, 200, '<!DOCTYPE html><html><head><title>GeekMagic</title></head><body></body></html>', 'text/html', false);
  }
}

/** Anything with a hotspot the pretend Wi-Fi can see and join: a FakeScreen, or a FakeIspindel in setup mode. */
export interface HotspotDevice {
  readonly id: string;
  /** The hotspot it has open now, or null. */
  readonly hotspot: string | null;
  /** Where its web server answers. */
  readonly address: string;
  /** Its hotspot's address (made up from its id if not given). */
  readonly bssid?: string;
}

/**
 * A pretend Wi-Fi for FakeScreens (and FakeIspindels): their hotspots show up in scans, joining one returns the
 * device's address, and the hub's own network is always there to go back to.
 */
export class MockWifi implements WifiController {
  readonly name = 'mock';
  /** The network the hub is on now. */
  current: string | null;
  readonly joins: string[] = [];
  private previous: string | null | undefined;

  constructor(
    private readonly screens: () => HotspotDevice[],
    readonly home: { ssid: string; password: string; channel: number } = { ssid: 'Brewery', password: 'hops-and-barley', channel: 6 },
    /** on5GHz: the home network has a 5 GHz band too, with the same name, and the hub is on it (on that channel). */
    private readonly opts: { goesOffline?: boolean; knowsPassword?: boolean; on5GHz?: number } = {},
  ) {
    this.current = home.ssid;
  }

  async status(): Promise<WifiStatus> {
    const home = this.current === this.home.ssid;
    const five = home ? this.opts.on5GHz : undefined;
    return {
      canSetUp: true,
      reason: null,
      ssid: this.current,
      channel: home ? (five ?? this.home.channel) : 1,
      band: five ? 5 : 2.4,
      goesOffline: this.opts.goesOffline ?? true,
      knowsPassword: home && (this.opts.knowsPassword ?? true),
    };
  }

  async scan(): Promise<WifiNetwork[]> {
    const home = this.current === this.home.ssid;
    const five = this.opts.on5GHz;
    const nets: WifiNetwork[] = [
      {
        ssid: this.home.ssid,
        bssid: '02:00:00:00:00:01',
        signal: 82,
        channel: this.home.channel,
        band: 2.4,
        secure: true,
        kind: null,
        current: home && !five,
      },
      { ssid: 'Neighbours', bssid: '02:00:00:00:00:02', signal: 35, channel: 11, band: 2.4, secure: true, kind: null, current: false },
    ];
    if (five) {
      nets.push({
        ssid: this.home.ssid,
        bssid: '02:00:00:00:00:03',
        signal: 90,
        channel: five,
        band: 5,
        secure: true,
        kind: null,
        current: home,
      });
    }
    for (const s of this.screens()) {
      const h = s.hotspot;
      if (h)
        nets.push({
          ssid: h,
          bssid: s.bssid ?? `02:00:00:00:01:${s.id.slice(-2)}`,
          signal: 70,
          channel: 1,
          band: 2.4,
          secure: false,
          kind: null,
          current: this.current === h,
        });
    }
    return tidyNetworks(nets.map((n) => ({ ...n, kind: n.secure ? null : hotspotKind(n.ssid) })));
  }

  async join(ssid: string, timeoutMs: number): Promise<HotspotLink> {
    if (this.previous === undefined) this.previous = this.current;
    this.joins.push(ssid);
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const screen = this.screens().find((s) => s.hotspot === ssid);
      if (screen) {
        this.current = ssid;
        return { address: '127.0.0.1', screen: screen.address };
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    this.current = null;
    throw new Error(`Timed out joining ${ssid}`);
  }

  async restore(): Promise<boolean> {
    if (this.previous !== undefined) this.current = this.previous;
    this.previous = undefined;
    return true;
  }

  async password(ssid: string): Promise<string | null> {
    return ssid === this.home.ssid && (this.opts.knowsPassword ?? true) ? this.home.password : null;
  }

  async recover(): Promise<void> {
    if (this.current !== this.home.ssid) this.current = this.home.ssid;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A pretend ESP32 board plugged into the hub (for tests, the end-to-end tests and the development server). Writing
 * RaptHooker's firmware and settings to it turns it into a FakeScreen with those settings, on the pretend network if
 * the Wi-Fi details are right; watching it start prints what the firmware would.
 */
export class MockUsb implements UsbFlasher {
  static readonly PORT = '/dev/ttyUSB0';
  readonly name = 'mock';
  plugged = true;
  /** What each write wrote, for tests to check. */
  readonly writes: string[] = [];
  screen: FakeScreen | null = null;
  private written: { model: string; version: string; settings: Record<string, unknown> | null } | null = null;

  constructor(
    private readonly add: (screen: FakeScreen) => Promise<void>,
    private readonly opts: {
      networks?: Record<string, string>;
      mac?: string;
      chip?: string;
      esptool?: boolean;
      fetchPictures?: boolean;
      /** The firmware never says it's online (as if the hub couldn't read the board): set-up goes by mDNS. */
      quiet?: boolean;
    } = {},
  ) {}

  private get mac(): string {
    return (this.opts.mac ?? '02:52:48:00:00:32').toLowerCase();
  }

  async status(): Promise<UsbStatus> {
    const ok = this.opts.esptool ?? true;
    return { canSetUp: ok, reason: ok ? null : 'no-esptool', esptool: ok ? '5.0.0' : null, ports: await this.ports() };
  }

  async ports(): Promise<UsbPort[]> {
    return this.plugged
      ? [{ path: MockUsb.PORT, name: 'QinHeng Electronics USB Serial (pretend)', vid: '1a86', pid: '7523', likely: true }]
      : [];
  }

  private check(port: string): void {
    if (!this.plugged || port !== MockUsb.PORT) throw new UsbError('no-board', 'Failed to connect to ESP32: No serial data received.');
  }

  async identify(port: string): Promise<UsbBoard> {
    this.check(port);
    const chip = this.opts.chip ?? 'esp32';
    return { chip, description: chip === 'esp32' ? 'ESP32-D0WD-V3 (revision v3.1)' : chip.toUpperCase(), mac: this.mac, flashMb: 4 };
  }

  async write(port: string, regions: FlashRegion[], onProgress: (percent: number) => void): Promise<void> {
    this.check(port);
    for (const p of [0, 30, 60, 100]) {
      onProgress(p);
      await sleep(5);
    }
    const app = regions.find((r) => r.at === ESP32_APP_AT);
    const sector = regions.find((r) => r.at === ESP32_SETTINGS_AT);
    const marker = app ? imageMarker(app.data) : null;
    this.writes.push(regions.map((r) => r.name).join(', '));
    this.written = marker ? { ...marker, settings: sector ? readSettingsSector(sector.data) : null } : null;
  }

  async whois(ports: string[]): Promise<Map<string, UsbBoardId>> {
    const s = this.screen;
    if (!this.plugged || !s || !ports.includes(MockUsb.PORT)) return new Map();
    const board = {
      id: s.id,
      model: s.model,
      firmware: s.firmware,
      name: s.settings.name,
      hub: s.settings.hub,
      claimed: !!s.settings.token,
    };
    return new Map([[MockUsb.PORT, board]]);
  }

  async watch(port: string, _ms: number, onLine: (line: string) => boolean): Promise<boolean> {
    this.check(port);
    const w = this.written;
    if (!w) return true;
    const lines = [
      `[0:00:00] RHSCREEN-FW:${w.model}:${w.version}`,
      w.settings ? '[0:00:00] store: loaded 240 bytes' : '[0:00:00] store: empty',
    ];
    if (!this.screen) {
      this.screen = new FakeScreen({
        mac: this.mac,
        model: w.model,
        stock: false,
        firmware: w.version,
        fetchPictures: this.opts.fetchPictures,
      });
      await this.add(this.screen);
    }
    const screen = this.screen;
    const str = (k: string, d = '') => (typeof w.settings?.[k] === 'string' ? (w.settings[k] as string) : d);
    const num = (k: string, d: number) => (typeof w.settings?.[k] === 'number' ? (w.settings[k] as number) : d);
    screen.firmware = w.version;
    screen.settings = {
      ssid: str('ssid'),
      pass: str('pass'),
      token: str('token'),
      hub: str('hub'),
      name: str('name'),
      imageUrl: str('imageUrl'),
      interval: num('interval', 60),
      brightness: num('brightness', 80),
      panel: num('panel', 0),
    };
    const networks = this.opts.networks ?? {};
    const ssid = screen.settings.ssid;
    const joins = ssid in networks && networks[ssid] === screen.settings.pass;
    screen.lost = !joins;
    screen.powerCycle();
    if (w.settings) lines.push(`[0:00:00] net: joining ${ssid}`);
    if (joins) {
      if (!this.opts.quiet) {
        lines.push(
          `[0:00:01] net: joined ${ssid} on channel 6, waiting for an address`,
          `[0:00:01] net: online ${screen.address}, -52 dBm, channel 6, 802.11n`,
        );
      }
    } else if (ssid in networks) {
      lines.push('[0:00:02] net: station disconnected, reason 15 (wrong password)', `[0:00:15] net: still joining ${ssid}: wrong password`);
    } else if (ssid) {
      lines.push(
        '[0:00:03] net: station disconnected, reason 201 (network not found)',
        `[0:00:15] net: still joining ${ssid}: network not found`,
      );
    }
    for (const line of lines) if (onLine(line)) break;
    // A board that doesn't say it's online still gets there, a moment later.
    if (joins && this.opts.quiet) await sleep(screen.restartMs + 50);
    return !this.opts.quiet;
  }
}
