import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import { hostname } from 'node:os';
import { Aedes, type AuthenticateError, type Client } from 'aedes';
import { connectAsync, type MqttClient } from 'mqtt';
import Fastify from 'fastify';
import { z } from 'zod';
import { DEFAULT_MQTT_SETTINGS, type MqttSettings, type Reading } from '@rapthooker/shared';
import { ClockGuard } from '../clock.js';
import { PillService } from '../pills.js';
import { BrewService } from '../brews.js';
import { MASKED, Settings } from '../settings.js';
import { MQTT_ENTITIES, MqttService, describeMqttError } from '../mqtt.js';
import { mqttRoutes } from '../routes/mqtt.js';
import type { RouteContext } from '../routes/context.js';
import { RAPT_COMPANY_ID, encodeRaptV2 } from '../ble/rapt.js';
import { silent, tempStore } from './helpers.js';

const ADDR = 'AA:BB:CC:00:00:01';
const CLIENT_ID = 'rapthooker-test-hub';

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polls until `fn` gives something truthy. Generous, so a busy machine (or CI runner) doesn't fail it. */
async function waitFor<T>(fn: () => T | null | undefined | false, ms = 5000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out');
    await sleep(10);
  }
}

async function startBroker(password?: string) {
  const aedes = await Aedes.createBroker(
    password === undefined
      ? {}
      : {
          authenticate: (_client, _username, pass, done) => {
            if (pass?.toString() === password) done(null, true);
            else done(Object.assign(new Error('Bad username or password'), { returnCode: 4 }) as AuthenticateError, null);
          },
        },
  );
  const clients = new Map<string, Client>();
  aedes.on('client', (c) => clients.set(c.id, c));
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    aedes.handle(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        aedes.close(() => server.close(() => resolve()));
      }),
  );
  return { url: `mqtt://127.0.0.1:${port}`, aedes, clients };
}

/** A client that records everything it receives. Retained messages arrive with `retain` set. */
async function watch(url: string, topic = '#') {
  const client: MqttClient = await connectAsync(url, { clientId: `watcher-${Math.random().toString(16).slice(2, 8)}`, reconnectPeriod: 0 });
  cleanups.push(() => client.endAsync(true));
  const seen = new Map<string, { payload: string; retain: boolean }>();
  const log: { topic: string; payload: string }[] = [];
  client.on('message', (t, p, packet) => {
    seen.set(t, { payload: p.toString(), retain: packet.retain });
    log.push({ topic: t, payload: p.toString() });
  });
  await client.subscribeAsync(topic);
  return { client, seen, log, json: (t: string) => JSON.parse(seen.get(t)?.payload || 'null') as Record<string, unknown> | null };
}

function hub(mqtt: Partial<MqttSettings> = {}) {
  const t = tempStore();
  const clock = new ClockGuard({ syncFile: null, maxWaitMs: 0 });
  const pills = new PillService(t.store, clock, silent);
  pills.load();
  const brews = new BrewService(t.store, pills, silent);
  pills.brewOf = (id) => brews.activeFor(id);
  const settings = new Settings(t.store);
  settings.setMqtt({ ...DEFAULT_MQTT_SETTINGS, enabled: true, ...mqtt });
  const service = new MqttService({ pills, brews, settings, version: '1.2.3' }, silent, {
    minRetryMs: 30,
    maxRetryMs: 60,
    authRetryMs: 60,
    birthDelayMs: 0,
    testTimeoutMs: 1500,
    clientId: CLIENT_ID,
  });
  pills.on('reading', (id: string, r: Reading) => {
    brews.onReading(id, r);
    service.onReading(id, r);
  });
  cleanups.push(async () => {
    await service.stop();
    t.cleanup();
  });
  let at = Date.now() - 3_600_000;
  const reading = (sg: number, temp = 19.5) => {
    at += 120_000;
    const payload = encodeRaptV2({ sg, temp, velocity: -2.5, battery: 90, x: 400, y: 0, z: 950 });
    pills.handleAdvert({ address: ADDR, rssi: -61, manufacturer: new Map([[RAPT_COMPANY_ID, payload]]), at, mono: at, cached: false });
  };
  return { pills, brews, settings, mqtt: service, reading };
}

const connected = (h: ReturnType<typeof hub>) => waitFor(() => h.mqtt.status.state === 'connected');

describe('MQTT', () => {
  it('publishes each reading as retained JSON, with the brew', async () => {
    const b = await startBroker();
    const h = hub({ url: b.url });
    await h.mqtt.start();
    await connected(h);
    const pill = h.pills.adopt(ADDR, { name: 'Pale ale' });
    h.reading(1.0465);
    await waitFor(() => h.mqtt.status.lastPublishAt);

    const w = await watch(b.url);
    const state = await waitFor(() => w.seen.get(`rapthooker/${pill.id}/state`));
    expect(state.retain).toBe(true);
    expect(JSON.parse(state.payload)).toMatchObject({
      name: 'Pale ale',
      gravity: 1.0465,
      temperature: 19.5,
      velocity: -2.5,
      battery: 90,
      rssi: -61,
      plausible: true,
      pill_gravity: 1.0465,
      brew_name: null,
      og: null,
    });
    expect(w.seen.get('rapthooker/status')).toEqual({ payload: 'online', retain: true });
    expect(w.seen.get(`rapthooker/${pill.id}/plausible`)?.payload).toBe('true');

    // Starting a brew republishes the latest reading with it.
    h.brews.start(pill.id, { name: 'Summer pale', og: 1.05 }, Date.now() - 6 * 3_600_000);
    await waitFor(() => w.json(`rapthooker/${pill.id}/state`)?.brew_name === 'Summer pale');
    expect(w.json(`rapthooker/${pill.id}/state`)).toMatchObject({ og: 1.05 });
    h.reading(1.0402);
    await waitFor(() => w.json(`rapthooker/${pill.id}/state`)?.gravity === 1.0402);
    expect(w.json(`rapthooker/${pill.id}/state`)).toMatchObject({ brew_name: 'Summer pale', abv: expect.any(Number) as number });
  });

  it('announces pills to Home Assistant, follows renames and removes archived pills', async () => {
    const b = await startBroker();
    const h = hub({ url: b.url });
    await h.mqtt.start();
    await connected(h);
    const pill = h.pills.adopt(ADDR, { name: 'Pale ale' });
    const w = await watch(b.url, 'homeassistant/#');
    const topic = (component: string, object: string) => `homeassistant/${component}/rapthooker_${pill.id}/${object}/config`;

    const gravity = await waitFor(() => w.json(topic('sensor', 'gravity')));
    expect(gravity).toMatchObject({
      name: 'Gravity',
      unique_id: `rapthooker_${pill.id}_gravity`,
      state_topic: `rapthooker/${pill.id}/state`,
      value_template: '{{ value_json.gravity }}',
      availability_topic: 'rapthooker/status',
      state_class: 'measurement',
      suggested_display_precision: 4,
      device: { identifiers: [`rapthooker_${pill.id}`], name: 'Pale ale', manufacturer: 'KegLand', model: 'RAPT Pill' },
      origin: { name: 'RaptHooker', sw_version: '1.2.3' },
    });
    expect(gravity).not.toHaveProperty('device_class');
    expect(w.json(topic('sensor', 'temperature'))).toMatchObject({ device_class: 'temperature', unit_of_measurement: '°C' });
    expect(w.json(topic('sensor', 'signal_strength'))).toMatchObject({
      device_class: 'signal_strength',
      unit_of_measurement: 'dBm',
      entity_category: 'diagnostic',
    });
    expect(w.json(topic('binary_sensor', 'implausible'))).toMatchObject({
      device_class: 'problem',
      state_topic: `rapthooker/${pill.id}/plausible`,
      payload_on: 'false',
      payload_off: 'true',
    });
    const hubTopic = [...w.seen.keys()].find((t) => t.endsWith('/connection/config'))!;
    const hubConfig = w.json(hubTopic) as { device: { identifiers: string[] }; state_topic: string };
    expect(hubConfig.state_topic).toBe('rapthooker/status');
    expect((gravity as { device: { via_device: string } }).device.via_device).toBe(hubConfig.device.identifiers[0]);

    h.pills.update(pill.id, { name: 'Stout' });
    await waitFor(() => (w.json(topic('sensor', 'gravity')) as { device?: { name: string } } | null)?.device?.name === 'Stout');

    h.pills.update(pill.id, { archived: true });
    await waitFor(() => MQTT_ENTITIES.every((e) => w.seen.get(topic(e.component, e.object))?.payload === ''));

    // Home Assistant restarting (its birth message) brings the announcements back.
    h.pills.update(pill.id, { archived: false });
    await waitFor(() => w.json(topic('sensor', 'gravity')));
    w.seen.clear();
    await w.client.publishAsync('homeassistant/status', 'online');
    await waitFor(() => w.json(topic('sensor', 'battery')) && w.json(hubTopic));
  });

  it('removes a pill everywhere, including one removed while disconnected', async () => {
    const b = await startBroker();
    const h = hub({ url: b.url });
    await h.mqtt.start();
    await connected(h);
    const pill = h.pills.adopt(ADDR, { name: 'Pale ale' });
    h.reading(1.05);
    const w = await watch(b.url);
    await waitFor(() => w.seen.get(`rapthooker/${pill.id}/state`));

    h.pills.remove(pill.id);
    await waitFor(() => w.seen.get(`rapthooker/${pill.id}/state`)?.payload === '');
    await waitFor(() =>
      MQTT_ENTITIES.every((e) => w.seen.get(`homeassistant/${e.component}/rapthooker_${pill.id}/${e.object}/config`)?.payload === ''),
    );

    // A config this hub left behind for a pill it no longer has is cleared when it connects.
    await h.mqtt.stop();
    const hubId = `rapthooker_hub_${hostname()
      .replace(/[^A-Za-z0-9_-]/g, '')
      .toLowerCase()}`;
    const stale = 'homeassistant/sensor/rapthooker_0123456789ab/gravity/config';
    await w.client.publishAsync(stale, JSON.stringify({ name: 'Gravity', device: { via_device: hubId } }), { retain: true, qos: 1 });
    const other = 'homeassistant/sensor/rapthooker_ba9876543210/gravity/config';
    await w.client.publishAsync(other, JSON.stringify({ name: 'Gravity', device: { via_device: 'someone_else' } }), {
      retain: true,
      qos: 1,
    });
    await h.mqtt.start();
    await waitFor(() => w.seen.get(stale)?.payload === '');
    await sleep(50);
    expect(w.seen.get(other)?.payload).not.toBe('');

    const fresh = await watch(b.url);
    await waitFor(() => fresh.seen.get('rapthooker/status'));
    await sleep(50);
    expect([...fresh.seen.keys()].filter((t) => t.includes(pill.id) || t === stale)).toEqual([]);
  });

  it('skips implausible readings but still says the pill has fallen over', async () => {
    const b = await startBroker();
    const h = hub({ url: b.url, skipImplausible: true, discovery: false });
    await h.mqtt.start();
    await connected(h);
    const pill = h.pills.adopt(ADDR, { name: 'Pale ale' });
    const w = await watch(b.url);
    h.reading(1.05);
    await waitFor(() => w.json(`rapthooker/${pill.id}/state`)?.gravity === 1.05);
    h.reading(0.2057);
    await waitFor(() => w.seen.get(`rapthooker/${pill.id}/plausible`)?.payload === 'false');
    await sleep(50);
    expect(w.json(`rapthooker/${pill.id}/state`)).toMatchObject({ gravity: 1.05, plausible: true });
    expect([...w.seen.keys()].some((t) => t.startsWith('homeassistant/'))).toBe(false);

    // Saving new settings reconnects and republishes the latest reading.
    h.settings.setMqtt({ ...h.settings.mqtt(), skipImplausible: false });
    await waitFor(() => w.json(`rapthooker/${pill.id}/state`)?.plausible === false);
    expect(w.json(`rapthooker/${pill.id}/state`)).toMatchObject({ gravity: 0.2057 });

    // Switching retain off drops the retained reading instead of leaving a stale one behind.
    h.settings.setMqtt({ ...h.settings.mqtt(), retain: false });
    await waitFor(() => w.seen.get(`rapthooker/${pill.id}/state`)?.payload === '');
    await waitFor(() => w.json(`rapthooker/${pill.id}/state`)?.gravity === 0.2057);
    const fresh = await watch(b.url);
    await waitFor(() => fresh.seen.get('rapthooker/status'));
    await sleep(50);
    expect(fresh.seen.has(`rapthooker/${pill.id}/state`)).toBe(false);
  });

  it('reconnects after losing the broker and publishes again', async () => {
    const b = await startBroker();
    const h = hub({ url: b.url, discovery: false });
    let statePublishes = 0;
    b.aedes.on('publish', (packet, client) => {
      if (client?.id === CLIENT_ID && packet.topic.endsWith('/state')) statePublishes++;
    });
    await h.mqtt.start();
    await connected(h);
    h.pills.adopt(ADDR, { name: 'Pale ale' });
    h.reading(1.05);
    await waitFor(() => statePublishes === 1);
    const w = await watch(b.url, 'rapthooker/status');

    // The error state can last only until the next retry (30 ms here), so record every change rather than poll.
    const states: string[] = [];
    h.mqtt.on('status', (s: { state: string }) => states.push(s.state));
    b.clients.get(CLIENT_ID)!.conn.destroy();
    // The hub can be back (and 'online' again) before a poll sees 'offline', so look through everything received.
    await waitFor(() => w.log.some((m) => m.topic === 'rapthooker/status' && m.payload === 'offline'));
    await waitFor(() => states.includes('error'));
    await waitFor(() => states.lastIndexOf('connected') > states.indexOf('error'));
    await waitFor(() => statePublishes === 2);
    await waitFor(() => w.seen.get('rapthooker/status')?.payload === 'online');

    // Recording doesn't care: a reading while the broker is away is simply not published.
    await h.mqtt.stop();
    expect(() => h.reading(1.049)).not.toThrow();
    expect(h.mqtt.status.state).toBe('off');
  });

  it('explains a wrong password, and tests settings without saving them', async () => {
    const b = await startBroker('secret');
    const h = hub({ url: b.url, username: 'brewer', password: 'wrong' });
    await h.mqtt.start();
    await waitFor(() => h.mqtt.status.state === 'error');
    expect(h.mqtt.status.error).toMatch(/username or password/);

    await expect(h.mqtt.test({ ...h.settings.mqtt() })).rejects.toThrow(/username or password/);
    await expect(h.mqtt.test({ ...h.settings.mqtt(), password: 'secret' })).resolves.toBeUndefined();
    expect(h.mqtt.status.state).toBe('error');

    h.settings.setMqtt({ ...h.settings.mqtt(), password: 'secret' });
    await connected(h);
    expect(h.mqtt.status.error).toBeNull();
  });

  it('gives readable connection errors', () => {
    const url = 'mqtt://broker.example.com:1883';
    expect(describeMqttError(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }), url)).toMatch(
      /Couldn't find broker\.example\.com/,
    );
    expect(describeMqttError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), url)).toMatch(/refused the connection/);
    expect(describeMqttError(Object.assign(new Error('x'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }), url)).toMatch(/TLS certificate/);
    expect(describeMqttError(Object.assign(new Error('Connection refused: Bad User Name or Password'), { code: 134 }), url)).toMatch(
      /username or password/,
    );
    expect(describeMqttError(new Error('connack timeout'), url)).toMatch(/didn't answer/);
  });

  it('serves the settings to the owner, keeps the saved password and tests a connection', async () => {
    const b = await startBroker('secret');
    const h = hub({ url: b.url, username: 'brewer', password: 'secret', enabled: false });
    await h.mqtt.start();
    const app = Fastify();
    app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) =>
      reply.code(err instanceof z.ZodError ? 400 : (err.statusCode ?? 500)).send({ error: err.message }),
    );
    const ctx = {
      app,
      s: { settings: h.settings, mqtt: h.mqtt },
      owner: {
        preHandler: async (
          req: { headers: Record<string, unknown> },
          reply: { code: (n: number) => { send: (b: unknown) => unknown } },
        ) => {
          if (!req.headers['x-owner']) return reply.code(403).send({ error: 'Only the owner' });
        },
      },
    } as unknown as RouteContext;
    mqttRoutes(ctx);
    cleanups.push(() => app.close());
    const owner = { 'x-owner': '1' };

    expect((await app.inject({ url: '/api/settings/mqtt' })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/mqtt/status' })).json()).toMatchObject({ state: 'off' });
    const saved = (await app.inject({ url: '/api/settings/mqtt', headers: owner })).json<MqttSettings>();
    expect(saved.password).toBe(MASKED);

    const tested = await app.inject({ method: 'POST', url: '/api/settings/mqtt/test', headers: owner, payload: saved });
    expect(tested.json()).toEqual({ ok: true, error: null });
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/settings/mqtt/test',
      headers: owner,
      payload: { ...saved, password: 'nope' },
    });
    expect(wrong.json()).toMatchObject({ ok: false, error: expect.stringMatching(/username or password/) as string });

    const bad = await app.inject({ method: 'PUT', url: '/api/settings/mqtt', headers: owner, payload: { ...saved, topic: 'a b' } });
    expect(bad.statusCode).toBe(400);
    const noUrl = await app.inject({
      method: 'PUT',
      url: '/api/settings/mqtt',
      headers: owner,
      payload: { ...saved, enabled: true, url: '' },
    });
    expect(noUrl.statusCode).toBe(400);
    const noUser = await app.inject({
      method: 'POST',
      url: '/api/settings/mqtt/test',
      headers: owner,
      payload: { ...saved, username: '' },
    });
    expect(noUser.json()).toMatchObject({ ok: false, error: expect.stringMatching(/username too/) as string });

    const put = await app.inject({ method: 'PUT', url: '/api/settings/mqtt', headers: owner, payload: { ...saved, enabled: true } });
    expect(put.json()).toMatchObject({ enabled: true, password: MASKED });
    expect(h.settings.mqtt().password).toBe('secret');
    await connected(h);
  });
});
