import { afterEach, describe, expect, it } from 'vitest';
import type { Pill } from '@rapthooker/shared';
import { ClockGuard } from '../clock.js';
import { PillService, THERMOMETER_SAMPLE_MS, calibrate } from '../pills.js';
import { BrewError, BrewService } from '../brews.js';
import { APPLE_COMPANY_ID, encodeRaptThermometer } from '../ble/rapt.js';
import type { Advert } from '../ble/scanner.js';
import { csvLines } from '../routes/csv.js';
import { CAPTURED, silent, tempStore } from './helpers.js';

const THERMO = 'D0:26:25:B4:48:95';
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
  const events = { pill: 0, nearby: 0, readings: [] as number[] };
  pills.on('pill', () => events.pill++);
  pills.on('nearby', () => events.nearby++);
  pills.on('reading', (_id: string, r: { temperature: number }) => events.readings.push(r.temperature));
  /** The thermometer's beacon (null: only its signal strength, as BlueZ reports it when the data hasn't changed). */
  const beacon = (temp: number | null, extra: Partial<Advert> = {}): Advert => ({
    address: THERMO,
    rssi: -48,
    manufacturer: temp === null ? null : new Map([[APPLE_COMPANY_ID, encodeRaptThermometer(temp)]]),
    at: now,
    mono: now,
    cached: false,
    ...extra,
  });
  return {
    store: t.store,
    pills,
    brews,
    events,
    beacon,
    hear: (temp: number | null, extra: Partial<Advert> = {}) => pills.handleAdvert(beacon(temp, extra)),
    /** Only heard again: what BlueZ's monitor reports for each advert when nothing has changed. */
    heard: () => pills.handleAdvert(beacon(null, { rssi: null })),
    advance: (ms: number) => (now += ms),
    now: () => now,
    sync: () => {
      synced = true;
      clock.check();
    },
    /** The hub starting again: a new service over the same data. */
    restart: () => {
      const again = new PillService(t.store, clock, silent, () => now);
      again.load();
      return again;
    },
  };
}

/** Hears the thermometer every second for `seconds`: this temperature first (if any), then only that it was heard. */
function everySecond(t: ReturnType<typeof setup>, seconds: number, temp: number | null = null) {
  for (let i = 0; i < seconds; i++) {
    t.advance(1000);
    if (i === 0 && temp !== null) t.hear(temp);
    else t.heard();
  }
}

describe('RAPT Thermometer', () => {
  it('is listed nearby with its temperature, and added as a thermometer', () => {
    const t = setup();
    t.hear(15.3);
    expect(t.pills.nearby()).toEqual([
      expect.objectContaining({ address: THERMO, kind: 'thermometer', raptId: THERMO, rssi: -48, info: expect.any(Object) as object }),
    ]);
    expect(t.pills.nearby()[0]!.latest).toMatchObject({ temperature: 15.3, gravity: null, battery: null, tilt: null, x: null });

    const thermometer = t.pills.adopt(THERMO, {});
    expect(thermometer).toMatchObject({ kind: 'thermometer', name: 'RAPT Thermometer 4895', raptId: THERMO });
    expect(t.pills.nearby()).toEqual([]);
    // What it last sent is recorded straight away.
    expect(t.store.countReadings(thermometer.id)).toBe(1);
    expect(t.pills.get(thermometer.id)!.live.latest).toMatchObject({ temperature: 15.3, gravity: null, plausible: true });
  });

  it('records one reading a minute however often it broadcasts, and only says so then', () => {
    const t = setup();
    t.hear(15.3);
    const thermometer = t.pills.adopt(THERMO, {});
    t.events.pill = 0;
    t.events.readings = [];
    // BlueZ passes the data on when it changes; every other second its monitor only says it heard it.
    everySecond(t, 59, 15.4);
    expect(t.store.countReadings(thermometer.id)).toBe(1);
    expect(t.events.pill).toBe(0);
    everySecond(t, 1);
    expect(t.store.countReadings(thermometer.id)).toBe(2);
    expect(t.events.readings).toEqual([15.4]);
    expect(t.events.pill).toBe(1);
    // Still the same temperature a minute later: recorded again from being heard alone.
    everySecond(t, 60);
    expect(t.events.readings).toEqual([15.4, 15.4]);
    expect(t.pills.get(thermometer.id)!.live).toMatchObject({ online: true, intervalSec: 60, rssi: -48 });
    // A change in signal strength (all that active scanning or a relay may pass on) does as well.
    for (let i = 0; i < 60; i++) {
      t.advance(1000);
      t.hear(null, { rssi: -60 });
    }
    expect(t.events.readings).toEqual([15.4, 15.4, 15.4]);
    expect(t.store.latestReadings(thermometer.id, 1)[0]).toMatchObject({ temp: 15.4, rssi: -60 });
    expect(THERMOMETER_SAMPLE_MS).toBe(60_000);
  });

  it("isn't recorded more than once a minute from a relay's late copies, nor set back by them", () => {
    const t = setup();
    t.hear(15.3);
    const start = t.now();
    const thermometer = t.pills.adopt(THERMO, {});
    // It warms 0.1 °C at 30 s. The hub hears it every second; a relay passes on what it heard 9 s earlier.
    const truth = (sec: number) => (sec < 30 ? 15.5 : 15.6);
    for (let sec = 1; sec <= 180; sec++) {
      t.advance(1000);
      if (sec === 1 || truth(sec) !== truth(sec - 1)) t.hear(truth(sec));
      else t.heard();
      if (sec % 10 === 2) t.hear(truth(sec - 9), { at: t.now() - 9000, mono: t.now() - 9000, rssi: -70, source: 'relay:shed' });
    }
    const readings = t.store.latestReadings(thermometer.id, 10).reverse();
    expect(readings.map((r) => r.ts - start)).toEqual([0, 60_000, 120_000, 180_000]);
    expect(readings.map((r) => r.temp)).toEqual([15.3, 15.6, 15.6, 15.6]);
  });

  it("takes BlueZ's cached temperature after a restart, but only records it once the thermometer is heard", () => {
    const t = setup();
    t.hear(15.3);
    const thermometer = t.pills.adopt(THERMO, {});
    t.advance(10 * 60_000);
    const again = t.restart();
    again.handleAdvert(t.beacon(21.5, { cached: true }));
    expect(t.store.countReadings(thermometer.id)).toBe(1);
    t.advance(1000);
    again.handleAdvert(t.beacon(null, { rssi: null }));
    expect(t.store.countReadings(thermometer.id)).toBe(2);
    expect(again.latest(thermometer.id)?.temperature).toBe(21.5);
    // Once it's been heard, what's in the cache doesn't replace what it sends.
    again.handleAdvert(t.beacon(21.6));
    again.handleAdvert(t.beacon(30, { cached: true }));
    t.advance(60_000);
    again.handleAdvert(t.beacon(null, { rssi: null }));
    expect(again.latest(thermometer.id)?.temperature).toBe(21.6);
  });

  it('applies the temperature offset, and stores nothing for what a pill would measure', () => {
    const t = setup();
    t.hear(15.3);
    const thermometer = t.pills.adopt(THERMO, {});
    const updated = t.pills.update(thermometer.id, { offsets: { gravity: 0.002, temperature: -0.3 } });
    expect(updated.live.latest).toMatchObject({ temperature: 15, gravity: null, pillGravity: null, velocity: null });
    const raw = t.store.latestReadings(thermometer.id, 1)[0]!;
    expect(raw).toMatchObject({ temp: 15.3, sg: null, battery: null, x: null, y: null, z: null, velocity: null, flags: 0 });
    expect(calibrate(raw, { gravity: 0.002, temperature: 0 })).toMatchObject({ gravity: null, battery: null, plausible: true });
  });

  it('charts only the temperature and signal, from the readings and from the 15-minute averages', () => {
    const t = setup();
    t.hear(15.3);
    const thermometer = t.pills.adopt(THERMO, {});
    everySecond(t, 120, 16.1);
    const opts = { gapMs: 600_000, offsets: { gravity: 0, temperature: 0 } };
    const h = t.store.history(thermometer.id, t.now() - 3_600_000, t.now(), { ...opts, maxPoints: 500 });
    expect(h.temperature).toEqual([15.3, 16.1, 16.1]);
    expect(h.rssi).toEqual([-48, -48, -48]);
    expect([...h.gravity, ...h.battery, ...h.tilt, ...h.velocity]).toEqual(Array(12).fill(null));
    expect(h.implausible).toEqual([false, false, false]);
    expect(h.pillGravity).toBeUndefined();
    const averaged = t.store.history(thermometer.id, t.now() - 7 * 86_400_000, t.now(), { ...opts, maxPoints: 50 });
    expect(averaged.bucketMs).toBeGreaterThanOrEqual(15 * 60_000);
    expect(averaged.temperature.at(-1)).toBeCloseTo((15.3 + 16.1 + 16.1) / 3, 6);
    expect([averaged.gravity.at(-1), averaged.battery.at(-1), averaged.tilt.at(-1)]).toEqual([null, null, null]);
    expect(averaged.implausible.at(-1)).toBe(false);
  });

  it('exports a CSV with only its own columns', () => {
    const t = setup();
    t.hear(15.3);
    const thermometer = t.pills.adopt(THERMO, {});
    const lines = [...csvLines(t.store, t.pills.get(thermometer.id) as Pill, 0, t.now())];
    expect(lines[0]).toBe('timestamp,unix_ms,temperature_c,temperature_f,rssi_dbm\n');
    expect(lines[1]).toBe(`${new Date(t.now()).toISOString()},${t.now()},15.30,59.54,-48\n`);
  });

  it('stores readings heard before the clock is synced once it is, a minute apart', () => {
    const t = setup({ trusted: false });
    t.hear(15.3);
    const thermometer = t.pills.adopt(THERMO, {});
    everySecond(t, 120, 15.5);
    expect(t.store.countReadings(thermometer.id)).toBe(0);
    expect(t.pills.latest(thermometer.id)?.temperature).toBe(15.5);
    t.sync();
    expect(t.store.countReadings(thermometer.id)).toBe(2);
  });

  it('becomes a thermometer when one added by address turns out to be one', () => {
    const t = setup();
    const added = t.pills.adopt(THERMO, {});
    expect(added).toMatchObject({ kind: 'pill', name: 'RAPT Pill 4893' });
    t.hear(15.3);
    expect(t.pills.get(added.id)).toMatchObject({ kind: 'thermometer', name: 'RAPT Thermometer 4895', raptId: THERMO });
    expect(t.pills.latest(added.id)?.temperature).toBe(15.3);
  });

  it('keeps the name you gave it when it turns out to be a thermometer', () => {
    const t = setup();
    const named = t.pills.adopt(THERMO, { name: 'Fridge' });
    t.hear(15.3);
    expect(t.pills.get(named.id)).toMatchObject({ kind: 'thermometer', name: 'Fridge' });
  });

  it("doesn't take a pill's readings, and has no brews", () => {
    const t = setup();
    t.hear(15.3);
    const thermometer = t.pills.adopt(THERMO, {});
    t.advance(120_000);
    t.pills.handleAdvert({
      address: THERMO,
      rssi: -48,
      manufacturer: new Map([[0x4152, Buffer.from(CAPTURED.metricsFalling, 'hex')]]),
      at: t.now(),
      mono: t.now(),
      cached: false,
    });
    expect(t.pills.get(thermometer.id)?.kind).toBe('thermometer');
    // It was still heard, so its own temperature is recorded, not the pill's reading (20.06 °C, 1.0546).
    expect(t.pills.latest(thermometer.id)).toMatchObject({ temperature: 15.3, gravity: null });
    expect(t.store.latestReadings(thermometer.id, 5).every((r) => r.temp === 15.3)).toBe(true);
    expect(() => t.brews.start(thermometer.id, { name: 'Lager' })).toThrow(BrewError);
    expect(() => t.brews.start(thermometer.id, { name: 'Lager' })).toThrow(/thermometer/);
  });

  it('only tells the browsers about a nearby thermometer when it is found or has a new reading', () => {
    const t = setup();
    t.hear(15.3);
    expect(t.events.nearby).toBe(1);
    everySecond(t, 59, 15.4);
    expect(t.events.nearby).toBe(1);
    everySecond(t, 1);
    expect(t.events.nearby).toBe(2);
    expect(t.pills.nearby()[0]!.latest?.temperature).toBe(15.4);
  });
});
