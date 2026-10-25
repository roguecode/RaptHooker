import { afterEach, describe, expect, it } from 'vitest';
import type { AbvFormula, Brew, BrewCurve, BrewEvent } from '@rapthooker/shared';
import { parseConfig } from '../config.js';
import { ClockGuard } from '../clock.js';
import { PillService } from '../pills.js';
import { BrewService } from '../brews.js';
import { WebhookService } from '../webhooks.js';
import { AlertService } from '../alerts.js';
import { Maintenance } from '../maintenance.js';
import { buildServer, Settings } from '../server.js';
import { UnavailableScanner } from '../ble/scanner.js';
import { encodeRaptV2, RAPT_COMPANY_ID } from '../ble/rapt.js';
import type { Advert } from '../ble/scanner.js';
import type { PushService } from '../push.js';
import { MqttService } from '../mqtt.js';
import { ChannelService } from '../channels.js';
import { UpdateService } from '../updates.js';
import { SystemService } from '../system.js';
import { TokenService } from '../tokens.js';
import { LogBuffer } from '../logbuffer.js';
import type { Store } from '../db.js';
import { silent, tempStore } from './helpers.js';

const ADDR = '08:B6:1F:00:00:66';
const MIN = 60_000;
const HOUR = 60 * MIN;
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function setup() {
  const t = tempStore();
  cleanups.push(t.cleanup);
  let now = Date.UTC(2026, 9, 1, 12);
  let formula: AbvFormula = 'standard';
  const clock = new ClockGuard({ syncFile: null, maxWaitMs: 0, now: () => now, mono: () => now });
  const pills = new PillService(t.store, clock, silent, () => now);
  pills.load();
  const brews = new BrewService(t.store, pills, silent, () => now);
  brews.abvFormula = () => formula;
  pills.brewOf = (id) => brews.activeFor(id);
  pills.on('reading', (id: string, r) => brews.onReading(id, r));
  pills.on('offsets', (id: string) => brews.refresh(id));
  let x = 0;
  const advert = (sg: number, temp = 20): Advert => ({
    address: ADDR,
    rssi: -50,
    manufacturer: new Map([[RAPT_COMPANY_ID, encodeRaptV2({ sg, temp, velocity: -2, battery: 90, x: x++, y: 0, z: 1000 })]]),
    at: now,
    mono: now,
    cached: false,
  });
  const { id } = pills.adopt(ADDR, {});
  return {
    store: t.store,
    pills,
    brews,
    id,
    /** A reading straight from the pill, `ms` after the last one. */
    send: (sg: number, ms = 10 * MIN, temp = 20) => {
      now += ms;
      pills.handleAdvert(advert(sg, temp));
    },
    advance: (ms: number) => (now += ms),
    now: () => now,
    setFormula: (f: AbvFormula) => (formula = f),
  };
}

/** Stores a reading directly (for long synthetic brews). */
function add(store: Store, pillId: string, ts: number, sg: number, opts: { temp?: number; flags?: number; x?: number; z?: number } = {}) {
  store.addReading(pillId, {
    ts,
    sg,
    temp: opts.temp ?? 20,
    velocity: null,
    battery: 90,
    rssi: -60,
    x: opts.x ?? 0,
    y: 0,
    z: opts.z ?? 1000,
    flags: opts.flags ?? 0,
  });
}

/** A typical ale: 1.050 down to 1.010, halfway after 30 hours. */
const ale = (h: number) => 1.01 + 0.04 / (1 + Math.exp(0.12 * (h - 30)));

describe('automatic OG', () => {
  it('skips the settling hour and implausible readings, and takes the median up to hour 3', () => {
    const t = setup();
    const brew = t.brews.start(t.id, { name: 'Pale' });
    // Settling: reads high while bubbles cling to the pill.
    for (let i = 0; i < 6; i++) t.send(1.058);
    expect(t.brews.activeFor(t.id)!.stats.og).toBeCloseTo(1.058, 4);
    // Settled, with a wild reading and a few from a pill lying on its side.
    for (let i = 0; i < 12; i++) t.send(i === 4 ? 1.07 : i % 5 === 1 ? 0.5 : 1.05);
    for (let i = 0; i < 12; i++) t.send(1.045);
    const live = t.brews.activeFor(t.id)!.stats;
    expect(live.og).toBeCloseTo(1.05, 4);
    expect(live.ogAuto).toBe(true);
    // A full recompute agrees with the live one.
    t.brews.refresh(t.id);
    expect(t.brews.get(brew.id)!.stats.og).toBeCloseTo(1.05, 4);
  });

  it('keeps a manual OG and uses the gravity from a tilt-calibrated pill', () => {
    const t = setup();
    const start = t.now();
    const at = start - 10 * MIN;
    // sg = 1 + (tilt − 20) × 0.0025; tilt 40° gives 1.050 whatever the pill itself says (1.030).
    t.pills.update(t.id, {
      model: {
        gravitySource: 'tilt',
        tiltPoints: [
          { tilt: 20, sg: 1.0, at },
          { tilt: 60, sg: 1.1, at },
        ],
      },
    });
    const forty = { x: Math.round(Math.sin((40 * Math.PI) / 180) * 1000), z: Math.round(Math.cos((40 * Math.PI) / 180) * 1000) };
    for (let i = 1; i <= 24; i++) add(t.store, t.id, start + i * 10 * MIN, 1.03, forty);
    t.advance(5 * HOUR);
    const auto = t.brews.start(t.id, { name: 'Tilted' }, start);
    expect(auto.stats.og).toBeCloseTo(1.05, 3);
    expect(auto.stats.gravity).toBeCloseTo(1.05, 3);
    const manual = t.brews.update(auto.id, { og: 1.062 });
    expect(manual.stats).toMatchObject({ og: 1.062, ogAuto: false });
  });

  it('survives old raw readings being pruned: stats come from the 15-minute averages', () => {
    const t = setup();
    // A 45-day lager, 1.050 down to 1.010, a reading every 15 minutes.
    const start = t.now() - 45 * 24 * HOUR;
    const lager = (h: number) => 1.01 + 0.04 / (1 + Math.exp(0.05 * (h - 200)));
    for (let i = 0; i <= 45 * 24 * 4; i++) {
      const ts = start + i * 15 * MIN;
      add(t.store, t.id, ts, lager((ts - start) / HOUR), { temp: i < 96 ? 9 : 12 });
    }
    const brew = t.brews.start(t.id, { name: 'Lager' }, start);
    const before = t.brews.get(brew.id)!.stats;
    expect(before.og).toBeCloseTo(1.05, 3);
    // Raw readings older than 30 days go; a restart recalculates the running brew.
    t.store.pruneRaw(t.now() - 30 * 24 * HOUR);
    const again = new BrewService(t.store, t.pills, silent, t.now);
    again.load();
    const after = again.get(brew.id)!.stats;
    expect(after.og).toBeCloseTo(before.og!, 3);
    expect(after.abv).toBeCloseTo(before.abv!, 1);
    expect(after.readings).toBeGreaterThan(before.readings * 0.95);
    expect(after.firstReadingAt).toBeLessThanOrEqual(start + 15 * MIN);
    expect(after.tempMin).toBeCloseTo(9, 1);
    // Ending it saves the right numbers.
    const ended = again.end(brew.id);
    expect(ended.stats.og).toBeCloseTo(before.og!, 3);
    expect(ended.stats.gravity).toBeCloseTo(1.01, 3);
  });
});

describe('ABV', () => {
  it('uses the hub formula, live and for finished brews', () => {
    const t = setup();
    const brew = t.brews.start(t.id, { name: 'Barley wine', og: 1.08 });
    const sent: Brew[] = [];
    t.brews.on('brew', (b: Brew) => sent.push(b));
    t.send(1.01);
    expect(t.brews.activeFor(t.id)!.stats.abv).toBeCloseTo(9.19, 2);
    t.setFormula('alternative');
    t.brews.refreshAbv();
    expect(sent.at(-1)!.stats.abv).toBeCloseTo(9.75, 2);
    const ended = t.brews.end(brew.id);
    expect(ended.stats.abv).toBeCloseTo(9.75, 2);
    // Ending saves the final ABV, even before the gravity has settled.
    expect(ended.stats.finalAbv).toBeCloseTo(9.75, 2);
    t.setFormula('standard');
    expect(t.brews.get(brew.id)!.stats.finalAbv).toBeCloseTo(9.19, 2);
  });
});

describe('stable gravity and predictions', () => {
  it('fits the curve while fermenting and calls the final ABV once the gravity settles', () => {
    const t = setup();
    const start = t.now();
    const step = 15 * MIN;
    for (let ts = start + step; ts <= start + 30 * HOUR; ts += step) add(t.store, t.id, ts, ale((ts - start) / HOUR));
    t.advance(30 * HOUR);
    const brew = t.brews.start(t.id, { name: 'Ale', targetFg: 1.012 }, start);
    expect(brew.stats.stable).toBe(false);
    expect(brew.stats.finalAbv).toBeNull();
    expect(brew.stats.prediction).toMatchObject({ stage: 'active' });
    expect(Math.abs(brew.stats.prediction!.fg - 1.01)).toBeLessThan(0.003);
    expect(brew.stats.prediction!.finishAt).toBeGreaterThan(t.now());

    for (let ts = start + 30 * HOUR + step; ts <= start + 120 * HOUR; ts += step) add(t.store, t.id, ts, ale((ts - start) / HOUR));
    t.advance(90 * HOUR);
    t.brews.refresh(t.id);
    const done = t.brews.activeFor(t.id)!.stats;
    expect(done.stable).toBe(true);
    expect(done.prediction).toMatchObject({ stage: 'done', fg: 1.01 });
    expect(done.finalAbv).toBe(done.abv);
    expect(done.og).toBeCloseTo(ale(2), 3);
    expect(done.abv).toBeCloseTo((ale(2) - 1.01) * 131.25, 1);

    const ended = t.brews.end(brew.id);
    expect(ended.stats.prediction?.stage).toBe('done');
    expect(t.brews.get(brew.id)!.stats.stable).toBe(true);
  });

  it('refits a running brew at most every ten minutes', () => {
    const t = setup();
    t.brews.start(t.id, { name: 'Quick' });
    for (let i = 0; i < 80; i++) t.send(1.05, 15 * MIN);
    const fitted = t.brews.activeFor(t.id)!.stats.prediction!;
    expect(fitted.stage).toBe('lag');
    t.send(1.05, MIN);
    expect(t.brews.activeFor(t.id)!.stats.prediction!.fittedAt).toBe(fitted.fittedAt);
  });
});

describe('brew events', () => {
  it('adds, edits and deletes events, and keeps them on the running brew', () => {
    const t = setup();
    const brew = t.brews.start(t.id, { name: 'IPA' });
    t.advance(2 * HOUR);
    const sent: Brew[] = [];
    t.brews.on('brew', (b: Brew) => sent.push(b));
    const hop = t.brews.addEvent(brew.id, { at: t.now() - HOUR, kind: 'dry_hop', text: '50 g Citra' });
    const note = t.brews.addEvent(brew.id, { at: t.now() - 2 * HOUR, kind: 'note', text: 'Pitched US-05' });
    expect(t.brews.activeFor(t.id)!.events.map((e) => e.id)).toEqual([note.id, hop.id]);
    expect(sent.at(-1)!.events).toHaveLength(2);
    expect(t.pills.get(t.id)!.brew!.events).toHaveLength(2);

    t.brews.updateEvent(brew.id, hop.id, { at: hop.at, kind: 'dry_hop', text: '100 g Citra' });
    expect(t.brews.events(brew.id)[1]!.text).toBe('100 g Citra');
    t.brews.deleteEvent(brew.id, note.id);
    expect(t.brews.activeFor(t.id)!.events.map((e) => e.kind)).toEqual(['dry_hop']);

    // Readings keep the events on the live brew.
    t.send(1.05);
    expect(t.brews.activeFor(t.id)!.events).toHaveLength(1);

    expect(() => t.brews.addEvent(brew.id, { at: t.now() + HOUR, kind: 'note', text: 'Soon' })).toThrow(/future/);
    expect(() => t.brews.addEvent(brew.id, { at: t.now() - 5 * 24 * HOUR, kind: 'cold_crash', text: '' })).toThrow(/during/);
    expect(() => t.brews.addEvent(brew.id, { at: t.now(), kind: 'note', text: ' ' })).toThrow(/note/);
    expect(() => t.brews.deleteEvent('nope', hop.id)).toThrow(/Unknown/);
  });

  it('go with their brew, and with a removed pill', () => {
    const t = setup();
    const one = t.brews.start(t.id, { name: 'One' });
    t.brews.addEvent(one.id, { at: t.now(), kind: 'addition', text: 'Yeast nutrient' });
    t.brews.delete(one.id);
    expect(t.store.listBrewEvents(one.id)).toHaveLength(0);

    const two = t.brews.start(t.id, { name: 'Two' });
    const ev = t.brews.addEvent(two.id, { at: t.now(), kind: 'temp_change', text: 'Up to 20 °C' });
    t.pills.remove(t.id);
    expect(t.store.getBrewEvent(ev.id)).toBeNull();
  });
});

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
  brews.abvFormula = () => settings.hub().abvFormula;
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
  cleanups.push(() => {
    void app.close();
    t.cleanup();
  });
  return { app, pills, brews, store: t.store };
}

const owner = { 'tailscale-user-login': 'me@example.com' };

describe('brew API', () => {
  it('manages events, owner only', async () => {
    const { app, pills } = await api();
    const pill = pills.adopt(ADDR, { name: 'Red' });
    const brew = (
      await app.inject({ method: 'POST', url: '/api/brews', headers: owner, payload: { pillId: pill.id, name: 'Saison' } })
    ).json<Brew>();
    const url = `/api/brews/${brew.id}/events`;
    const payload = { at: Date.now() - MIN, kind: 'dry_hop', text: 'Saaz' };
    expect((await app.inject({ method: 'POST', url, payload })).statusCode).toBe(403);
    const added = await app.inject({ method: 'POST', url, headers: owner, payload });
    expect(added.statusCode).toBe(200);
    const event = added.json<BrewEvent>();
    expect(event).toMatchObject({ brewId: brew.id, kind: 'dry_hop', text: 'Saaz' });
    expect((await app.inject({ method: 'POST', url, headers: owner, payload: { ...payload, kind: 'boil' } })).statusCode).toBe(400);

    const put = await app.inject({ method: 'PUT', url: `${url}/${event.id}`, headers: owner, payload: { ...payload, text: 'Saaz, 80 g' } });
    expect(put.json<BrewEvent>().text).toBe('Saaz, 80 g');
    expect((await app.inject({ url })).json<BrewEvent[]>().map((e) => e.text)).toEqual(['Saaz, 80 g']);
    expect((await app.inject({ url: `/api/brews/${brew.id}` })).json<Brew>().events).toHaveLength(1);

    expect((await app.inject({ method: 'DELETE', url: `${url}/${event.id}` })).statusCode).toBe(403);
    expect((await app.inject({ method: 'DELETE', url: `${url}/${event.id}`, headers: owner })).statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `${url}/${event.id}`, headers: owner })).statusCode).toBe(404);
    expect((await app.inject({ url: '/api/brews/nope/events' })).statusCode).toBe(404);
  });

  it('compares brews by time since they started', async () => {
    const { app, pills, store } = await api();
    const red = pills.adopt(ADDR, { name: 'Red' });
    const blue = pills.adopt('08:B6:1F:00:00:6A', { name: 'Blue' });
    const now = Date.now();
    const startA = now - 5 * 24 * HOUR;
    const startB = now - 2 * 24 * HOUR;
    for (let ts = startA; ts <= now; ts += 5 * MIN) add(store, red.id, ts, ale((ts - startA) / HOUR), { temp: 19 });
    for (let ts = startB; ts <= now; ts += 5 * MIN) add(store, blue.id, ts, ale((ts - startB) / HOUR) + 0.005, { temp: 21 });
    add(store, red.id, startA + 30 * HOUR + 1000, 0.3, { flags: 1 });
    const start = async (pillId: string, name: string, startedAt: number) =>
      (await app.inject({ method: 'POST', url: '/api/brews', headers: owner, payload: { pillId, name, startedAt } })).json<Brew>();
    const a = await start(red.id, 'Bitter', startA);
    const b = await start(blue.id, 'Stout', startB);

    const res = await app.inject({ url: `/api/brews/compare?ids=${a.id},${b.id}` });
    expect(res.statusCode).toBe(200);
    const curves = res.json<BrewCurve[]>();
    expect(curves.map((c) => c.name)).toEqual(['Bitter', 'Stout']);
    for (const c of curves) {
      expect(c.hours.length).toBeGreaterThan(50);
      expect(c.hours.length).toBeLessThanOrEqual(400);
      expect(c.gravity).toHaveLength(c.hours.length);
      expect(c.temperature).toHaveLength(c.hours.length);
      expect(c.hours[0]).toBeLessThan(1);
      expect(Math.min(...c.gravity.filter((g): g is number => g !== null))).toBeGreaterThan(1);
    }
    expect(curves[0]!.hours.at(-1)).toBeCloseTo(120, 0);
    expect(curves[1]!.hours.at(-1)).toBeCloseTo(48, 0);
    expect(curves[1]!.temperature.find((v) => v !== null)).toBeCloseTo(21, 1);

    expect((await app.inject({ url: `/api/brews/compare?ids=${a.id},nope` })).statusCode).toBe(404);
    expect((await app.inject({ url: `/api/brews/compare?ids=${'x,'.repeat(9)}` })).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/brews/compare' })).statusCode).toBe(400);
  });
});
