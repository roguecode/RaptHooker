import { afterEach, describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import {
  ISPINDEL_PATH,
  decodeHtmlEntities,
  ispindelPostSchema,
  pillIdFromAddress,
  type IspindelSetupProgress,
  type NearbyPill,
  type Pill,
} from '@rapthooker/shared';
import { parseConfig } from '../config.js';
import { ClockGuard } from '../clock.js';
import { FLAG_IMPLAUSIBLE } from '../db.js';
import { PillService } from '../pills.js';
import { BrewService } from '../brews.js';
import { WebhookService } from '../webhooks.js';
import { AlertService } from '../alerts.js';
import { Maintenance } from '../maintenance.js';
import { buildServer, Settings } from '../server.js';
import { UnavailableScanner } from '../ble/scanner.js';
import type { PushService } from '../push.js';
import { MqttService } from '../mqtt.js';
import { ChannelService } from '../channels.js';
import { UpdateService } from '../updates.js';
import { SystemService } from '../system.js';
import { TokenService } from '../tokens.js';
import { LogBuffer } from '../logbuffer.js';
import { decodeIspindel } from '../ispindel/decode.js';
import { httpServiceNumber, isIspindelForm, parsePortalForm, saveParams } from '../ispindel/portal.js';
import type { IspindelService } from '../ispindel/service.js';
import { FakeIspindel } from '../ispindel/simulator.js';
import { MockWifi } from '../screens/simulator.js';
import { CAPTURED_ISPINDEL, silent, tempStore, testIspindel, testScreens } from './helpers.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const T = Date.UTC(2026, 10, 2, 19, 44, 11);
const parse = (json: string) => ispindelPostSchema.parse(JSON.parse(json));

describe('what an iSpindel posts', () => {
  it('reads a real iSpindel (firmware 6.5.1) lying flat: its own gravity, tilt and battery, flagged as not floating', () => {
    const d = decodeIspindel(parse(CAPTURED_ISPINDEL.flat), T);
    expect(d).toEqual({
      ok: true,
      address: 'ISPINDEL:64983F',
      name: '2-yolandi_[SG]',
      intervalSec: 30,
      raw: {
        ts: T,
        sg: 1.112757,
        temp: 16.5625,
        velocity: null,
        battery: 97.9,
        rssi: -53,
        x: null,
        y: null,
        z: null,
        tilt: 87.6058,
        voltage: 4.1293,
        flags: FLAG_IMPLAUSIBLE,
      },
    });
    // Its id comes from its chip id, as webhook variables have it (chip_id 6592575).
    expect(pillIdFromAddress('ISPINDEL:64983F')).toBe('ispindel-64983f');
  });

  it('turns °F, K and °Plato into °C and SG, and floats between lying flat and standing up', () => {
    const base = { ID: 1234, angle: 52.3, battery: 3.9 };
    const f = decodeIspindel(ispindelPostSchema.parse({ ...base, temperature: 68.5, temp_units: 'F', gravity: 12.4 }), T);
    expect(f.ok && f.raw).toMatchObject({ temp: 20.2778, sg: expect.closeTo(1.0501, 4), tilt: 52.3, flags: 0, battery: 66 });
    const k = decodeIspindel(ispindelPostSchema.parse({ ...base, temperature: 293.15, temp_units: 'K', gravity: 1.05 }), T);
    expect(k.ok && k.raw).toMatchObject({ temp: 20, sg: 1.05 });
    // GravityMon says which unit its gravity is in.
    const p = decodeIspindel(ispindelPostSchema.parse({ ...base, temperature: 20, gravity: 1.4, 'gravity-unit': 'P' }), T);
    expect(p.ok && p.raw.sg).toBeCloseTo(1.0054, 4);
    // No formula (or no gravity) is no gravity, not 0.
    const none = decodeIspindel(ispindelPostSchema.parse({ ...base, temperature: 20, gravity: 0 }), T);
    expect(none.ok && none.raw).toMatchObject({ sg: null, flags: 0 });
    const upright = decodeIspindel(ispindelPostSchema.parse({ ...base, angle: 2, temperature: 20, gravity: 1.05 }), T);
    expect(upright.ok && upright.raw.flags).toBe(FLAG_IMPLAUSIBLE);
    // Numbers as text, as some firmware sends them.
    expect(ispindelPostSchema.parse({ ID: '1234', temperature: '20.5', angle: '40' })).toMatchObject({
      ID: 1234,
      temperature: 20.5,
      angle: 40,
    });
  });

  it("doesn't store a temperature its sensor couldn't read", () => {
    expect(decodeIspindel(ispindelPostSchema.parse({ ID: 1, temperature: -127, angle: 40 }), T)).toEqual({
      ok: false,
      reason: 'temperature out of range',
    });
  });
});

/**
 * The Configuration page of a real iSpindel on firmware 6.5.1, as it served it: its service list and its form, with the
 * values changed to made-up ones (encoded as the firmware encodes them: every character that isn't a letter or digit
 * as &#NN;). The firmware's own scripts and styles are left out.
 */
const PORTAL_651 = `<!DOCTYPE html><html lang="en"><head><meta name="viewport" charset="utf-8" content="width=device-width, initial-scale=1, user-scalable=no"/><title>Config ESP</title>
<script>
var lAPI = [
{"name":"Ubidots",    "token":1,"server":0,"uri":0,"port":0,"channel":0,"db":0,"username":0,"password":0,"job":0,"instance":0},
{"name":"empty",      "token":1,"server":0,"uri":0,"port":0,"channel":0,"db":0,"username":0,"password":0,"job":0,"instance":0},
{"name":"CraftBeerPi","token":0,"server":1,"uri":0,"port":0,"channel":0,"db":0,"username":0,"password":0,"job":0,"instance":0},
{"name":"HTTP",       "token":1,"server":1,"uri":1,"port":1,"channel":0,"db":0,"username":0,"password":0,"job":0,"instance":0},
{"name":"TControl",   "token":0,"server":1,"uri":0,"port":0,"channel":0,"db":0,"username":0,"password":0,"job":0,"instance":0},
{"name":"FHEM",       "token":0,"server":1,"uri":0,"port":1,"channel":0,"db":0,"username":0,"password":0,"job":0,"instance":0},
{"name":"TCP",        "token":1,"server":1,"uri":0,"port":1,"channel":0,"db":0,"username":0,"password":0,"job":0,"instance":0},
{"name":"iSpindel.de","token":1,"server":0,"uri":0,"port":0,"channel":0,"db":0,"username":0,"password":0,"job":0,"instance":0},
{"name":"InfluxDB",   "token":0,"server":1,"uri":0,"port":1,"channel":0,"db":1,"username":1,"password":1,"job":0,"instance":0},
{"name":"Prometheus", "token":0,"server":1,"uri":0,"port":1,"channel":0,"db":0,"username":0,"password":0,"job":1,"instance":1},
{"name":"MQTT",       "token":0,"server":1,"uri":0,"port":1,"channel":0,"db":0,"username":1,"password":1,"job":0,"instance":0},
{"name":"ThingSpeak", "token":1,"server":0,"uri":0,"port":0,"channel":1,"db":0,"username":0,"password":0,"job":0,"instance":0},
{"name":"Blynk",      "token":1,"server":0,"uri":0,"port":0,"channel":0,"db":0,"username":0,"password":0,"job":0,"instance":0},
{"name":"Brewblox",   "token":0,"server":1,"uri":1,"port":1,"channel":0,"db":0,"username":1,"password":1,"job":0,"instance":0}];
</script></head><body><div class="container"><h2>Configuration</h2><div><a href="#p" onclick="c(this)">Brewery</a>&nbsp;<span class="q l">100%</span></div><div><a href="#p" onclick="c(this)">Neighbours</a>&nbsp;<span class="q ">24%</span></div><br/><form method="get" action="wifisave"><label>SSID</label><input id="s" name="s" length=32 placeholder="SSID" value="Brewery"><label>Password</label><input id="p" name="p" length=64 placeholder="password" value="hops&#38;barley&#33;"><label for="name">iSpindel Name</label><input id="name" name="name" length=8 placeholder="iSpindel Name" value="Spindel&#45;1&#95;&#91;SG&#93;" ><label for="sleep">Update Interval (s)</label><input id="sleep" name="sleep" length=6 placeholder="Update Interval (s)" value="300" type="number" step="any"><label for="vfact">Battery conversion factor</label><input id="vfact" name="vfact" length=7 placeholder="Battery conversion factor" value="191.80" type="number" step="any"><label for="TS">Unit of temperature</label>
<select id="TS" onclick="sTS()">
<option value=0>Celsius</option>
<option value=1>Fahrenheit</option>
<option value=2>Kelvin</option>
</select><input id="tempscale" name="tempscale" length=5 placeholder="tempscale" value="0" type="hidden"><hr><label for="API">Service Type</label>
<select id="API" onchange="sAPI(this.options[this.selectedIndex].value);"></select><input id="selAPI" name="selAPI" length=2 placeholder="selAPI" value="9" type="hidden"><label for="token">Token</label><input id="token" name="token" length=1 placeholder="Token" value="brewspy&#45;key" ><label for="server">Server Address</label><input id="server" name="server" length=2 placeholder="Server Address" value="brew&#45;spy&#46;com" ><label for="port">Server Port</label><input id="port" name="port" length=4 placeholder="Server Port" value="80" type="number" step="any"><label for="channel">Channelnumber</label><input id="channel" name="channel" length=4 placeholder="Channelnumber" value="0" type="number" step="any"><label for="uri">Path / URI</label><input id="uri" name="uri" length=2 placeholder="Path / URI" value="/api/ispindel" ><label for="db">InfluxDB db</label><input id="db" name="db" length=4 placeholder="InfluxDB db" value="ispindel" ><label for="username">Username</label><input id="username" name="username" length=4 placeholder="Username" value="" ><label for="password">Password</label><input id="password" name="password" length=4 placeholder="Password" value="" ><label for="job">Prometheus job</label><input id="job" name="job" length=4 placeholder="Prometheus job" value="ispindel" ><label for="instance">Prometheus instance</label><input id="instance" name="instance" length=4 placeholder="Prometheus instance" value="000" ><hr><label for="POLYN">Gravity conversion<br/>ex. "-0.00031*tilt^2+0.557*tilt-14.054"</label><label for="POLYN">Polynominal</label><input id="POLYN" name="POLYN" length=5 placeholder="Polynominal" value="0&#46;959105&#43;0&#46;00160272&#42;tilt&#43;0&#46;0000017256799&#42;tilt&#94;2" ><br/><button class="btn" type="submit">save</button></form></div></body></html>`;

/** Firmware 7's form has boxes to tick, sent only when ticked. */
const PORTAL_7_BOXES = `<form method="get" action="wifisave"><input id="s" name="s" value="Brewery"><input id="p" name="p" type="password" value="x"><input id="selAPI" name="selAPI" value="3" type="hidden"><input id="token" name="token" value=""><input id="server" name="server" value=""><input id="usehttps" name="usehttps" length=7 placeholder="Connect to server via HTTPS" value="checked" type="checkbox" checked><input id="hassio" name="hassio" length=7 value="checked" type="checkbox"><input id="POLYN" name="POLYN" value="1"></form>`;

describe("an iSpindel's setup page", () => {
  it('reads every setting of a real one (6.5.1), decoded, and the number HTTP is saved as', () => {
    const form = parsePortalForm(PORTAL_651);
    expect(isIspindelForm(form)).toBe(true);
    expect(form.services).toHaveLength(14);
    expect(httpServiceNumber(form)).toBe(3);
    expect(Object.fromEntries(form.fields.map((f) => [f.name, f.value]))).toEqual({
      s: 'Brewery',
      p: 'hops&barley!',
      name: 'Spindel-1_[SG]',
      sleep: '300',
      vfact: '191.80',
      tempscale: '0',
      selAPI: '9',
      token: 'brewspy-key',
      server: 'brew-spy.com',
      port: '80',
      channel: '0',
      uri: '/api/ispindel',
      db: 'ispindel',
      username: '',
      password: '',
      job: 'ispindel',
      instance: '000',
      POLYN: '0.959105+0.00160272*tilt+0.0000017256799*tilt^2',
    });
    expect(isIspindelForm(parsePortalForm('<form action="/wifisave"><input name="s"><input name="p"></form>'))).toBe(false);
  });

  it('sends everything back, with only the changes', () => {
    const params = saveParams(parsePortalForm(PORTAL_651), { selAPI: '3', server: '192.168.1.20', port: '8080', token: 'rh_ispindel_x' });
    expect(params).toEqual([
      ['s', 'Brewery'],
      ['p', 'hops&barley!'],
      ['name', 'Spindel-1_[SG]'],
      ['sleep', '300'],
      ['vfact', '191.80'],
      ['tempscale', '0'],
      ['selAPI', '3'],
      ['token', 'rh_ispindel_x'],
      ['server', '192.168.1.20'],
      ['port', '8080'],
      ['channel', '0'],
      ['uri', '/api/ispindel'],
      ['db', 'ispindel'],
      ['username', ''],
      ['password', ''],
      ['job', 'ispindel'],
      ['instance', '000'],
      ['POLYN', '0.959105+0.00160272*tilt+0.0000017256799*tilt^2'],
    ]);
  });

  it('sends a ticked box as a browser would, and leaves out one it unticks', () => {
    const form = parsePortalForm(PORTAL_7_BOXES);
    expect(saveParams(form, {})).toContainEqual(['usehttps', 'checked']);
    expect(saveParams(form, {}).map(([k]) => k)).not.toContain('hassio');
    expect(saveParams(form, {}, ['usehttps']).map(([k]) => k)).not.toContain('usehttps');
  });

  it('decodes text the way the firmware encodes it, a byte at a time', () => {
    expect(decodeHtmlEntities('rh&#95;ispindel&#95;abc')).toBe('rh_ispindel_abc');
    // "é" is two UTF-8 bytes, each encoded on its own.
    expect(decodeHtmlEntities('caf&#195;&#169;')).toBe('café');
    // A single character reference that isn't UTF-8 bytes is taken as the character.
    expect(decodeHtmlEntities('caf&#233; &amp; &#x1F37A;')).toBe('café & 🍺');
    expect(decodeHtmlEntities('no entities')).toBe('no entities');
    // Text that looks percent-encoded, or a reference no string can hold on its own, comes through as it is.
    expect(decodeHtmlEntities('100% &#37;41 %41')).toBe('100% %41 %41');
    expect(decodeHtmlEntities('a&#xD800;b')).toBe('a\uD800b');
  });
});

const owner = { 'tailscale-user-login': 'me@example.com' };

async function api() {
  const t = tempStore();
  const config = parseConfig({ dataDir: t.dir, webDir: `${t.dir}/no-web` }, t.dir, t.dir);
  const clock = new ClockGuard({ syncFile: null, maxWaitMs: 0 });
  const pills = new PillService(t.store, clock, silent);
  const brews = new BrewService(t.store, pills, silent);
  pills.brewOf = (id) => brews.activeFor(id);
  const webhooks = new WebhookService(
    t.store,
    { pills, brews, clockTrusted: () => true, version: 't', fetch: (async () => new Response('ok')) as typeof fetch },
    silent,
  );
  const push = { publicKey: 'k', send: async () => undefined } as unknown as PushService;
  const settings = new Settings(t.store);
  const tokens = new TokenService(t.store);
  const ispindel = testIspindel(t.store, tokens, pills);
  const app = await buildServer({
    config,
    store: t.store,
    pills,
    brews,
    webhooks,
    alerts: new AlertService(t.store, { pills, brews, units: () => settings.units() }, push, silent),
    push,
    maintenance: new Maintenance(t.store, silent, { backupDir: '', backupTime: '03:00', keep: 1, rawRetentionDays: 0 }),
    scanner: new UnavailableScanner('test'),
    clock,
    settings,
    mqtt: new MqttService({ pills, brews, settings, version: 't' }, silent),
    channels: new ChannelService(t.store, silent),
    updates: new UpdateService('t', settings, silent),
    system: new SystemService(config, t.store, silent),
    tokens,
    screens: testScreens(t.store, settings),
    ispindel,
    logs: new LogBuffer(),
    version: 't',
    startedAt: Date.now(),
  });
  cleanups.push(async () => {
    await app.close();
    t.cleanup();
  });
  return { app, pills, store: t.store, tokens, ispindel, token: ispindel.token() };
}

const post = (json: string, token: string) => ({ ...JSON.parse(json), token }) as Record<string, unknown>;

describe('POST /api/ispindel', () => {
  it("turns away posts without the hub's iSpindel token", async () => {
    const { app, tokens } = await api();
    const send = (payload: unknown, headers: Record<string, string> = {}) =>
      app.inject({ method: 'POST', url: ISPINDEL_PATH, payload: payload as object, headers });
    expect((await send(JSON.parse(CAPTURED_ISPINDEL.flat))).statusCode).toBe(401);
    expect((await send(post(CAPTURED_ISPINDEL.flat, 'rh_ispindel_madeup'))).statusCode).toBe(401);
    expect((await send(post(CAPTURED_ISPINDEL.flat, tokens.create('Shed', 'relay').token))).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/state' })).json<{ nearby: NearbyPill[] }>().nearby).toEqual([]);
  });

  it('lists a new iSpindel under its own name, then records it once added', async () => {
    const { app, token, store } = await api();
    const res = await app.inject({ method: 'POST', url: ISPINDEL_PATH, payload: post(CAPTURED_ISPINDEL.afterSetup, token) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, status: 'nearby' });
    const nearby = (await app.inject({ url: '/api/state' })).json<{ nearby: NearbyPill[] }>().nearby;
    expect(nearby).toEqual([
      expect.objectContaining({
        address: 'ISPINDEL:64983F',
        kind: 'ispindel',
        name: '2-yolandi_[SG]',
        raptId: 'ISPINDEL:64983F',
        rssi: -56,
      }),
    ]);
    expect(nearby[0]!.latest).toMatchObject({ gravity: 1.11283, temperature: 16.5625, tilt: 87.6443, voltage: 4.1345, plausible: false });

    const added = await app.inject({ method: 'POST', url: '/api/pills', headers: owner, payload: { address: 'ISPINDEL:64983F' } });
    expect(added.statusCode).toBe(200);
    const pill = added.json<Pill>();
    expect(pill).toMatchObject({ id: 'ispindel-64983f', kind: 'ispindel', name: '2-yolandi_[SG]', info: { deviceType: 'iSpindel' } });
    // It doesn't send a velocity: RaptHooker works it out.
    expect(pill.model.velocitySource).toBe('computed');
    expect(store.countReadings('ispindel-64983f')).toBe(1);

    const next = await app.inject({ method: 'POST', url: ISPINDEL_PATH, payload: post(CAPTURED_ISPINDEL.flat, token) });
    expect(next.json()).toEqual({ ok: true, status: 'recorded' });
    expect(store.latestReadings('ispindel-64983f', 1)[0]).toMatchObject({ tilt: 87.6058, voltage: 4.1293, sg: 1.112757, x: null });
    const history = (
      await app.inject({ url: `/api/pills/ispindel-64983f/history?from=${Date.now() - 3_600_000}&to=${Date.now() + 1000}` })
    ).json<{
      tilt: (number | null)[];
    }>();
    expect(history.tilt.filter((v) => v !== null)).toEqual([expect.closeTo(87.6443, 3), expect.closeTo(87.6058, 3)]);
  });

  it('takes a name and token sent HTML-encoded, as an iSpindel does after its setup mode times out', async () => {
    const { app, token, pills } = await api();
    const encode = (s: string) => s.replace(/[^A-Za-z0-9]/g, (c) => `&#${c.charCodeAt(0)};`);
    const body = { ...JSON.parse(CAPTURED_ISPINDEL.flat), name: '2&#45;yolandi&#95;&#91;SG&#93;', token: encode(token) } as Record<
      string,
      unknown
    >;
    const res = await app.inject({ method: 'POST', url: ISPINDEL_PATH, payload: body });
    expect(res.statusCode).toBe(200);
    expect(pills.nearby()).toEqual([expect.objectContaining({ address: 'ISPINDEL:64983F', name: '2-yolandi_[SG]' })]);
  });

  it('takes the token from a header or the address as well, for other firmware', async () => {
    const { app, token } = await api();
    const body = JSON.parse(CAPTURED_ISPINDEL.flat) as Record<string, unknown>;
    delete body.token;
    const header = await app.inject({ method: 'POST', url: ISPINDEL_PATH, payload: body, headers: { authorization: `Bearer ${token}` } });
    expect(header.statusCode).toBe(200);
    const query = await app.inject({ method: 'POST', url: `${ISPINDEL_PATH}?token=${encodeURIComponent(token)}`, payload: body });
    expect(query.statusCode).toBe(200);
    // JSON sent as text.
    const text = await app.inject({
      method: 'POST',
      url: ISPINDEL_PATH,
      payload: JSON.stringify({ ...body, token }),
      headers: { 'content-type': 'text/plain' },
    });
    expect(text.statusCode).toBe(200);
  });

  it('gives the owner the token, the address to send to and the hotspots it has seen; others no token', async () => {
    const { app, token } = await api();
    const mine = (await app.inject({ url: '/api/ispindel', headers: owner })).json();
    expect(mine).toMatchObject({ token, server: { host: '192.168.1.20', port: 8080, path: '/api/ispindel' }, hotspots: [], setup: null });
    expect((await app.inject({ url: '/api/ispindel' })).json()).toMatchObject({ token: null, setup: null });
    expect((await app.inject({ url: '/api/ispindel/setup' })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/ispindel/setup', headers: owner })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: '/api/ispindel/setup/s1' })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: '/api/ispindel/setup/s1', headers: owner })).statusCode).toBe(204);
  });
});

describe('the iSpindel token', () => {
  it('is made once, shown again, and made anew if it was deleted', async () => {
    const t = tempStore();
    cleanups.push(t.cleanup);
    const tokens = new TokenService(t.store);
    const pills = new PillService(t.store, new ClockGuard({ syncFile: null, maxWaitMs: 0 }), silent);
    const service = testIspindel(t.store, tokens, pills);
    const first = service.token();
    expect(first).toMatch(/^rh_ispindel_/);
    expect(service.token()).toBe(first);
    expect(tokens.list()).toEqual([expect.objectContaining({ name: 'iSpindels', scope: 'ispindel' })]);
    tokens.remove(tokens.list()[0]!.id);
    const again = service.token();
    expect(again).not.toBe(first);
    expect(service.verify(again)).toBe(true);
    expect(service.verify(first)).toBe(false);
  });
});

/** A hub with the pretend Wi-Fi and a pretend iSpindel in setup mode, whose posts go straight to the hub. */
async function rig(opts: { knowsPassword?: boolean; spindel?: ConstructorParameters<typeof FakeIspindel>[0]; now?: () => number } = {}) {
  const t = tempStore();
  const clock = new ClockGuard({ syncFile: null, maxWaitMs: 0 });
  const pills = new PillService(t.store, clock, silent);
  const tokens = new TokenService(t.store);
  let service: IspindelService | null = null;
  const fake = new FakeIspindel({
    chipId: 0x64983f,
    name: '2-yolandi_[SG]',
    networks: { Brewery: 'hops-and-barley' },
    restartMs: 10,
    send: async (_url, body) => {
      const p = ispindelPostSchema.parse(body);
      if (!service!.verify(p.token)) return 401;
      service!.ingest(p, Date.now(), performance.now());
      return 200;
    },
    ...opts.spindel,
  });
  await fake.start();
  const wifi = new MockWifi(() => [fake], undefined, { knowsPassword: opts.knowsPassword ?? true });
  service = testIspindel(t.store, tokens, pills, { wifi, fast: true, now: opts.now });
  cleanups.push(async () => {
    service!.stop();
    await fake.stop();
    t.cleanup();
  });
  return { fake, wifi, pills, service, store: t.store };
}

const finished = (service: IspindelService) =>
  new Promise<IspindelSetupProgress>((resolve) => {
    const on = (p: IspindelSetupProgress) => {
      if (p.state === 'running') return;
      service.off('setup', on);
      resolve(p);
    };
    service.on('setup', on);
  });

describe('setting an iSpindel up from its hotspot', () => {
  it('finds it, points it at the hub keeping its own settings, and adds it with its first reading', async () => {
    const { fake, wifi, pills, service } = await rig();
    expect(await service.scan(true)).toEqual([expect.objectContaining({ ssid: 'iSpindel', chipId: '64983F' })]);

    const done = finished(service);
    const started = await service.startSetup({ hotspot: 'iSpindel', ssid: 'Brewery', password: '', name: '', interval: 900 });
    expect(started).toMatchObject({ state: 'running', step: 'hotspot', chipId: '64983F' });
    const p = await done;
    expect(p).toMatchObject({
      state: 'done',
      error: null,
      deviceId: 'ispindel-64983f',
      waiting: false,
      hubBack: true,
      written: { name: '2-yolandi_[SG]', ssid: 'Brewery', server: '192.168.1.20', port: 8080, path: '/api/ispindel', interval: 900 },
    });
    expect(p.steps.map((s) => s.step)).toEqual(['hotspot', 'read', 'configure', 'back', 'reading', 'done']);

    expect(fake.settings).toMatchObject({
      s: 'Brewery',
      // The hub's own network's password, which it knows.
      p: 'hops-and-barley',
      selAPI: '3',
      server: '192.168.1.20',
      port: '8080',
      uri: '/api/ispindel',
      token: service.token(),
      sleep: '900',
      // What it had is kept.
      name: '2-yolandi_[SG]',
      vfact: '191.80',
      POLYN: '0.959105+0.00160272*tilt+0.0000017256799*tilt^2',
      db: 'ispindel',
    });
    expect(wifi.joins).toEqual(['iSpindel']);
    expect(wifi.current).toBe('Brewery');
    expect(pills.get('ispindel-64983f')).toMatchObject({ kind: 'ispindel', name: '2-yolandi_[SG]' });
    expect(pills.get('ispindel-64983f')!.live.latest?.tilt).toBeGreaterThan(50);
    // Only the owner sees how it went (it names the Wi-Fi) and the hub's own network.
    expect(await service.info(true)).toMatchObject({ setup: { state: 'done' }, wifi: { ssid: 'Brewery' } });
    expect(await service.info(false)).toMatchObject({ token: null, setup: null, wifi: { ssid: null, canSetUp: true } });
    // Once a page has shown how it ended, the tab is ready to set up another.
    service.forget('another-setup');
    expect(service.setupProgress()).toMatchObject({ id: p.id });
    service.forget(p.id);
    expect(service.setupProgress()).toBeNull();
    expect((await service.info(true)).setup).toBeNull();
  });

  it('only keeps how a set-up ended for a while, for a page that missed it', async () => {
    let later = 0;
    const { service } = await rig({ now: () => Date.now() + later });
    await service.scan(true);
    const done = finished(service);
    await service.startSetup({ hotspot: 'iSpindel', ssid: 'Brewery', password: '', name: '', interval: 900 });
    const p = await done;
    later = 14 * 60_000;
    expect(service.setupProgress()).toMatchObject({ id: p.id, state: 'done' });
    later = 16 * 60_000;
    expect(service.setupProgress()).toBeNull();
  });

  it('renames it and keeps the Wi-Fi it already has when asked', async () => {
    const { fake, service } = await rig();
    fake.settings.s = 'Brewery';
    fake.settings.p = 'hops-and-barley';
    const done = finished(service);
    await service.startSetup({ hotspot: 'iSpindel', ssid: '', password: '', name: 'Fermenter 2', interval: 600 });
    expect(await done).toMatchObject({ state: 'done', deviceId: 'ispindel-64983f', written: { name: 'Fermenter 2', ssid: 'Brewery' } });
    expect(fake.settings).toMatchObject({ s: 'Brewery', p: 'hops-and-barley', name: 'Fermenter 2', sleep: '600' });
  });

  it("says when it needs the password for the hub's network, and puts the hub back", async () => {
    const { wifi, service } = await rig({ knowsPassword: false });
    const done = finished(service);
    await service.startSetup({ hotspot: 'iSpindel', ssid: 'Brewery', password: '', name: '', interval: 900 });
    expect(await done).toMatchObject({ state: 'failed', error: 'no-password', hubBack: true });
    expect(wifi.current).toBe('Brewery');
  });

  it('finishes waiting when no reading comes (a wrong password), and adds it when one does later', async () => {
    const { fake, pills, service } = await rig();
    const done = finished(service);
    await service.startSetup({ hotspot: 'iSpindel', ssid: 'Brewery', password: 'wrong', name: '', interval: 900 });
    expect(await done).toMatchObject({ state: 'done', deviceId: null, waiting: true });
    expect(fake.online).toBe(false);
    expect(pills.get('ispindel-64983f')).toBeNull();
    // Put right (set up again by hand, say): its first reading adds it.
    expect(service.ingest(parse(CAPTURED_ISPINDEL.flat), Date.now(), performance.now())).toEqual({ ok: true, status: 'recorded' });
    expect(pills.get('ispindel-64983f')).toMatchObject({ kind: 'ispindel' });
  });

  it('still adds it when its first reading comes after the hub restarted', async () => {
    const { pills, service, store } = await rig();
    const done = finished(service);
    await service.startSetup({ hotspot: 'iSpindel', ssid: 'Brewery', password: 'wrong', name: 'Fermenter 2', interval: 900 });
    expect(await done).toMatchObject({ state: 'done', waiting: true });
    service.stop();
    const again = testIspindel(store, new TokenService(store), pills);
    const post = { ...JSON.parse(CAPTURED_ISPINDEL.flat), name: 'Fermenter 2' } as Record<string, unknown>;
    expect(again.ingest(ispindelPostSchema.parse(post), Date.now(), performance.now())).toEqual({ ok: true, status: 'recorded' });
    expect(pills.get('ispindel-64983f')).toMatchObject({ kind: 'ispindel', name: 'Fermenter 2' });
    // Once added, it isn't waited for any more.
    expect(store.getMeta('ispindelPending')).toBeNull();
  });

  it("won't start a second set-up while one is running", async () => {
    const { service } = await rig();
    const done = finished(service);
    await service.startSetup({ hotspot: 'iSpindel', ssid: 'Brewery', password: '', name: '', interval: 900 });
    await expect(service.startSetup({ hotspot: 'iSpindel', ssid: 'Brewery', password: '', name: '', interval: 900 })).rejects.toThrow(
      /already being set up/,
    );
    await done;
  });
});
