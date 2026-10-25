import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PILL_MODEL, type Pill, type Reading } from '@rapthooker/shared';
import { AlertService } from '../alerts.js';
import { silent, tempStore } from './helpers.js';

let cleanup: (() => void) | undefined;
afterEach(() => cleanup?.());

const pill: Pill = {
  id: 'p1',
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

function setup() {
  const t = tempStore();
  cleanup = t.cleanup;
  let now = Date.UTC(2026, 9, 1, 10);
  let heardAt = now;
  const reading = (): Reading => ({
    ts: heardAt,
    gravity: 1.04,
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
  });
  const sent: string[] = [];
  const make = () =>
    new AlertService(
      t.store,
      {
        pills: {
          get: () => pill,
          activeIds: () => ['p1'],
          latest: reading,
          lastHeardAt: () => heardAt,
          offsets: () => ({ gravity: 0, temperature: 0 }),
        },
        brews: { activeFor: () => null },
        units: () => ({ temperature: 'C', gravity: 'sg' }),
        now: () => now,
      },
      { send: async (m) => void sent.push(m.body) },
      silent,
    );
  const alerts = make();
  alerts.load();
  return {
    alerts,
    make,
    sent,
    at: (minutes: number) => (now = Date.UTC(2026, 9, 1, 10) + minutes * 60_000),
    heard: () => (heardAt = now),
  };
}

describe('alert cooldown', () => {
  it("doesn't announce the end of an alert it kept quiet about, even after a restart", async () => {
    const t = setup();
    t.alerts.create({
      name: 'Quiet pill',
      enabled: true,
      pillIds: 'all',
      kind: 'offline',
      threshold: 30,
      hours: 48,
      onlyDuringBrew: false,
      cooldownMin: 60,
      channelIds: 'all',
    });
    // 10:30 silent past the threshold: announced.
    t.at(31);
    t.alerts.evaluatePill('p1');
    // 10:35 heard again: "back" is announced.
    t.at(35);
    t.heard();
    t.alerts.evaluatePill('p1');
    // 11:10 silent again, inside the cooldown: kept quiet.
    t.at(70);
    t.alerts.evaluatePill('p1');
    await Promise.resolve();
    expect(t.sent).toHaveLength(2);
    // A restart in between must remember that it was kept quiet.
    const again = t.make();
    again.load();
    // 11:15 heard again: nothing to announce.
    t.at(75);
    t.heard();
    again.evaluatePill('p1');
    await Promise.resolve();
    expect(t.sent).toHaveLength(2);
    expect(again.events(10).map((e) => e.kind)).toEqual(['resolved', 'fired']);
    expect(again.list()[0]!.active).toEqual([]);
  });
});
