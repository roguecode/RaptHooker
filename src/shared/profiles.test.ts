import { describe, expect, it } from 'vitest';
import { plannedEvents, profileFromBrew } from './profiles.js';
import type { BrewAlert, BrewEvent } from './types.js';

const HOUR = 3_600_000;
const START = Date.UTC(2026, 9, 1, 12);
const event = (over: Partial<BrewEvent>): BrewEvent => ({
  id: 'e',
  brewId: 'b',
  at: START,
  endAt: null,
  kind: 'note',
  text: 'x',
  hidden: false,
  remind: false,
  ...over,
});
const alert: BrewAlert = {
  id: 'a1',
  brewId: 'b',
  createdAt: 1,
  active: true,
  lastFiredAt: 2,
  // Worked out while it runs: not for a profile.
  waitingForGravity: 1.0427,
  name: 'Started',
  enabled: true,
  kind: 'fermentation_started',
  threshold: 3,
  hours: 48,
  cooldownMin: 60,
  channelIds: 'all',
  message: '',
  addToTimeline: true,
};

describe('brew profiles', () => {
  it("are made from a brew's own alerts and its events, timed from its start", () => {
    const events = [
      event({ id: 'before', at: START - HOUR, text: 'Made the starter' }),
      event({ id: 'hop', at: START + 72 * HOUR, endAt: START + 144 * HOUR, kind: 'dry_hop', text: 'Citra' }),
      // What happened in that brew, not a plan for the next.
      event({ id: 'noted', at: START + 80 * HOUR, text: 'Started: down 3 points', hidden: true, alertId: 'r1' }),
      event({ id: 'crash', at: START + 240 * HOUR, kind: 'cold_crash', text: '', remind: true }),
    ];
    const p = profileFromBrew({ startedAt: START, events }, [alert], { name: 'NEIPA' });
    expect(p).toEqual({
      name: 'NEIPA',
      notes: '',
      alerts: [
        {
          name: 'Started',
          enabled: true,
          kind: 'fermentation_started',
          threshold: 3,
          hours: 48,
          cooldownMin: 60,
          channelIds: 'all',
          message: '',
          addToTimeline: true,
        },
      ],
      events: [
        { offset: 72 * HOUR, endOffset: 144 * HOUR, kind: 'dry_hop', text: 'Citra', remind: false },
        { offset: 240 * HOUR, endOffset: null, kind: 'cold_crash', text: '', remind: true },
      ],
    });
    expect(profileFromBrew({ startedAt: START, events }, [], { name: 'x', remind: true }).events.every((e) => e.remind)).toBe(true);
  });

  it("plan their events from a new brew's start", () => {
    const later = START + 30 * 24 * HOUR;
    expect(
      plannedEvents({ events: [{ offset: 72 * HOUR, endOffset: 144 * HOUR, kind: 'dry_hop', text: 'Citra', remind: true }] }, later),
    ).toEqual([{ at: later + 72 * HOUR, endAt: later + 144 * HOUR, kind: 'dry_hop', text: 'Citra', remind: true }]);
  });
});
