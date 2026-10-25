import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ClockGuard } from '../clock.js';
import { PillService } from '../pills.js';
import { BrewService } from '../brews.js';
import { RAPT_COMPANY_ID, encodeRaptV2 } from '../ble/rapt.js';
import type { Advert } from '../ble/scanner.js';
import { FLAG_IMPLAUSIBLE, MIGRATIONS, ROLLUP_MS, Store } from '../db.js';
import { CAPTURED, silent, tempStore } from './helpers.js';

const ADDR = '08:B6:1F:00:00:66';
let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  vi.useRealTimers();
});

const payload = (sg: number, x = 0, z = 1000) => encodeRaptV2({ sg, temp: 20, velocity: -3, battery: 90, x, y: 0, z });

function setup(opts: { holdMs?: number } = {}) {
  const t = tempStore();
  cleanup = t.cleanup;
  let now = Date.UTC(2026, 9, 1, 12);
  const clock = new ClockGuard({ syncFile: null, maxWaitMs: 0, now: () => now, mono: () => now });
  const pills = new PillService(t.store, clock, silent, () => now, { holdMs: opts.holdMs });
  pills.load();
  const brews = new BrewService(t.store, pills, silent, () => now);
  pills.brewOf = (id) => brews.activeFor(id);
  pills.on('reading', (id: string, r) => brews.onReading(id, r));
  const advert = (data: string | Buffer): Advert => ({
    address: ADDR,
    rssi: -50,
    manufacturer: new Map([[RAPT_COMPANY_ID, typeof data === 'string' ? Buffer.from(data, 'hex') : data]]),
    at: now,
    mono: now,
    cached: false,
  });
  const { id } = pills.adopt(ADDR, {});
  return { store: t.store, pills, brews, id, advert, advance: (ms: number) => (now += ms), now: () => now };
}

describe('implausible readings', () => {
  it('are kept and flagged, but left out of brew stats', () => {
    const t = setup();
    const brew = t.brews.start(t.id, { name: 'Test', og: null });
    t.pills.handleAdvert(t.advert(payload(1.05)));
    t.advance(120_000);
    t.pills.handleAdvert(t.advert(CAPTURED.metricsOutOfLiquid));
    expect(t.store.countReadings()).toBe(2);
    const latest = t.pills.latest(t.id)!;
    expect(latest.plausible).toBe(false);
    expect(t.store.latestReadings(t.id, 1)[0]!.flags & FLAG_IMPLAUSIBLE).toBe(FLAG_IMPLAUSIBLE);
    const stats = t.brews.get(brew.id)!.stats;
    expect(stats.og).toBeCloseTo(1.05, 4);
    const h = t.store.history(t.id, t.now() - 3_600_000, t.now(), {
      maxPoints: 100,
      gapMs: 3_600_000,
      offsets: { gravity: 0, temperature: 0 },
    });
    expect(h.implausible).toEqual([false, true]);
  });

  it('are left out of 15-minute averages unless nothing else is there', () => {
    const t = setup();
    const start = Math.floor(t.now() / ROLLUP_MS) * ROLLUP_MS;
    const add = (ts: number, sg: number) =>
      t.store.addReading(t.id, { ts, sg, temp: 20, velocity: null, battery: 90, rssi: -60, x: 0, y: 0, z: 1000, flags: sg < 0.98 ? 1 : 0 });
    for (let i = 0; i < 7; i++) add(start + i * 120_000, i === 3 ? 0.2 : 1.04);
    for (let i = 0; i < 7; i++) add(start + ROLLUP_MS + i * 120_000, 0.2);
    const h = t.store.history(t.id, start, start + 400 * ROLLUP_MS, {
      maxPoints: 20,
      gapMs: 3_600_000,
      offsets: { gravity: 0, temperature: 0 },
    });
    expect(h.bucketMs).toBeGreaterThanOrEqual(ROLLUP_MS);
    const values = h.gravity.filter((g): g is number => g !== null);
    expect(values[0]).toBeCloseTo(1.04, 4);
  });
});

describe('recovered readings', () => {
  it('back-dates a reading re-sent from a transmission the hub missed', () => {
    vi.useFakeTimers();
    const t = setup({ holdMs: 2500 });
    const times: number[] = [];
    t.pills.on('reading', (_id: string, r: { ts: number }) => times.push(r.ts));
    const start = t.now();
    // Two normal transmissions, two minutes apart: each re-sends the previous reading first.
    t.pills.handleAdvert(t.advert(payload(1.05)));
    vi.advanceTimersByTime(3000);
    t.advance(120_000);
    t.pills.handleAdvert(t.advert(payload(1.05)));
    t.pills.handleAdvert(t.advert(payload(1.049)));
    vi.advanceTimersByTime(3000);
    t.advance(120_000);
    t.pills.handleAdvert(t.advert(payload(1.049)));
    t.pills.handleAdvert(t.advert(payload(1.048)));
    vi.advanceTimersByTime(3000);
    // The hub misses the next one (1.047), then hears its re-send just before 1.046.
    t.advance(240_000);
    t.pills.handleAdvert(t.advert(payload(1.047)));
    t.advance(500);
    t.pills.handleAdvert(t.advert(payload(1.046)));
    vi.advanceTimersByTime(3000);
    expect(times).toHaveLength(5);
    expect(times[3]).toBe(start + 480_500 - 120_000);
    expect(times[4]).toBe(start + 480_500);
    expect(t.pills.intervalSec(t.id)).toBe(120);
  });

  it('keeps the order right when a relay delivers the re-send after the new reading', () => {
    vi.useFakeTimers();
    const t = setup({ holdMs: 2500 });
    const stored: [number, number][] = [];
    t.pills.on('reading', (_id: string, r: { ts: number; gravity: number }) => stored.push([r.ts, r.gravity]));
    for (const sg of [1.05, 1.049, 1.048]) {
      t.pills.handleAdvert(t.advert(payload(sg)));
      vi.advanceTimersByTime(3000);
      t.advance(120_000);
    }
    // Nobody hears 1.047. Next time the hub's own radio hears only the new 1.046...
    t.advance(120_000);
    const heardAt = t.now();
    t.pills.handleAdvert(t.advert(payload(1.046)));
    // ...and a moment later a relay posts what it heard: the re-sent 1.047, from just before.
    t.advance(1500);
    t.pills.handleAdvert({ ...t.advert(payload(1.047)), at: heardAt - 900 });
    vi.advanceTimersByTime(3000);
    const last = stored.slice(-2);
    expect(last.map(([, g]) => Math.round(g * 1000) / 1000)).toEqual([1.047, 1.046]);
    expect(last[0]![0]).toBe(heardAt - 120_000);
    expect(last[1]![0]).toBe(heardAt);
  });

  it('stores a held reading on shutdown', () => {
    vi.useFakeTimers();
    const t = setup({ holdMs: 2500 });
    t.pills.handleAdvert(t.advert(payload(1.05)));
    expect(t.store.countReadings()).toBe(0);
    t.pills.stop();
    expect(t.store.countReadings()).toBe(1);
  });
});

describe("RaptHooker's own values", () => {
  it('works out velocity from the readings when chosen, keeping the pill’s too', () => {
    const t = setup();
    // 10 points a day for a day, every 30 minutes.
    for (let i = 0; i <= 48; i++) {
      t.pills.handleAdvert(t.advert(payload(1.05 - (i * 0.01) / 48)));
      t.advance(1_800_000);
    }
    const pill = t.pills.get(t.id)!;
    expect(pill.live.computedVelocity).toBeCloseTo(-10, 1);
    expect(pill.live.latest!.velocity).toBeCloseTo(-3, 3);
    t.pills.update(t.id, { model: { velocitySource: 'computed' } });
    const r = t.pills.latest(t.id)!;
    expect(r.velocity).toBeCloseTo(-10, 1);
    expect(r.pillVelocity).toBeCloseTo(-3, 3);
  });

  it('works out gravity from the tilt with a calibration fit', () => {
    const t = setup();
    t.pills.handleAdvert(t.advert(payload(1.03, 500, 866)));
    expect(() => t.pills.update(t.id, { model: { gravitySource: 'tilt' } })).toThrow(/two calibration points/);
    t.pills.update(t.id, {
      model: {
        gravitySource: 'tilt',
        tiltPoints: [
          { tilt: 20, sg: 1.0, at: 0 },
          { tilt: 40, sg: 1.08, at: 0 },
        ],
      },
    });
    const r = t.pills.latest(t.id)!;
    // tilt = acos(866/1000) ≈ 30° → halfway.
    expect(r.tilt).toBeCloseTo(30, 0);
    expect(r.gravity).toBeCloseTo(1.04, 3);
    expect(r.pillGravity).toBeCloseTo(1.03, 4);
  });

  it('smooths the gravity when asked', () => {
    const t = setup();
    for (let i = 0; i < 10; i++) {
      t.pills.handleAdvert(t.advert(payload(i % 2 ? 1.05 : 1.04)));
      t.advance(120_000);
    }
    expect(t.pills.latest(t.id)!.gravity).toBeCloseTo(1.05, 4);
    t.pills.update(t.id, { model: { smoothing: 'light' } });
    expect(t.pills.latest(t.id)!.gravity).toBeCloseTo(1.045, 3);
  });

  it('counts readings caught against the learned interval', () => {
    const t = setup();
    for (let i = 0; i < 20; i++) {
      // Every fourth transmission is missed.
      if (i % 4 !== 3) t.pills.handleAdvert(t.advert(payload(1.05 - i * 0.0001)));
      t.advance(120_000);
    }
    const caught = t.pills.get(t.id)!.live.caught!;
    expect(caught.received).toBe(15);
    expect(caught.expected).toBeGreaterThanOrEqual(19);
  });
});

describe('after a power cut', () => {
  it('stamps held readings with the synced time and counts caught readings only since the hub came back', () => {
    const t = tempStore();
    cleanup = t.cleanup;
    const realStart = Date.UTC(2026, 9, 2, 6);
    // Recording happily until the power goes, 8 hours before the hub comes back.
    let wall = realStart - 10 * 3_600_000;
    let mono = 0;
    let synced = true;
    const before = new PillService(
      t.store,
      new ClockGuard({ syncFile: null, maxWaitMs: 0, now: () => wall, mono: () => mono }),
      silent,
      () => wall,
    );
    before.load();
    const { id } = before.adopt(ADDR, {});
    const advert = (sg: number): Advert => ({
      address: ADDR,
      rssi: -50,
      manufacturer: new Map([[RAPT_COMPANY_ID, payload(sg)]]),
      at: wall,
      mono,
      cached: false,
    });
    for (let i = 0; i < 24; i++) {
      before.handleAdvert(advert(1.06 - i * 0.0001));
      wall += 300_000;
    }
    // The Pi boots with the time it last saved (the moment the power went).
    wall = realStart - 8 * 3_600_000;
    mono = 0;
    synced = false;
    const clock = new ClockGuard({ syncFile: '/sync', maxWaitMs: 600_000, exists: () => synced, now: () => wall, mono: () => mono });
    const pills = new PillService(t.store, clock, silent, () => wall);
    pills.load();
    mono = 1000;
    wall += 1000;
    pills.handleAdvert(advert(1.05));
    expect(t.store.countReadings(id, realStart - 8 * 3_600_000)).toBe(0);
    // NTP: the wall clock jumps to the real time; the monotonic clock only moves by the 30 s that passed.
    mono = 30_000;
    wall = realStart + 30_000;
    synced = true;
    clock.check();
    expect(t.store.latestReadings(id, 1)[0]!.ts).toBe(realStart + 1000);

    // Two hours of perfect reception, every 5 minutes.
    for (let i = 1; i <= 24; i++) {
      mono += 300_000;
      wall += 300_000;
      pills.handleAdvert(advert(1.05 - i * 0.0005));
    }
    const caught = pills.get(id)!.live.caught!;
    expect(caught.since).toBe(realStart);
    expect(caught.received).toBe(25);
    expect(caught.expected).toBeLessThanOrEqual(26);
  });
});

describe('database upgrade', () => {
  it('flags implausible readings recorded before flags existed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rapthooker-mig-'));
    cleanup = () => rmSync(dir, { recursive: true, force: true });
    const file = join(dir, 'old.db');
    const db = new DatabaseSync(file);
    db.exec(MIGRATIONS[0]!);
    db.exec('PRAGMA user_version = 1');
    const ins = db.prepare(
      'INSERT INTO readings (pill_id, ts, sg, temp, velocity, battery, rssi, x, y, z) VALUES (?, ?, ?, 20, NULL, 90, -60, 0, 0, 1000)',
    );
    ins.run('p', 1_000, 1.04);
    ins.run('p', 2_000, 0.2);
    db.exec("INSERT INTO rollups VALUES ('p', 0, 2, 1.24, 40, 0, 0, 180, -120, 2, 0, 0, 2000)");
    db.close();
    const store = new Store(file);
    try {
      expect(store.schemaVersion).toBe(MIGRATIONS.length);
      expect(store.latestReadings('p', 2).map((r) => r.flags)).toEqual([1, 0]);
      const rollup = store.db.prepare('SELECT sg, sg_n, sg_all, n FROM rollups').get() as Record<string, number>;
      expect(rollup).toMatchObject({ sg_n: 1, n: 2 });
      expect(rollup.sg).toBeCloseTo(1.04, 6);
      expect(rollup.sg_all).toBeCloseTo(1.24, 6);
    } finally {
      store.close();
    }
  });
});
