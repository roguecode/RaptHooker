import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PILL_MODEL,
  DEFAULT_WEBHOOK_OPTIONS,
  PRESETS,
  webhookImportSchema,
  type Brew,
  type Pill,
  type Reading,
  type WebhookInput,
} from '@rapthooker/shared';
import { CATCH_UP_PER_MIN, WebhookService, maskWebhook } from '../webhooks.js';
import { AlertService } from '../alerts.js';
import { calibrate } from '../pills.js';
import { silent, tempStore } from './helpers.js';

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

const pill: Pill = {
  id: 'p1',
  kind: 'pill',
  address: '08:B6:1F:00:00:66',
  raptId: '08:B6:1F:00:00:64',
  name: 'Kveik',
  color: '#a78bfa',
  createdAt: 0,
  archived: false,
  offsets: { gravity: 0, temperature: 0 },
  model: DEFAULT_PILL_MODEL,
  order: 0,
  info: { firmware: null, deviceType: null, payloadVersion: 2 },
  live: {
    lastHeardAt: null,
    lastReadingAt: null,
    firstReadingAt: null,
    online: true,
    rssi: -50,
    intervalSec: 120,
    latest: null,
    computedVelocity: null,
    caught: null,
  },
  brew: null,
};

const MIN = 60_000;

function setup(opts: { pills?: Pill[]; hubName?: string } = {}) {
  const t = tempStore();
  cleanup = t.cleanup;
  const list = opts.pills ?? [pill];
  let now = Date.UTC(2026, 9, 1, 12);
  const first: Reading = {
    ts: now,
    gravity: 1.04,
    temperature: 20,
    velocity: -5,
    battery: 90,
    rssi: -50,
    tilt: 40,
    x: 1,
    y: 2,
    z: 3,
    plausible: true,
    pillGravity: 1.04,
    pillVelocity: -5,
  };
  const readings = new Map<string, Reading>(list.map((p) => [p.id, first]));
  let brew: Brew | null = null;
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response('{"result":"OK"}', { status: 200 }));
  const svc = new WebhookService(
    t.store,
    {
      pills: {
        get: (id) => list.find((p) => p.id === id) ?? null,
        activeIds: () => list.map((p) => p.id),
        latest: (id) => readings.get(id) ?? null,
      },
      brews: { activeFor: () => brew },
      clockTrusted: () => true,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => now,
      version: 'test',
      hubName: () => opts.hubName ?? 'RaptHooker',
    },
    silent,
  );
  svc.load();
  return {
    store: t.store,
    svc,
    fetchMock,
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    /** A new reading now, 1 point lower. */
    newReading: (id = 'p1') => {
      const r = readings.get(id)!;
      readings.set(id, { ...r, ts: now, gravity: Math.round((r.gravity! - 0.001) * 1e6) / 1e6 });
    },
    /** A new reading now with these values. */
    setReading: (change: Partial<Reading>, id = 'p1') => readings.set(id, { ...readings.get(id)!, ts: now, ...change }),
    /** Stores a reading (catch-up reads them from the database) and makes it the pill's latest. */
    record: (sg: number, id = 'p1') => {
      const raw = { ts: now, sg, temp: 20, velocity: null, battery: 90, rssi: -50, x: 0, y: 0, z: 1000, flags: 0 };
      t.store.addReading(id, raw);
      readings.set(id, calibrate(raw, { gravity: 0, temperature: 0 }));
    },
    setBrew: (b: Brew | null) => (brew = b),
    run: async () => {
      await svc.tick();
      await svc.idle();
    },
    /** Request bodies sent so far, parsed. */
    bodies: () => fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>),
  };
}

const brewfather = (): WebhookInput => {
  const p = PRESETS.find((x) => x.id === 'brewfather')!;
  return {
    name: 'Brewfather',
    enabled: true,
    preset: p.id,
    url: 'https://log.brewfather.net/stream?id=abc',
    method: p.method,
    headers: [],
    bodyFormat: p.bodyFormat,
    body: p.body,
    intervalMin: 15,
    pillIds: 'all',
    onlyDuringBrew: false,
    onlyNewReadings: true,
    gravityUnit: 'sg',
    temperatureUnit: 'C',
    timeoutSec: 10,
    skipImplausible: true,
    batch: false,
    batchBody: '',
    minChangeGravity: null,
    minChangeTemp: null,
    maxSilenceMin: null,
    pausedUntil: null,
    catchUp: false,
  };
};

const custom = (): WebhookInput => ({
  ...brewfather(),
  name: 'Mine',
  preset: 'custom',
  url: 'https://example.com/hook',
  body: '{"name": "{{name}}", "ts": {{timestamp_ms}}, "sg": {{gravity_sg}}}',
});

describe('webhook scheduler', () => {
  it('sends the latest reading once per interval', async () => {
    const t = setup();
    const hook = t.svc.create(brewfather());
    await t.svc.tick();
    await t.svc.idle();
    expect(t.fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = t.fetchMock.mock.calls[0]!;
    expect(url).toBe('https://log.brewfather.net/stream?id=abc');
    expect(JSON.parse(String(init?.body))).toMatchObject({ name: 'Kveik', gravity: 1.04, temp: 20 });
    expect(new Headers(init?.headers).get('content-type')).toBe('application/json');

    // New readings inside the interval wait for it.
    t.advance(5 * 60_000);
    t.newReading();
    await t.svc.tick();
    await t.svc.idle();
    expect(t.fetchMock).toHaveBeenCalledTimes(1);
    t.advance(10 * 60_000 + 10_000);
    await t.svc.tick();
    await t.svc.idle();
    expect(t.fetchMock).toHaveBeenCalledTimes(2);

    // Nothing new: nothing sent.
    t.advance(20 * 60_000);
    await t.svc.tick();
    await t.svc.idle();
    expect(t.fetchMock).toHaveBeenCalledTimes(2);
    expect(t.svc.get(hook.id)!.status.sent24h).toBe(2);
  });

  it('carries on after a restart without sending again early', async () => {
    const t = setup();
    t.svc.create(brewfather());
    await t.svc.tick();
    await t.svc.idle();
    const again = new WebhookService(
      t.store,
      {
        pills: {
          get: () => pill,
          activeIds: () => ['p1'],
          latest: () => ({
            ts: Date.UTC(2026, 9, 1, 12, 1),
            gravity: 1.03,
            temperature: 20,
            velocity: null,
            battery: 90,
            rssi: -50,
            tilt: 40,
            x: 1,
            y: 2,
            z: 3,
            plausible: true,
            pillGravity: 1.04,
            pillVelocity: null,
          }),
        },
        brews: { activeFor: () => null },
        clockTrusted: () => true,
        fetch: t.fetchMock as unknown as typeof fetch,
        now: () => Date.UTC(2026, 9, 1, 12, 2),
        version: 'test',
      },
      silent,
    );
    again.load();
    await again.tick();
    await again.idle();
    expect(t.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries failures with a backoff', async () => {
    const t = setup();
    t.fetchMock.mockResolvedValueOnce(new Response('nope', { status: 500 }));
    const hook = t.svc.create(brewfather());
    await t.svc.tick();
    await t.svc.idle();
    expect(t.svc.get(hook.id)!.status).toMatchObject({ lastOk: false, lastHttpStatus: 500 });
    t.advance(30_000);
    await t.svc.tick();
    await t.svc.idle();
    expect(t.fetchMock).toHaveBeenCalledTimes(1);
    t.advance(31_000);
    await t.svc.tick();
    await t.svc.idle();
    expect(t.fetchMock).toHaveBeenCalledTimes(2);
    expect(t.svc.get(hook.id)!.status.lastOk).toBe(true);
  });

  it('only sends while a brew runs when asked to, and skips disabled webhooks', async () => {
    const t = setup();
    t.svc.create({ ...brewfather(), onlyDuringBrew: true });
    t.svc.create({ ...brewfather(), enabled: false });
    await t.svc.tick();
    await t.svc.idle();
    expect(t.fetchMock).not.toHaveBeenCalled();
    t.setBrew({
      id: 'b',
      pillId: 'p1',
      name: 'B',
      style: 'APA',
      notes: '',
      og: null,
      targetFg: null,
      startedAt: 0,
      endedAt: null,
      stats: {} as Brew['stats'],
      events: [],
    });
    await t.svc.tick();
    await t.svc.idle();
    expect(t.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('logs deliveries and hides secrets from viewers', async () => {
    const t = setup();
    const hook = t.svc.create({ ...brewfather(), headers: [{ name: 'X-Key', value: 'secret' }] });
    await t.svc.tick();
    await t.svc.idle();
    const log = t.svc.deliveries(hook.id);
    expect(log[0]).toMatchObject({ ok: true, status: 200, responseBody: '{"result":"OK"}' });
    const masked = maskWebhook(t.svc.get(hook.id)!);
    expect(masked.url).not.toContain('abc');
    expect(masked.headers[0]!.value).not.toBe('secret');
    expect(masked.body).toBe('');
  });

  it('reports timeouts and network errors without leaking the URL', async () => {
    const t = setup();
    t.fetchMock.mockRejectedValueOnce(
      Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND x' } }),
    );
    const d = await t.svc.test(brewfather(), null, 'p1');
    expect(d).toMatchObject({ ok: false, error: 'getaddrinfo ENOTFOUND x' });
    t.fetchMock.mockRejectedValueOnce(
      new TypeError('Request cannot be constructed from a URL that includes credentials: https://a:b@x/?key=abc'),
    );
    const hook = t.svc.create({ ...brewfather(), url: 'https://log.brewfather.net/stream?id=abc' });
    await t.svc.idle();
    const status = t.svc.get(hook.id)!.status;
    expect(status.lastError).not.toContain('key=abc');
    expect(maskWebhook(t.svc.get(hook.id)!).status.lastError).toBe('Send failed');
  });
});

describe('webhook options', () => {
  it('gives webhooks saved before the newer options their defaults', async () => {
    const t = setup();
    const { skipImplausible: _a, batch: _b, batchBody: _c, minChangeGravity: _d, minChangeTemp: _e, ...rest } = brewfather();
    const { maxSilenceMin: _f, pausedUntil: _g, catchUp: _h, ...old } = rest;
    t.store.saveWebhook('old', old, 1, 1);
    t.svc.load();
    expect(t.svc.get('old')).toMatchObject({ ...DEFAULT_WEBHOOK_OPTIONS, name: 'Brewfather', enabled: true });
    await t.run();
    expect(t.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('skips readings that look wrong, without counting it as a failure', async () => {
    const t = setup();
    t.setReading({ plausible: false });
    const hook = t.svc.create(brewfather());
    await t.run();
    expect(t.fetchMock).not.toHaveBeenCalled();
    let status = t.svc.get(hook.id)!.status;
    expect(status.pills[0]!.skipped).toMatch(/looks wrong/);
    expect(status).toMatchObject({ lastOk: null, failed24h: 0 });
    expect(t.svc.deliveries(hook.id)).toEqual([]);

    // Someone who wants everything gets it anyway.
    t.svc.create({ ...brewfather(), name: 'Everything', skipImplausible: false });
    await t.run();
    expect(t.fetchMock).toHaveBeenCalledTimes(1);

    t.advance(MIN);
    t.setReading({ plausible: true, gravity: 1.039 });
    await t.run();
    expect(t.fetchMock).toHaveBeenCalledTimes(2);
    status = t.svc.get(hook.id)!.status;
    expect(status.pills[0]!.skipped).toBeNull();
    expect(status.lastOk).toBe(true);
  });

  it('sends every pill in one request in batch mode', async () => {
    const stout: Pill = { ...pill, id: 'p2', name: 'Stout', address: '08:B6:1F:00:00:77' };
    const t = setup({ pills: [pill, stout], hubName: 'Cellar' });
    const input: WebhookInput = {
      ...custom(),
      batch: true,
      body: '{"name": "{{name}}", "sg": {{gravity_sg}}}',
      batchBody: '{"hub": "{{hub_name}}", "count": {{count}}, "readings": [{{items}}]}',
    };
    expect(JSON.parse(t.svc.preview(input, null).body!)).toMatchObject({ count: 2 });
    const text = t.svc.preview({ ...input, bodyFormat: 'text', body: '{{name}}: {{gravity_sg}}', batchBody: 'Readings\n{{items}}' }, null);
    expect(text.body).toBe('Readings\nKveik: 1.04\nStout: 1.04');

    const hook = t.svc.create(input);
    await t.run();
    expect(t.fetchMock).toHaveBeenCalledTimes(1);
    expect(t.bodies()[0]).toEqual({
      hub: 'Cellar',
      count: 2,
      readings: [
        { name: 'Kveik', sg: 1.04 },
        { name: 'Stout', sg: 1.04 },
      ],
    });
    expect(
      t.store
        .webhookStates(hook.id)
        .map((s) => s.pill_id)
        .sort(),
    ).toEqual(['p1', 'p2']);

    // Once per interval, with only the pills that have something new.
    t.advance(5 * MIN);
    t.newReading('p2');
    await t.run();
    expect(t.fetchMock).toHaveBeenCalledTimes(1);
    t.advance(10 * MIN + 10_000);
    await t.run();
    expect(t.fetchMock).toHaveBeenCalledTimes(2);
    expect(t.bodies()[1]).toEqual({ hub: 'Cellar', count: 1, readings: [{ name: 'Stout', sg: 1.039 }] });
    t.advance(20 * MIN);
    await t.run();
    expect(t.fetchMock).toHaveBeenCalledTimes(2);
  });

  it('only sends big enough changes, but at least every maxSilenceMin', async () => {
    const t = setup();
    const hook = t.svc.create({ ...brewfather(), minChangeGravity: 2, minChangeTemp: 1, maxSilenceMin: 120 });
    await t.run();
    expect(t.fetchMock).toHaveBeenCalledTimes(1);
    const step = async (change: Partial<Reading>, ms = 16 * MIN) => {
      t.advance(ms);
      t.setReading(change);
      await t.run();
    };

    await step({ gravity: 1.0395, temperature: 20.4 });
    expect(t.fetchMock).toHaveBeenCalledTimes(1);
    expect(t.svc.get(hook.id)!.status.pills[0]!.skipped).toMatch(/gravity moves 2 points or the temperature 1 °C/);
    await step({ gravity: 1.0385, temperature: 19.5 });
    expect(t.fetchMock).toHaveBeenCalledTimes(1);
    await step({ gravity: 1.0379 });
    expect(t.fetchMock).toHaveBeenCalledTimes(2);
    expect(t.svc.get(hook.id)!.status.pills[0]!.skipped).toBeNull();

    // A big change still waits for the interval.
    await step({ temperature: 22 }, 5 * MIN);
    expect(t.fetchMock).toHaveBeenCalledTimes(2);
    await step({}, 11 * MIN);
    expect(t.fetchMock).toHaveBeenCalledTimes(3);

    // Small changes stay quiet until two hours have gone by without a send.
    for (let i = 0; i < 7; i++) await step({ gravity: 1.0379 - (i % 2) * 0.0001 });
    expect(t.fetchMock).toHaveBeenCalledTimes(3);
    await step({ gravity: 1.0378 });
    expect(t.fetchMock).toHaveBeenCalledTimes(4);
  });

  it('pauses for a while or until resumed', async () => {
    const t = setup();
    const hook = t.svc.create(brewfather());
    await t.run();
    const until = t.now() + 60 * MIN;
    expect(t.svc.pause(hook.id, until).pausedUntil).toBe(until);
    t.advance(20 * MIN);
    t.newReading();
    await t.run();
    expect(t.fetchMock).toHaveBeenCalledTimes(1);
    t.advance(41 * MIN);
    t.newReading();
    await t.run();
    expect(t.fetchMock).toHaveBeenCalledTimes(2);

    t.svc.pause(hook.id, Date.UTC(9999, 0, 1));
    t.advance(20 * MIN);
    t.newReading();
    await t.run();
    expect(t.fetchMock).toHaveBeenCalledTimes(2);
    expect(t.svc.pause(hook.id, null).pausedUntil).toBeNull();
    await t.run();
    expect(t.fetchMock).toHaveBeenCalledTimes(3);
  });

  it('duplicates a webhook, switched off', () => {
    const t = setup();
    const hook = t.svc.create(brewfather());
    const copy = t.svc.duplicate(hook.id);
    expect(copy).toMatchObject({ name: 'Brewfather (copy)', enabled: false, url: hook.url, body: hook.body });
    expect(copy.id).not.toBe(hook.id);
    expect(t.svc.list()).toHaveLength(2);
  });

  it('exports webhooks with their secrets and imports them switched off', () => {
    const t = setup();
    t.svc.create({ ...brewfather(), headers: [{ name: 'X-Key', value: 'secret' }] });
    t.svc.create({ ...brewfather(), name: 'Gone pill', pillIds: ['p9'] });
    t.svc.create({ ...brewfather(), name: 'Mixed', pillIds: ['p1', 'p9'], batch: true, batchBody: '[{{items}}]' });
    const file = JSON.parse(JSON.stringify(t.svc.exportAll())) as unknown;
    expect(file).toMatchObject({ app: 'rapthooker', kind: 'webhooks', version: 1 });
    expect(JSON.stringify(file)).toContain('secret');

    const created = t.svc.importAll(webhookImportSchema.parse(file).webhooks as WebhookInput[]);
    expect(created.map((w) => [w.name, w.enabled, w.pillIds])).toEqual([
      ['Brewfather', false, 'all'],
      ['Gone pill', false, 'all'],
      ['Mixed', false, ['p1']],
    ]);
    expect(created[0]!.headers).toEqual([{ name: 'X-Key', value: 'secret' }]);
    expect(created[2]).toMatchObject({ batch: true, batchBody: '[{{items}}]' });
    expect(t.svc.list()).toHaveLength(6);
  });

  it('catches up after an outage: oldest first, one reading per interval, rate-limited', async () => {
    const t = setup();
    const start = t.now();
    t.record(1.05);
    const hook = t.svc.create({ ...custom(), catchUp: true });
    await t.run();
    expect(t.fetchMock).toHaveBeenCalledTimes(1);

    // Three hours of failures, with a reading every 5 minutes.
    t.fetchMock.mockImplementation(async () => new Response('down', { status: 503 }));
    for (let i = 1; i <= 36; i++) {
      t.advance(5 * MIN);
      t.record(1.05 - i * 0.0002);
      await t.run();
    }
    expect(t.svc.get(hook.id)!.status.lastOk).toBe(false);
    const before = t.fetchMock.mock.calls.length;
    const sent = () =>
      t
        .bodies()
        .slice(before)
        .map((b) => b.ts);
    const windowEnd = (k: number) => start + k * 15 * MIN;
    const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => windowEnd(from + i));

    // Back up: the missed readings go first, at most CATCH_UP_PER_MIN a minute.
    t.fetchMock.mockImplementation(async () => new Response('ok'));
    const { retry_at } = t.store.webhookStates(hook.id)[0]!;
    t.advance(retry_at! - t.now() + 1000);
    await t.run();
    expect(CATCH_UP_PER_MIN).toBe(10);
    expect(sent()).toEqual(range(1, 10));
    t.advance(MIN + 1000);
    await t.run();
    expect(sent()).toEqual(range(1, 11));

    // Then back to normal: the latest reading once the interval is up.
    t.advance(10 * MIN);
    await t.run();
    expect(sent()).toHaveLength(11);
    t.advance(5 * MIN + 10_000);
    await t.run();
    expect(sent()).toEqual([...range(1, 11), start + 180 * MIN]);
    expect(t.svc.get(hook.id)!.status.lastOk).toBe(true);
  });

  it("doesn't replay the time a webhook was switched off", async () => {
    const t = setup();
    const start = t.now();
    t.record(1.05);
    const hook = t.svc.create({ ...custom(), catchUp: true });
    await t.run();
    t.fetchMock.mockImplementation(async () => new Response('down', { status: 503 }));
    for (let i = 1; i <= 12; i++) {
      t.advance(5 * MIN);
      t.record(1.05 - i * 0.0002);
      await t.run();
    }
    t.svc.setEnabled(hook.id, false);
    const before = t.fetchMock.mock.calls.length;
    t.fetchMock.mockImplementation(async () => new Response('ok'));
    t.advance(MIN);
    t.svc.setEnabled(hook.id, true);
    await t.run();
    t.advance(MIN);
    await t.run();
    expect(
      t
        .bodies()
        .slice(before)
        .map((b) => b.ts),
    ).toEqual([start + 60 * MIN]);
  });
});

describe('alerts', () => {
  it('fires once when the temperature goes too high and clears with hysteresis', () => {
    const t = tempStore();
    cleanup = t.cleanup;
    let temperature = 20;
    const sent: string[] = [];
    const alerts = new AlertService(
      t.store,
      {
        pills: {
          get: () => pill,
          activeIds: () => ['p1'],
          latest: () => ({
            ts: Date.now(),
            gravity: 1.04,
            temperature,
            velocity: null,
            battery: 90,
            rssi: -50,
            tilt: 40,
            x: 1,
            y: 2,
            z: 3,
            plausible: true,
            pillGravity: 1.04,
            pillVelocity: null,
          }),
          lastHeardAt: () => Date.now(),
          offsets: () => ({ gravity: 0, temperature: 0 }),
        },
        brews: { activeFor: () => null },
        units: () => ({ temperature: 'C', gravity: 'sg' }),
      },
      { send: async (m) => void sent.push(m.body) },
      silent,
    );
    alerts.load();
    alerts.create({
      name: 'Too warm',
      enabled: true,
      pillIds: 'all',
      kind: 'temp_above',
      threshold: 22,
      hours: 48,
      onlyDuringBrew: false,
      cooldownMin: 0,
      channelIds: 'all',
    });
    temperature = 23;
    alerts.evaluatePill('p1');
    alerts.evaluatePill('p1');
    expect(sent).toEqual(['Kveik is at 23.0 °C, above 22.0 °C']);
    temperature = 21.8;
    alerts.evaluatePill('p1');
    expect(alerts.list()[0]!.active).toEqual(['p1']);
    temperature = 21.4;
    alerts.evaluatePill('p1');
    expect(alerts.list()[0]!.active).toEqual([]);
    expect(alerts.events(10).map((e) => e.kind)).toEqual(['resolved', 'fired']);
  });
});
