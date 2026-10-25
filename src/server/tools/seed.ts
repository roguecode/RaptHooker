/**
 * Development only: adds the simulated pills with a few days of history (including an outage), plus brews, to the
 * development database. Run with the dev server stopped:  npm run seed
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pino from 'pino';
import { PILL_COLORS, pillIdFromAddress } from '@rapthooker/shared';
import { Store } from '../db.js';
import { ClockGuard } from '../clock.js';
import { PillService } from '../pills.js';
import { BrewService } from '../brews.js';
import { MOCK_PROFILES, cycleAgeDays, simulate, simulatedRssi } from '../ble/mock.js';

const dataDir = resolve(process.env.RAPTHOOKER_DATA_DIR ?? './data');
mkdirSync(dataDir, { recursive: true });
const store = new Store(join(dataDir, 'rapthooker.db'));
const log = pino({ level: 'warn' });
const pills = new PillService(store, new ClockGuard({ syncFile: null, maxWaitMs: 0 }), log);
pills.load();
const brews = new BrewService(store, pills, log);
brews.load();

const names = ['Hazy IPA', 'Czech Pils', 'Spare pill'];
const now = Date.now();
const DAY = 86_400_000;
const STEP = 2 * 60_000;
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
store.close();
console.log(`Seeded ${dataDir}`);
