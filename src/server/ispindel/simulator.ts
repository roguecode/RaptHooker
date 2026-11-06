import { EventEmitter } from 'node:events';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { HotspotDevice } from '../screens/simulator.js';

/**
 * A pretend iSpindel, for tests, the end-to-end tests and the development server. In setup mode it has an open
 * "iSpindel" hotspot and serves its setup portal like firmware 6.5.1 does (a WiFiManager form, saved with a GET to
 * /wifisave). Once saved with the HTTP service, and a Wi-Fi network it knows the password of, it leaves setup mode and
 * posts readings to the server it was given, every interval (or `postEveryMs`), as a fermentation slowly goes on.
 */

/** The service list as the firmware's script has it: the order gives each one's number. */
const SERVICES = [
  'Ubidots',
  'empty',
  'CraftBeerPi',
  'HTTP',
  'TControl',
  'FHEM',
  'TCP',
  'iSpindel.de',
  'InfluxDB',
  'Prometheus',
  'MQTT',
  'ThingSpeak',
  'Blynk',
  'Brewblox',
];

/** The fields in its form, in order, with labels (WiFiManager parameters). `s` and `p` come first, without these. */
const FIELDS: [name: string, label: string, extra: string][] = [
  ['name', 'iSpindel Name', ''],
  ['sleep', 'Update Interval (s)', 'type="number" step="any"'],
  ['vfact', 'Battery conversion factor', 'type="number" step="any"'],
  ['tempscale', '', 'type="hidden"'],
  ['selAPI', '', 'type="hidden"'],
  ['token', 'Token', ''],
  ['server', 'Server Address', ''],
  ['port', 'Server Port', 'type="number" step="any"'],
  ['channel', 'Channelnumber', 'type="number" step="any"'],
  ['uri', 'Path / URI', ''],
  ['db', 'InfluxDB db', ''],
  ['username', 'Username', ''],
  ['password', 'Password', ''],
  ['job', 'Prometheus job', ''],
  ['instance', 'Prometheus instance', ''],
  ['POLYN', '', ''],
];

const POLYNOMIAL = '0.959105+0.00160272*tilt+0.0000017256799*tilt^2';
const gravityAt = (tilt: number) => 0.959105 + 0.00160272 * tilt + 0.0000017256799 * tilt * tilt;

const html = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface FakeIspindelOptions {
  /** Its chip id (the last three bytes of its MAC address). */
  chipId?: number;
  name?: string;
  /** Wi-Fi networks it can join, with their passwords. */
  networks?: Record<string, string>;
  /** Posts this often once set up, instead of its interval (the development server's is a minute). */
  postEveryMs?: number;
  /** Starts in setup mode (default) or already posting with these settings. */
  setupMode?: boolean;
  /** Milliseconds a restart takes. */
  restartMs?: number;
  /** Sends a post (default: an HTTP POST, like the firmware's). */
  send?: (url: string, body: Record<string, unknown>) => Promise<number>;
}

export class FakeIspindel extends EventEmitter implements HotspotDevice {
  readonly chipId: number;
  readonly id: string;
  settings: Record<string, string>;
  setupMode: boolean;
  /** Restarting: no hotspot. */
  down = false;
  /** Things that happened, for tests to check. */
  readonly events: string[] = [];
  /** What it posted, newest last. */
  readonly posts: { url: string; body: Record<string, unknown>; status: number | null }[] = [];
  tilt = 55;
  temperature = 19.5;
  volts = 4.12;
  port = 0;
  private server: http.Server | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly opts: Required<Omit<FakeIspindelOptions, 'chipId' | 'name' | 'postEveryMs' | 'setupMode' | 'send'>> &
    Pick<FakeIspindelOptions, 'postEveryMs' | 'send'>;

  constructor(opts: FakeIspindelOptions = {}) {
    super();
    this.chipId = opts.chipId ?? 0x52480a;
    this.id = this.chipId.toString(16).padStart(6, '0');
    this.setupMode = opts.setupMode ?? true;
    this.opts = { networks: opts.networks ?? {}, restartMs: opts.restartMs ?? 300, postEveryMs: opts.postEveryMs, send: opts.send };
    this.settings = {
      s: '',
      p: '',
      name: opts.name ?? 'iSpindel000',
      sleep: '900',
      vfact: '191.80',
      tempscale: '0',
      selAPI: '0',
      token: '',
      server: '',
      port: '80',
      channel: '0',
      uri: '',
      db: 'ispindel',
      username: '',
      password: '',
      job: 'ispindel',
      instance: '000',
      POLYN: POLYNOMIAL,
    };
  }

  get address(): string {
    return `127.0.0.1:${this.port}`;
  }

  /** Its hotspot's address: its MAC address with the locally administered bit set, as an ESP8266's is. */
  get bssid(): string {
    const hex = this.id.toUpperCase();
    return `42:91:51:${hex.slice(0, 2)}:${hex.slice(2, 4)}:${hex.slice(4, 6)}`;
  }

  get hotspot(): string | null {
    return this.setupMode && !this.down ? 'iSpindel' : null;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.port = (this.server.address() as AddressInfo).port;
    if (!this.setupMode) this.schedule(0);
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = null;
  }

  /** Back into setup mode, as a double press of its reset button does. */
  enterSetupMode(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.setupMode = true;
    this.events.push('setup mode');
  }

  /** On the network: set up with the HTTP service and a network it can join. */
  get online(): boolean {
    const s = this.settings.s ?? '';
    const p = this.settings.p ?? '';
    return !this.setupMode && !this.down && s in this.opts.networks && this.opts.networks[s] === p;
  }

  private schedule(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.post(), ms);
    this.timer.unref?.();
  }

  /** Wakes up, sends a reading (if it can) and goes back to sleep. */
  async post(): Promise<void> {
    this.timer = null;
    if (this.setupMode) return;
    const interval = Number(this.settings.sleep) || 900;
    this.schedule(this.opts.postEveryMs ?? interval * 1000);
    if (!this.online || this.settings.selAPI !== String(SERVICES.indexOf('HTTP')) || !this.settings.server) return;
    // A fermentation going on: it tilts less as the sugar goes.
    this.tilt = Math.max(28, this.tilt - 0.15);
    this.temperature = Math.round((19.5 + Math.sin(Date.now() / 3_600_000) * 0.4) * 100) / 100;
    this.volts = Math.max(3.4, this.volts - 0.0005);
    const body: Record<string, unknown> = {
      name: this.settings.name,
      ID: this.chipId,
      ...(this.settings.token ? { token: this.settings.token } : {}),
      angle: Math.round(this.tilt * 1e5) / 1e5,
      temperature: this.settings.tempscale === '1' ? this.temperature * 1.8 + 32 : this.temperature,
      temp_units: this.settings.tempscale === '1' ? 'F' : this.settings.tempscale === '2' ? 'K' : 'C',
      battery: Math.round(this.volts * 1e6) / 1e6,
      gravity: Math.round(gravityAt(this.tilt) * 1e6) / 1e6,
      interval,
      RSSI: -58,
    };
    const uri = this.settings.uri ?? '';
    const url = `http://${this.settings.server}:${this.settings.port}${uri.startsWith('/') ? '' : '/'}${uri}`;
    let status: number | null = null;
    try {
      status = this.opts.send
        ? await this.opts.send(url, body)
        : (
            await fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'User-Agent': 'ESP8266HTTPClient' },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(5000),
            })
          ).status;
    } catch {}
    this.posts.push({ url, body, status });
    this.emit('post', body, status);
  }

  private send(res: ServerResponse, status: number, body: string, type = 'text/html'): void {
    res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
    res.end(body);
  }

  private page(title: string, body: string): string {
    const list = SERVICES.map((n) => `{"name":"${n}", "token":1,"server":1,"uri":1,"port":1}`).join(',\n');
    return (
      `<!DOCTYPE html><html lang="en"><head><meta name="viewport" charset="utf-8" content="width=device-width, initial-scale=1, user-scalable=no"/><title>${title}</title>` +
      `<script>\nvar lAPI = [\n${list}\n];\n</script></head><body><div class="container">${body}</div></body></html>`
    );
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    // Only its setup portal answers, and only in setup mode.
    if (!this.setupMode || this.down) return void res.destroy();
    const url = new URL(req.url ?? '/', 'http://ispindel');
    if (url.pathname === '/') {
      return this.send(
        res,
        200,
        this.page('Options', `<h2>iSpindel</h2><form action="/wifi" method="get"><button class="btn">Configuration</button></form>`),
      );
    }
    if (url.pathname === '/wifi') {
      const s = this.settings;
      let form = `<h2>Configuration</h2>`;
      for (const [net] of Object.entries(this.opts.networks))
        form += `<div><a href="#p" onclick="c(this)">${html(net)}</a>&nbsp;<span class="q l">80%</span></div>`;
      form += `<form method="get" action="wifisave"><label>SSID</label><input id="s" name="s" length=32 placeholder="SSID" value="${html(s.s!)}"><label>Password</label><input id="p" name="p" length=64 placeholder="password" value="${html(s.p!)}">`;
      for (const [name, label, extra] of FIELDS) {
        if (label) form += `<label for="${name}">${label}</label>`;
        if (name === 'selAPI') form += '<select id="API" onchange="sAPI(this.options[this.selectedIndex].value);"></select>';
        if (name === 'tempscale')
          form +=
            '<select id="TS" onclick="sTS()">\n<option value=0>Celsius</option>\n<option value=1>Fahrenheit</option>\n<option value=2>Kelvin</option>\n</select>';
        form += `<input id="${name}" name="${name}" length=${(s[name] ?? '').length} placeholder="${label || name}" value="${html(s[name] ?? '')}" ${extra}>`;
      }
      form += '<br/><button class="btn" type="submit">save</button></form>';
      return this.send(res, 200, this.page('Config ESP', form));
    }
    if (url.pathname === '/wifisave') {
      // Like WiFiManager: every setting is replaced with what's sent; one that isn't sent is emptied.
      for (const key of Object.keys(this.settings)) this.settings[key] = url.searchParams.get(key) ?? '';
      this.events.push(`saved ${this.settings.s}`);
      this.send(
        res,
        200,
        this.page(
          'Credentials Saved',
          `<div class="msg"><strong>Credentials Saved</strong><br>Trying to connect ESP to the ${html(this.settings.s!)} network.<br>Give it 10 seconds or so and check <a href="/">how it went.</a></div>`,
        ),
      );
      // It leaves setup mode, restarts and sends its first reading straight away.
      this.setupMode = false;
      this.down = true;
      setTimeout(() => {
        this.down = false;
        this.schedule(0);
      }, this.opts.restartMs).unref?.();
      return;
    }
    this.send(res, 404, 'Not found', 'text/plain');
  }
}
