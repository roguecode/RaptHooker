import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../config.js';
import { ClockGuard } from '../clock.js';
import { PillService } from '../pills.js';
import { BrewService } from '../brews.js';
import { WebhookService } from '../webhooks.js';
import { AlertService } from '../alerts.js';
import { Maintenance } from '../maintenance.js';
import { buildServer, Settings } from '../server.js';
import { UnavailableScanner } from '../ble/scanner.js';
import { RAPT_COMPANY_ID } from '../ble/rapt.js';
import type { PushService } from '../push.js';
import { MqttService } from '../mqtt.js';
import { ChannelService } from '../channels.js';
import { UpdateService } from '../updates.js';
import { SystemService } from '../system.js';
import { TokenService } from '../tokens.js';
import { LogBuffer } from '../logbuffer.js';
import { CAPTURED, silent, tempStore } from './helpers.js';

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
    logs: new LogBuffer(),
    version: 't',
    startedAt: Date.now(),
  });
  cleanup = () => {
    void app.close();
    t.cleanup();
  };
  return { app, pills, store: t.store };
}

const owner = { 'tailscale-user-login': 'me@example.com' };

describe('API', () => {
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
});
