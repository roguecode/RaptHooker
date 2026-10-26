import { afterEach, describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { ClockGuard } from '../clock.js';
import { PillService } from '../pills.js';
import { BrewService } from '../brews.js';
import { RAPT_COMPANY_ID, KEG_COMPANY_ID, encodeRaptV2 } from '../ble/rapt.js';
import type { Advert } from '../ble/scanner.js';
import { ROLLUP_MS, type Store } from '../db.js';
import { CAPTURED, silent, tempStore } from './helpers.js';

const ADDR = '08:B6:1F:00:00:66';
let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

function setup(opts: { trusted?: boolean } = {}) {
  const t = tempStore();
  cleanup = t.cleanup;
  let now = Date.UTC(2026, 9, 1, 12);
  let synced = opts.trusted ?? true;
  const clock = new ClockGuard({ syncFile: '/sync', maxWaitMs: 600_000, exists: () => synced, now: () => now, mono: () => now });
  const pills = new PillService(t.store, clock, silent, () => now);
  pills.load();
  const brews = new BrewService(t.store, pills, silent, () => now);
  pills.brewOf = (id) => brews.activeFor(id);
  pills.on('reading', (id: string, r) => brews.onReading(id, r));
  const advert = (payload: string | Buffer, companyId = RAPT_COMPANY_ID, extra: Partial<Advert> = {}): Advert => ({
    address: ADDR,
    rssi: -50,
    manufacturer: new Map([[companyId, typeof payload === 'string' ? Buffer.from(payload, 'hex') : payload]]),
    at: now,
    mono: now,
    cached: false,
    ...extra,
  });
  return {
    store: t.store,
    pills,
    brews,
    clock,
    advert,
    advance: (ms: number) => (now += ms),
    now: () => now,
    sync: () => {
      synced = true;
      clock.check();
    },
  };
}

const count = (store: Store) => store.countReadings();

describe('pills', () => {
  it('lists unknown pills as nearby until added', () => {
    const t = setup();
    t.pills.handleAdvert(t.advert(CAPTURED.metricsFalling));
    t.pills.handleAdvert(t.advert(CAPTURED.firmware, KEG_COMPANY_ID));
    expect(t.pills.nearby()).toHaveLength(1);
    expect(t.pills.nearby()[0]).toMatchObject({
      address: ADDR,
      raptId: '08:B6:1F:00:00:64',
      info: { firmware: '20250319_055542_b3788ba' },
    });
    expect(count(t.store)).toBe(0);

    const pill = t.pills.adopt(ADDR, { name: 'Pale' });
    expect(pill.info.firmware).toBe('20250319_055542_b3788ba');
    expect(t.pills.nearby()).toHaveLength(0);
    // What it last sent is recorded straight away...
    expect(count(t.store)).toBe(1);
    // ...and isn't stored again when the pill repeats it, or re-sends it before its next reading.
    t.pills.handleAdvert(t.advert(CAPTURED.metricsFalling));
    expect(count(t.store)).toBe(1);
    t.advance(120_000);
    t.pills.handleAdvert(t.advert(CAPTURED.metricsFalling));
    t.pills.handleAdvert(t.advert(CAPTURED.metricsRising));
    expect(count(t.store)).toBe(2);
  });

  it('counts a pill only heard again (BlueZ reporting a repeat) as heard, without announcing it', () => {
    const t = setup();
    t.pills.handleAdvert(t.advert(CAPTURED.metricsFalling));
    const pill = t.pills.adopt(ADDR, {});
    let events = 0;
    let nearby = 0;
    t.pills.on('pill', () => events++);
    t.pills.on('nearby', () => nearby++);
    t.advance(30_000);
    t.pills.handleAdvert(t.advert(CAPTURED.metricsFalling, RAPT_COMPANY_ID, { manufacturer: null, rssi: null }));
    expect(events).toBe(0);
    expect(t.pills.get(pill.id)!.live.lastHeardAt).toBe(t.now());
    expect(count(t.store)).toBe(1);
    // Likewise for one nearby that hasn't been added.
    const other = '08:B6:1F:00:00:76';
    t.pills.handleAdvert(t.advert(CAPTURED.metricsRising, RAPT_COMPANY_ID, { address: other }));
    expect(nearby).toBe(1);
    t.advance(1000);
    t.pills.handleAdvert(t.advert(CAPTURED.metricsRising, RAPT_COMPANY_ID, { address: other, manufacturer: null, rssi: null }));
    expect(nearby).toBe(1);
    expect(t.pills.nearby()[0]).toMatchObject({ address: other, lastHeardAt: t.now() });
  });

  it('records each reading once, however often it is repeated', () => {
    const t = setup();
    t.pills.adopt(ADDR, {});
    const readings: number[] = [];
    t.pills.on('reading', (_id, r) => readings.push(r.ts));
    // A burst: six copies of the new reading.
    for (let i = 0; i < 6; i++) t.pills.handleAdvert(t.advert(CAPTURED.metricsFalling));
    t.advance(120_000);
    // The next burst re-sends the previous reading before the new one.
    t.pills.handleAdvert(t.advert(CAPTURED.metricsFalling));
    t.pills.handleAdvert(t.advert(CAPTURED.metricsRising));
    t.pills.handleAdvert(t.advert(CAPTURED.metricsRising));
    expect(readings).toHaveLength(2);
    expect(count(t.store)).toBe(2);
    expect(t.pills.intervalSec(t.pills.list()[0]!.id)).toBe(120);
  });

  it('remembers the last readings across a restart', () => {
    const t = setup();
    const { id } = t.pills.adopt(ADDR, {});
    t.pills.handleAdvert(t.advert(CAPTURED.metricsFalling));
    const again = new PillService(t.store, t.clock, silent, t.now);
    again.load();
    again.handleAdvert(t.advert(CAPTURED.metricsFalling));
    expect(count(t.store)).toBe(1);
    expect(again.get(id)?.live.latest?.gravity).toBeCloseTo(1.0546, 4);
  });

  it('holds readings until the clock is synced, then stamps them correctly', () => {
    const t = setup({ trusted: false });
    t.pills.adopt(ADDR, {});
    t.pills.handleAdvert({ ...t.advert(CAPTURED.metricsFalling), mono: t.now() });
    expect(count(t.store)).toBe(0);
    expect(t.pills.list()[0]!.live.latest).not.toBeNull();
    t.advance(30_000);
    t.sync();
    expect(count(t.store)).toBe(1);
    expect(t.store.latestReadings(t.pills.list()[0]!.id, 1)[0]!.ts).toBe(t.now() - 30_000);
  });

  it('applies calibration offsets to readings', () => {
    const t = setup();
    const { id } = t.pills.adopt(ADDR, {});
    t.pills.handleAdvert(t.advert(CAPTURED.metricsFalling));
    t.pills.update(id, { offsets: { gravity: -0.002, temperature: 0.5 } });
    const r = t.pills.latest(id)!;
    expect(r.gravity).toBeCloseTo(1.0526, 4);
    expect(r.temperature).toBeCloseTo(20.56, 2);
  });

  it('stops recording archived pills and forgets removed ones', () => {
    const t = setup();
    const { id } = t.pills.adopt(ADDR, {});
    t.pills.update(id, { archived: true });
    t.pills.handleAdvert(t.advert(CAPTURED.metricsRising));
    expect(count(t.store)).toBe(0);
    t.pills.remove(id);
    expect(t.pills.list()).toHaveLength(0);
  });

  it('leaves a pill as it was when a change is turned down', () => {
    const t = setup();
    const { id } = t.pills.adopt(ADDR, { name: 'Pale' });
    expect(() =>
      t.pills.update(id, { name: 'Renamed', offsets: { gravity: 0.01, temperature: 1 }, model: { gravitySource: 'tilt' } }),
    ).toThrow(/two calibration points/);
    expect(t.pills.get(id)).toMatchObject({ name: 'Pale', offsets: { gravity: 0, temperature: 0 }, model: { gravitySource: 'pill' } });
  });

  it("doesn't move when a pill was last heard back for a relay's late copy", () => {
    const t = setup();
    t.pills.handleAdvert(t.advert(CAPTURED.metricsFalling));
    const { id } = t.pills.adopt(ADDR, {});
    t.advance(1000);
    t.pills.handleAdvert(t.advert(CAPTURED.metricsFalling, RAPT_COMPANY_ID, { manufacturer: null }));
    const heard = t.now();
    // A relay posting a batch: what it heard almost 5 minutes ago.
    const late = { at: heard - 290_000, mono: heard - 290_000, source: 'relay:shed' };
    t.pills.handleAdvert(t.advert(CAPTURED.metricsFalling, RAPT_COMPANY_ID, late));
    expect(t.pills.get(id)!.live.lastHeardAt).toBe(heard);
  });

  it('dates when a pill was last heard by the clock once it is set', () => {
    const t = tempStore();
    cleanup = t.cleanup;
    // Booted with the time the Pi last saved; the network sets it 3 hours later a moment after the pill is heard.
    let wall = Date.UTC(2026, 9, 1, 12);
    let mono = 1000;
    let synced = false;
    const clock = new ClockGuard({ syncFile: '/sync', maxWaitMs: 600_000, exists: () => synced, now: () => wall, mono: () => mono });
    const pills = new PillService(t.store, clock, silent, () => wall);
    pills.load();
    const advert = (): Advert => ({
      address: ADDR,
      rssi: -50,
      manufacturer: new Map([[RAPT_COMPANY_ID, Buffer.from(CAPTURED.metricsFalling, 'hex')]]),
      at: wall,
      mono,
      cached: false,
    });
    pills.handleAdvert(advert());
    const { id } = pills.adopt(ADDR, {});
    wall += 30_000;
    mono += 30_000;
    pills.handleAdvert(advert());
    wall += 3 * 3_600_000 + 2000;
    mono += 2000;
    synced = true;
    clock.check();
    expect(pills.get(id)!.live.lastHeardAt).toBe(wall - 2000);
  });
});

describe('history', () => {
  it('breaks the line where readings are missing', () => {
    const t = setup();
    const { id } = t.pills.adopt(ADDR, {});
    const start = t.now();
    const add = (ts: number, sg: number) =>
      t.store.addReading(id, { ts, sg, temp: 20, velocity: null, battery: 90, rssi: -60, x: 0, y: 0, z: 1000, flags: 0 });
    for (let i = 0; i < 10; i++) add(start + i * 120_000, 1.05 - i * 0.001);
    // The hub was off for 2 hours.
    for (let i = 0; i < 5; i++) add(start + 2 * 3_600_000 + i * 120_000, 1.04);
    const h = t.store.history(id, start, start + 3 * 3_600_000, {
      maxPoints: 800,
      gapMs: 10 * 60_000,
      offsets: { gravity: 0, temperature: 0 },
    });
    expect(h.bucketMs).toBe(0);
    expect(h.ts).toHaveLength(16);
    expect(h.gravity[10]).toBeNull();
    expect(h.tilt[0]).toBeCloseTo(0);
  });

  it('averages long ranges from the rollups', () => {
    const t = setup();
    const { id } = t.pills.adopt(ADDR, {});
    const start = Math.floor(t.now() / ROLLUP_MS) * ROLLUP_MS;
    for (let i = 0; i < 30 * 24 * 30; i++) {
      t.store.addReading(id, {
        ts: start + i * 120_000,
        sg: 1.05,
        temp: 18 + (i % 2),
        velocity: -1,
        battery: 80,
        rssi: -70,
        x: 0,
        y: 0,
        z: 1000,
        flags: 0,
      });
    }
    const end = start + 30 * 24 * 30 * 120_000;
    const h = t.store.history(id, start, end, { maxPoints: 500, gapMs: 600_000, offsets: { gravity: 0.001, temperature: 0 } });
    expect(h.bucketMs % ROLLUP_MS).toBe(0);
    expect(h.ts.length).toBeLessThanOrEqual(520);
    expect(h.gravity[3]).toBeCloseTo(1.051, 5);
    expect(h.temperature[3]).toBeCloseTo(18.5, 1);
    expect(h.gravity.every((g) => g !== null)).toBe(true);
  });

  it('uses the 15-minute averages where raw readings have been pruned', () => {
    const t = setup();
    const { id } = t.pills.adopt(ADDR, {});
    const start = Math.floor(t.now() / ROLLUP_MS) * ROLLUP_MS;
    for (let i = 0; i < 60; i++)
      t.store.addReading(id, {
        ts: start + i * 120_000,
        sg: 1.04,
        temp: 20,
        velocity: null,
        battery: 80,
        rssi: -70,
        x: 0,
        y: 0,
        z: 1000,
        flags: 0,
      });
    const end = start + 60 * 120_000;
    t.store.pruneRaw(end);
    const opts = { maxPoints: 800, gapMs: 600_000, offsets: { gravity: 0, temperature: 0 } };
    expect(t.store.history(id, start, end, opts).ts).toHaveLength(0);
    const h = t.store.history(id, start, end, { ...opts, rawFrom: end });
    expect(h.bucketMs).toBe(ROLLUP_MS);
    expect(h.ts.length).toBe(8);
    expect(h.gravity[0]).toBeCloseTo(1.04, 5);
  });
});

describe('brews', () => {
  it('tracks OG, ABV and attenuation as readings arrive', () => {
    const t = setup();
    const { id } = t.pills.adopt(ADDR, {});
    const brew = t.brews.start(id, { name: 'Pale ale' });
    let i = 0;
    const send = (sg: number, temp = 20) => {
      t.advance(120_000);
      t.pills.handleAdvert(t.advert(encodeRaptV2({ sg, temp, velocity: -2, battery: 90, x: i++, y: 0, z: 1000 })));
    };
    for (const sg of [1.05, 1.0501, 1.0499, 1.05, 1.05, 1.0501, 1.04, 1.03, 1.01]) send(sg, sg > 1.04 ? 20 : 22);
    const live = t.brews.activeFor(id)!;
    expect(live.stats.og).toBeCloseTo(1.05, 4);
    expect(live.stats.gravity).toBeCloseTo(1.01, 4);
    expect(live.stats.attenuation).toBeCloseTo(80, 0);
    expect(live.stats.abv).toBeGreaterThan(5);
    expect(live.stats.readings).toBe(9);
    expect(live.stats.tempMax).toBeCloseTo(22, 1);

    const ended = t.brews.end(brew.id);
    expect(ended.endedAt).toBe(t.now());
    expect(t.brews.activeFor(id)).toBeNull();
    expect(t.brews.get(brew.id)!.stats.readings).toBe(9);
    expect(() => t.brews.start(id, { name: 'Next' })).not.toThrow();
    expect(() => t.brews.start(id, { name: 'Two at once' })).toThrow(/already/);
  });

  it('keeps running after a restart', () => {
    const t = setup();
    const { id } = t.pills.adopt(ADDR, {});
    t.brews.start(id, { name: 'Lager', og: 1.048 });
    const again = new BrewService(t.store, t.pills, silent, t.now);
    again.load();
    expect(again.activeFor(id)?.name).toBe('Lager');
    expect(again.activeFor(id)?.stats.og).toBe(1.048);
  });
});

describe('clock guard', () => {
  it('trusts the clock once synced or after waiting long enough', () => {
    let mono = 0;
    const g = new ClockGuard({ syncFile: '/x', maxWaitMs: 1000, exists: () => false, now: () => Date.UTC(2026, 5, 1), mono: () => mono });
    expect(g.trusted).toBe(false);
    mono = 999;
    expect(g.check()).toBe(false);
    mono = 1001;
    expect(g.check()).toBe(true);
  });

  it("doesn't trust a clock from before the app existed", () => {
    const g = new ClockGuard({ syncFile: null, maxWaitMs: 1e9, now: () => Date.UTC(2020, 0, 1), mono: () => performance.now() });
    expect(g.trusted).toBe(false);
  });
});
