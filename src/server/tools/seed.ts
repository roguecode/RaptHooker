/**
 * Development only: adds the simulated devices with a few days of history to the development database. Run with the dev
 * server stopped:  npm run seed  (everything), or name what to add:  npm run seed -- laser
 *
 * - pills: the simulated pills, with an outage, and brews
 * - thermometer: the simulated thermometer, in a brew fridge
 * - laser: the simulated RAPT Laser Level, with a keg before this one and the beer on tap now
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import pino from 'pino';
import { PILL_COLORS, pillIdFromAddress } from '@rapthooker/shared';
import { Store } from '../db.js';
import { ClockGuard } from '../clock.js';
import { PillService, THERMOMETER_SAMPLE_MS, thermometerReading } from '../pills.js';
import { BrewService } from '../brews.js';
import { KegService } from '../kegs.js';
import { APPLE_COMPANY_ID, encodeRaptThermometer, RAPT_COMPANY_ID } from '../ble/rapt.js';
import {
  LASER_CYCLE_MS,
  laserFilledAt,
  MOCK_LASER,
  MOCK_PROFILES,
  MOCK_THERMOMETER,
  cycleAgeDays,
  simulate,
  simulatedLaserAdvert,
  simulatedLaserDistance,
  simulatedLaserTemp,
  simulatedRssi,
  simulatedThermometerTemp,
} from '../ble/mock.js';

const GROUPS = ['pills', 'thermometer', 'laser'] as const;
const asked = process.argv.slice(2);
const unknown = asked.filter((a) => !(GROUPS as readonly string[]).includes(a));
if (unknown.length) {
  console.error(`Unknown: ${unknown.join(', ')}. Name any of: ${GROUPS.join(', ')} (or nothing, for all of them).`);
  process.exit(1);
}
const want = (group: (typeof GROUPS)[number]) => asked.length === 0 || asked.includes(group);

const dataDir = resolve(process.env.RAPTHOOKER_DATA_DIR ?? './data');
mkdirSync(dataDir, { recursive: true });
const store = new Store(join(dataDir, 'rapthooker.db'));
const log = pino({ level: 'warn' });
const pills = new PillService(store, new ClockGuard({ syncFile: null, maxWaitMs: 0 }), log);
pills.load();
const brews = new BrewService(store, pills, log);
brews.load();
const kegs = new KegService(store, pills, log);

const now = Date.now();
const DAY = 86_400_000;
const STEP = 2 * 60_000;

if (want('pills')) {
  const names = ['Hazy IPA', 'Czech Pils', 'Spare pill'];
  const pitched = MOCK_PROFILES.map((p) => now - cycleAgeDays(p, now) * DAY);

  MOCK_PROFILES.forEach((p, i) => {
    const id = pillIdFromAddress(p.address);
    if (!pills.has(id)) pills.adopt(p.address, { name: names[i], color: PILL_COLORS[i] });
    const start = i === 2 ? now - 2 * DAY : pitched[i]! - 2.5 * DAY;
    const outageFrom = now - 1.6 * DAY;
    const outageTo = outageFrom + 3 * 3_600_000;
    let n = 0;
    store.transaction(() => {
      for (let t = start; t < now - STEP; t += STEP + Math.round((Math.random() - 0.5) * 8000)) {
        if (t > outageFrom && t < outageTo) continue;
        store.addReading(id, { ts: t, rssi: simulatedRssi(p), flags: 0, ...simulate(p, t) });
        n++;
      }
    });
    console.log(`${names[i]}: ${n} readings`);
  });

  const [ale, lager] = MOCK_PROFILES.slice(0, 2).map((p) => pillIdFromAddress(p.address)) as [string, string];
  if (!brews.activeFor(ale))
    brews.start(ale, { name: 'Hazy IPA #4', style: 'New England IPA', notes: 'Dry hop on day 3.', targetFg: 1.012 }, pitched[0]! + 600_000);
  if (!brews.activeFor(lager)) {
    const old = brews.start(
      lager,
      { name: 'Munich Helles', style: 'Munich Helles', notes: 'Lagered for 5 weeks.', og: 1.047, targetFg: 1.01 },
      pitched[1]! - 2.4 * DAY,
    );
    brews.end(old.id, pitched[1]! - 0.2 * DAY);
    brews.start(lager, { name: 'Czech Pils', style: 'Czech Premium Pale Lager', targetFg: 1.012 }, pitched[1]! + 600_000);
  }
}

/** Hears a device first (as from BlueZ's cache, so without a reading of its own) so it's added as what it is. */
const hear = (address: string, companyId: number, data: Uint8Array) =>
  pills.handleAdvert({ address, rssi: null, manufacturer: new Map([[companyId, data]]), at: now, mono: performance.now(), cached: true });

if (want('thermometer')) {
  const thermometer = pillIdFromAddress(MOCK_THERMOMETER.address);
  if (!pills.has(thermometer)) {
    hear(MOCK_THERMOMETER.address, APPLE_COMPANY_ID, encodeRaptThermometer(simulatedThermometerTemp(now)));
    pills.adopt(MOCK_THERMOMETER.address, { name: 'Brew fridge', color: PILL_COLORS[3] });
  }
  let readings = 0;
  store.transaction(() => {
    for (let t = now - 3 * DAY; t < now - THERMOMETER_SAMPLE_MS; t += THERMOMETER_SAMPLE_MS) {
      store.addReading(thermometer, thermometerReading(t, simulatedThermometerTemp(t), simulatedRssi(MOCK_THERMOMETER)));
      readings++;
    }
  });
  console.log(`Brew fridge: ${readings} readings`);
}

if (want('laser')) {
  // The keg before this one and this one: it's filled again every 8 days.
  const laser = pillIdFromAddress(MOCK_LASER.address);
  if (!pills.has(laser)) {
    hear(MOCK_LASER.address, RAPT_COMPANY_ID, simulatedLaserAdvert(now));
    pills.adopt(MOCK_LASER.address, { name: 'Kegerator', color: PILL_COLORS[4] });
  }
  const filled = laserFilledAt(now);
  // Up to its own first reading, if it has been recording already.
  const until = pills.get(laser)?.live.firstReadingAt ?? now - THERMOMETER_SAMPLE_MS;
  let readings = 0;
  store.transaction(() => {
    for (let t = filled - LASER_CYCLE_MS; t < until; t += STEP) {
      store.addReading(laser, {
        ts: t,
        sg: null,
        temp: simulatedLaserTemp(t),
        velocity: null,
        battery: MOCK_LASER.battery,
        rssi: simulatedRssi(MOCK_LASER),
        x: null,
        y: null,
        z: null,
        distance: simulatedLaserDistance(t),
        flags: 0,
      });
      readings++;
    }
  });
  if (!kegs.activeFor(laser)) {
    kegs.start(laser, { name: 'Hazy IPA #3', style: 'New England IPA', abv: 6.4, keggedAt: filled - LASER_CYCLE_MS });
    kegs.start(laser, { name: 'Munich Helles', style: 'Munich Helles', abv: 5.1, keggedAt: filled });
  }
  console.log(`Kegerator: ${readings} readings`);
}

store.close();
console.log(`Seeded ${dataDir}`);
