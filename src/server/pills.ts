import { EventEmitter } from 'node:events';
import {
  DEFAULT_PILL_MODEL,
  PILL_COLORS,
  SMOOTHING_MS,
  fitTilt,
  normalizeAddress,
  pillIdFromAddress,
  plausibleGravity,
  raptIdFromAddress,
  slopePerDay,
  tiltGravity,
  type Brew,
  type CatchRate,
  type NearbyPill,
  type Offsets,
  type Pill,
  type PillInfo,
  type PillModel,
  type Reading,
} from '@rapthooker/shared';
import type { ClockGuard } from './clock.js';
import { FLAG_IMPLAUSIBLE, tiltOf, type RawReading, type Store } from './db.js';
import type { Logger } from './log.js';
import { decodeRapt, fingerprintOf } from './ble/rapt.js';
import type { Advert } from './ble/scanner.js';

interface PillConfig {
  name: string;
  color: string;
  archived: boolean;
  offsets: Offsets;
  model: PillModel;
  order: number;
  info: PillInfo;
}

/** Values RaptHooker works out from the stored readings, refreshed with each new reading. */
interface Derived {
  /** RaptHooker's velocity over the model's window. */
  velocity: number | null;
  /** Average plausible gravity over the smoothing window. */
  smoothed: number | null;
  caught: CatchRate | null;
}

export interface PillPatch {
  name?: string;
  color?: string;
  offsets?: Offsets;
  archived?: boolean;
  model?: Partial<Omit<PillModel, 'tiltPoly'>>;
  order?: number;
}

interface PillState {
  id: string;
  address: string;
  raptId: string;
  createdAt: number;
  config: PillConfig;
  lastHeardAt: number | null;
  lastReadingAt: number | null;
  firstReadingAt: number | null;
  rssi: number | null;
  latest: RawReading | null;
  /** Fingerprints of the last few readings: a pill re-sends its previous reading before each new one. */
  recent: string[];
  gaps: number[];
  online: boolean;
  derived: Derived;
  /** A new reading held back for a moment in case another follows (see hold()). */
  held: { raw: RawReading; timer: NodeJS.Timeout } | null;
}

interface NearbyState {
  address: string;
  firstHeardAt: number;
  lastHeardAt: number;
  rssi: number | null;
  latest: RawReading | null;
  info: PillInfo;
}

interface Pending {
  pillId: string;
  raw: RawReading;
  mono: number;
}

export class PillError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

const RECENT = 6;
const GAPS = 15;
const NEARBY_EXPIRY_MS = 15 * 60_000;
const IGNORED_KEY = 'ignoredAddresses';
const MAX_PENDING = 2000;

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

const NO_DERIVED: Derived = { velocity: null, smoothed: null, caught: null };

/** FLAG_* bits for a reading as the pill sent it. */
export const flagsOf = (sg: number): number => (plausibleGravity(sg) ? 0 : FLAG_IMPLAUSIBLE);

const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/** The gravity a pill's model uses for a stored reading (offset applied), before smoothing. */
export function modelGravity(raw: Pick<RawReading, 'sg' | 'x' | 'y' | 'z'>, offsets: Offsets, model: PillModel): number {
  const fromTilt = tiltGravity(model, tiltOf(raw.x, raw.y, raw.z));
  return (fromTilt ?? raw.sg) + offsets.gravity;
}

/**
 * A stored reading as shown and sent: offsets applied, gravity and velocity from wherever the pill's model says
 * (with `derived` holding RaptHooker's own values for the latest reading).
 */
export function calibrate(
  raw: RawReading,
  offsets: Offsets,
  model: PillModel = DEFAULT_PILL_MODEL,
  derived: Derived = NO_DERIVED,
): Reading {
  const pillGravity = r6(raw.sg + offsets.gravity);
  let gravity = r6(modelGravity(raw, offsets, model));
  const plausible = (raw.flags & FLAG_IMPLAUSIBLE) === 0 && plausibleGravity(gravity);
  if (plausible && model.smoothing !== 'off' && derived.smoothed !== null) gravity = r6(derived.smoothed);
  return {
    ts: raw.ts,
    gravity,
    temperature: Math.round((raw.temp + offsets.temperature) * 1e4) / 1e4,
    velocity: model.velocitySource === 'computed' ? derived.velocity : raw.velocity,
    battery: raw.battery,
    rssi: raw.rssi,
    tilt: tiltOf(raw.x, raw.y, raw.z),
    x: raw.x,
    y: raw.y,
    z: raw.z,
    plausible,
    pillGravity,
    pillVelocity: raw.velocity,
  };
}

/** Fills in what older saved configs don't have. */
function upgradeConfig(c: Partial<PillConfig> & Pick<PillConfig, 'name' | 'color' | 'offsets' | 'info'>, order: number): PillConfig {
  const model = { ...DEFAULT_PILL_MODEL, ...c.model };
  return { archived: false, ...c, model: { ...model, tiltPoly: fitTilt(model.tiltPoints) }, order: c.order ?? order };
}

/**
 * Pills you've added (recorded around the clock, brew or not) and pills heard nearby that you haven't.
 * Emits 'pill' (Pill), 'reading' (pillId, Reading), 'removed' (pillId) and 'nearby' ().
 */
export class PillService extends EventEmitter {
  private readonly pills = new Map<string, PillState>();
  private readonly byAddress = new Map<string, string>();
  private readonly nearbyPills = new Map<string, NearbyState>();
  private readonly nearbyRecent = new Map<string, string[]>();
  private ignored = new Set<string>();
  private pending: Pending[] = [];
  private timer: NodeJS.Timeout | undefined;
  private readonly holdMs: number;
  brewOf: (pillId: string) => Brew | null = () => null;

  constructor(
    private readonly store: Store,
    private readonly clock: ClockGuard,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
    opts: { holdMs?: number } = {},
  ) {
    super();
    this.holdMs = opts.holdMs ?? 0;
    clock.on('trusted', () => this.flushPending());
  }

  load(): void {
    this.ignored = new Set(JSON.parse(this.store.getMeta(IGNORED_KEY) ?? '[]') as string[]);
    this.store.listPillRows().forEach((row, index) => {
      const config = upgradeConfig(JSON.parse(row.json) as PillConfig, index);
      const recentRows = this.store.latestReadings(row.id, GAPS + 1);
      const ts = recentRows.map((r) => r.ts).reverse();
      const gaps = ts
        .slice(1)
        .map((t, i) => t - ts[i]!)
        .filter((g) => g > 5000 && g < 6 * 3_600_000);
      const latest = recentRows[0] ?? null;
      const state: PillState = {
        id: row.id,
        address: row.address,
        raptId: raptIdFromAddress(row.address),
        createdAt: row.created_at,
        config,
        lastHeardAt: latest?.ts ?? null,
        lastReadingAt: latest?.ts ?? null,
        firstReadingAt: latest ? this.store.firstReadingTs(row.id) : null,
        rssi: latest?.rssi ?? null,
        latest,
        recent: recentRows.slice(0, RECENT).map((r) => fingerprintOf(r)),
        gaps,
        online: false,
        derived: NO_DERIVED,
        held: null,
      };
      state.online = this.isOnline(state);
      this.refreshDerived(state);
      this.pills.set(row.id, state);
      this.byAddress.set(row.address, row.id);
    });
  }

  start(): void {
    this.timer = setInterval(() => this.tick(), 30_000);
    this.timer.unref();
  }

  /** Stops the timers and stores any reading being held back. */
  stop(): void {
    clearInterval(this.timer);
    for (const s of this.pills.values()) this.releaseHeld(s);
  }

  // Views

  list(): Pill[] {
    return [...this.pills.values()].sort((a, b) => a.config.order - b.config.order || a.createdAt - b.createdAt).map((s) => this.view(s));
  }

  get(id: string): Pill | null {
    const s = this.pills.get(id);
    return s ? this.view(s) : null;
  }

  has(id: string): boolean {
    return this.pills.has(id);
  }

  /** Pills being recorded (not archived). */
  activeIds(): string[] {
    return [...this.pills.values()].filter((s) => !s.config.archived).map((s) => s.id);
  }

  offsets(id: string): Offsets {
    return this.pills.get(id)?.config.offsets ?? { gravity: 0, temperature: 0 };
  }

  model(id: string): PillModel {
    return this.pills.get(id)?.config.model ?? DEFAULT_PILL_MODEL;
  }

  latest(id: string): Reading | null {
    const s = this.pills.get(id);
    return s?.latest ? calibrate(s.latest, s.config.offsets, s.config.model, s.derived) : null;
  }

  intervalSec(id: string): number | null {
    const s = this.pills.get(id);
    const m = s ? median(s.gaps) : null;
    return m === null ? null : Math.round(m / 1000);
  }

  lastHeardAt(id: string): number | null {
    return this.pills.get(id)?.lastHeardAt ?? null;
  }

  /** Gap in readings that counts as missing data on a chart. */
  gapMs(id: string): number {
    const interval = this.intervalSec(id);
    return Math.min(3 * 3_600_000, Math.max(10 * 60_000, (interval ?? 300) * 4000));
  }

  nearby(): NearbyPill[] {
    return [...this.nearbyPills.values()]
      .filter((n) => !this.ignored.has(n.address))
      .sort((a, b) => a.firstHeardAt - b.firstHeardAt)
      .map((n) => ({
        address: n.address,
        raptId: raptIdFromAddress(n.address),
        firstHeardAt: n.firstHeardAt,
        lastHeardAt: n.lastHeardAt,
        rssi: n.rssi,
        latest: n.latest ? calibrate(n.latest, { gravity: 0, temperature: 0 }) : null,
        info: n.info,
      }));
  }

  ignoredAddresses(): string[] {
    return [...this.ignored];
  }

  private view(s: PillState): Pill {
    return {
      id: s.id,
      address: s.address,
      raptId: s.raptId,
      name: s.config.name,
      color: s.config.color,
      createdAt: s.createdAt,
      archived: s.config.archived,
      offsets: s.config.offsets,
      model: s.config.model,
      order: s.config.order,
      info: s.config.info,
      live: {
        lastHeardAt: s.lastHeardAt,
        lastReadingAt: s.lastReadingAt,
        firstReadingAt: s.firstReadingAt,
        online: s.online,
        rssi: s.rssi,
        intervalSec: this.intervalSec(s.id),
        latest: s.latest ? calibrate(s.latest, s.config.offsets, s.config.model, s.derived) : null,
        computedVelocity: s.derived.velocity,
        caught: s.derived.caught,
      },
      brew: this.brewOf(s.id),
    };
  }

  /**
   * Works out RaptHooker's own values for the latest reading: velocity from a straight line through the plausible
   * readings over the model's window, the smoothed gravity, and how many readings were caught.
   */
  private refreshDerived(s: PillState): void {
    const latest = s.latest;
    if (!latest) {
      s.derived = NO_DERIVED;
      return;
    }
    const { model, offsets } = s.config;
    const velocityMs = model.velocityHours * 3_600_000;
    const smoothMs = SMOOTHING_MS[model.smoothing];
    const ts: number[] = [];
    const gravity: number[] = [];
    let sum = 0;
    let n = 0;
    for (const r of this.store.iterateReadings(s.id, latest.ts - Math.max(velocityMs, smoothMs), latest.ts)) {
      if (r.flags & FLAG_IMPLAUSIBLE) continue;
      const g = modelGravity(r, offsets, model);
      if (!plausibleGravity(g)) continue;
      if (r.ts >= latest.ts - velocityMs) {
        ts.push(r.ts);
        gravity.push(g);
      }
      if (smoothMs > 0 && r.ts >= latest.ts - smoothMs) {
        sum += g;
        n++;
      }
    }
    const velocity = slopePerDay(ts, gravity);
    s.derived = {
      velocity: velocity === null ? null : Math.round(velocity * 100) / 100,
      smoothed: n > 0 ? sum / n : null,
      caught: this.catchRate(s),
    };
  }

  /** Readings stored vs transmissions expected from the learned interval, over the last day this hub has been running. */
  private catchRate(s: PillState): CatchRate | null {
    const interval = median(s.gaps);
    if (interval === null || s.firstReadingAt === null) return null;
    const now = this.now();
    // Since this process started (by the synced clock, so a power cut doesn't count as missed readings).
    const started = this.clock.trusted ? this.clock.startedAt : now;
    const since = Math.max(now - 24 * 3_600_000, s.firstReadingAt, started);
    const expected = Math.floor((now - since) / interval) + (since === s.firstReadingAt ? 1 : 0);
    if (expected < 3) return null;
    const received = this.store.countReadings(s.id, since);
    return { since, expected: Math.max(expected, received), received };
  }

  private onlineWindowMs(s: PillState): number {
    const m = median(s.gaps);
    return m === null ? 20 * 60_000 : Math.min(6 * 3_600_000, Math.max(5 * 60_000, m * 3));
  }

  private isOnline(s: PillState): boolean {
    return s.lastHeardAt !== null && this.now() - s.lastHeardAt < this.onlineWindowMs(s);
  }

  private save(s: PillState): void {
    this.store.savePill(s.id, s.address, s.config, s.createdAt);
  }

  private emitPill(s: PillState): void {
    this.emit('pill', this.view(s));
  }

  // Changes from the app

  adopt(address: string, input: { name?: string; color?: string }): Pill {
    const addr = normalizeAddress(address);
    if (!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(addr)) throw new PillError('That is not a Bluetooth address');
    const existingId = this.byAddress.get(addr);
    if (existingId) {
      const s = this.pills.get(existingId)!;
      if (!s.config.archived) throw new PillError('That pill has already been added', 409);
      return this.update(existingId, { archived: false, ...(input.name ? { name: input.name } : {}) });
    }
    const id = pillIdFromAddress(addr);
    const near = this.nearbyPills.get(addr);
    const used = new Set([...this.pills.values()].map((p) => p.config.color));
    const raptId = raptIdFromAddress(addr);
    const config: PillConfig = {
      name: input.name?.trim() || `RAPT Pill ${raptId.slice(-5).replace(':', '')}`,
      color: input.color ?? PILL_COLORS.find((c) => !used.has(c)) ?? PILL_COLORS[this.pills.size % PILL_COLORS.length]!,
      archived: false,
      offsets: { gravity: 0, temperature: 0 },
      model: { ...DEFAULT_PILL_MODEL },
      order: Math.max(-1, ...[...this.pills.values()].map((p) => p.config.order)) + 1,
      info: near?.info ?? { firmware: null, deviceType: null, payloadVersion: null },
    };
    const state: PillState = {
      id,
      address: addr,
      raptId,
      createdAt: this.now(),
      config,
      lastHeardAt: near?.lastHeardAt ?? null,
      lastReadingAt: null,
      firstReadingAt: null,
      rssi: near?.rssi ?? null,
      latest: null,
      recent: this.nearbyRecent.get(addr) ?? [],
      gaps: [],
      online: false,
      derived: NO_DERIVED,
      held: null,
    };
    // A pill removed earlier may have left nothing behind; make sure its id is free.
    this.store.deletePill(id);
    this.pills.set(id, state);
    this.byAddress.set(addr, id);
    this.save(state);
    // Start recording with what it last sent, so the dashboard isn't empty until its next transmission. Its fingerprint
    // stays in `recent` so the pill re-sending it isn't stored again. Before the clock is trusted it's only shown.
    if (near?.latest && this.now() - near.lastHeardAt < 30 * 60_000) {
      if (this.clock.trusted) {
        this.commit(state, near.latest);
      } else {
        state.latest = near.latest;
        state.recent = state.recent.filter((f) => f !== fingerprintOf(near.latest!));
      }
    }
    this.nearbyPills.delete(addr);
    this.nearbyRecent.delete(addr);
    state.online = this.isOnline(state);
    this.log.info({ id, address: addr }, 'pill added');
    this.emit('nearby');
    this.emitPill(state);
    return this.view(state);
  }

  update(id: string, patch: PillPatch): Pill {
    const s = this.pills.get(id);
    if (!s) throw new PillError('Unknown pill', 404);
    if (patch.name !== undefined) s.config.name = patch.name.trim() || s.config.name;
    if (patch.color !== undefined) s.config.color = patch.color;
    if (patch.offsets !== undefined) s.config.offsets = patch.offsets;
    if (patch.archived !== undefined) s.config.archived = patch.archived;
    if (patch.order !== undefined) s.config.order = patch.order;
    if (patch.model !== undefined) {
      const model = { ...s.config.model, ...patch.model };
      model.tiltPoly = fitTilt(model.tiltPoints);
      if (model.gravitySource === 'tilt' && !model.tiltPoly) {
        throw new PillError('Working out gravity from the tilt needs at least two calibration points at different tilts');
      }
      s.config.model = model;
    }
    this.save(s);
    const recalculated = patch.offsets !== undefined || patch.model !== undefined;
    if (recalculated) this.refreshDerived(s);
    this.emitPill(s);
    if (recalculated) this.emit('offsets', id);
    return this.view(s);
  }

  /** Puts pills in this order on the dashboard (pills not listed go after). */
  reorder(ids: string[]): void {
    const rank = new Map(ids.map((id, i) => [id, i]));
    const sorted = [...this.pills.values()].sort(
      (a, b) => (rank.get(a.id) ?? ids.length) - (rank.get(b.id) ?? ids.length) || a.config.order - b.config.order,
    );
    sorted.forEach((s, i) => {
      if (s.config.order === i) return;
      s.config.order = i;
      this.save(s);
      this.emitPill(s);
    });
  }

  /** Forgets a pill and deletes everything recorded from it. */
  remove(id: string): void {
    const s = this.pills.get(id);
    if (!s) throw new PillError('Unknown pill', 404);
    if (s.held) clearTimeout(s.held.timer);
    this.store.deletePill(id);
    this.pills.delete(id);
    this.byAddress.delete(s.address);
    this.pending = this.pending.filter((p) => p.pillId !== id);
    this.log.info({ id }, 'pill removed');
    this.emit('removed', id);
  }

  ignore(address: string, ignored: boolean): void {
    const addr = normalizeAddress(address);
    if (ignored) this.ignored.add(addr);
    else this.ignored.delete(addr);
    this.store.setMeta(IGNORED_KEY, JSON.stringify([...this.ignored]));
    this.emit('nearby');
  }

  // Bluetooth

  handleAdvert(a: Advert): void {
    const address = normalizeAddress(a.address);
    const id = this.byAddress.get(address);
    const s = id ? this.pills.get(id) : undefined;
    if (s?.config.archived) return;
    if (!s) {
      this.handleNearby(address, a);
      return;
    }

    if (!a.cached) {
      s.lastHeardAt = a.at;
      if (a.rssi !== null) s.rssi = a.rssi;
    }
    let changed = !a.cached;
    for (const [companyId, data] of a.manufacturer ?? []) {
      const decoded = decodeRapt(companyId, data);
      if (!decoded) continue;
      if (decoded.kind === 'firmware' && decoded.firmware !== s.config.info.firmware) {
        s.config.info = { ...s.config.info, firmware: decoded.firmware };
        this.save(s);
      } else if (decoded.kind === 'deviceType' && decoded.deviceType !== s.config.info.deviceType) {
        s.config.info = { ...s.config.info, deviceType: decoded.deviceType };
        this.save(s);
      } else if (decoded.kind === 'metrics') {
        if (decoded.metrics.version !== s.config.info.payloadVersion) {
          s.config.info = { ...s.config.info, payloadVersion: decoded.metrics.version };
          this.save(s);
        }
        if (s.recent.includes(decoded.fingerprint)) continue;
        s.recent = [decoded.fingerprint, ...s.recent].slice(0, RECENT);
        const { sg, temp, velocity, battery, x, y, z } = decoded.metrics;
        const raw: RawReading = { ts: a.at, sg, temp, velocity, battery, rssi: a.rssi ?? s.rssi, x, y, z, flags: flagsOf(sg) };
        if (a.cached) s.lastHeardAt = Math.max(s.lastHeardAt ?? 0, a.at);
        if (this.clock.trusted) {
          this.hold(s, raw);
        } else {
          // Shown straight away, stored once the clock can be trusted.
          s.latest = raw;
          if (this.pending.length < MAX_PENDING) this.pending.push({ pillId: s.id, raw, mono: a.mono });
        }
        changed = true;
      }
    }
    const wasOnline = s.online;
    s.online = this.isOnline(s);
    if (changed || wasOnline !== s.online) this.emitPill(s);
  }

  private handleNearby(address: string, a: Advert): void {
    let n = this.nearbyPills.get(address);
    if (!n) {
      // RSSI-only updates don't say it's a RAPT Pill; wait for manufacturer data.
      if (!a.manufacturer) return;
      n = {
        address,
        firstHeardAt: a.at,
        lastHeardAt: a.at,
        rssi: a.rssi,
        latest: null,
        info: { firmware: null, deviceType: null, payloadVersion: null },
      };
    }
    let isPill = false;
    for (const [companyId, data] of a.manufacturer ?? []) {
      const decoded = decodeRapt(companyId, data);
      if (!decoded) continue;
      isPill = true;
      if (decoded.kind === 'firmware') n.info = { ...n.info, firmware: decoded.firmware };
      else if (decoded.kind === 'deviceType') n.info = { ...n.info, deviceType: decoded.deviceType };
      else {
        const recent = this.nearbyRecent.get(address) ?? [];
        if (!recent.includes(decoded.fingerprint)) {
          this.nearbyRecent.set(address, [decoded.fingerprint, ...recent].slice(0, RECENT));
          const { sg, temp, velocity, battery, x, y, z } = decoded.metrics;
          n.latest = { ts: a.at, sg, temp, velocity, battery, rssi: a.rssi, x, y, z, flags: flagsOf(sg) };
        }
        n.info = { ...n.info, payloadVersion: decoded.metrics.version };
      }
    }
    if (!this.nearbyPills.has(address) && !isPill) return;
    if (!a.cached) n.lastHeardAt = a.at;
    if (a.rssi !== null) n.rssi = a.rssi;
    const isNew = !this.nearbyPills.has(address);
    this.nearbyPills.set(address, n);
    if (isNew) this.log.info({ address }, 'found a RAPT Pill nearby');
    if (!this.ignored.has(address)) this.emit('nearby');
  }

  /**
   * Each transmission repeats the previous reading before the new one. Normally the repeat is recognised and skipped,
   * but when the hub missed the previous transmission (out of range, busy, restarting) the repeat is new to us too, and
   * arrives a moment before the current reading. So a new reading is held for `holdMs`: if another new one follows, the
   * held one is really from one interval earlier and is stored with that time instead of now.
   */
  private hold(s: PillState, raw: RawReading): void {
    if (this.holdMs <= 0) {
      this.commit(s, raw);
      return;
    }
    if (s.held) {
      clearTimeout(s.held.timer);
      const held = s.held.raw;
      s.held = null;
      // Usually the held reading is the re-send and `raw` the new one, but a relay can deliver them the other way round.
      const [earlier, newer] = raw.ts < held.ts ? [raw, held] : [held, raw];
      const interval = median(s.gaps);
      const backdated = interval === null ? null : Math.round(newer.ts - interval);
      if (backdated !== null && backdated > (s.lastReadingAt ?? 0) && backdated < earlier.ts) {
        this.log.debug({ pill: s.id, by: earlier.ts - backdated }, 'stored a reading recovered from a missed transmission');
        this.commit(s, { ...earlier, ts: backdated }, { learnGap: false });
      } else {
        this.commit(s, earlier);
      }
      raw = newer;
    }
    const timer = setTimeout(() => this.releaseHeld(s), this.holdMs);
    timer.unref?.();
    s.held = { raw, timer };
  }

  private releaseHeld(s: PillState): void {
    if (!s.held) return;
    clearTimeout(s.held.timer);
    const { raw } = s.held;
    s.held = null;
    if (!this.pills.has(s.id)) return;
    this.commit(s, raw);
    this.emitPill(s);
  }

  /** Stores a new reading and tells everyone about it. */
  private commit(s: PillState, raw: RawReading, opts: { learnGap?: boolean } = {}): void {
    const last = s.lastReadingAt;
    if (last !== null && raw.ts <= last) raw = { ...raw, ts: last + 1 };
    try {
      this.store.addReading(s.id, raw);
    } catch (err) {
      this.log.error({ err: (err as Error).message, pill: s.id }, 'could not store a reading');
      return;
    }
    if (last !== null && opts.learnGap !== false) {
      const gap = raw.ts - last;
      if (gap > 5000 && gap < 6 * 3_600_000) s.gaps = [...s.gaps, gap].slice(-GAPS);
    }
    s.lastReadingAt = raw.ts;
    s.firstReadingAt ??= raw.ts;
    s.latest = raw;
    this.refreshDerived(s);
    this.emit('reading', s.id, calibrate(raw, s.config.offsets, s.config.model, s.derived));
  }

  private flushPending(): void {
    const pending = this.pending;
    this.pending = [];
    if (pending.length) this.log.info({ readings: pending.length }, 'clock trusted: storing readings held since start-up');
    for (const p of pending) {
      const s = this.pills.get(p.pillId);
      if (!s) continue;
      this.commit(s, { ...p.raw, ts: this.clock.wallTime(p.mono) });
      this.emitPill(s);
    }
  }

  /** Online/offline changes and forgetting pills no longer heard nearby. */
  tick(): void {
    for (const s of this.pills.values()) {
      const online = this.isOnline(s);
      if (online !== s.online) {
        s.online = online;
        this.emitPill(s);
      }
    }
    let changed = false;
    for (const [address, n] of this.nearbyPills) {
      if (this.now() - n.lastHeardAt > NEARBY_EXPIRY_MS) {
        this.nearbyPills.delete(address);
        this.nearbyRecent.delete(address);
        changed = true;
      }
    }
    if (changed) this.emit('nearby');
  }
}
