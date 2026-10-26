import { afterEach, describe, expect, it } from 'vitest';
import type { NearbyPill } from '@rapthooker/shared';
import { parseConfig } from '../config.js';
import { ClockGuard } from '../clock.js';
import { PillService } from '../pills.js';
import { BrewService } from '../brews.js';
import { WebhookService } from '../webhooks.js';
import { AlertService } from '../alerts.js';
import { Maintenance } from '../maintenance.js';
import { buildServer, Settings } from '../server.js';
import { UnavailableScanner, type Scanner } from '../ble/scanner.js';
import { CompositeScanner } from '../ble/composite.js';
import { RelayHub } from '../ble/relays.js';
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

async function setup(opts: { relays?: boolean } = {}) {
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
  const tokens = new TokenService(t.store);
  const scanner: Scanner =
    opts.relays === false ? new UnavailableScanner('test') : new CompositeScanner(new UnavailableScanner('test'), new RelayHub(silent));
  scanner.on('advert', (a) => pills.handleAdvert(a));
  const app = await buildServer({
    config,
    store: t.store,
    pills,
    brews,
    webhooks,
    alerts,
    push,
    maintenance: new Maintenance(t.store, silent, { backupDir: '', backupTime: '03:00', keep: 1, rawRetentionDays: 0 }),
    scanner,
    clock,
    settings,
    mqtt: new MqttService({ pills, brews, settings, version: 't' }, silent),
    channels: new ChannelService(t.store, silent),
    updates: new UpdateService('t', settings, silent),
    system: new SystemService(config, t.store, silent),
    tokens,
    logs: new LogBuffer(),
    version: 't',
    startedAt: Date.now(),
  });
  cleanup = () => {
    void app.close();
    t.cleanup();
  };
  const relayToken = tokens.create('Shed ESP32', 'relay').token;
  const readToken = tokens.create('Grafana', 'read').token;
  return { app, scanner, relayToken, readToken };
}

const ADDR = '08:B6:1F:00:00:66';
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const advert = (data = CAPTURED.metricsFalling, companyId = RAPT_COMPANY_ID) => ({
  address: ADDR,
  rssi: -68,
  manufacturerData: { [companyId]: data },
});
const body = (adverts: unknown[] = [advert()]) => ({ relay: 'shed', adverts });

describe('POST /api/relay', () => {
  it('turns away requests without a relay token', async () => {
    const { app, readToken } = await setup();
    const post = (headers: Record<string, string>) => app.inject({ method: 'POST', url: '/api/relay', headers, payload: body() });
    expect((await post({})).statusCode).toBe(401);
    expect((await post(auth('rh_relay_madeup'))).statusCode).toBe(401);
    // A read token is refused too (by the hub's token check, which may answer first with 403).
    expect([401, 403]).toContain((await post(auth(readToken))).statusCode);
    expect((await post({ authorization: 'Basic c2hlZDpwYXNz' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/state' })).json<{ nearby: NearbyPill[] }>().nearby).toEqual([]);
  });

  it('feeds adverts into the pipeline and lists the relay', async () => {
    const { app, scanner, relayToken } = await setup();
    const res = await app.inject({
      method: 'POST',
      url: '/api/relay',
      headers: auth(relayToken),
      payload: body([advert(), advert('1005031c0e5b2a', 0x004c), { address: ADDR.toLowerCase(), manufacturerData: {} }]),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accepted: 2, ignored: 1 });

    const state = (await app.inject({ url: '/api/state' })).json<{ nearby: NearbyPill[] }>();
    expect(state.nearby).toHaveLength(1);
    expect(state.nearby[0]).toMatchObject({ address: ADDR, rssi: -68 });
    expect(state.nearby[0]!.latest?.gravity).toBeCloseTo(1.0546, 4);
    expect(scanner.status.relays).toEqual([expect.objectContaining({ name: 'shed', adverts: 2 })]);
    expect(scanner.status.lastAdvertAt).toBeTypeOf('number');
  });

  it('passes on a RAPT Thermometer heard by a relay', async () => {
    const { app, relayToken } = await setup();
    const thermometer = { address: 'D0:26:25:B4:48:95', rssi: -50, manufacturerData: { [0x004c]: CAPTURED.thermometerRest } };
    const res = await app.inject({ method: 'POST', url: '/api/relay', headers: auth(relayToken), payload: body([thermometer]) });
    expect(res.json()).toEqual({ accepted: 1, ignored: 0 });
    const state = (await app.inject({ url: '/api/state' })).json<{ nearby: NearbyPill[] }>();
    expect(state.nearby).toEqual([
      expect.objectContaining({ address: 'D0:26:25:B4:48:95', kind: 'thermometer', raptId: 'D0:26:25:B4:48:95', rssi: -50 }),
    ]);
    expect(state.nearby[0]!.latest).toMatchObject({ temperature: 15.3, gravity: null, battery: null });
  });

  it('back-dates adverts the relay heard a while ago', async () => {
    const { app, scanner, relayToken } = await setup();
    const heard: number[] = [];
    scanner.on('advert', (a) => heard.push(a.at));
    const before = Date.now();
    await app.inject({ method: 'POST', url: '/api/relay', headers: auth(relayToken), payload: body([{ ...advert(), ageMs: 4000 }]) });
    expect(heard[0]).toBeLessThanOrEqual(Date.now() - 4000);
    expect(heard[0]).toBeGreaterThanOrEqual(before - 4000);
  });

  it('rejects bad, oversized and too frequent posts', async () => {
    const { app, relayToken } = await setup();
    const post = (payload: unknown) =>
      app.inject({ method: 'POST', url: '/api/relay', headers: auth(relayToken), payload: payload as object });
    expect((await post(body([]))).statusCode).toBe(400);
    expect((await post(body([{ ...advert(), address: 'not-an-address' }]))).statusCode).toBe(400);
    expect((await post(body([advert('5054xyz')]))).statusCode).toBe(400);
    expect((await post(body(Array.from({ length: 51 }, () => advert())))).statusCode).toBe(400);
    const huge = await app.inject({
      method: 'POST',
      url: '/api/relay',
      headers: { ...auth(relayToken), 'content-type': 'application/json' },
      payload: JSON.stringify({ relay: 'shed', adverts: [advert()], padding: 'x'.repeat(40_000) }),
    });
    expect(huge.statusCode).toBe(413);

    const fifty = body(Array.from({ length: 50 }, () => advert()));
    const codes: number[] = [];
    for (let i = 0; i < 13; i++) codes.push((await post(fifty)).statusCode);
    expect(codes.slice(0, 12).every((c) => c === 200)).toBe(true);
    expect(codes[12]).toBe(429);
  });

  it("says so when the hub doesn't take relays", async () => {
    const { app, relayToken } = await setup({ relays: false });
    const res = await app.inject({ method: 'POST', url: '/api/relay', headers: auth(relayToken), payload: body() });
    expect(res.statusCode).toBe(503);
  });
});
