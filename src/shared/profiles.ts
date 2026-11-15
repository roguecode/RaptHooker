import type { Brew, BrewAlert, BrewAlertInput, BrewEventInput, BrewProfileInput, ProfileEvent } from './types.js';

/** A brew alert as a profile keeps it: what it watches for, without what's worked out while it runs. */
export const alertInputOf = ({
  id: _id,
  brewId: _b,
  createdAt: _c,
  active: _a,
  lastFiredAt: _l,
  waitingForGravity: _w,
  ...input
}: BrewAlert): BrewAlertInput => input;

/**
 * A profile from a brew: its own alerts, and its events timed from its start (events from before the start, and notes
 * alerts made, which say what happened in that brew, are left out). With `remind`, every event reminds you when the
 * profile is used; otherwise each keeps its own setting.
 */
export function profileFromBrew(
  brew: Pick<Brew, 'startedAt' | 'events'>,
  alerts: BrewAlert[],
  opts: { name: string; notes?: string; remind?: boolean },
): BrewProfileInput {
  const events: ProfileEvent[] = brew.events
    .filter((e) => e.at >= brew.startedAt && !e.alertId)
    .map((e) => ({
      offset: e.at - brew.startedAt,
      endOffset: e.endAt !== null && e.endAt > e.at ? e.endAt - brew.startedAt : null,
      kind: e.kind,
      text: e.text,
      remind: opts.remind ?? e.remind,
    }));
  return { name: opts.name, notes: opts.notes ?? '', alerts: alerts.map(alertInputOf), events };
}

/** A profile's events as planned in a brew that started at `startedAt`. */
export const plannedEvents = (profile: Pick<BrewProfileInput, 'events'>, startedAt: number): BrewEventInput[] =>
  profile.events.map((e) => ({
    at: startedAt + e.offset,
    endAt: e.endOffset === null ? null : startedAt + e.endOffset,
    kind: e.kind,
    text: e.text,
    remind: e.remind,
  }));
