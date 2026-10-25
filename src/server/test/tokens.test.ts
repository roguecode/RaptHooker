import { afterEach, describe, expect, it } from 'vitest';
import type { ApiToken, ApiTokenCreated, Webhook, WebhookExport } from '@rapthooker/shared';
import { parseConfig } from '../config.js';
import { ClockGuard } from '../clock.js';
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
import { silent, tempStore } from './helpers.js';

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
  return { app, webhooks };
}

const owner = { 'tailscale-user-login': 'me@example.com' };
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('API tokens', () => {
  it('are created, listed and deleted by the owner only', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'POST', url: '/api/tokens', payload: { name: 'Grafana', scope: 'read' } })).statusCode).toBe(403);
    const res = await app.inject({ method: 'POST', url: '/api/tokens', headers: owner, payload: { name: 'Grafana', scope: 'read' } });
    expect(res.statusCode).toBe(200);
    const created = res.json<ApiTokenCreated>();
    expect(created.token).toMatch(/^rh_read_/);
    expect(created.hint).toBe(created.token.slice(-4));

    expect((await app.inject({ url: '/api/tokens' })).statusCode).toBe(403);
    const list = (await app.inject({ url: '/api/tokens', headers: owner })).json<ApiToken[]>();
    expect(list).toEqual([expect.objectContaining({ id: created.id, name: 'Grafana', scope: 'read', lastUsedAt: null })]);
    expect(JSON.stringify(list)).not.toContain(created.token);

    expect(
      (await app.inject({ method: 'POST', url: '/api/tokens', headers: owner, payload: { name: '', scope: 'read' } })).statusCode,
    ).toBe(400);
    expect(
      (await app.inject({ method: 'POST', url: '/api/tokens', headers: owner, payload: { name: 'x', scope: 'admin' } })).statusCode,
    ).toBe(400);

    expect((await app.inject({ method: 'DELETE', url: `/api/tokens/${created.id}`, headers: owner })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/api/tokens/${created.id}`, headers: owner })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/pills', headers: bearer(created.token) })).statusCode).toBe(401);
  });

  it('a read token can read but not change anything, and sees no secrets', async () => {
    const { app } = await setup();
    const { token } = (
      await app.inject({ method: 'POST', url: '/api/tokens', headers: owner, payload: { name: 'Script', scope: 'read' } })
    ).json<ApiTokenCreated>();
    await app.inject({
      method: 'POST',
      url: '/api/webhooks',
      headers: owner,
      payload: { name: 'BF', url: 'https://log.brewfather.net/stream?id=secret123', body: '{}' },
    });

    const pills = await app.inject({ url: '/api/pills', headers: bearer(token) });
    expect(pills.statusCode).toBe(200);
    expect(pills.json()).toEqual([]);
    expect((await app.inject({ url: '/api/session', headers: bearer(token) })).json()).toMatchObject({
      role: 'viewer',
      via: 'token',
      user: 'token:Script',
    });
    const hooks = await app.inject({ url: '/api/webhooks', headers: bearer(token) });
    expect(hooks.statusCode).toBe(200);
    expect(hooks.body).not.toContain('secret123');

    // Even with the owner's headers, a token only reads.
    const denied = await app.inject({
      method: 'POST',
      url: '/api/brews',
      headers: { ...owner, ...bearer(token) },
      payload: { pillId: 'x', name: 'y' },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error).toMatch(/only read/);
    expect((await app.inject({ url: '/api/webhooks/export', headers: bearer(token) })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/tokens', headers: bearer(token) })).statusCode).toBe(403);

    const used = (await app.inject({ url: '/api/tokens', headers: owner })).json<ApiToken[]>();
    expect(used[0]!.lastUsedAt).toBeTypeOf('number');
  });

  it("a relay token can't read, and unknown tokens are refused", async () => {
    const { app } = await setup();
    const { token } = (
      await app.inject({ method: 'POST', url: '/api/tokens', headers: owner, payload: { name: 'Garage ESP32', scope: 'relay' } })
    ).json<ApiTokenCreated>();
    expect(token).toMatch(/^rh_relay_/);
    expect((await app.inject({ url: '/api/pills', headers: bearer(token) })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/state', headers: bearer(token) })).statusCode).toBe(403);
    // Relays may post adverts (the relay endpoint checks the token itself).
    const relay = await app.inject({ method: 'POST', url: '/api/relay', headers: bearer(token), payload: {} });
    expect([401, 403]).not.toContain(relay.statusCode);

    const bad = await app.inject({ url: '/api/pills', headers: bearer('rh_read_nope') });
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error).toMatch(/Unknown or deleted/);
    expect((await app.inject({ url: '/api/pills', headers: bearer('nonsense') })).statusCode).toBe(401);
    // No token at all: an ordinary viewer.
    expect((await app.inject({ url: '/api/pills' })).statusCode).toBe(200);
  });
});

describe('webhook routes', () => {
  const hook = { name: 'BF', url: 'https://log.brewfather.net/stream?id=secret123', body: '{"g": {{gravity}}}' };

  it('pause, resume and duplicate', async () => {
    const { app } = await setup();
    const created = (await app.inject({ method: 'POST', url: '/api/webhooks', headers: owner, payload: hook })).json<Webhook>();
    const until = Date.now() + 3_600_000;
    const pause = (body: Record<string, unknown>, headers: Record<string, string> = owner) =>
      app.inject({ method: 'POST', url: `/api/webhooks/${created.id}/pause`, headers, payload: body });
    expect((await pause({ until }, {})).statusCode).toBe(403);
    expect((await pause({ until })).json<Webhook>().pausedUntil).toBe(until);
    expect((await pause({ until: null })).json<Webhook>().pausedUntil).toBeNull();
    expect((await pause({ until: 'soon' })).statusCode).toBe(400);

    const copy = await app.inject({ method: 'POST', url: `/api/webhooks/${created.id}/duplicate`, headers: owner });
    expect(copy.json<Webhook>()).toMatchObject({ name: 'BF (copy)', enabled: false, url: hook.url });
    expect((await app.inject({ method: 'POST', url: '/api/webhooks/nope/duplicate', headers: owner })).statusCode).toBe(404);
  });

  it('exports for the owner and imports switched off', async () => {
    const { app } = await setup();
    await app.inject({ method: 'POST', url: '/api/webhooks', headers: owner, payload: { ...hook, pillIds: ['gone'] } });
    expect((await app.inject({ url: '/api/webhooks/export' })).statusCode).toBe(403);
    const res = await app.inject({ url: '/api/webhooks/export', headers: owner });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="rapthooker-webhooks-\d{4}-\d\d-\d\d\.json"$/);
    const file = res.json<WebhookExport>();
    expect(file.webhooks[0]!.url).toContain('secret123');

    expect((await app.inject({ method: 'POST', url: '/api/webhooks/import', payload: file })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/webhooks/import', headers: owner, payload: { webhooks: [] } })).statusCode).toBe(
      400,
    );
    const imported = await app.inject({ method: 'POST', url: '/api/webhooks/import', headers: owner, payload: file });
    expect(imported.statusCode).toBe(200);
    expect(imported.json<Webhook[]>()).toEqual([expect.objectContaining({ name: 'BF', enabled: false, pillIds: 'all', url: hook.url })]);
    expect((await app.inject({ url: '/api/webhooks', headers: owner })).json()).toHaveLength(2);
  });

  it("won't switch on a batch webhook without {{items}}", async () => {
    const { app } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks',
      headers: owner,
      payload: { ...hook, batch: true, batchBody: '{"readings": []}' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('{{items}}');
    const ok = await app.inject({
      method: 'POST',
      url: '/api/webhooks',
      headers: owner,
      payload: { ...hook, batch: true, batchBody: '{"readings": [{{items}}]}' },
    });
    expect(ok.statusCode).toBe(200);
  });
});
