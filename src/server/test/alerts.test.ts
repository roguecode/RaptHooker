import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PILL_MODEL,
  type AlertRuleInput,
  type Brew,
  type BrewAlertInput,
  type Decimals,
  type GravityUnit,
  type Pill,
  type Reading,
  type TemperatureUnit,
} from '@rapthooker/shared';
import { AlertService, type AlertDeps } from '../alerts.js';
import type { BrewEventRow } from '../db.js';
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

function setup(
  over: Partial<Reading> = {},
  opts: {
    pill?: Pill;
    brew?: () => Brew | null;
    brews?: Partial<AlertDeps['brews']>;
    units?: () => { temperature: TemperatureUnit; gravity: GravityUnit };
    decimals?: () => Decimals;
  } = {},
) {
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
  const pushes: { title: string; body: string; url?: string }[] = [];
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
        brews: { activeFor: opts.brew ?? (() => null), ...opts.brews },
        units: opts.units ?? (() => ({ temperature: 'C', gravity: 'sg' })),
        decimals: opts.decimals,
        clockTrusted: () => trusted,
        now: () => now,
      },
      {
        send: async (m) => {
          sent.push(m.body);
          pushes.push(m);
        },
      },
      silent,
    );
  const alerts = make();
  alerts.load();
  return {
    store: t.store,
    alerts,
    make,
    sent,
    pushes,
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

  it("writes readings with the hub's decimals, in its units", () => {
    let decimals: Decimals = { sg: 4, plato: 1, temperature: 1 };
    let units: { temperature: TemperatureUnit; gravity: GravityUnit } = { temperature: 'C', gravity: 'sg' };
    const t = setup({ gravity: 1.01234, temperature: 26.04 }, { decimals: () => decimals, units: () => units });
    const message = (r: AlertRuleInput) => {
      const created = t.alerts.create(r);
      const text = t.alerts.events(1)[0]!.message;
      t.alerts.delete(created.id);
      return text;
    };
    const gravity = rule({ name: 'Done', kind: 'gravity_below', threshold: 1.015 });
    expect(message(rule())).toBe('Kveik is at 26.0 °C, above 25.0 °C');
    expect(message(gravity)).toBe('Kveik has reached 1.0123 (target 1.0150)');
    decimals = { sg: 3, plato: 2, temperature: 2 };
    expect(message(rule())).toBe('Kveik is at 26.04 °C, above 25.00 °C');
    expect(message(gravity)).toBe('Kveik has reached 1.012 (target 1.015)');
    units = { temperature: 'F', gravity: 'plato' };
    expect(message(gravity)).toBe('Kveik has reached 3.15 °P (target 3.83 °P)');
    expect(message(rule({ threshold: 25 }))).toBe('Kveik is at 78.87 °F, above 77.00 °F');
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

  it("lists one pill's events", () => {
    const t = setup({ temperature: 26 });
    t.alerts.create(rule());
    t.store.addAlertEvent({ ruleId: 'r2', ruleName: 'Other', pillId: 'p2', at: t.now(), kind: 'fired', message: 'm', value: null });
    expect(t.alerts.events(10).map((e) => e.pillId)).toEqual(['p2', 'p1']);
    expect(t.alerts.events(10, 'p1').map((e) => e.ruleName)).toEqual(['Too warm']);
    expect(t.alerts.events(10, 'p3')).toEqual([]);
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

describe('velocity alerts', () => {
  /** A running brew with just what the alerts look at. */
  const brew = (og: number | null): Brew => ({ id: 'b1', pillId: 'p1', startedAt: 0, endedAt: null, stats: { og } }) as unknown as Brew;

  it('fires when fermentation slows to under the threshold, and lets go once it is clearly faster again', () => {
    const current: Partial<Reading> = { velocity: -12 };
    const t = setup(current);
    t.alerts.create(rule({ name: 'Nearly done', kind: 'velocity_slow', threshold: 10 }));
    expect(t.alerts.events(10)).toEqual([]);
    current.velocity = -9.5;
    t.alerts.evaluatePill('p1');
    // Within a point of the threshold it stays as it is.
    current.velocity = -10.6;
    t.alerts.evaluatePill('p1');
    current.velocity = -11.2;
    t.alerts.evaluatePill('p1');
    expect(t.alerts.events(10).map((e) => [e.kind, e.message, e.value])).toEqual([
      ['resolved', "Back to normal: Kveik's gravity is dropping 11.2 points a day", 11.2],
      ['fired', "Kveik's gravity is dropping 9.5 points a day, slower than 10.0 points a day", 9.5],
    ]);
  });

  it('fires when fermentation is faster than the threshold', () => {
    const current: Partial<Reading> = { velocity: -4 };
    const t = setup(current);
    t.alerts.create(rule({ name: 'Going strong', kind: 'velocity_fast', threshold: 10 }));
    current.velocity = -14.3;
    t.alerts.evaluatePill('p1');
    current.velocity = -9.5;
    t.alerts.evaluatePill('p1');
    expect(t.alerts.list()[0]!.active).toEqual(['p1']);
    current.velocity = -8.9;
    t.alerts.evaluatePill('p1');
    expect(t.alerts.events(10).map((e) => [e.kind, e.message])).toEqual([
      ['resolved', "Back to normal: Kveik's gravity is dropping 8.9 points a day"],
      ['fired', "Kveik's gravity is dropping 14.3 points a day, faster than 10.0 points a day"],
    ]);
  });

  it('clears a small threshold half of it back, not a whole point', () => {
    const current: Partial<Reading> = { velocity: -0.3 };
    const t = setup(current);
    t.alerts.create(rule({ name: 'Done', kind: 'velocity_slow', threshold: 0.5 }));
    current.velocity = -0.7;
    t.alerts.evaluatePill('p1');
    expect(t.alerts.list()[0]!.active).toEqual(['p1']);
    current.velocity = -0.8;
    t.alerts.evaluatePill('p1');
    expect(t.alerts.events(10).map((e) => e.kind)).toEqual(['resolved', 'fired']);
  });

  it('counts a rising or steady gravity as slow', () => {
    const current: Partial<Reading> = { velocity: 2 };
    const t = setup(current);
    t.alerts.create(rule({ name: 'Slow', kind: 'velocity_slow', threshold: 1 }));
    t.alerts.create(rule({ name: 'Fast', kind: 'velocity_fast', threshold: 1 }));
    current.velocity = 0.01;
    t.alerts.create(rule({ name: 'Slow again', kind: 'velocity_slow', threshold: 1 }));
    expect(t.alerts.events(10).map((e) => [e.ruleName, e.message])).toEqual([
      ['Slow again', "Kveik's gravity is steady, slower than 1.0 points a day"],
      ['Slow', "Kveik's gravity is rising 2.0 points a day, slower than 1.0 points a day"],
    ]);
  });

  it('waits for a velocity and for a reading that looks real', () => {
    const current: Partial<Reading> = { velocity: null };
    const t = setup(current);
    t.alerts.create(rule({ kind: 'velocity_slow', threshold: 10 }));
    expect(t.alerts.events(10)).toEqual([]);
    Object.assign(current, { velocity: -1, plausible: false });
    t.alerts.evaluatePill('p1');
    expect(t.alerts.events(10)).toEqual([]);
    current.plausible = true;
    t.alerts.evaluatePill('p1');
    expect(t.alerts.events(10).map((e) => e.kind)).toEqual(['fired']);
  });

  it("doesn't call a brew slow or fast before it has started fermenting", () => {
    const current: Partial<Reading> = { gravity: 1.0495, velocity: -0.3 };
    const t = setup(current, { brew: () => brew(1.05) });
    t.alerts.create(rule({ name: 'Slow', kind: 'velocity_slow', threshold: 2 }));
    t.alerts.create(rule({ name: 'Fast', kind: 'velocity_fast', threshold: 0.2 }));
    expect(t.alerts.events(10)).toEqual([]);
    // Once the gravity has dropped two points from the OG, it counts.
    current.gravity = 1.0479;
    t.alerts.evaluatePill('p1');
    expect(t.alerts.events(10).map((e) => [e.ruleName, e.message])).toEqual([
      ['Fast', "Kveik's gravity is dropping 0.3 points a day, faster than 0.2 points a day"],
      ['Slow', "Kveik's gravity is dropping 0.3 points a day, slower than 2.0 points a day"],
    ]);
  });

  it("doesn't call a pill in water fermenting because its velocity drifts at the start of a brew", () => {
    // A brew of water: the gravity hasn't moved from its OG, but a tenth of a point in an hour reads as 2.4 a day.
    const t = setup({ gravity: 1.0, velocity: -2.4 }, { brew: () => brew(1.0) });
    t.alerts.create(rule({ name: 'Fermentation started', kind: 'velocity_fast', threshold: 1.5, onlyDuringBrew: true }));
    t.alerts.evaluateAll();
    expect(t.alerts.events(10)).toEqual([]);
    expect(t.sent).toEqual([]);
  });

  it('lets go of a fast alert from before the brew left its OG, so it tells you when fermentation really starts', () => {
    const current: Partial<Reading> = { gravity: 1.05, velocity: -2.3 };
    let running: Brew | null = null;
    const t = setup(current, { brew: () => running });
    t.alerts.create(rule({ name: 'Fast', kind: 'velocity_fast', threshold: 2 }));
    expect(t.alerts.list()[0]!.active).toEqual(['p1']);
    // The brew starts with the pill at its OG: it clears, without a notification.
    running = brew(1.05);
    t.alerts.evaluatePill('p1');
    expect(t.alerts.list()[0]!.active).toEqual([]);
    // Between one and two points down it neither fires nor clears.
    current.gravity = 1.0485;
    t.alerts.evaluatePill('p1');
    expect(t.alerts.list()[0]!.active).toEqual([]);
    current.gravity = 1.0475;
    current.velocity = -12;
    t.alerts.evaluatePill('p1');
    current.gravity = 1.0485;
    t.alerts.evaluatePill('p1');
    expect(t.alerts.list()[0]!.active).toEqual(['p1']);
    expect(t.alerts.events(10).map((e) => [e.kind, e.message])).toEqual([
      ['fired', "Kveik's gravity is dropping 12.0 points a day, faster than 2.0 points a day"],
      ['resolved', "Back to normal: Kveik is at 1.0500, near the brew's OG of 1.0500"],
      ['fired', "Kveik's gravity is dropping 2.3 points a day, faster than 2.0 points a day"],
    ]);
    expect(t.sent).toEqual([
      "Kveik's gravity is dropping 2.3 points a day, faster than 2.0 points a day",
      "Kveik's gravity is dropping 12.0 points a day, faster than 2.0 points a day",
    ]);
  });

  it("doesn't wait for a brew that has no OG yet", () => {
    const t = setup({ gravity: 1.05, velocity: -0.3 }, { brew: () => brew(null) });
    t.alerts.create(rule({ kind: 'velocity_slow', threshold: 2 }));
    expect(t.alerts.events(10)).toHaveLength(1);
  });
});

describe('steps in a brew', () => {
  const DAY = 86_400_000;
  /** A running brew with just what the alerts look at. */
  const brewOf = (o: { id?: string; startedAt?: number; og?: number | null; startGravity?: number | null } = {}): Brew =>
    ({
      id: o.id ?? 'b1',
      name: 'Hazy',
      pillId: 'p1',
      startedAt: o.startedAt ?? 0,
      endedAt: null,
      stats: { og: o.og ?? null, startGravity: o.startGravity },
    }) as unknown as Brew;

  it('says fermentation has started once the gravity has dropped from where the pill started, once a brew', () => {
    const current: Partial<Reading> = { gravity: 1.048 };
    // A typed OG four points above what the pill reads: it's not a drop.
    let running: Brew | null = brewOf({ og: 1.052, startGravity: 1.048 });
    const t = setup(current, { brew: () => running });
    t.alerts.create(rule({ name: 'Started', kind: 'fermentation_started', threshold: 3 }));
    current.gravity = 1.0455;
    t.alerts.evaluatePill('p1');
    expect(t.alerts.events(10)).toEqual([]);
    current.gravity = 1.0449;
    t.alerts.evaluatePill('p1');
    // A reading that bounces back doesn't clear it: it has started.
    current.gravity = 1.047;
    t.alerts.evaluatePill('p1');
    expect(t.alerts.events(10).map((e) => [e.kind, e.message, e.value])).toEqual([
      ['fired', 'Hazy has started fermenting: Kveik has dropped 3.1 points, from 1.0480 to 1.0449', 3.1],
    ]);

    // The next brew gets it afresh.
    running = null;
    t.alerts.evaluateAll();
    expect(t.alerts.list()[0]!.active).toEqual([]);
    t.at(60);
    running = brewOf({ id: 'b2', startedAt: t.now(), startGravity: 1.06 });
    current.gravity = 1.056;
    t.alerts.evaluatePill('p1');
    expect(t.alerts.events(10).map((e) => e.kind)).toEqual(['fired', 'fired']);
    expect(t.sent).toHaveLength(2);
  });

  it('watches only a running brew, whatever the rule says, and falls back to the OG for a brew from before it was kept', () => {
    const current: Partial<Reading> = { gravity: 1.04 };
    let running: Brew | null = null;
    const t = setup(current, { brew: () => running });
    t.alerts.create(rule({ name: 'Started', kind: 'fermentation_started', threshold: 3, onlyDuringBrew: false }));
    expect(t.alerts.events(10)).toEqual([]);
    running = brewOf({ og: 1.05 });
    t.alerts.evaluatePill('p1');
    expect(t.alerts.events(10).map((e) => e.message)).toEqual([
      'Hazy has started fermenting: Kveik has dropped 10.0 points, from 1.0500 to 1.0400',
    ]);
  });

  it('goes off afresh in a new brew started before the minute check let go of the last one', () => {
    const current: Partial<Reading> = { gravity: 1.04 };
    let running: Brew | null = brewOf({ startGravity: 1.05 });
    const t = setup(current, { brew: () => running });
    t.alerts.create(rule({ name: 'Started', kind: 'fermentation_started', threshold: 3 }));
    t.at(10);
    running = brewOf({ id: 'b2', startedAt: t.now(), startGravity: 1.045 });
    t.alerts.evaluatePill('p1');
    expect(t.alerts.events(10).map((e) => e.message)).toEqual([
      'Hazy has started fermenting: Kveik has dropped 5.0 points, from 1.0450 to 1.0400',
      'Hazy has started fermenting: Kveik has dropped 10.0 points, from 1.0500 to 1.0400',
    ]);
  });

  it('says when a brew has reached an attenuation, from its OG', () => {
    const current: Partial<Reading> = { gravity: 1.03 };
    const t = setup(current, { brew: () => brewOf({ og: 1.05, startGravity: 1.049 }) });
    t.alerts.create(rule({ name: 'Dry hop now', kind: 'attenuation_reached', threshold: 50 }));
    expect(t.alerts.events(10)).toEqual([]);
    current.gravity = 1.025;
    t.alerts.evaluatePill('p1');
    expect(t.alerts.events(10).map((e) => [e.message, e.value])).toEqual([
      ['Hazy is 50% attenuated: Kveik is at 1.0250, from an OG of 1.0500', 50],
    ]);
  });

  it('reminds you a number of days into a brew, once, by the clock', () => {
    const t = setup({}, { brew: () => brewOf({ startedAt: Date.UTC(2026, 9, 1, 10) - 2.5 * DAY }) });
    t.setTrusted(false);
    t.alerts.create(rule({ name: 'Day 3', kind: 'brew_day', threshold: 3 }));
    t.at(13 * 60);
    t.alerts.evaluateAll();
    expect(t.alerts.events(10)).toEqual([]);
    t.setTrusted(true);
    t.alerts.evaluateAll();
    t.at(14 * 60);
    t.alerts.evaluateAll();
    expect(t.alerts.events(10).map((e) => [e.kind, e.message])).toEqual([['fired', 'Hazy has been going for 3 days']]);
  });

  it("puts what to do first, and notes it on the brew's timeline (as its own, off the charts) when asked to", () => {
    const notes: { brewId: string; text: string; kind: string; hidden?: boolean; alertId?: string }[] = [];
    const current: Partial<Reading> = { gravity: 1.05 };
    const t = setup(current, {
      brew: () => brewOf({ og: 1.05 }),
      brews: { addEvent: (brewId, e, alertId) => notes.push({ brewId, text: e.text, kind: e.kind, hidden: e.hidden, alertId }) },
    });
    const made = t.alerts.create(
      rule({ name: 'Dry hop', kind: 'attenuation_reached', threshold: 40, message: 'Add 100 g Citra', addToTimeline: true }),
    );
    current.gravity = 1.03;
    t.alerts.evaluatePill('p1');
    const message = 'Add 100 g Citra — Hazy is 40% attenuated: Kveik is at 1.0300, from an OG of 1.0500';
    expect(t.sent).toEqual([message]);
    expect(notes).toEqual([{ brewId: 'b1', kind: 'note', text: `Dry hop: ${message}`, hidden: true, alertId: made.id }]);
  });
});

describe("a brew's own alerts", () => {
  const brewOf = (id: string): Brew =>
    ({ id, name: 'Hazy', pillId: 'p1', startedAt: 0, endedAt: null, stats: { og: 1.05 } }) as unknown as Brew;
  const own = (over: Partial<BrewAlertInput> = {}): BrewAlertInput => ({
    name: 'Dry hop',
    enabled: true,
    kind: 'gravity_below',
    threshold: 1.02,
    hours: 48,
    cooldownMin: 60,
    channelIds: 'all',
    message: 'Add the hops',
    addToTimeline: false,
    ...over,
  });

  it('watches its brew while it runs, and nothing else', () => {
    const current: Partial<Reading> = { gravity: 1.03 };
    let running: Brew | null = brewOf('b1');
    const known = new Set(['b1', 'b2']);
    const t = setup(current, { brew: () => running, brews: { get: (id) => (known.has(id) ? brewOf(id) : null) } });
    const a = t.alerts.createBrewAlert('b1', own());
    expect(a).toMatchObject({ brewId: 'b1', active: false, lastFiredAt: null, message: 'Add the hops' });
    expect(() => t.alerts.createBrewAlert('nope', own())).toThrow(/Unknown brew/);
    // Not a rule on the Alerts page.
    expect(t.alerts.list()).toEqual([]);

    current.gravity = 1.019;
    t.alerts.evaluatePill('p1');
    expect(t.pushes).toEqual([
      expect.objectContaining({ title: 'Dry hop', body: 'Add the hops — Kveik has reached 1.0190 (target 1.0200)', url: '/#/brew/b1' }),
    ]);
    expect(t.alerts.listBrewAlerts('b1')).toEqual([expect.objectContaining({ id: a.id, active: true, lastFiredAt: t.now() })]);

    // Another brew on the pill: it lets go, quietly, and doesn't watch that one.
    running = brewOf('b2');
    current.gravity = 1.05;
    t.alerts.evaluateAll();
    current.gravity = 1.01;
    t.alerts.evaluatePill('p1');
    expect(t.alerts.listBrewAlerts('b1')[0]!.active).toBe(false);
    expect(t.sent).toHaveLength(1);
    expect(t.alerts.listBrewAlerts('b2')).toEqual([]);
  });

  it('is kept across restarts, changed and deleted, and goes with its brew', () => {
    const t = setup({}, { brew: () => brewOf('b1') });
    const a = t.alerts.createBrewAlert('b1', own());
    const b = t.alerts.createBrewAlert('b1', own({ name: 'Day 3', kind: 'brew_day', threshold: 3, message: '' }));
    // A field a newer version saved is kept when this one changes the alert.
    const row = t.store.listBrewAlertRows().find((r) => r.id === a.id)!;
    t.store.saveBrewAlert({ ...row, json: JSON.stringify({ ...JSON.parse(row.json), future: 1 }) });
    const again = t.make();
    again.load();
    expect(again.listBrewAlerts('b1').map((x) => x.name)).toEqual(['Dry hop', 'Day 3']);
    again.updateBrewAlert('b1', a.id, own({ threshold: 1.018 }));
    expect(JSON.parse(t.store.listBrewAlertRows().find((r) => r.id === a.id)!.json)).toMatchObject({ threshold: 1.018, future: 1 });
    expect(() => again.updateBrewAlert('b2', a.id, own())).toThrow(/Unknown alert/);
    again.deleteBrewAlert('b1', b.id);
    expect(again.listBrewAlerts('b1').map((x) => x.id)).toEqual([a.id]);
    again.forgetBrew('b1');
    expect(again.listBrewAlerts('b1')).toEqual([]);
  });

  it('drops a deleted notification channel', () => {
    const t = setup({}, { brew: () => brewOf('b1') });
    const a = t.alerts.createBrewAlert('b1', own({ channelIds: ['ch1', 'ch2'] }));
    t.alerts.forgetChannel('ch1');
    expect(t.alerts.listBrewAlerts('b1')[0]!.channelIds).toEqual(['ch2']);
    expect(JSON.parse(t.store.listBrewAlertRows()[0]!.json).channelIds).toEqual(['ch2']);
    expect(a.id).toBeTruthy();
  });
});

describe('reminders of planned events', () => {
  const HOUR = 3_600_000;
  const event = (over: Partial<BrewEventRow>): BrewEventRow => ({
    id: 'e1',
    brew_id: 'b1',
    at: 0,
    end_at: null,
    kind: 'dry_hop',
    text: '100 g Citra',
    hidden: 0,
    remind: 1,
    reminded_at: null,
    reminded_end: null,
    alert_id: null,
    ...over,
  });

  it('reminds when a planned event starts and when it ends, once each, and again for a time it is moved to', () => {
    const t = setup();
    const start = t.now();
    t.store.saveBrew({
      id: 'b1',
      pill_id: 'p1',
      started_at: start - 24 * HOUR,
      ended_at: null,
      json: '{"name":"Hazy IPA"}',
      created_at: start,
    });
    t.store.saveBrewEvent(event({ at: start + HOUR, end_at: start + 49 * HOUR }));
    t.store.saveBrewEvent(event({ id: 'e2', at: start + HOUR, kind: 'note', text: 'Check the airlock', remind: 0 }));
    t.alerts.checkReminders();
    expect(t.sent).toEqual([]);
    t.at(61);
    t.alerts.checkReminders();
    t.alerts.checkReminders();
    expect(t.pushes).toEqual([
      expect.objectContaining({ title: 'Hazy IPA: Dry hop', body: 'Time for the dry hop: 100 g Citra', url: '/#/brew/b1' }),
    ]);
    t.at(49 * 60 + 1);
    t.alerts.checkReminders();
    expect(t.sent.at(-1)).toBe('Time to finish the dry hop: 100 g Citra');
    // Moved on: due again at its new time.
    t.store.saveBrewEvent({ ...t.store.getBrewEvent('e1')!, end_at: t.now() + HOUR });
    t.at(50 * 60 + 2);
    t.alerts.checkReminders();
    expect(t.sent).toHaveLength(3);
    expect(t.alerts.events(10)[0]).toMatchObject({ ruleName: 'Hazy IPA: Dry hop', pillId: 'p1', kind: 'fired' });
  });

  it("lets go of one the hub was off for, says only the end of one that's over, and waits for the clock", () => {
    const t = setup();
    const start = t.now();
    t.store.saveBrew({
      id: 'b1',
      pill_id: 'p1',
      started_at: start - 24 * HOUR,
      ended_at: null,
      json: '{"name":"Hazy IPA"}',
      created_at: start,
    });
    t.store.saveBrewEvent(event({ at: start - 7 * HOUR, kind: 'cold_crash', text: '' }));
    t.store.saveBrewEvent(event({ id: 'e2', at: start - 3 * HOUR, end_at: start - HOUR }));
    t.setTrusted(false);
    t.alerts.checkReminders();
    expect(t.sent).toEqual([]);
    t.setTrusted(true);
    t.alerts.checkReminders();
    t.alerts.checkReminders();
    expect(t.sent).toEqual(['Time to finish the dry hop: 100 g Citra']);
  });

  it("doesn't remind of a finished brew's events", () => {
    const t = setup();
    const start = t.now();
    t.store.saveBrew({
      id: 'b1',
      pill_id: 'p1',
      started_at: start - 24 * HOUR,
      ended_at: start,
      json: '{"name":"Hazy IPA"}',
      created_at: start,
    });
    t.store.saveBrewEvent(event({ at: start - HOUR }));
    t.alerts.checkReminders();
    expect(t.sent).toEqual([]);
  });
});

describe('alerts on a thermometer', () => {
  it('leaves out gravity and battery rules, and still watches the temperature', async () => {
    const t = setup({ gravity: null, pillGravity: null, battery: null, tilt: null, x: null, y: null, z: null, temperature: 26 });
    for (const [kind, threshold] of [
      ['gravity_below', 1.1],
      ['gravity_stable', 5],
      ['velocity_slow', 100],
      ['velocity_fast', -100],
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
