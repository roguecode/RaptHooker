import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_BACKUP_SETTINGS, DEFAULT_HUB_SETTINGS } from '@rapthooker/shared';
import { parseConfig } from '../config.js';
import { ClockGuard } from '../clock.js';
import { PillService } from '../pills.js';
import { BrewService } from '../brews.js';
import { WebhookService } from '../webhooks.js';
import { AlertService } from '../alerts.js';
import { Maintenance } from '../maintenance.js';
import { buildServer, Settings } from '../server.js';
import { UnavailableScanner } from '../ble/scanner.js';
import { RAPT_COMPANY_ID, encodeRaptLaser } from '../ble/rapt.js';
import type { PushService } from '../push.js';
import { MqttService } from '../mqtt.js';
import { ChannelService } from '../channels.js';
import { UpdateService } from '../updates.js';
import { SystemService } from '../system.js';
import { TokenService } from '../tokens.js';
import { LogBuffer } from '../logbuffer.js';
import { CAPTURED, silent, tempStore, testIspindel, testScreens } from './helpers.js';

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

async function setup() {
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
  const push = {
    publicKey: 'k',
    send: async () => undefined,
    subscribe: () => undefined,
    unsubscribe: () => undefined,
  } as unknown as PushService;
  const settings = new Settings(t.store);
  const alerts = new AlertService(t.store, { pills, brews, units: () => settings.units() }, push, silent);
  const screens = testScreens(t.store, settings);
  const app = await buildServer({
    config,
    store: t.store,
    pills,
    brews,
    webhooks,
    alerts,
    push,
    maintenance: new Maintenance(t.store, silent, { backupDir: '', backupTime: '03:00', keep: 1, rawRetentionDays: 0 }),
    scanner: new UnavailableScanner('test'),
    clock,
    settings,
    mqtt: new MqttService({ pills, brews, settings, version: 't' }, silent),
    channels: new ChannelService(t.store, silent),
    updates: new UpdateService('t', settings, silent),
    system: new SystemService(config, t.store, silent),
    tokens: new TokenService(t.store),
    screens,
    ispindel: testIspindel(t.store, new TokenService(t.store), pills),
    logs: new LogBuffer(),
    version: 't',
    startedAt: Date.now(),
  });
  cleanup = () => {
    void app.close();
    t.cleanup();
  };
  return { app, pills, store: t.store, screens };
}

const owner = { 'tailscale-user-login': 'me@example.com' };

describe('API', () => {
  it('kegs a beer up under a Laser Level for the owner, and shows it to everyone', async () => {
    const { app, pills } = await setup();
    const laser = encodeRaptLaser({ mac: 'D8:3B:DA:44:55:66', distance: 293, battery: 86, temp: 4 });
    pills.handleAdvert({
      address: 'D8:3B:DA:44:55:66',
      rssi: -60,
      manufacturer: new Map([[RAPT_COMPANY_ID, laser]]),
      at: Date.now(),
      mono: 0,
      cached: false,
    });
    const id = pills.adopt('D8:3B:DA:44:55:66', {}).id;
    const body = { pillId: id, name: 'Pale ale', style: 'APA', abv: 5.2 };
    expect((await app.inject({ method: 'POST', url: '/api/kegs', payload: body })).statusCode).toBe(403);
    const made = await app.inject({ method: 'POST', url: '/api/kegs', payload: body, headers: owner });
    expect(made.statusCode).toBe(200);
    const keg = made.json<{ id: string }>();
    expect((await app.inject({ url: `/api/kegs?pill=${id}` })).json()).toEqual([expect.objectContaining({ id: keg.id, abv: 5.2 })]);
    expect((await app.inject({ url: '/api/pills' })).json()).toEqual([
      expect.objectContaining({ id, keg: expect.objectContaining({ name: 'Pale ale' }) }),
    ]);
    expect((await app.inject({ method: 'POST', url: '/api/kegs', payload: { pillId: id, abv: 99 }, headers: owner })).statusCode).toBe(400);
    const patched = await app.inject({ method: 'PATCH', url: `/api/kegs/${keg.id}`, payload: { name: 'Pale' }, headers: owner });
    expect(patched.json()).toMatchObject({ name: 'Pale', style: 'APA' });
    const ended = await app.inject({ method: 'POST', url: `/api/kegs/${keg.id}/end`, payload: {}, headers: owner });
    expect(ended.json<{ endedAt: number | null }>().endedAt).not.toBeNull();
    expect((await app.inject({ method: 'DELETE', url: `/api/kegs/${keg.id}`, headers: owner })).statusCode).toBe(204);
    expect((await app.inject({ url: `/api/kegs/${keg.id}` })).statusCode).toBe(404);
  });

  it("lists one pill's alerts, and takes velocity alerts", async () => {
    const { app, store } = await setup();
    for (const pillId of ['p1', 'p2'])
      store.addAlertEvent({ ruleId: 'r1', ruleName: 'Too warm', pillId, at: 1, kind: 'fired', message: `${pillId} is warm`, value: 25 });
    expect((await app.inject({ url: '/api/alerts/events?pillId=p2' })).json()).toEqual([
      expect.objectContaining({ pillId: 'p2', message: 'p2 is warm' }),
    ]);
    expect((await app.inject({ url: '/api/alerts/events' })).json()).toHaveLength(2);
    const payload = { name: 'Nearly done', kind: 'velocity_slow', threshold: 2 };
    const made = await app.inject({ method: 'POST', url: '/api/alerts/rules', payload, headers: owner });
    expect(made.json()).toMatchObject({ kind: 'velocity_slow', threshold: 2, hours: 48, channelIds: 'all' });
  });

  it('lists the alerts waiting to be acknowledged, lets the owner acknowledge them, and does when their brew ends', async () => {
    const { app, pills, store } = await setup();
    pills.handleAdvert({
      address: '08:B6:1F:00:00:66',
      rssi: -40,
      manufacturer: new Map([[RAPT_COMPANY_ID, Buffer.from(CAPTURED.metricsFalling, 'hex')]]),
      at: Date.now(),
      mono: 0,
      cached: false,
    });
    const id = (await app.inject({ method: 'POST', url: '/api/pills', headers: owner, payload: { address: '08:B6:1F:00:00:66' } })).json()
      .id as string;
    const brewId = (await app.inject({ method: 'POST', url: '/api/brews', headers: owner, payload: { pillId: id, name: 'Stout' } })).json()
      .id as string;
    const add = (ruleName: string, brew: string | null, at = Date.now()) =>
      store.addAlertEvent({ ruleId: 'r1', ruleName, pillId: id, at, kind: 'fired', message: '', value: null, brewId: brew });
    const a = add('Too warm', brewId);
    // From before the brew.
    const b = add('Battery low', null, Date.now() - 3_600_000);
    const c = add('Dry hop', brewId);
    const waiting = async () => (await app.inject({ url: '/api/alerts/events?unacked=1' })).json<{ id: number }[]>().map((e) => e.id);
    const ack = (ids: unknown, headers: Record<string, string> = owner) =>
      app.inject({ method: 'POST', url: '/api/alerts/events/ack', payload: { ids }, headers });

    expect(await waiting()).toEqual([c, b, a]);
    expect((await app.inject({ url: '/api/alerts/events' })).json()[0]).toMatchObject({ id: c, ackedAt: null, brewId });
    expect((await ack([a], {})).statusCode).toBe(403);
    expect((await ack([a])).json()).toEqual({ acked: [a] });
    expect((await ack([])).statusCode).toBe(400);
    // Ending the brew acknowledges what went off in it.
    expect((await app.inject({ method: 'POST', url: `/api/brews/${brewId}/end`, headers: owner, payload: {} })).statusCode).toBe(200);
    expect(await waiting()).toEqual([b]);
    expect((await ack('all')).json()).toEqual({ acked: [b] });
    expect(await waiting()).toEqual([]);
  });

  it('lets anyone look but only the owner change things', async () => {
    const { app } = await setup();
    expect((await app.inject({ url: '/api/session' })).json()).toMatchObject({ role: 'viewer', pinSet: false });
    const denied = await app.inject({ method: 'POST', url: '/api/brews', payload: { pillId: 'x', name: 'y' } });
    expect(denied.statusCode).toBe(403);
    expect((await app.inject({ url: '/api/session', headers: owner })).json()).toMatchObject({ role: 'owner', via: 'tailscale' });
  });

  it("doesn't let another website act as the owner through the owner's browser", async () => {
    const { app } = await setup();
    const hub = { ...owner, host: 'rapthooker.example.ts.net' };
    const restart = (headers: Record<string, string>) =>
      app.inject({ method: 'POST', url: '/api/update/check', headers: { ...hub, ...headers } });
    // Another site's page (with or without an Origin header) is refused.
    expect((await restart({ origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await restart({ 'sec-fetch-site': 'cross-site' })).statusCode).toBe(403);
    expect((await restart({ origin: 'null' })).statusCode).toBe(403);
    // The app itself, and scripts that send no Origin, are fine.
    expect((await restart({ origin: 'https://rapthooker.example.ts.net', 'sec-fetch-site': 'same-origin' })).statusCode).not.toBe(403);
    expect((await restart({ origin: 'https://rapthooker.example.ts.net' })).statusCode).not.toBe(403);
    expect((await restart({})).statusCode).not.toBe(403);
    // Reading is left alone; opening the live socket from another site isn't.
    expect((await app.inject({ url: '/api/pills', headers: { ...hub, origin: 'https://evil.example' } })).statusCode).toBe(200);
    const ws = await app.inject({
      url: '/api/live',
      headers: { ...hub, origin: 'https://evil.example', upgrade: 'websocket', connection: 'Upgrade' },
    });
    expect(ws.statusCode).toBe(403);
  });

  it('signs in with a PIN created on first visit', async () => {
    const { app } = await setup();
    const created = await app.inject({ method: 'POST', url: '/api/owner-pin', payload: { pin: '2468' } });
    expect(created.statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/owner-pin', payload: { pin: '1111' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/login', payload: { pin: '0000' } })).statusCode).toBe(401);
    const login = await app.inject({ method: 'POST', url: '/api/login', payload: { pin: '2468' } });
    const cookie = login.cookies.find((c) => c.name === 'rapthooker_pin')!;
    const session = await app.inject({ url: '/api/session', cookies: { rapthooker_pin: cookie.value } });
    expect(session.json()).toMatchObject({ role: 'owner', via: 'pin' });
  });

  it('adds a nearby pill, records it, runs a brew and exports CSV', async () => {
    const { app, pills } = await setup();
    pills.handleAdvert({
      address: '08:B6:1F:00:00:66',
      rssi: -40,
      manufacturer: new Map([[RAPT_COMPANY_ID, Buffer.from(CAPTURED.metricsFalling, 'hex')]]),
      at: Date.now(),
      mono: 0,
      cached: false,
    });
    const state = (await app.inject({ url: '/api/state' })).json();
    expect(state.nearby).toHaveLength(1);

    const added = await app.inject({
      method: 'POST',
      url: '/api/pills',
      headers: owner,
      payload: { address: '08:B6:1F:00:00:66', name: 'Stout' },
    });
    expect(added.statusCode).toBe(200);
    const id = added.json().id as string;
    expect(added.json().live.latest.gravity).toBeCloseTo(1.0546, 4);

    const brew = await app.inject({
      method: 'POST',
      url: '/api/brews',
      headers: owner,
      payload: { pillId: id, name: 'Oatmeal Stout', og: 1.06 },
    });
    expect(brew.statusCode).toBe(200);
    expect(
      (await app.inject({ method: 'POST', url: '/api/brews', headers: owner, payload: { pillId: id, name: 'Again' } })).statusCode,
    ).toBe(409);
    expect((await app.inject({ method: 'PATCH', url: `/api/pills/${id}`, headers: owner, payload: { archived: true } })).statusCode).toBe(
      409,
    );

    const history = await app.inject({ url: `/api/pills/${id}/history?from=0&to=${Date.now() + 1000}` });
    expect(history.json().gravity).toHaveLength(1);

    const csv = await app.inject({ url: `/api/pills/${id}/export.csv` });
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body.split('\n')[1]).toMatch(/,1\.0546\d,/);
    expect((await app.inject({ url: `/api/brews/${brew.json().id}/export.csv` })).body).toMatch(/^timestamp,/);

    const ended = await app.inject({ method: 'POST', url: `/api/brews/${brew.json().id}/end`, headers: owner, payload: {} });
    expect(ended.json().endedAt).toBeTypeOf('number');
  });

  it("lets the owner leave ranges out of a pill's charts and put them back", async () => {
    const { app } = await setup();
    const id = (await app.inject({ method: 'POST', url: '/api/pills', headers: owner, payload: { address: '08:B6:1F:00:00:66' } })).json()
      .id as string;
    const url = `/api/pills/${id}/exclusions`;
    const range = { from: Date.UTC(2026, 9, 1, 12), to: Date.UTC(2026, 9, 1, 13) };
    expect((await app.inject({ method: 'POST', url, payload: range })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url, headers: owner, payload: { from: range.to, to: range.from } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/pills/nope/exclusions', headers: owner, payload: range })).statusCode).toBe(404);

    const added = await app.inject({ method: 'POST', url, headers: owner, payload: range });
    expect(added.statusCode).toBe(200);
    const [exclusion] = added.json().exclusions as { id: string; from: number; to: number }[];
    expect(exclusion).toMatchObject(range);
    expect((await app.inject({ url: '/api/pills' })).json()[0].exclusions).toHaveLength(1);
    const history = `/api/pills/${id}/history?from=${range.from - 3_600_000}&to=${range.to + 3_600_000}`;
    expect((await app.inject({ url: `${history}&exclude=1` })).statusCode).toBe(200);
    expect((await app.inject({ url: `${history}&exclude=yes` })).statusCode).toBe(400);

    expect((await app.inject({ method: 'DELETE', url: `${url}/${exclusion!.id}` })).statusCode).toBe(403);
    const removed = await app.inject({ method: 'DELETE', url: `${url}/${exclusion!.id}`, headers: owner });
    expect(removed.json().exclusions).toEqual([]);
    expect((await app.inject({ method: 'DELETE', url: `${url}/${exclusion!.id}`, headers: owner })).statusCode).toBe(404);
  });

  it("won't switch on a webhook with unfilled placeholders, and hides secrets from viewers", async () => {
    const { app } = await setup();
    const hook = {
      name: 'BF',
      preset: 'brewfather',
      url: 'https://log.brewfather.net/stream?id=<LOGGING_ID>',
      body: '{"name": "{{name}}"}',
    };
    const bad = await app.inject({ method: 'POST', url: '/api/webhooks', headers: owner, payload: hook });
    expect(bad.statusCode).toBe(400);
    const off = await app.inject({ method: 'POST', url: '/api/webhooks', headers: owner, payload: { ...hook, enabled: false } });
    expect(off.statusCode).toBe(200);
    const good = await app.inject({
      method: 'POST',
      url: '/api/webhooks',
      headers: owner,
      payload: { ...hook, url: 'https://log.brewfather.net/stream?id=secret123' },
    });
    expect(good.statusCode).toBe(200);
    const asViewer = (await app.inject({ url: '/api/webhooks' })).json();
    expect(JSON.stringify(asViewer)).not.toContain('secret123');
    const asOwner = (await app.inject({ url: '/api/webhooks', headers: owner })).json();
    expect(JSON.stringify(asOwner)).toContain('secret123');
  });

  it('keeps settings a newer version saved when saving the hub and backup settings', async () => {
    const { app, store } = await setup();
    // As a newer version (since put back) left them.
    store.setMeta(
      'hub',
      JSON.stringify({
        ...DEFAULT_HUB_SETTINGS,
        units: { ...DEFAULT_HUB_SETTINGS.units, pressure: 'bar' },
        theme: 'dark',
      }),
    );
    store.setMeta(
      'backups',
      JSON.stringify({
        ...DEFAULT_BACKUP_SETTINGS,
        s3: { ...DEFAULT_BACKUP_SETTINGS.s3, storageClass: 'STANDARD_IA' },
        keepMonthly: 6,
      }),
    );
    const hub = { ...DEFAULT_HUB_SETTINGS, name: 'Shed', units: { temperature: 'F', gravity: 'sg' } };
    expect((await app.inject({ method: 'PUT', url: '/api/settings/hub', headers: owner, payload: hub })).statusCode).toBe(200);
    expect(JSON.parse(store.getMeta('hub')!)).toEqual({ ...hub, units: { ...hub.units, pressure: 'bar' }, theme: 'dark' });
    const b = { ...DEFAULT_BACKUP_SETTINGS, usb: true };
    expect((await app.inject({ method: 'PUT', url: '/api/settings/backups', headers: owner, payload: b })).statusCode).toBe(200);
    expect(JSON.parse(store.getMeta('backups')!)).toEqual({ ...b, s3: { ...b.s3, storageClass: 'STANDARD_IA' }, keepMonthly: 6 });
  });

  it('saves the Bluetooth switch, and keeps it when a client from before the switch saves the hub settings', async () => {
    const { app, store } = await setup();
    // Hub settings saved before the switch existed: Bluetooth is on.
    store.setMeta(
      'hub',
      JSON.stringify({ name: 'Shed', units: { gravity: 'sg', temperature: 'C' }, abvFormula: 'standard', updateCheck: true }),
    );
    expect((await app.inject({ url: '/api/settings/hub' })).json()).toMatchObject({ name: 'Shed', bluetooth: true });

    const off = await app.inject({
      method: 'PUT',
      url: '/api/settings/hub',
      headers: owner,
      payload: { ...DEFAULT_HUB_SETTINGS, bluetooth: false },
    });
    expect(off.json()).toMatchObject({ bluetooth: false });

    const { bluetooth: _, ...older } = { ...DEFAULT_HUB_SETTINGS, name: 'Cellar' };
    const res = await app.inject({ method: 'PUT', url: '/api/settings/hub', headers: owner, payload: older });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ...DEFAULT_HUB_SETTINGS, name: 'Cellar', bluetooth: false });
    expect(JSON.parse(store.getMeta('hub')!)).toMatchObject({ name: 'Cellar', bluetooth: false });

    const bad = await app.inject({
      method: 'PUT',
      url: '/api/settings/hub',
      headers: owner,
      payload: { ...DEFAULT_HUB_SETTINGS, bluetooth: 'no' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('saves the decimals readings are shown with, and keeps them when a client from before them saves the hub settings', async () => {
    const { app, store } = await setup();
    // Saved before decimals could be set: shown as they always were.
    store.setMeta(
      'hub',
      JSON.stringify({
        name: 'Shed',
        units: { gravity: 'sg', temperature: 'C' },
        abvFormula: 'standard',
        updateCheck: true,
        bluetooth: true,
      }),
    );
    expect((await app.inject({ url: '/api/settings/hub' })).json()).toMatchObject({
      name: 'Shed',
      decimals: { sg: 4, plato: 1, temperature: 1 },
    });

    const decimals = { sg: 3, plato: 2, temperature: 2 };
    const put = (payload: object) => app.inject({ method: 'PUT', url: '/api/settings/hub', headers: owner, payload });
    expect((await put({ ...DEFAULT_HUB_SETTINGS, name: 'Shed', decimals })).json()).toMatchObject({ decimals });
    const { decimals: _, ...older } = { ...DEFAULT_HUB_SETTINGS, name: 'Cellar' };
    expect((await put(older)).json()).toMatchObject({ name: 'Cellar', decimals });
    expect(JSON.parse(store.getMeta('hub')!)).toMatchObject({ name: 'Cellar', decimals });

    for (const wrong of [{ ...decimals, sg: 2.5 }, { ...decimals, plato: 7 }, { ...decimals, temperature: -1 }, { sg: 3 }])
      expect((await put({ ...DEFAULT_HUB_SETTINGS, decimals: wrong })).statusCode, JSON.stringify(wrong)).toBe(400);

    // As a newer version (since put back) might leave them: what isn't understood shows as usual, and is kept on saving.
    store.setMeta('hub', JSON.stringify({ ...DEFAULT_HUB_SETTINGS, decimals: { sg: 'lots', plato: 2, temperature: 2, volume: 1 } }));
    expect((await app.inject({ url: '/api/settings/hub' })).json()).toMatchObject({ decimals: { sg: 4, plato: 2, temperature: 2 } });
    expect((await put({ ...DEFAULT_HUB_SETTINGS, decimals })).statusCode).toBe(200);
    expect(JSON.parse(store.getMeta('hub')!).decimals).toEqual({ ...decimals, volume: 1 });
  });

  it('lists screens to anyone and leaves setting them up to the owner', async () => {
    const { app } = await setup();
    expect((await app.inject({ url: '/api/screens' })).json()).toEqual([]);
    expect((await app.inject({ url: '/api/screens/wifi' })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/screens/wifi', headers: owner })).json()).toMatchObject({ canSetUp: false, reason: 'off' });
    // Nothing set up since the hub started: null, which the app reads as such.
    const none = await app.inject({ url: '/api/screens/setup', headers: owner });
    expect(none.statusCode).toBe(200);
    expect(none.json()).toBeNull();
    const setupBody = { hotspot: 'Smart weather clock', ssid: 'Brewery', name: 'Kitchen' };
    expect((await app.inject({ method: 'POST', url: '/api/screens/setup', payload: setupBody })).statusCode).toBe(403);
    expect(
      (await app.inject({ method: 'POST', url: '/api/screens/setup', headers: owner, payload: { ...setupBody, name: '' } })).statusCode,
    ).toBe(400);
    expect((await app.inject({ url: '/api/screens/f008d11c1802' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/screens/f008d11c1802/image.jpg' })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'PATCH', url: '/api/screens/f008d11c1802', headers: owner, payload: { name: 'x' } })).statusCode,
    ).toBe(404);
  });

  it("draws a screen's picture with its options and tells it when to come back", async () => {
    const { app, store, screens } = await setup();
    store.db
      .prepare('INSERT INTO screens (id, json, created_at) VALUES (?, ?, ?)')
      .run('f008d11c1802', JSON.stringify({ name: 'Kitchen', token: 'k', interval: 90, look: { theme: 'light' } }), Date.now());
    screens.load();
    const listed = (await app.inject({ url: '/api/screens' })).json();
    expect(listed).toMatchObject([
      { id: 'f008d11c1802', name: 'Kitchen', interval: 90, look: { theme: 'light' }, status: { state: 'unknown' } },
    ]);
    expect(JSON.stringify(listed)).not.toContain('"token"');
    const preview = await app.inject({ url: '/api/screens/f008d11c1802/image.jpg' });
    expect(preview.statusCode).toBe(200);
    expect(preview.headers['content-type']).toBe('image/jpeg');
    expect(preview.headers['x-refresh']).toBe('90');
    expect(screens.get('f008d11c1802')!.status.state).toBe('unknown');
    await app.inject({
      url: '/api/screens/f008d11c1802/image.jpg',
      headers: {
        'x-screen-id': 'f008d11c1802',
        'x-screen-firmware': 'sdpro-240/1.0.0',
        'x-screen-status': 'rssi=-60;up=30;heap=35000;fail=0',
      },
    });
    expect(screens.get('f008d11c1802')!.status).toMatchObject({ state: 'online', rssi: -60, uptime: 30, failures: 0 });
    expect(screens.get('f008d11c1802')!.firmware).toBe('1.0.0');
  });
});
