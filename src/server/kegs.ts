import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { vesselFill, type DeviceKind, type Keg, type Vessel } from '@rapthooker/shared';
import type { KegRow, Store } from './db.js';
import type { Logger } from './log.js';

export class KegError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

/** What kegs need to know about the devices they're on. */
export interface KegPills {
  kind(id: string): DeviceKind | null;
  vessel(id: string): Vessel;
  kegOf: (pillId: string) => Keg | null;
}

/** What's saved for a keg, as JSON. */
interface KegJson {
  name: string;
  style: string;
  abv: number | null;
  brewId: string | null;
  /** mm down to the beer when it was kegged up (the fullest it was soon after): kept, as its readings may be pruned. */
  startDistance?: number;
}

export interface KegInput {
  name?: string;
  style?: string;
  abv?: number | null;
  brewId?: string | null;
  keggedAt?: number;
}

/**
 * How much went in is the fullest the keg was in this long after kegging up: once filled it only goes down, and it may
 * be kegged up in the app before or after it's filled.
 */
const START_WINDOW_MS = 6 * 3_600_000;

const clean = (input: KegInput, base: KegJson): KegJson => ({
  ...base,
  name: (input.name ?? base.name).trim(),
  style: (input.style ?? base.style).trim(),
  abv: input.abv === undefined ? base.abv : input.abv === null ? null : Math.round(input.abv * 100) / 100,
  brewId: input.brewId === undefined ? base.brewId : input.brewId,
});

/**
 * Kegs: a beer kegged up under a RAPT Laser Level, from when it was kegged until the keg is emptied. Its name, style
 * and ABV are only for showing (they can be copied from a brew); how much is in it comes from the Laser Level's
 * readings. Kegging up another beer ends the one before. Emits 'keg' (Keg) when one changes and 'removed' (Keg) when
 * one is deleted.
 */
export class KegService extends EventEmitter {
  constructor(
    private readonly store: Store,
    private readonly pills: KegPills,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {
    super();
    pills.kegOf = (pillId) => this.activeFor(pillId);
  }

  list(pillId?: string): Keg[] {
    return this.store.listKegRows(pillId).map((row) => this.view(row));
  }

  get(id: string): Keg | null {
    const row = this.store.getKegRow(id);
    return row ? this.view(row) : null;
  }

  activeFor(pillId: string): Keg | null {
    const row = this.store.listKegRows(pillId).find((r) => r.ended_at === null);
    return row ? this.view(row) : null;
  }

  start(pillId: string, input: KegInput): Keg {
    const kind = this.pills.kind(pillId);
    if (!kind) throw new KegError('Unknown device', 404);
    if (kind !== 'laser-level') throw new KegError('Only a RAPT Laser Level can have a beer kegged up');
    const now = this.now();
    const keggedAt = Math.min(input.keggedAt ?? now, now);
    // The beer before is gone once another is kegged up.
    const before = this.store.listKegRows(pillId).find((r) => r.ended_at === null);
    if (before) {
      if (keggedAt < before.kegged_at) throw new KegError('A beer was kegged up after that: pick a later time', 409);
      this.saveRow({ ...before, ended_at: keggedAt });
    }
    const row: KegRow = {
      id: randomUUID(),
      pill_id: pillId,
      json: JSON.stringify(clean(input, { name: '', style: '', abv: null, brewId: null })),
      kegged_at: keggedAt,
      ended_at: null,
      created_at: now,
    };
    const keg = this.saveRow(row);
    this.log.info({ keg: keg.id, pill: pillId }, 'beer kegged up');
    return keg;
  }

  update(id: string, patch: KegInput & { endedAt?: number | null }): Keg {
    const row = this.store.getKegRow(id);
    if (!row) throw new KegError('Unknown keg', 404);
    const json = JSON.parse(row.json) as KegJson;
    const keggedAt = patch.keggedAt ?? row.kegged_at;
    let endedAt = patch.endedAt === undefined ? row.ended_at : patch.endedAt;
    if (keggedAt > this.now()) throw new KegError("A keg can't be kegged up in the future");
    if (endedAt !== null) endedAt = Math.min(endedAt, this.now());
    if (endedAt !== null && endedAt < keggedAt) throw new KegError('A keg has to be emptied after it was kegged up');
    if (endedAt === null && row.ended_at !== null) {
      const other = this.store.listKegRows(row.pill_id).find((r) => r.ended_at === null && r.id !== id);
      if (other) throw new KegError('Another beer is kegged up on this Laser Level: empty it first', 409);
    }
    const next = clean(patch, json);
    // Kegged up at another time: how much went in is worked out again.
    if (keggedAt !== row.kegged_at) delete next.startDistance;
    return this.saveRow({ ...row, json: JSON.stringify(next), kegged_at: keggedAt, ended_at: endedAt });
  }

  end(id: string, at?: number): Keg {
    const row = this.store.getKegRow(id);
    if (!row) throw new KegError('Unknown keg', 404);
    if (row.ended_at !== null) throw new KegError('That keg has already been emptied', 409);
    const keg = this.update(id, { endedAt: at ?? this.now() });
    this.log.info({ keg: id }, 'keg emptied');
    return keg;
  }

  delete(id: string): Keg {
    const keg = this.get(id);
    if (!keg) throw new KegError('Unknown keg', 404);
    this.store.deleteKeg(id);
    this.emit('removed', keg);
    return keg;
  }

  private saveRow(row: KegRow): Keg {
    this.store.saveKeg(row);
    const keg = this.view(row);
    this.emit('keg', keg);
    return keg;
  }

  private view(row: KegRow): Keg {
    const json = JSON.parse(row.json) as KegJson;
    let distance = json.startDistance ?? null;
    if (distance === null) {
      const until = Math.min(row.ended_at ?? Infinity, row.kegged_at + START_WINDOW_MS);
      distance = this.store.minDistance(row.pill_id, row.kegged_at, until);
      // Kept once the window is over, as the readings may be pruned later.
      if (distance !== null && this.now() >= until) {
        this.store.saveKeg({ ...row, json: JSON.stringify({ ...json, startDistance: distance } satisfies KegJson) });
      }
    }
    return {
      id: row.id,
      pillId: row.pill_id,
      name: json.name ?? '',
      style: json.style ?? '',
      abv: json.abv ?? null,
      brewId: json.brewId ?? null,
      keggedAt: row.kegged_at,
      endedAt: row.ended_at,
      createdAt: row.created_at,
      startVolume: distance === null ? null : (vesselFill(distance, this.pills.vessel(row.pill_id))?.volume ?? null),
    };
  }
}
