import { randomUUID } from 'node:crypto';
import { BROWSER_PUSH, plannedEvents, type Brew, type BrewAlertInput, type BrewProfile, type BrewProfileInput } from '@rapthooker/shared';
import type { Store } from './db.js';
import type { BrewService } from './brews.js';
import type { AlertService } from './alerts.js';
import type { Logger } from './log.js';

export class ProfileError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

/** What's saved for a profile (fields a newer version added are kept). */
const profileInput = ({ id: _id, createdAt: _c, ...input }: BrewProfile & Record<string, unknown>): BrewProfileInput => input;

/**
 * Brew profiles: alerts and planned events (timed from the start) that a brew can start with, saved from a brew you
 * liked, like a RAPT Pill profile.
 */
export class ProfileService {
  constructor(
    private readonly store: Store,
    private readonly brews: Pick<BrewService, 'get' | 'addEvent'>,
    private readonly alerts: Pick<AlertService, 'createBrewAlert'>,
    private readonly log: Logger,
    /** Whether a notification channel still exists (a profile's alerts drop the ones that have gone). */
    private readonly channelExists: (id: string) => boolean = () => true,
    private readonly now: () => number = Date.now,
  ) {}

  list(): BrewProfile[] {
    const out: BrewProfile[] = [];
    for (const row of this.store.listProfileRows()) {
      const p = this.parse(row.id, row.json, row.created_at);
      if (p) out.push(p);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): BrewProfile | null {
    const row = this.store.getProfileRow(id);
    return row ? this.parse(row.id, row.json, row.created_at) : null;
  }

  create(input: BrewProfileInput): BrewProfile {
    const profile: BrewProfile = { ...input, id: randomUUID(), createdAt: this.now() };
    this.store.saveProfile(profile.id, input, profile.createdAt);
    return profile;
  }

  update(id: string, input: BrewProfileInput): BrewProfile {
    const row = this.store.getProfileRow(id);
    const old = row ? this.parse(row.id, row.json, row.created_at) : null;
    if (!old) throw new ProfileError('Unknown profile', 404);
    const profile = { ...old, ...input } as BrewProfile & Record<string, unknown>;
    this.store.saveProfile(id, profileInput(profile), old.createdAt);
    return profile;
  }

  delete(id: string): void {
    if (!this.store.deleteProfile(id)) throw new ProfileError('Unknown profile', 404);
  }

  /**
   * Adds a profile's alerts and planned events to a running brew, timed from its start. Planned times that have already
   * passed (a brew started earlier) are added as they are, without reminding of them.
   */
  apply(profileId: string, brewId: string): Brew {
    const profile = this.get(profileId);
    if (!profile) throw new ProfileError('Unknown profile', 404);
    const brew = this.brews.get(brewId);
    if (!brew) throw new ProfileError('Unknown brew', 404);
    if (brew.endedAt !== null) throw new ProfileError('That brew has ended: a profile is for a running brew', 409);
    for (const a of profile.alerts) this.alerts.createBrewAlert(brew.id, this.withChannels(a));
    for (const e of plannedEvents(profile, brew.startedAt)) {
      try {
        this.brews.addEvent(brew.id, e);
      } catch (err) {
        this.log.warn({ err: (err as Error).message, profile: profileId, brew: brew.id }, "couldn't add a profile's event to a brew");
      }
    }
    this.log.info({ profile: profileId, brew: brew.id }, 'brew profile used');
    return this.brews.get(brew.id) ?? brew;
  }

  private withChannels(a: BrewAlertInput): BrewAlertInput {
    if (a.channelIds === 'all') return a;
    return { ...a, channelIds: a.channelIds.filter((id) => id === BROWSER_PUSH || this.channelExists(id)) };
  }

  private parse(id: string, json: string, createdAt: number): BrewProfile | null {
    try {
      const saved = JSON.parse(json) as Partial<BrewProfileInput>;
      return {
        ...saved,
        name: saved.name ?? 'Profile',
        notes: saved.notes ?? '',
        alerts: Array.isArray(saved.alerts) ? saved.alerts : [],
        events: Array.isArray(saved.events) ? saved.events : [],
        id,
        createdAt,
      };
    } catch (err) {
      this.log.error({ id, err: (err as Error).message }, 'skipped a brew profile that could not be read');
      return null;
    }
  }
}
