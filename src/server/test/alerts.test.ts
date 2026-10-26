import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PILL_MODEL, type AlertRuleInput, type Pill, type Reading } from '@rapthooker/shared';
import { AlertService } from '../alerts.js';
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

function setup(over: Partial<Reading> = {}, opts: { pill?: Pill } = {}) {
  const t = tempStore();
  cleanup = t.cleanup;
  let now = Date.UTC(2026, 9, 1, 10);
  let heardAt = now;
  let trusted = true;
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
    ...over,
  });
  const sent: string[] = [];
  const make = () =>
    new AlertService(
      t.store,
      {
        pills: {
          get: () => opts.pill ?? pill,
          activeIds: () => ['p1'],
          latest: reading,
          lastHeardAt: () => heardAt,
          offsets: () => ({ gravity: 0, temperature: 0 }),
        },
        brews: { activeFor: () => null },
        units: () => ({ temperature: 'C', gravity: 'sg' }),
        clockTrusted: () => trusted,
        now: () => now,
      },
      { send: async (m) => void sent.push(m.body) },
      silent,
    );
  const alerts = make();
  alerts.load();
  return {
    store: t.store,
    alerts,
    make,
    sent,
    now: () => now,
    at: (minutes: number) => (now = Date.UTC(2026, 9, 1, 10) + minutes * 60_000),
    heard: () => (heardAt = now),
    setTrusted: (v: boolean) => (trusted = v),
  };
}

const rule = (over: Partial<AlertRuleInput> = {}): AlertRuleInput => ({
  name: 'Too warm',
  enabled: true,
  pillIds: 'all',
  kind: 'temp_above',
  threshold: 25,
  hours: 48,
  onlyDuringBrew: false,
  cooldownMin: 0,
  channelIds: 'all',
  ...over,
});

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

  it('announces an alert it kept quiet once the cooldown is over, if it is still going', async () => {
    const t = setup();
    t.alerts.create(rule({ name: 'Quiet pill', kind: 'offline', threshold: 30, cooldownMin: 60 }));
    t.at(31);
    t.alerts.evaluatePill('p1');
    t.at(35);
    t.heard();
    t.alerts.evaluatePill('p1');
    // 11:10 silent again, inside the cooldown (from 10:31): kept quiet, still at 11:30.
    t.at(70);
    t.alerts.evaluatePill('p1');
    t.at(90);
    t.alerts.evaluatePill('p1');
    await Promise.resolve();
    expect(t.sent).toEqual(['Nothing heard from Kveik for 31 minutes', 'Kveik is back']);
    // 11:32 the cooldown is over and it's still quiet: now it's said, once.
    t.at(92);
    t.alerts.evaluatePill('p1');
    t.at(150);
    t.alerts.evaluatePill('p1');
    await Promise.resolve();
    expect(t.sent).toEqual(['Nothing heard from Kveik for 31 minutes', 'Kveik is back', 'Nothing heard from Kveik for 57 minutes']);
  });
});

describe('alert rules', () => {
  it('says where things are when an alert clears', () => {
    const current: Partial<Reading> = { temperature: 26 };
    const t = setup(current);
    t.alerts.create(rule());
    current.temperature = 21;
    t.alerts.evaluatePill('p1');
    expect(t.alerts.events(10).map((e) => e.message)).toEqual([
      'Back to normal: Kveik is at 21.0 °C',
      'Kveik is at 26.0 °C, above 25.0 °C',
    ]);
  });

  it('lets go of an alert when its rule is switched off, so it fires afresh when switched on again', async () => {
    const t = setup({ temperature: 26 });
    const created = t.alerts.create(rule());
    expect(created.active).toEqual(['p1']);
    expect(t.alerts.update(created.id, rule({ enabled: false })).active).toEqual([]);
    expect(t.alerts.update(created.id, rule()).active).toEqual(['p1']);
    await Promise.resolve();
    expect(t.sent).toEqual(['Kveik is at 26.0 °C, above 25.0 °C', 'Kveik is at 26.0 °C, above 25.0 °C']);
    // Nothing is said about it stopping.
    expect(t.alerts.events(10).map((e) => e.kind)).toEqual(['fired', 'fired']);
  });

  it("doesn't call a pill quiet before the clock is set", () => {
    const t = setup();
    t.setTrusted(false);
    t.alerts.create(rule({ name: 'Quiet pill', kind: 'offline', threshold: 30 }));
    // The clock jumps when it's set: "last heard" was stamped by the old one.
    t.at(120);
    t.alerts.evaluateAll();
    expect(t.alerts.events(10)).toEqual([]);
    t.setTrusted(true);
    t.alerts.evaluateAll();
    expect(t.alerts.events(10).map((e) => e.kind)).toEqual(['fired']);
  });

  it('keeps what a newer version saved in a rule when it is edited', () => {
    const t = setup();
    const created = t.alerts.create(rule());
    t.store.saveAlertRule(created.id, { ...rule(), snoozeUntil: 123 }, created.createdAt);
    const again = t.make();
    again.load();
    again.update(created.id, rule({ name: 'Warm' }));
    const saved = JSON.parse(t.store.listAlertRuleRows()[0]!.json) as Record<string, unknown>;
    expect(saved).toMatchObject({ name: 'Warm', snoozeUntil: 123 });
    expect(saved).not.toHaveProperty('active');
    expect(saved).not.toHaveProperty('id');
  });

  it("judges fermentation stable by the gravity the pill's model gives", () => {
    // The gravity worked out from the tilt (steady at 1.012) rather than the pill's own (all over the place).
    const tilted: Pill = {
      ...pill,
      model: { ...DEFAULT_PILL_MODEL, gravitySource: 'tilt', tiltPoints: [], tiltPoly: [1, 0.0003] },
    };
    const t = setup({ gravity: 1.012 }, { pill: tilted });
    const rad = (40 * Math.PI) / 180;
    for (let h = 50; h >= 0; h--) {
      t.store.addReading('p1', {
        ts: t.now() - h * 3_600_000,
        sg: h % 2 ? 1.02 : 1.05,
        temp: 20,
        velocity: null,
        battery: 90,
        rssi: -50,
        x: Math.sin(rad),
        y: 0,
        z: Math.cos(rad),
        flags: 0,
      });
    }
    expect(t.store.sgRange('p1', t.now() - 48 * 3_600_000, t.now())).toMatchObject({ min: 1.02, max: 1.05 });
    t.alerts.create(rule({ name: 'Done', kind: 'gravity_stable', threshold: 1 }));
    expect(t.alerts.events(10).map((e) => e.message)).toEqual([expect.stringContaining('steady at 1.012')]);
  });
});

describe('alerts on a thermometer', () => {
  it('leaves out gravity and battery rules, and still watches the temperature', async () => {
    const t = setup({ gravity: null, pillGravity: null, battery: null, tilt: null, x: null, y: null, z: null, temperature: 26 });
    for (const [kind, threshold] of [
      ['gravity_below', 1.1],
      ['gravity_stable', 5],
      ['battery_below', 50],
      ['temp_above', 25],
    ] as const) {
      t.alerts.create({
        name: kind,
        enabled: true,
        pillIds: 'all',
        kind,
        threshold,
        hours: 48,
        onlyDuringBrew: false,
        cooldownMin: 60,
        channelIds: 'all',
      });
    }
    t.alerts.evaluatePill('p1');
    await Promise.resolve();
    expect(t.sent).toEqual([expect.stringContaining('above 25')]);
  });
});
