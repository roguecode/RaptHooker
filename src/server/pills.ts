import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_PILL_MODEL,
  DEFAULT_VESSEL,
  PILL_COLORS,
  SMOOTHING_MS,
  TILT_COLOR_HEX,
  fitTilt,
  isIspindelAddress,
  measuresGravity,
  normalizeAddress,
  pillIdFromAddress,
  plausibleGravity,
  raptIdFromAddress,
  slopePerDay,
  tiltGravity,
  vesselFill,
  type Brew,
  type CatchRate,
  type ChartExclusion,
  type DeviceKind,
  type Keg,
  type NearbyPill,
  type Offsets,
  type Pill,
  type PillInfo,
  type PillModel,
  type Reading,
  type ServingUnit,
  type Vessel,
} from '@rapthooker/shared';
import type { ClockGuard } from './clock.js';
import { FLAG_IMPLAUSIBLE, readingTilt, type RawReading, type Store } from './db.js';
import type { Logger } from './log.js';
import { fingerprintOf } from './ble/rapt.js';
import { decodeAdvert, type DeviceAdvert } from './ble/devices.js';
import type { Advert } from './ble/scanner.js';
import type { IspindelDecoded } from './ispindel/decode.js';

interface PillConfig {
  kind: DeviceKind;
  name: string;
  color: string;
  archived: boolean;
  offsets: Offsets;
  model: PillModel;
  order: number;
  info: PillInfo;
  exclusions: ChartExclusion[];
  /** The keg under a RAPT Laser Level (Laser Levels only). */
  vessel?: Vessel;
  /** A Laser Level's own unit for how much is left. */
  servingUnit?: ServingUnit | null;
}

/** Values RaptHooker works out from the stored readings, refreshed with each new reading. */
export interface Derived {
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
  vessel?: Vessel;
  servingUnit?: ServingUnit | null;
}

interface PillState {
  id: string;
  address: string;
  raptId: string;
  createdAt: number;
  config: PillConfig;
  lastHeardAt: number | null;
  /** When (performance.now()) it was last heard, to put `lastHeardAt` right once the clock is set. */
  lastHeardMono: number | null;
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
  /** A thermometer's temperature as last decoded (BlueZ only passes it on when it changes), °C. */
  thermo: number | null;
  /** When (performance.now()) the advert `thermo` came from was heard: a relay's late copy of an older one doesn't count. */
  thermoMono: number | null;
  /** When (performance.now()) a thermometer's temperature was last taken as a reading (see sampleDue()). */
  lastSampleMono: number | null;
  /** A Tilt's or Laser Level's reading as last decoded, taken as a reading once a minute like a thermometer's. */
  beacon: Beacon | null;
  beaconMono: number | null;
}

/** What a Tilt or Laser Level last sent: a reading without its time and signal. */
type Beacon = Omit<RawReading, 'ts' | 'rssi'>;

interface NearbyState {
  address: string;
  kind: DeviceKind;
  firstHeardAt: number;
  lastHeardAt: number;
  lastHeardMono: number | null;
  rssi: number | null;
  latest: RawReading | null;
  info: PillInfo;
  thermo: number | null;
  thermoMono: number | null;
  lastSampleMono: number | null;
  beacon: Beacon | null;
  beaconMono: number | null;
  /** The name it gives itself (iSpindels). */
  name: string | null;
  /** How long it stays listed after it was last heard (iSpindels only post every so often). */
  expiryMs: number;
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
/** Ranges left out of one device's charts. */
const MAX_EXCLUSIONS = 200;
/** A thermometer broadcasts about once a second; one reading a minute is recorded. */
export const THERMOMETER_SAMPLE_MS = 60_000;

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

const NO_DERIVED: Derived = { velocity: null, smoothed: null, caught: null };
const NO_INFO: PillInfo = { firmware: null, deviceType: null, payloadVersion: null };
const ISPINDEL_INFO: PillInfo = { firmware: null, deviceType: 'iSpindel', payloadVersion: null };

/** How long an iSpindel stays listed nearby after a post: a few of its intervals (it only posts every so often). */
const ispindelExpiryMs = (intervalSec: number | null): number =>
  Math.min(3 * 3_600_000, Math.max(NEARBY_EXPIRY_MS, (intervalSec ?? 900) * 2500 + 5 * 60_000));

/** FLAG_* bits for a reading as the pill sent it. */
export const flagsOf = (sg: number): number => (plausibleGravity(sg) ? 0 : FLAG_IMPLAUSIBLE);

/** A thermometer's reading: it measures only the temperature (and the hub the signal). */
export const thermometerReading = (ts: number, temp: number, rssi: number | null): RawReading => ({
  ts,
  sg: null,
  temp,
  velocity: null,
  battery: null,
  rssi,
  x: null,
  y: null,
  z: null,
  flags: 0,
});

/**
 * Whether a thermometer heard at `mono` (performance.now()) should have its temperature taken as a reading: once a
 * minute. Monotonic time, as a relay's adverts arrive backdated (and the wall clock can jump).
 */
const sampleDue = (lastMono: number | null, mono: number): boolean => lastMono === null || mono - lastMono >= THERMOMETER_SAMPLE_MS;

/** Takes a thermometer's temperature from an advert, unless what it has is from a later one (a relay's can arrive late). */
function takeThermo(t: { thermo: number | null; thermoMono: number | null }, temp: number, a: Advert): void {
  // BlueZ's cache at start-up holds the data it last heard, so it's a start until the thermometer is heard.
  if (a.cached) {
    if (t.thermoMono === null) t.thermo = temp;
    return;
  }
  if (t.thermoMono !== null && a.mono < t.thermoMono) return;
  t.thermo = temp;
  t.thermoMono = a.mono;
}

/** What the RAPT app calls a pill (the Bluetooth address with 2 off the last octet); thermometers go by their address. */
const raptIdOf = (kind: DeviceKind, address: string): string => (kind === 'pill' ? raptIdFromAddress(address) : address);

/** The kind of device an advert comes from. */
const kindOfAdvert = (d: DeviceAdvert): DeviceKind =>
  d.kind === 'thermometer' ? 'thermometer' : d.kind === 'tilt' ? 'tilt' : d.kind === 'laser' ? 'laser-level' : 'pill';

/** Kinds that broadcast all the time and are taken as a reading once a minute (see sampleDue()). */
const BEACON_KINDS: ReadonlySet<DeviceKind> = new Set<DeviceKind>(['tilt', 'laser-level']);

/** What the log calls a device found nearby. */
const FOUND: Partial<Record<DeviceKind, string>> = { thermometer: 'RAPT Thermometer', tilt: 'Tilt', 'laser-level': 'RAPT Laser Level' };

/** A Tilt's or Laser Level's reading in an advert, if it has one (a Laser Level needs its distance and temperature). */
function beaconOf(d: DeviceAdvert): Beacon | null {
  if (d.kind === 'tilt') {
    const { sg, temp } = d.metrics;
    return { sg, temp, velocity: null, battery: null, x: null, y: null, z: null, flags: flagsOf(sg) };
  }
  if (d.kind === 'laser' && d.laser.distance !== null && d.laser.temp !== null) {
    const { distance, temp, battery } = d.laser;
    return { sg: null, temp, velocity: null, battery, x: null, y: null, z: null, distance, flags: 0 };
  }
  return null;
}

/** Takes a beacon reading from an advert, unless what it has is from a later one (as takeThermo()). */
function takeBeacon(t: { beacon: Beacon | null; beaconMono: number | null }, beacon: Beacon, a: Advert): void {
  if (a.cached) {
    if (t.beaconMono === null) t.beacon = beacon;
    return;
  }
  if (t.beaconMono !== null && a.mono < t.beaconMono) return;
  t.beacon = beacon;
  t.beaconMono = a.mono;
}

/** What an advert says about the device itself: a Tilt's colour, a Laser Level's firmware. */
function infoFrom(d: DeviceAdvert, info: PillInfo): PillInfo {
  if (d.kind === 'tilt') {
    const deviceType = `Tilt ${d.metrics.pro ? 'Pro ' : ''}${d.metrics.color}`;
    return info.deviceType === deviceType ? info : { ...info, deviceType };
  }
  if (d.kind === 'laser') {
    const firmware = d.laser.firmware ?? info.firmware;
    return info.firmware === firmware && info.deviceType === 'RAPT Laser Level'
      ? info
      : { ...info, firmware, deviceType: 'RAPT Laser Level' };
  }
  return info;
}

/**
 * The kinds of device this version understands. One added by a newer version (and kept after going back to this one)
 * is listed, but nothing is recorded for it and its kind isn't changed.
 */
const KNOWN_KINDS: ReadonlySet<string> = new Set<DeviceKind>(['pill', 'thermometer', 'ispindel', 'tilt', 'laser-level']);

const shortAddress = (address: string) => address.slice(-5).replace(':', '');

const defaultName = (kind: DeviceKind, address: string): string =>
  kind === 'pill'
    ? `RAPT Pill ${raptIdFromAddress(address).slice(-5).replace(':', '')}`
    : kind === 'ispindel'
      ? `iSpindel ${address.slice(-6)}`
      : kind === 'tilt'
        ? `Tilt ${shortAddress(address)}`
        : kind === 'laser-level'
          ? `RAPT Laser Level ${shortAddress(address)}`
          : `RAPT Thermometer ${shortAddress(address)}`;

/** A Bluetooth address, or an iSpindel's (ISPINDEL: and its chip id in hex). */
const validAddress = (addr: string): boolean => /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(addr) || /^ISPINDEL:[0-9A-F]{6,8}$/.test(addr);

const r6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/** The gravity a pill's model uses for a stored reading (offset applied), before smoothing; null if it has none. */
export function modelGravity(
  raw: { sg: number | null; x: number | null; y: number | null; z: number | null; tilt?: number | null },
  offsets: Offsets,
  model: PillModel,
): number | null {
  const fromTilt = tiltGravity(model, readingTilt(raw));
  const g = fromTilt ?? raw.sg;
  return g === null ? null : g + offsets.gravity;
}

/**
 * RaptHooker's own values at a reading's time `ts`: velocity from a straight line through the plausible readings over
 * the model's window, and the gravity averaged over its smoothing window.
 */
export function deriveAt(
  store: Store,
  pillId: string,
  ts: number,
  offsets: Offsets,
  model: PillModel,
): Pick<Derived, 'velocity' | 'smoothed'> {
  const velocityMs = model.velocityHours * 3_600_000;
  const smoothMs = SMOOTHING_MS[model.smoothing];
  const times: number[] = [];
  const gravity: number[] = [];
  let sum = 0;
  let n = 0;
  for (const r of store.iterateReadings(pillId, ts - Math.max(velocityMs, smoothMs), ts)) {
    if (r.flags & FLAG_IMPLAUSIBLE) continue;
    const g = modelGravity(r, offsets, model);
    if (g === null || !plausibleGravity(g)) continue;
    if (r.ts >= ts - velocityMs) {
      times.push(r.ts);
      gravity.push(g);
    }
    if (smoothMs > 0 && r.ts >= ts - smoothMs) {
      sum += g;
      n++;
    }
  }
  const velocity = slopePerDay(times, gravity);
  return { velocity: velocity === null ? null : Math.round(velocity * 100) / 100, smoothed: n > 0 ? sum / n : null };
}

/**
 * A stored reading as shown and sent: offsets applied, gravity and velocity from wherever the pill's model says
 * (with `derived` holding RaptHooker's own values for the latest reading). What the device doesn't measure is null.
 */
export function calibrate(
  raw: RawReading,
  offsets: Offsets,
  model: PillModel = DEFAULT_PILL_MODEL,
  derived: Derived = NO_DERIVED,
  vessel: Vessel = DEFAULT_VESSEL,
): Reading {
  const temperature = Math.round((raw.temp + offsets.temperature) * 1e4) / 1e4;
  const pillGravity = raw.sg === null ? null : r6(raw.sg + offsets.gravity);
  const modelled = modelGravity(raw, offsets, model);
  let gravity = modelled === null ? null : r6(modelled);
  const plausible = gravity === null || ((raw.flags & FLAG_IMPLAUSIBLE) === 0 && plausibleGravity(gravity));
  if (gravity !== null && plausible && model.smoothing !== 'off' && derived.smoothed !== null) gravity = r6(derived.smoothed);
  return {
    ts: raw.ts,
    gravity,
    temperature,
    velocity: gravity === null ? null : model.velocitySource === 'computed' ? derived.velocity : raw.velocity,
    battery: raw.battery,
    voltage: raw.voltage ?? null,
    rssi: raw.rssi,
    tilt: readingTilt(raw),
    x: raw.x,
    y: raw.y,
    z: raw.z,
    plausible,
    pillGravity,
    pillVelocity: gravity === null ? null : raw.velocity,
    // A Laser Level's: how far down the beer is, and so how full its keg is.
    ...(raw.distance !== null && raw.distance !== undefined ? laserValues(raw.distance, vessel) : {}),
  };
}

const laserValues = (distance: number, vessel: Vessel): Pick<Reading, 'distance' | 'fill' | 'volume'> => {
  const v = vesselFill(distance, vessel);
  return { distance, fill: v?.fill ?? null, volume: v?.volume ?? null };
};

/** Fills in what older saved configs don't have. */
function upgradeConfig(c: Partial<PillConfig> & Pick<PillConfig, 'name' | 'color' | 'offsets' | 'info'>, order: number): PillConfig {
  const model = { ...DEFAULT_PILL_MODEL, ...c.model };
  return {
    kind: 'pill',
    archived: false,
    ...c,
    model: { ...model, tiltPoly: fitTilt(model.tiltPoints) },
    order: c.order ?? order,
    exclusions: Array.isArray(c.exclusions) ? c.exclusions : [],
    ...(c.kind === 'laser-level' ? { vessel: { ...DEFAULT_VESSEL, ...c.vessel } } : {}),
  };
}

/**
 * Pills and thermometers you've added (recorded around the clock, brew or not) and ones heard nearby that you haven't.
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
  /** The beer kegged under a Laser Level (set by KegService). */
  kegOf: (pillId: string) => Keg | null = () => null;

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
        raptId: raptIdOf(config.kind, row.address),
        createdAt: row.created_at,
        config,
        lastHeardAt: latest?.ts ?? null,
        lastHeardMono: null,
        lastReadingAt: latest?.ts ?? null,
        firstReadingAt: latest ? this.store.firstReadingTs(row.id) : null,
        rssi: latest?.rssi ?? null,
        latest,
        recent: recentRows.slice(0, RECENT).map((r) => fingerprintOf(r)),
        gaps,
        online: false,
        derived: NO_DERIVED,
        held: null,
        thermo: null,
        thermoMono: null,
        lastSampleMono: null,
        beacon: null,
        beaconMono: null,
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

  kind(id: string): DeviceKind | null {
    return this.pills.get(id)?.config.kind ?? null;
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

  /** The keg under a Laser Level (the default one for other devices, which have no use for it). */
  vessel(id: string): Vessel {
    return this.pills.get(id)?.config.vessel ?? DEFAULT_VESSEL;
  }

  /** Ranges left out of the pill's charts. */
  exclusions(id: string): ChartExclusion[] {
    return this.pills.get(id)?.config.exclusions ?? [];
  }

  latest(id: string): Reading | null {
    const s = this.pills.get(id);
    return s?.latest ? calibrate(s.latest, s.config.offsets, s.config.model, s.derived, s.config.vessel) : null;
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
        kind: n.kind,
        raptId: raptIdOf(n.kind, n.address),
        name: n.name,
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
      kind: s.config.kind,
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
      exclusions: s.config.exclusions,
      ...(s.config.vessel ? { vessel: s.config.vessel } : {}),
      ...(s.config.kind === 'laser-level' ? { servingUnit: s.config.servingUnit ?? null } : {}),
      live: {
        lastHeardAt: s.lastHeardAt,
        lastReadingAt: s.lastReadingAt,
        firstReadingAt: s.firstReadingAt,
        online: s.online,
        rssi: s.rssi,
        intervalSec: this.intervalSec(s.id),
        latest: s.latest ? calibrate(s.latest, s.config.offsets, s.config.model, s.derived, s.config.vessel) : null,
        computedVelocity: s.derived.velocity,
        caught: s.derived.caught,
      },
      brew: this.brewOf(s.id),
      ...(s.config.kind === 'laser-level' ? { keg: this.kegOf(s.id) } : {}),
    };
  }

  /**
   * Works out RaptHooker's own values for the latest reading (see deriveAt()), and how many readings were caught.
   */
  private refreshDerived(s: PillState): void {
    const latest = s.latest;
    if (!latest) {
      s.derived = NO_DERIVED;
      return;
    }
    if (!measuresGravity(s.config.kind)) {
      s.derived = { ...NO_DERIVED, caught: this.catchRate(s) };
      return;
    }
    s.derived = { ...deriveAt(this.store, s.id, latest.ts, s.config.offsets, s.config.model), caught: this.catchRate(s) };
  }

  /** RaptHooker's own values at an earlier reading's time, for sending it later (webhook catch-up). */
  derivedAt(id: string, ts: number): Derived {
    const s = this.pills.get(id);
    if (!s || !measuresGravity(s.config.kind)) return NO_DERIVED;
    const { model, offsets } = s.config;
    if (model.velocitySource !== 'computed' && model.smoothing === 'off') return NO_DERIVED;
    return { ...deriveAt(this.store, id, ts, offsets, model), caught: null };
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
    if (!validAddress(addr)) throw new PillError('That is not a Bluetooth address');
    const existingId = this.byAddress.get(addr);
    if (existingId) {
      const s = this.pills.get(existingId)!;
      if (!s.config.archived) throw new PillError('That pill has already been added', 409);
      return this.update(existingId, { archived: false, ...(input.name ? { name: input.name } : {}) });
    }
    const id = pillIdFromAddress(addr);
    const near = this.nearbyPills.get(addr);
    const used = new Set([...this.pills.values()].map((p) => p.config.color));
    // Added by address before it was heard, it's taken to be a pill until it turns out otherwise (see settleKind()).
    const kind = isIspindelAddress(addr) ? 'ispindel' : (near?.kind ?? 'pill');
    // A Tilt is known by its colour ("Tilt Red"), which it's given in the app too.
    const tiltColor = kind === 'tilt' ? near?.info.deviceType?.split(' ').pop() : undefined;
    const config: PillConfig = {
      kind,
      name: input.name?.trim() || near?.name || (kind === 'tilt' ? near?.info.deviceType : null) || defaultName(kind, addr),
      color:
        input.color ??
        (tiltColor && TILT_COLOR_HEX[tiltColor]) ??
        PILL_COLORS.find((c) => !used.has(c)) ??
        PILL_COLORS[this.pills.size % PILL_COLORS.length]!,
      archived: false,
      offsets: { gravity: 0, temperature: 0 },
      // An iSpindel or a Tilt doesn't send a velocity: RaptHooker works it out.
      model: kind === 'ispindel' || kind === 'tilt' ? { ...DEFAULT_PILL_MODEL, velocitySource: 'computed' } : { ...DEFAULT_PILL_MODEL },
      order: Math.max(-1, ...[...this.pills.values()].map((p) => p.config.order)) + 1,
      info: near?.info ?? (kind === 'ispindel' ? ISPINDEL_INFO : NO_INFO),
      exclusions: [],
      ...(kind === 'laser-level' ? { vessel: { ...DEFAULT_VESSEL } } : {}),
    };
    const state: PillState = {
      id,
      address: addr,
      raptId: raptIdOf(kind, addr),
      createdAt: this.now(),
      config,
      lastHeardAt: near?.lastHeardAt ?? null,
      lastHeardMono: near?.lastHeardMono ?? null,
      lastReadingAt: null,
      firstReadingAt: null,
      rssi: near?.rssi ?? null,
      latest: null,
      recent: this.nearbyRecent.get(addr) ?? [],
      gaps: [],
      online: false,
      derived: NO_DERIVED,
      held: null,
      thermo: near?.thermo ?? null,
      thermoMono: near?.thermoMono ?? null,
      lastSampleMono: near?.lastSampleMono ?? null,
      beacon: near?.beacon ?? null,
      beaconMono: near?.beaconMono ?? null,
    };
    // A pill removed earlier may have left nothing behind; make sure its id is free.
    this.store.deletePill(id);
    this.pills.set(id, state);
    this.byAddress.set(addr, id);
    this.save(state);
    // Start recording with what it last sent, so the dashboard isn't empty until its next transmission. Its fingerprint
    // stays in `recent` so the pill re-sending it isn't stored again. Before the clock is trusted it's only shown.
    if (near?.latest && this.now() - near.lastHeardAt < Math.max(30 * 60_000, near.expiryMs)) {
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
    // Checked before anything changes, so a rejected patch leaves the pill as it was.
    let model: PillModel | undefined;
    if (patch.model !== undefined) {
      model = { ...s.config.model, ...patch.model };
      model.tiltPoly = fitTilt(model.tiltPoints);
      if (model.gravitySource === 'tilt' && !model.tiltPoly) {
        throw new PillError('Working out gravity from the tilt needs at least two calibration points at different tilts');
      }
    }
    if (patch.vessel !== undefined && s.config.kind !== 'laser-level') throw new PillError('Only a RAPT Laser Level has a keg to set up');
    if (patch.servingUnit !== undefined && s.config.kind !== 'laser-level')
      throw new PillError('Only a RAPT Laser Level has a unit of its own');
    if (patch.name !== undefined) s.config.name = patch.name.trim() || s.config.name;
    if (patch.color !== undefined) s.config.color = patch.color;
    if (patch.offsets !== undefined) s.config.offsets = patch.offsets;
    if (patch.archived !== undefined) s.config.archived = patch.archived;
    if (patch.order !== undefined) s.config.order = patch.order;
    if (model) s.config.model = model;
    if (patch.vessel !== undefined) s.config.vessel = { ...patch.vessel };
    if (patch.servingUnit !== undefined) s.config.servingUnit = patch.servingUnit ? { ...patch.servingUnit } : null;
    this.save(s);
    const recalculated = patch.offsets !== undefined || patch.model !== undefined;
    if (recalculated) this.refreshDerived(s);
    this.emitPill(s);
    if (recalculated) this.emit('offsets', id);
    return this.view(s);
  }

  /**
   * Leaves a range out of the pill's charts. Ranges it overlaps or touches become one with it, so no reading is under
   * two exclusions. The readings themselves are kept.
   */
  addExclusion(id: string, range: { from: number; to: number }): Pill {
    const s = this.pills.get(id);
    if (!s) throw new PillError('Unknown pill', 404);
    if (!(range.to > range.from)) throw new PillError('The end of the range has to be after its start');
    const existing = s.config.exclusions;
    if (existing.some((e) => e.from <= range.from && e.to >= range.to)) return this.view(s);
    let merged = { from: range.from, to: range.to };
    let rest = existing;
    for (;;) {
      const touching = rest.filter((e) => e.from <= merged.to && e.to >= merged.from);
      if (touching.length === 0) break;
      merged = {
        from: Math.min(merged.from, ...touching.map((e) => e.from)),
        to: Math.max(merged.to, ...touching.map((e) => e.to)),
      };
      rest = rest.filter((e) => !touching.includes(e));
    }
    if (rest.length >= MAX_EXCLUSIONS) throw new PillError(`A device can have up to ${MAX_EXCLUSIONS} excluded ranges: remove one first`);
    s.config.exclusions = [...rest, { id: randomUUID(), ...merged, createdAt: this.now() }].sort((a, b) => a.from - b.from);
    this.save(s);
    this.emitPill(s);
    return this.view(s);
  }

  /** Puts an excluded range back on the pill's charts. */
  removeExclusion(id: string, exclusionId: string): Pill {
    const s = this.pills.get(id);
    if (!s) throw new PillError('Unknown pill', 404);
    if (!s.config.exclusions.some((e) => e.id === exclusionId)) throw new PillError('Unknown excluded range', 404);
    s.config.exclusions = s.config.exclusions.filter((e) => e.id !== exclusionId);
    this.save(s);
    this.emitPill(s);
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
    // iSpindels post over Wi-Fi (handleIspindel): nothing heard over Bluetooth is one.
    if (isIspindelAddress(address)) return;
    const id = this.byAddress.get(address);
    const s = id ? this.pills.get(id) : undefined;
    if (s?.config.archived || (s && !KNOWN_KINDS.has(s.config.kind))) return;
    if (!s) {
      this.handleNearby(address, a);
      return;
    }

    if (!a.cached) {
      // A relay's batched advert can be older than one the radio has heard since.
      s.lastHeardAt = Math.max(s.lastHeardAt ?? 0, a.at);
      s.lastHeardMono = Math.max(s.lastHeardMono ?? -Infinity, a.mono);
      if (a.rssi !== null) s.rssi = a.rssi;
    }
    // Heard again with nothing new (BlueZ's monitor reports every advert) only counts as being heard.
    const onlyHeard = a.manufacturer === null && a.rssi === null;
    // A thermometer is heard every second: only its readings (once a minute) are worth announcing.
    let changed = !a.cached && !onlyHeard && s.config.kind === 'pill';
    for (const [companyId, data] of a.manufacturer ?? []) {
      const decoded = decodeAdvert(companyId, data);
      if (!decoded || !this.settleKind(s, kindOfAdvert(decoded))) continue;
      const info = infoFrom(decoded, s.config.info);
      if (info !== s.config.info) {
        s.config.info = info;
        this.save(s);
      }
      const beacon = beaconOf(decoded);
      if (beacon) takeBeacon(s, beacon, a);
      if (decoded.kind === 'thermometer') {
        takeThermo(s, decoded.temp, a);
      } else if (decoded.kind === 'firmware' && decoded.firmware !== s.config.info.firmware) {
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
        this.record(s, raw, a.mono, true);
        changed = true;
      }
    }
    // BlueZ only passes a thermometer's data on when it changes, so any sign of life (being heard again, or a new signal
    // strength) means it's still sending the temperature it last sent. BlueZ's cache at start-up only sets `thermo`.
    if (s.config.kind === 'thermometer' && s.thermo !== null && !a.cached && sampleDue(s.lastSampleMono, a.mono)) {
      s.lastSampleMono = a.mono;
      this.record(s, thermometerReading(a.at, s.thermo, a.rssi ?? s.rssi), a.mono, false);
      changed = true;
    }
    // A Tilt or Laser Level likewise: what it last sent, once a minute.
    if (BEACON_KINDS.has(s.config.kind) && s.beacon !== null && !a.cached && sampleDue(s.lastSampleMono, a.mono)) {
      s.lastSampleMono = a.mono;
      this.record(s, { ...s.beacon, ts: a.at, rssi: a.rssi ?? s.rssi }, a.mono, false);
      changed = true;
    }
    const wasOnline = s.online;
    s.online = this.isOnline(s);
    if (changed || wasOnline !== s.online) this.emitPill(s);
  }

  /**
   * Whether an advert of this kind is for this device. One added by address before it was ever heard becomes
   * whatever it turns out to be; otherwise adverts of the other kind are ignored.
   */
  private settleKind(s: PillState, kind: DeviceKind): boolean {
    if (s.config.kind === kind) return true;
    if (s.latest !== null || s.firstReadingAt !== null) return false;
    if (s.config.name === defaultName(s.config.kind, s.address)) s.config.name = defaultName(kind, s.address);
    s.config.kind = kind;
    s.raptId = raptIdOf(kind, s.address);
    this.save(s);
    this.log.info({ id: s.id, kind }, 'an added device turned out to be another kind');
    return true;
  }

  /** Stores a reading, or shows it until the clock can be trusted. Pills' readings are held back first (see hold()). */
  private record(s: PillState, raw: RawReading, mono: number, holdFirst: boolean): void {
    if (this.clock.trusted) {
      if (holdFirst) this.hold(s, raw);
      else this.commit(s, raw);
      return;
    }
    s.latest = raw;
    if (this.pending.length < MAX_PENDING) this.pending.push({ pillId: s.id, raw, mono });
  }

  // iSpindels (Wi-Fi)

  /**
   * A reading an iSpindel posted (see ispindel/decode.ts): recorded once it's been added, listed nearby until then.
   * Every post is a new reading (an iSpindel doesn't repeat itself), so nothing is held back or skipped as a repeat.
   */
  handleIspindel(post: Extract<IspindelDecoded, { ok: true }>, mono: number): 'recorded' | 'nearby' | 'ignored' {
    const { address, raw } = post;
    const id = this.byAddress.get(address);
    const s = id ? this.pills.get(id) : undefined;
    if (!s) {
      this.ispindelNearby(post, mono);
      return this.ignored.has(address) ? 'ignored' : 'nearby';
    }
    if (s.config.archived || s.config.kind !== 'ispindel') return 'ignored';
    s.lastHeardAt = Math.max(s.lastHeardAt ?? 0, raw.ts);
    s.lastHeardMono = Math.max(s.lastHeardMono ?? -Infinity, mono);
    if (raw.rssi !== null) s.rssi = raw.rssi;
    if (s.config.info.deviceType !== 'iSpindel') {
      s.config.info = { ...s.config.info, deviceType: 'iSpindel' };
      this.save(s);
    }
    this.record(s, raw, mono, false);
    s.online = this.isOnline(s);
    this.emitPill(s);
    return 'recorded';
  }

  private ispindelNearby(post: Extract<IspindelDecoded, { ok: true }>, mono: number): void {
    const { address, raw } = post;
    const isNew = !this.nearbyPills.has(address);
    const n: NearbyState = this.nearbyPills.get(address) ?? {
      address,
      kind: 'ispindel',
      firstHeardAt: raw.ts,
      lastHeardAt: raw.ts,
      lastHeardMono: null,
      rssi: null,
      latest: null,
      info: ISPINDEL_INFO,
      thermo: null,
      thermoMono: null,
      lastSampleMono: null,
      beacon: null,
      beaconMono: null,
      name: null,
      expiryMs: NEARBY_EXPIRY_MS,
    };
    n.name = post.name ?? n.name;
    n.latest = raw;
    n.lastHeardAt = Math.max(n.lastHeardAt, raw.ts);
    n.lastHeardMono = Math.max(n.lastHeardMono ?? -Infinity, mono);
    if (raw.rssi !== null) n.rssi = raw.rssi;
    n.expiryMs = ispindelExpiryMs(post.intervalSec);
    this.nearbyPills.set(address, n);
    if (isNew) this.log.info({ address, name: n.name }, 'found an iSpindel');
    if (!this.ignored.has(address)) this.emit('nearby');
  }

  private handleNearby(address: string, a: Advert): void {
    let n = this.nearbyPills.get(address);
    if (!n) {
      // RSSI-only updates don't say it's a RAPT device; wait for manufacturer data.
      if (!a.manufacturer) return;
      n = {
        address,
        kind: 'pill',
        firstHeardAt: a.at,
        lastHeardAt: a.at,
        lastHeardMono: null,
        rssi: a.rssi,
        latest: null,
        info: NO_INFO,
        thermo: null,
        thermoMono: null,
        lastSampleMono: null,
        beacon: null,
        beaconMono: null,
        name: null,
        expiryMs: NEARBY_EXPIRY_MS,
      };
    }
    let isRapt = false;
    for (const [companyId, data] of a.manufacturer ?? []) {
      const decoded = decodeAdvert(companyId, data);
      if (!decoded) continue;
      isRapt = true;
      n.info = infoFrom(decoded, n.info);
      if (decoded.kind === 'thermometer') {
        n.kind = 'thermometer';
        takeThermo(n, decoded.temp, a);
      } else if (decoded.kind === 'tilt' || decoded.kind === 'laser') {
        n.kind = kindOfAdvert(decoded);
        const beacon = beaconOf(decoded);
        if (beacon) takeBeacon(n, beacon, a);
      } else if (decoded.kind === 'firmware') n.info = { ...n.info, firmware: decoded.firmware };
      else if (decoded.kind === 'deviceType') n.info = { ...n.info, deviceType: decoded.deviceType };
      else if (decoded.kind === 'metrics') {
        const recent = this.nearbyRecent.get(address) ?? [];
        if (!recent.includes(decoded.fingerprint)) {
          this.nearbyRecent.set(address, [decoded.fingerprint, ...recent].slice(0, RECENT));
          const { sg, temp, velocity, battery, x, y, z } = decoded.metrics;
          n.latest = { ts: a.at, sg, temp, velocity, battery, rssi: a.rssi, x, y, z, flags: flagsOf(sg) };
        }
        n.info = { ...n.info, payloadVersion: decoded.metrics.version };
      }
    }
    if (!this.nearbyPills.has(address) && !isRapt) return;
    let sampled = false;
    if (n.kind === 'thermometer' && n.thermo !== null && !a.cached && sampleDue(n.lastSampleMono, a.mono)) {
      n.lastSampleMono = a.mono;
      n.latest = thermometerReading(a.at, n.thermo, a.rssi ?? n.rssi);
      sampled = true;
    }
    if (BEACON_KINDS.has(n.kind) && n.beacon !== null && !a.cached && sampleDue(n.lastSampleMono, a.mono)) {
      n.lastSampleMono = a.mono;
      n.latest = { ...n.beacon, ts: a.at, rssi: a.rssi ?? n.rssi };
      sampled = true;
    }
    if (!a.cached) {
      n.lastHeardAt = Math.max(n.lastHeardAt, a.at);
      n.lastHeardMono = Math.max(n.lastHeardMono ?? -Infinity, a.mono);
    }
    if (a.rssi !== null) n.rssi = a.rssi;
    const isNew = !this.nearbyPills.has(address);
    this.nearbyPills.set(address, n);
    if (isNew) this.log.info({ address }, `found a ${FOUND[n.kind] ?? 'RAPT Pill'} nearby`);
    const onlyHeard = a.manufacturer === null && a.rssi === null;
    if (!this.ignored.has(address) && ((n.kind === 'pill' && !onlyHeard) || isNew || sampled)) this.emit('nearby');
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
    // Heard while the clock was still wrong: when that was by the clock now it's set.
    for (const s of this.pills.values()) if (s.lastHeardMono !== null) s.lastHeardAt = this.clock.wallTime(s.lastHeardMono);
    for (const n of this.nearbyPills.values()) if (n.lastHeardMono !== null) n.lastHeardAt = this.clock.wallTime(n.lastHeardMono);
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
      if (this.now() - n.lastHeardAt > n.expiryMs) {
        this.nearbyPills.delete(address);
        this.nearbyRecent.delete(address);
        changed = true;
      }
    }
    if (changed) this.emit('nearby');
  }
}
