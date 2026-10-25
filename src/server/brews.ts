import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  abv,
  attenuation,
  gravityStable,
  plausibleGravity,
  predictFermentation,
  SMOOTHING_MS,
  type AbvFormula,
  type Brew,
  type BrewCurve,
  type BrewEvent,
  type BrewEventInput,
  type BrewEventKind,
  type BrewInput,
  type BrewStats,
  type GravityPoint,
  type History,
  type Offsets,
  type PillModel,
  type Reading,
} from '@rapthooker/shared';
import { FLAG_IMPLAUSIBLE, ROLLUP_MS, type BrewEventRow, type BrewRow, type PrunedRollup, type RawReading, type Store } from './db.js';
import type { Logger } from './log.js';
import { modelGravity } from './pills.js';

interface BrewJson extends BrewInput {
  /** Final stats, saved when the brew ends (older saves lack the newer fields). */
  stats?: Omit<BrewStats, 'stable' | 'finalAbv' | 'prediction'> & Partial<BrewStats>;
}

export class BrewError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

export interface PillLookup {
  has(id: string): boolean;
  offsets(id: string): Offsets;
  model(id: string): PillModel;
}

/** What a brew's curve fit needs to know about it. */
interface Subject {
  id: string;
  pillId: string;
  startedAt: number;
  targetFg: number | null;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The first hour after the pill goes in is left out of the OG: it reads off while it settles and bubbles cling to it. */
const OG_SETTLE_MS = HOUR;
/** The OG is the median of the readings from then until this long after the pill goes in… */
const OG_WINDOW_MS = 3 * HOUR;
/** …or, before there are any, of the first few. */
const OG_SAMPLES = 6;
/** How often a running brew's curve is refitted (it's a Pi). */
const ANALYSE_EVERY_MS = 10 * MINUTE;
/** Readings per brew for the fit, and for comparing brews. */
const FIT_POINTS = 1500;
const COMPARE_POINTS = 400;

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

const round = (v: number, decimals: number) => Math.round(v * 10 ** decimals) / 10 ** decimals;

const cleanInput = (input: Partial<BrewInput>, base: BrewInput): BrewInput => ({
  name: (input.name ?? base.name).trim() || base.name || 'Brew',
  style: (input.style ?? base.style).trim(),
  notes: input.notes ?? base.notes,
  og: input.og === undefined ? base.og : input.og,
  targetFg: input.targetFg === undefined ? base.targetFg : input.targetFg,
});

const toEvent = (row: BrewEventRow): BrewEvent => ({
  id: row.id,
  brewId: row.brew_id,
  at: row.at,
  kind: row.kind as BrewEventKind,
  text: row.text,
});

/**
 * Brews: a named stretch of a pill's recording. Starting and ending one never interrupts the recording itself.
 * Emits 'brew' (Brew) whenever a brew changes and 'removed' (Brew) when one is deleted.
 */
export class BrewService extends EventEmitter {
  /** Stats for running brews, kept up to date as readings arrive. */
  private readonly live = new Map<string, Brew>();
  /** When each running brew's curve was last fitted. */
  private readonly analysedAt = new Map<string, number>();
  /** The hub's ABV formula (set from the hub settings). */
  abvFormula: () => AbvFormula = () => 'standard';

  constructor(
    private readonly store: Store,
    private readonly pills: PillLookup,
    private readonly log: Logger,
    private readonly now: () => number = Date.now,
  ) {
    super();
  }

  load(): void {
    for (const row of this.store.activeBrewRows()) this.live.set(row.id, this.fromRow(row, true));
  }

  list(pillId?: string): Brew[] {
    return this.store.listBrewRows(pillId).map((row) => this.live.get(row.id) ?? this.fromRow(row, false));
  }

  get(id: string): Brew | null {
    const live = this.live.get(id);
    if (live) return live;
    const row = this.store.getBrewRow(id);
    return row ? this.fromRow(row, false) : null;
  }

  activeFor(pillId: string): Brew | null {
    for (const b of this.live.values()) if (b.pillId === pillId) return b;
    return null;
  }

  start(pillId: string, input: Partial<BrewInput>, startedAt?: number): Brew {
    if (!this.pills.has(pillId)) throw new BrewError('Unknown pill', 404);
    if (this.activeFor(pillId)) throw new BrewError('This pill already has a brew running: end it first', 409);
    const now = this.now();
    const start = Math.min(startedAt ?? now, now);
    const json = cleanInput(input, { name: 'Brew', style: '', notes: '', og: null, targetFg: null });
    const row: BrewRow = {
      id: randomUUID(),
      pill_id: pillId,
      started_at: start,
      ended_at: null,
      json: JSON.stringify(json),
      created_at: now,
    };
    this.store.saveBrew(row);
    const brew = this.fromRow(row, true);
    this.live.set(brew.id, brew);
    this.log.info({ brew: brew.id, pill: pillId }, 'brew started');
    this.emit('brew', brew);
    return brew;
  }

  update(id: string, patch: Partial<BrewInput> & { startedAt?: number; endedAt?: number | null }): Brew {
    const row = this.store.getBrewRow(id);
    if (!row) throw new BrewError('Unknown brew', 404);
    const json = JSON.parse(row.json) as BrewJson;
    const next = cleanInput(patch, json);
    const startedAt = patch.startedAt ?? row.started_at;
    let endedAt = patch.endedAt === undefined ? row.ended_at : patch.endedAt;
    if (endedAt !== null && endedAt < startedAt) throw new BrewError('A brew has to end after it starts');
    if (startedAt > this.now()) throw new BrewError("A brew can't start in the future");
    if (endedAt === null && row.ended_at !== null) {
      const other = this.activeFor(row.pill_id);
      if (other) throw new BrewError(`"${other.name}" is running on this pill: end it before resuming this one`, 409);
    }
    if (endedAt !== null) endedAt = Math.min(endedAt, this.now());
    const updated: BrewRow = { ...row, started_at: startedAt, ended_at: endedAt, json: JSON.stringify({ ...next }) };
    if (endedAt !== null) {
      // A finished brew keeps its saved stats (its raw readings may have been pruned since) unless what they depend on changed.
      const timesChanged = startedAt !== row.started_at || endedAt !== row.ended_at;
      let stats: BrewStats | undefined = json.stats ? this.upgrade(json.stats) : undefined;
      if (!stats || timesChanged || (next.og === null && json.og !== null)) {
        stats = this.computeStats(updated, next);
      } else if (next.og !== json.og && next.og !== null) {
        stats = { ...stats, og: next.og, ogAuto: false };
      }
      updated.json = JSON.stringify({ ...next, stats: this.withDerived(stats, true) } satisfies BrewJson);
    }
    this.store.saveBrew(updated);
    const brew = this.fromRow(updated, endedAt === null);
    if (endedAt === null) this.live.set(id, brew);
    else {
      this.live.delete(id);
      this.analysedAt.delete(id);
    }
    this.emit('brew', brew);
    return brew;
  }

  end(id: string, endedAt?: number): Brew {
    const row = this.store.getBrewRow(id);
    if (!row) throw new BrewError('Unknown brew', 404);
    if (row.ended_at !== null) throw new BrewError('That brew has already ended', 409);
    const brew = this.update(id, { endedAt: endedAt ?? this.now() });
    this.log.info({ brew: id }, 'brew ended');
    return brew;
  }

  delete(id: string): Brew {
    const brew = this.get(id);
    if (!brew) throw new BrewError('Unknown brew', 404);
    this.store.deleteBrew(id);
    this.live.delete(id);
    this.analysedAt.delete(id);
    this.emit('removed', brew);
    return brew;
  }

  /** A removed pill takes its brews with it. */
  forgetPill(pillId: string): void {
    for (const [id, b] of this.live) {
      if (b.pillId !== pillId) continue;
      this.live.delete(id);
      this.analysedAt.delete(id);
    }
  }

  /** Keeps a running brew's stats current without re-reading its whole history. */
  onReading(pillId: string, reading: Reading): void {
    const brew = this.activeFor(pillId);
    if (!brew || reading.ts < brew.startedAt || !reading.plausible) return;
    const s = brew.stats;
    const n = s.readings + 1;
    const firstAt = s.firstReadingAt ?? reading.ts;
    let og = s.og;
    // The automatic OG settles over the first few hours.
    if (s.ogAuto && reading.ts <= firstAt + OG_WINDOW_MS) og = this.autoOg(pillId, firstAt, reading.ts) ?? og;
    let stats: BrewStats = {
      ...s,
      og,
      gravity: reading.gravity,
      tempMin: s.tempMin === null ? reading.temperature : Math.min(s.tempMin, reading.temperature),
      tempMax: s.tempMax === null ? reading.temperature : Math.max(s.tempMax, reading.temperature),
      tempAvg: s.tempAvg === null ? reading.temperature : (s.tempAvg * s.readings + reading.temperature) / n,
      readings: n,
      firstReadingAt: firstAt,
      lastReadingAt: reading.ts,
    };
    const now = this.now();
    if (now - (this.analysedAt.get(brew.id) ?? 0) >= ANALYSE_EVERY_MS) {
      this.analysedAt.set(brew.id, now);
      stats = { ...stats, ...this.analyse(brew, og, now) };
    }
    const updated = { ...brew, stats: this.withDerived(stats, false) };
    this.live.set(brew.id, updated);
    this.emit('brew', updated);
  }

  /** Recomputes a pill's running brew (e.g. its calibration changed). */
  refresh(pillId: string): void {
    const brew = this.activeFor(pillId);
    if (!brew) return;
    const row = this.store.getBrewRow(brew.id);
    if (!row) return;
    const fresh = this.fromRow(row, true);
    this.live.set(brew.id, fresh);
    this.emit('brew', fresh);
  }

  /** Works out the running brews' ABV again, e.g. after the hub's ABV formula changed. */
  refreshAbv(): void {
    for (const [id, brew] of this.live) {
      const stats = this.withDerived(brew.stats, false);
      if (stats.abv === brew.stats.abv && stats.finalAbv === brew.stats.finalAbv) continue;
      const updated = { ...brew, stats };
      this.live.set(id, updated);
      this.emit('brew', updated);
    }
  }

  // Events

  events(brewId: string): BrewEvent[] {
    return this.store.listBrewEvents(brewId).map(toEvent);
  }

  addEvent(brewId: string, input: BrewEventInput): BrewEvent {
    const row = this.store.getBrewRow(brewId);
    if (!row) throw new BrewError('Unknown brew', 404);
    const event: BrewEventRow = { id: randomUUID(), brew_id: brewId, ...this.checkEvent(row, input) };
    this.store.saveBrewEvent(event);
    this.eventsChanged(brewId);
    return toEvent(event);
  }

  updateEvent(brewId: string, eventId: string, input: BrewEventInput): BrewEvent {
    const row = this.store.getBrewRow(brewId);
    const existing = this.store.getBrewEvent(eventId);
    if (!row || !existing || existing.brew_id !== brewId) throw new BrewError('Unknown event', 404);
    const event: BrewEventRow = { ...existing, ...this.checkEvent(row, input) };
    this.store.saveBrewEvent(event);
    this.eventsChanged(brewId);
    return toEvent(event);
  }

  deleteEvent(brewId: string, eventId: string): void {
    const existing = this.store.getBrewEvent(eventId);
    if (!existing || existing.brew_id !== brewId) throw new BrewError('Unknown event', 404);
    this.store.deleteBrewEvent(eventId);
    this.eventsChanged(brewId);
  }

  private checkEvent(row: BrewRow, input: BrewEventInput): Pick<BrewEventRow, 'at' | 'kind' | 'text'> {
    const text = input.text.trim();
    if (input.kind === 'note' && !text) throw new BrewError('Write something for the note');
    if (input.at > this.now() + 5 * MINUTE) throw new BrewError("An event can't be in the future");
    if (input.at < row.started_at - DAY || input.at > (row.ended_at ?? this.now()) + DAY) {
      throw new BrewError('Pick a time during the brew');
    }
    return { at: input.at, kind: input.kind, text };
  }

  private eventsChanged(brewId: string): void {
    const live = this.live.get(brewId);
    if (live) {
      const updated = { ...live, events: this.events(brewId) };
      this.live.set(brewId, updated);
      this.emit('brew', updated);
      return;
    }
    const brew = this.get(brewId);
    if (brew) this.emit('brew', brew);
  }

  // Comparing brews

  /** Each brew's gravity and temperature by hours since it started (at most COMPARE_POINTS points each). */
  curves(ids: string[]): BrewCurve[] {
    return [...new Set(ids)].map((id) => {
      const brew = this.get(id);
      if (!brew) throw new BrewError('Unknown brew', 404);
      const h = this.series(brew.pillId, brew.startedAt, brew.endedAt ?? this.now(), COMPARE_POINTS);
      const curve: BrewCurve = {
        brewId: brew.id,
        name: brew.name,
        pillId: brew.pillId,
        startedAt: brew.startedAt,
        hours: [],
        gravity: [],
        temperature: [],
      };
      h.ts.forEach((t, i) => {
        if (h.implausible[i] === true || t < brew.startedAt - 15 * MINUTE) return;
        const g = h.gravity[i] ?? null;
        const temp = h.temperature[i] ?? null;
        curve.hours.push(round(Math.max(0, (t - brew.startedAt) / HOUR), 3));
        curve.gravity.push(g === null ? null : round(g, 5));
        curve.temperature.push(temp === null ? null : round(temp, 2));
      });
      const step = Math.ceil(curve.hours.length / COMPARE_POINTS);
      if (step > 1) {
        const keep = (_: unknown, i: number) => i % step === 0 || i === curve.hours.length - 1;
        curve.hours = curve.hours.filter(keep);
        curve.gravity = curve.gravity.filter(keep);
        curve.temperature = curve.temperature.filter(keep);
      }
      return curve;
    });
  }

  // Stats

  private derived(og: number | null, gravity: number | null): Pick<BrewStats, 'abv' | 'attenuation'> {
    if (og === null || gravity === null) return { abv: null, attenuation: null };
    return { abv: round(abv(og, gravity, this.abvFormula()), 2), attenuation: round(attenuation(og, gravity), 1) };
  }

  /** ABV and attenuation from the OG and gravity; the final ABV once the gravity is stable or the brew has ended. */
  private withDerived(s: BrewStats, ended: boolean): BrewStats {
    const d = this.derived(s.og, s.gravity);
    return { ...s, ...d, finalAbv: ended || s.stable ? d.abv : null };
  }

  private upgrade(saved: NonNullable<BrewJson['stats']>): BrewStats {
    return { stable: false, finalAbv: null, prediction: null, ...saved };
  }

  /** The gravity a pill's model gives a stored reading, or null if it isn't a usable one. */
  private usable(r: RawReading, offsets: Offsets, model: PillModel): number | null {
    if (r.flags & FLAG_IMPLAUSIBLE) return null;
    const g = modelGravity(r, offsets, model);
    return plausibleGravity(g) ? g : null;
  }

  /** The gravity a pill's model gives a 15-minute average, or null if it isn't a usable one. */
  private usableAverage(b: PrunedRollup, offsets: Offsets, model: PillModel): number | null {
    const g = modelGravity(b, offsets, model);
    return plausibleGravity(g) ? g : null;
  }

  /**
   * The OG from the readings: the median from the end of the settling hour to three hours after the pill went in
   * (`firstAt`, its first plausible reading of the brew), or of the first few readings until then. `pruned` stands in
   * for raw readings that have been deleted since (see Store.prunedRollups).
   */
  private autoOg(pillId: string, firstAt: number, end: number, pruned: PrunedRollup[] = []): number | null {
    const offsets = this.pills.offsets(pillId);
    const model = this.pills.model(pillId);
    const early: number[] = [];
    const settled: number[] = [];
    for (const b of pruned) {
      const t = b.bucket + ROLLUP_MS / 2;
      if (t > Math.min(end, firstAt + OG_WINDOW_MS)) break;
      const g = this.usableAverage(b, offsets, model);
      if (g === null) continue;
      if (t >= firstAt + OG_SETTLE_MS) settled.push(g);
      else if (early.length < OG_SAMPLES) early.push(g);
    }
    for (const r of this.store.iterateReadings(pillId, firstAt, Math.min(end, firstAt + OG_WINDOW_MS))) {
      const g = this.usable(r, offsets, model);
      if (g === null) continue;
      if (r.ts >= firstAt + OG_SETTLE_MS) settled.push(g);
      else if (early.length < OG_SAMPLES) early.push(g);
    }
    const og = median(settled.length > 0 ? settled : early);
    return og === null ? null : round(og, 4);
  }

  /** The latest gravity before `end`, averaged over the smoothing window when the pill's model smooths it. */
  private gravityAt(pillId: string, start: number, end: number, pruned: PrunedRollup[] = []): number | null {
    const last = this.store.lastPlausibleBefore(pillId, end);
    const offsets = this.pills.offsets(pillId);
    const model = this.pills.model(pillId);
    if (!last || last.ts < start) {
      // The raw readings are gone: the last 15-minute average will do.
      for (let i = pruned.length - 1; i >= 0; i--) {
        const g = this.usableAverage(pruned[i]!, offsets, model);
        if (g !== null) return round(g, 6);
      }
      return null;
    }
    const smoothMs = SMOOTHING_MS[model.smoothing];
    let sum = 0;
    let n = 0;
    if (smoothMs > 0) {
      for (const r of this.store.iterateReadings(pillId, Math.max(start, last.ts - smoothMs), last.ts)) {
        const g = this.usable(r, offsets, model);
        if (g === null) continue;
        sum += g;
        n++;
      }
    }
    return round(n > 0 ? sum / n : modelGravity(last, offsets, model), 6);
  }

  /** A pill's history over a brew, from the 15-minute averages where the raw readings have been pruned. */
  private series(pillId: string, from: number, to: number, maxPoints: number): History {
    const first = this.store.firstReadingTs(pillId);
    const model = this.pills.model(pillId);
    return this.store.history(pillId, from, to, {
      maxPoints,
      gapMs: 3 * HOUR,
      offsets: this.pills.offsets(pillId),
      model: { ...model, smoothing: 'off', velocitySource: 'pill' },
      rawFrom: first !== null && first > from ? first : undefined,
    });
  }

  /** Whether the gravity has settled, and the fitted fermentation curve's prediction. Never throws. */
  private analyse(b: Subject, og: number | null, end: number): Pick<BrewStats, 'stable' | 'prediction'> {
    try {
      const h = this.series(b.pillId, b.startedAt, end, FIT_POINTS);
      const points: GravityPoint[] = [];
      h.ts.forEach((t, i) => {
        const g = h.gravity[i];
        if (g != null && h.implausible[i] === false && t >= b.startedAt && plausibleGravity(g)) points.push({ t, g });
      });
      const stable = gravityStable(points, { og });
      const prediction = predictFermentation(points, { stable, og, targetFg: b.targetFg, now: end });
      return { stable, prediction };
    } catch (err) {
      this.log.error({ err: (err as Error).stack ?? String(err), brew: b.id }, "couldn't fit the fermentation curve");
      return { stable: false, prediction: null };
    }
  }

  private computeStats(row: BrewRow, input: BrewInput): BrewStats {
    const off = this.pills.offsets(row.pill_id);
    const end = row.ended_at ?? this.now();
    // Raw readings older than the retention period are gone; their 15-minute averages stand in for them.
    const pruned = this.store.prunedRollups(row.pill_id, row.started_at, end);
    const agg = this.store.aggregate(row.pill_id, row.started_at, end);
    if (pruned.length > 0) {
      const temps = pruned.map((b) => b.temp);
      agg.firstTs = pruned[0]!.bucket;
      agg.lastTs ??= pruned.at(-1)!.bucket + ROLLUP_MS;
      agg.tempMin = Math.min(agg.tempMin ?? Infinity, ...temps);
      agg.tempMax = Math.max(agg.tempMax ?? -Infinity, ...temps);
      agg.tempSum += pruned.reduce((sum, b) => sum + b.temp * b.n, 0);
      agg.n += pruned.reduce((sum, b) => sum + b.n, 0);
    }
    const og = input.og ?? (agg.firstTs === null ? null : this.autoOg(row.pill_id, agg.firstTs, end, pruned));
    const subject: Subject = { id: row.id, pillId: row.pill_id, startedAt: row.started_at, targetFg: input.targetFg };
    if (row.ended_at === null) this.analysedAt.set(row.id, this.now());
    const stats: BrewStats = {
      og,
      ogAuto: input.og === null,
      gravity: this.gravityAt(row.pill_id, row.started_at, end, pruned),
      abv: null,
      attenuation: null,
      tempMin: agg.tempMin === null ? null : agg.tempMin + off.temperature,
      tempMax: agg.tempMax === null ? null : agg.tempMax + off.temperature,
      tempAvg: agg.n > 0 ? agg.tempSum / agg.n + off.temperature : null,
      readings: agg.n,
      firstReadingAt: agg.firstTs,
      lastReadingAt: agg.lastTs,
      finalAbv: null,
      ...this.analyse(subject, og, end),
    };
    return this.withDerived(stats, row.ended_at !== null);
  }

  private fromRow(row: BrewRow, compute: boolean): Brew {
    const json = JSON.parse(row.json) as BrewJson;
    const ended = row.ended_at !== null;
    const stats = !compute && json.stats ? this.withDerived(this.upgrade(json.stats), ended) : this.computeStats(row, json);
    return {
      id: row.id,
      pillId: row.pill_id,
      name: json.name,
      style: json.style,
      notes: json.notes,
      og: json.og,
      targetFg: json.targetFg,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      stats,
      events: this.events(row.id),
    };
  }
}
