import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  attenuation,
  BROWSER_PUSH,
  cToF,
  DEFAULT_DECIMALS,
  FERMENTATION_LIMITS,
  fixedText,
  gravityDecimals,
  ONCE_PER_BREW,
  plausibleGravity,
  sgToPlato,
  stableClearsAt,
  velocityClearsAt,
  type AlertEvent,
  type AlertKind,
  type AlertRule,
  type AlertRuleInput,
  type Brew,
  type BrewAlert,
  type BrewAlertInput,
  type BrewEventInput,
  type Decimals,
  type GravityUnit,
  type Pill,
  type Reading,
  type TemperatureUnit,
} from '@rapthooker/shared';
import { FLAG_IMPLAUSIBLE, type DueReminderRow, type Store } from './db.js';
import type { Logger } from './log.js';
import type { Notifier } from './push.js';
import type { Notification } from './channels.js';
import { modelGravity } from './pills.js';

/** Where alerts go besides browser push (the ChannelService). */
export interface ChannelSender {
  send(channelIds: string[] | 'all', n: Notification): Promise<void>;
}

/** Rules saved before channels existed went to browser push, which 'all' still includes. */
function channelIdsOf(saved: unknown): string[] | 'all' {
  if (Array.isArray(saved)) return saved.filter((id): id is string => typeof id === 'string');
  return 'all';
}

export class AlertError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

export interface AlertDeps {
  pills: {
    get(id: string): Pill | null;
    activeIds(): string[];
    latest(id: string): Reading | null;
    lastHeardAt(id: string): number | null;
    offsets(id: string): { gravity: number; temperature: number };
  };
  brews: {
    activeFor(pillId: string): Brew | null;
    /** A brew, running or not (to check a brew's own alerts belong to one). */
    get?(id: string): Brew | null;
    /** Notes something on a brew's timeline (for alerts set to), as the alert's. */
    addEvent?(brewId: string, input: BrewEventInput, alertId?: string): unknown;
  };
  units: () => { temperature: TemperatureUnit; gravity: GravityUnit };
  /** Decimals for the readings in messages (the hub's setting). */
  decimals?: () => Decimals;
  /** False until the clock can be trusted after boot ("last heard" times can't be compared with now until then). */
  clockTrusted?: () => boolean;
  now?: () => number;
}

interface Check {
  /** true: should fire, false: has cleared, null: in between (hysteresis) or not enough data. */
  firing: boolean | null;
  value: number | null;
  message: string;
  /**
   * Velocity alerts in a running brew: the gravity they wait for before they can go off, null once it's reached, and
   * left out when the check can't tell.
   */
  waitingFor?: number | null;
  /** Added to the message when it goes off straight after that wait. */
  afterWait?: string;
}

const NOTHING: Check = { firing: null, value: null, message: '' };

const HYSTERESIS = { temperature: 0.5, gravity: 0.003, battery: 5 };

/** Velocity alerts in a brew wait for the gravity to drop this many points from where the pill started it. */
const WAIT_POINTS = FERMENTATION_LIMITS.minDrop * 1000;

const VELOCITY_KINDS: ReadonlySet<AlertKind> = new Set<AlertKind>(['velocity_slow', 'velocity_fast']);

const DAY = 86_400_000;

/** A planned event's reminder still goes out this long after its time (the hub was off, say), and not after. */
const REMINDER_GRACE_MS = 6 * 3_600_000;

/** Event kinds in a reminder's words ("Time for the dry hop"). */
const EVENT_WORDS: Record<string, string> = {
  dry_hop: 'dry hop',
  temp_change: 'temperature change',
  cold_crash: 'cold crash',
  addition: 'addition',
  note: 'note',
};

/** Rules that go by the gravity, so wait for a reading that looks real. */
const GRAVITY_KINDS: ReadonlySet<AlertKind> = new Set<AlertKind>([
  'gravity_below',
  'gravity_stable',
  'velocity_slow',
  'velocity_fast',
  'fermentation_started',
  'attenuation_reached',
]);

/** What's saved for a rule: everything but what's worked out while running (fields a newer version added are kept). */
const ruleInput = ({ id: _id, createdAt: _c, active: _a, waitingForGravity: _w, ...input }: AlertRule): AlertRuleInput => input;

/** A brew's own alert as kept here. */
type StoredBrewAlert = BrewAlertInput & { id: string; brewId: string; createdAt: number };

/** What's saved for a brew's alert (fields a newer version added are kept). */
const brewAlertInput = ({ id: _id, brewId: _b, createdAt: _c, ...input }: StoredBrewAlert): BrewAlertInput => input;

/** A rule, or a brew's own alert as one (watching the brew's pill while the brew runs). */
type Watch = AlertRule & { brewId?: string };

const round1 = (v: number) => Math.round(v * 10) / 10;

/** "3 days", "1 day", "2.5 days". */
const dayText = (days: number) => `${Number.isInteger(days) ? days : days.toFixed(1)} day${days === 1 ? '' : 's'}`;

/**
 * Watches readings against your alert rules (and each running brew's own alerts) and notifies (in the app, by browser
 * push and through the rule's notification channels) when one fires. Also reminds of planned brew events when their
 * time comes.
 */
export class AlertService extends EventEmitter {
  private rules = new Map<string, AlertRule>();
  private brewAlerts = new Map<string, StoredBrewAlert>();
  /** `quiet`: active, but not announced because of the cooldown. */
  private state = new Map<string, { active: boolean; quiet: boolean; lastFiredAt: number | null }>();
  /**
   * Velocity alerts waiting at the start of a brew, by rule and pill: the gravity they wait for. Only kept in memory:
   * the checks work it out again within a minute of starting.
   */
  private waiting = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private readonly now: () => number;

  constructor(
    private readonly store: Store,
    private readonly deps: AlertDeps,
    private readonly notifier: Notifier,
    private readonly log: Logger,
    private readonly channels?: ChannelSender,
  ) {
    super();
    this.now = deps.now ?? Date.now;
  }

  load(): void {
    for (const row of this.store.listAlertRuleRows()) {
      try {
        const saved = JSON.parse(row.json) as AlertRuleInput;
        const rule: AlertRule = {
          ...saved,
          channelIds: channelIdsOf(saved.channelIds),
          id: row.id,
          createdAt: row.created_at,
          active: [],
          waitingForGravity: {},
        };
        this.rules.set(row.id, rule);
      } catch (err) {
        this.log.error({ id: row.id, err: (err as Error).message }, 'skipped an alert rule that could not be read');
      }
    }
    for (const row of this.store.listBrewAlertRows()) {
      try {
        const saved = JSON.parse(row.json) as BrewAlertInput;
        this.brewAlerts.set(row.id, {
          ...saved,
          channelIds: channelIdsOf(saved.channelIds),
          id: row.id,
          brewId: row.brew_id,
          createdAt: row.created_at,
        });
      } catch (err) {
        this.log.error({ id: row.id, err: (err as Error).message }, "skipped a brew's alert that could not be read");
      }
    }
    for (const s of this.store.alertStates())
      this.state.set(`${s.rule_id}|${s.pill_id}`, { active: s.active >= 1, quiet: s.active === 2, lastFiredAt: s.last_fired_at });
    // Brews may have ended (or devices been removed) under an older version, which doesn't acknowledge their alerts.
    this.settle();
  }

  start(): void {
    this.timer = setInterval(() => {
      // Thrown from a timer it would stop the hub (and the recording with it).
      try {
        this.evaluateAll();
      } catch (err) {
        this.log.error({ err: (err as Error).stack ?? String(err) }, 'checking the alerts failed');
      }
      try {
        this.checkReminders();
      } catch (err) {
        this.log.error({ err: (err as Error).stack ?? String(err) }, 'checking the reminders failed');
      }
    }, 60_000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  list(): AlertRule[] {
    return [...this.rules.values()].map((r) => this.withActive(r));
  }

  create(input: AlertRuleInput): AlertRule {
    const rule: AlertRule = { ...input, id: randomUUID(), createdAt: this.now(), active: [], waitingForGravity: {} };
    this.rules.set(rule.id, rule);
    this.store.saveAlertRule(rule.id, input, rule.createdAt);
    this.evaluateAll();
    return this.withActive(rule);
  }

  update(id: string, input: AlertRuleInput): AlertRule {
    const old = this.rules.get(id);
    if (!old) throw new AlertError('Unknown alert', 404);
    const rule: AlertRule = { ...old, ...input };
    this.rules.set(id, rule);
    this.store.saveAlertRule(id, ruleInput(rule), rule.createdAt);
    this.evaluateAll();
    return this.withActive(rule);
  }

  delete(id: string): void {
    if (!this.rules.delete(id)) throw new AlertError('Unknown alert', 404);
    this.store.deleteAlertRule(id);
    for (const key of [...this.state.keys()]) if (key.startsWith(`${id}|`)) this.state.delete(key);
  }

  /** Takes a deleted notification channel out of the rules (and brews' alerts) that send to it. */
  forgetChannel(channelId: string): void {
    for (const rule of this.rules.values()) {
      if (rule.channelIds === 'all' || !rule.channelIds.includes(channelId)) continue;
      const next: AlertRule = { ...rule, channelIds: rule.channelIds.filter((c) => c !== channelId) };
      this.rules.set(rule.id, next);
      this.store.saveAlertRule(rule.id, ruleInput(next), rule.createdAt);
    }
    for (const a of this.brewAlerts.values()) {
      if (a.channelIds === 'all' || !a.channelIds.includes(channelId)) continue;
      this.saveBrewAlert({ ...a, channelIds: a.channelIds.filter((c) => c !== channelId) });
    }
  }

  // A brew's own alerts

  /** A brew's own alerts, oldest first. */
  listBrewAlerts(brewId: string): BrewAlert[] {
    this.brewOrThrow(brewId);
    return [...this.brewAlerts.values()].filter((a) => a.brewId === brewId).map((a) => this.brewAlertOut(a));
  }

  createBrewAlert(brewId: string, input: BrewAlertInput): BrewAlert {
    this.brewOrThrow(brewId);
    const a: StoredBrewAlert = { ...input, id: randomUUID(), brewId, createdAt: this.now() };
    this.saveBrewAlert(a);
    this.evaluateAll();
    return this.brewAlertOut(a);
  }

  updateBrewAlert(brewId: string, id: string, input: BrewAlertInput): BrewAlert {
    const old = this.brewAlerts.get(id);
    if (!old || old.brewId !== brewId) throw new AlertError('Unknown alert', 404);
    const a: StoredBrewAlert = { ...old, ...input };
    this.saveBrewAlert(a);
    this.evaluateAll();
    return this.brewAlertOut(a);
  }

  deleteBrewAlert(brewId: string, id: string): void {
    const old = this.brewAlerts.get(id);
    if (!old || old.brewId !== brewId) throw new AlertError('Unknown alert', 404);
    this.brewAlerts.delete(id);
    this.store.deleteBrewAlert(id);
    for (const key of [...this.state.keys()]) if (key.startsWith(`${id}|`)) this.state.delete(key);
  }

  /** A deleted brew's alerts went with it (Store.deleteBrew), and what went off in it needs no more looking at. */
  forgetBrew(brewId: string): void {
    for (const a of [...this.brewAlerts.values()]) {
      if (a.brewId !== brewId) continue;
      this.brewAlerts.delete(a.id);
      for (const key of [...this.state.keys()]) if (key.startsWith(`${a.id}|`)) this.state.delete(key);
    }
    this.settle();
  }

  private brewOrThrow(brewId: string): void {
    if (this.deps.brews.get && !this.deps.brews.get(brewId)) throw new AlertError('Unknown brew', 404);
  }

  private saveBrewAlert(a: StoredBrewAlert): void {
    this.brewAlerts.set(a.id, a);
    this.store.saveBrewAlert({ id: a.id, brew_id: a.brewId, json: JSON.stringify(brewAlertInput(a)), created_at: a.createdAt });
  }

  private brewAlertOut(a: StoredBrewAlert): BrewAlert {
    let active = false;
    let lastFiredAt: number | null = null;
    for (const [key, st] of this.state) {
      if (!key.startsWith(`${a.id}|`)) continue;
      active ||= st.active;
      if (st.lastFiredAt !== null && (lastFiredAt === null || st.lastFiredAt > lastFiredAt)) lastFiredAt = st.lastFiredAt;
    }
    let waitingForGravity: number | null = null;
    for (const [key, g] of this.waiting) if (key.startsWith(`${a.id}|`)) waitingForGravity = g;
    return { ...a, active, lastFiredAt, waitingForGravity };
  }

  /** A brew's own alert, as a rule watching the brew's pill. */
  private brewWatch(a: StoredBrewAlert, pillId: string): Watch {
    return { ...a, pillIds: [pillId], onlyDuringBrew: true, active: [], waitingForGravity: {} };
  }

  /** A rule or a brew's alert, by id. */
  private watchById(id: string, pillId: string): Watch | undefined {
    const rule = this.rules.get(id);
    if (rule) return rule;
    const a = this.brewAlerts.get(id);
    return a ? this.brewWatch(a, pillId) : undefined;
  }

  /** The latest events, newest first (just one pill's with `pillId`; with `unacked`, only alerts waiting to be acknowledged). */
  events(limit: number, pillId?: string, unacked = false): AlertEvent[] {
    return this.store.listAlertEvents(limit, pillId, unacked).map((r) => {
      const kind = r.kind === 'resolved' ? 'resolved' : 'fired';
      return {
        id: Number(r.id),
        ruleId: String(r.rule_id),
        ruleName: String(r.rule_name),
        pillId: String(r.pill_id),
        at: Number(r.at),
        kind,
        message: String(r.message),
        value: (r.value as number | null) ?? null,
        ackedAt: kind === 'fired' && r.acked_at != null ? Number(r.acked_at) : null,
        brewId: r.brew_id != null ? String(r.brew_id) : null,
      };
    });
  }

  /** Acknowledges alerts that went off (these, or all); the ids of those that weren't yet, which go out as 'acked'. */
  ack(ids: number[] | 'all'): number[] {
    const at = this.now();
    const acked = this.store.ackAlertEvents(ids, at);
    if (acked.length) this.emit('acked', acked, at);
    return acked;
  }

  /**
   * Acknowledges what needs no more looking at: alerts that went off in a brew that has ended or been deleted, and those
   * of removed devices (whichever version ended or removed them). After a brew ends, and when the hub starts.
   */
  settle(): number[] {
    const at = this.now();
    const acked = this.store.ackSettledAlertEvents(at);
    if (acked.length) {
      this.log.info({ count: acked.length }, 'acknowledged the alerts of finished brews and removed devices');
      this.emit('acked', acked, at);
    }
    return acked;
  }

  /** The devices with an alert that went off and waits to be acknowledged (for screens). */
  pillsWithUnacked(): Set<string> {
    return this.store.pillsWithUnackedAlerts();
  }

  private withActive(rule: AlertRule): AlertRule {
    const prefix = `${rule.id}|`;
    const active = [...this.state.entries()].filter(([k, v]) => k.startsWith(prefix) && v.active).map(([k]) => k.slice(prefix.length));
    const waitingForGravity: Record<string, number> = {};
    for (const [k, g] of this.waiting) if (k.startsWith(prefix)) waitingForGravity[k.slice(prefix.length)] = g;
    return { ...rule, active, waitingForGravity };
  }

  private appliesTo(rule: Watch, pillId: string): boolean {
    if (!rule.enabled) return false;
    if (rule.pillIds !== 'all' && !rule.pillIds.includes(pillId)) return false;
    if (!this.deps.pills.activeIds().includes(pillId)) return false;
    const brew = this.deps.brews.activeFor(pillId);
    if (rule.brewId !== undefined) return brew?.id === rule.brewId;
    // Steps in a brew need one, whatever the rule says.
    if (ONCE_PER_BREW.has(rule.kind)) return brew !== null;
    return !rule.onlyDuringBrew || brew !== null;
  }

  /** The rules, and the alerts of the pill's running brew. */
  private watchesFor(pillId: string): Watch[] {
    const out: Watch[] = [...this.rules.values()];
    const brew = this.deps.brews.activeFor(pillId);
    if (brew) for (const a of this.brewAlerts.values()) if (a.brewId === brew.id) out.push(this.brewWatch(a, pillId));
    return out;
  }

  /** After each reading. */
  evaluatePill(pillId: string): void {
    for (const rule of this.watchesFor(pillId)) if (this.appliesTo(rule, pillId)) this.evaluate(rule, pillId);
  }

  /** Every minute, for time-based rules (and rules that just changed). */
  evaluateAll(): void {
    for (const pillId of this.deps.pills.activeIds()) this.evaluatePill(pillId);
    // A rule that no longer applies (switched off, the pill taken out of it or archived, the brew ended) lets go of what
    // it was firing for, without a word, so it fires afresh if it applies again.
    for (const [key, st] of this.state) {
      if (!st.active) continue;
      const [ruleId, pillId] = key.split('|') as [string, string];
      const rule = this.watchById(ruleId, pillId);
      if (!rule || this.appliesTo(rule, pillId)) continue;
      // A removed pill's state went with it.
      if (!this.deps.pills.get(pillId)) {
        this.state.delete(key);
        continue;
      }
      this.state.set(key, { active: false, quiet: false, lastFiredAt: st.lastFiredAt });
      this.store.saveAlertState(ruleId, pillId, false, st.lastFiredAt);
    }
    // Nor does it wait any more.
    for (const key of [...this.waiting.keys()]) {
      const [ruleId, pillId] = key.split('|') as [string, string];
      const rule = this.watchById(ruleId, pillId);
      if (!rule || !this.appliesTo(rule, pillId)) this.waiting.delete(key);
    }
  }

  private fmtT(c: number): string {
    const unit = this.deps.units().temperature;
    return `${fixedText(unit === 'F' ? cToF(c) : c, this.decimals().temperature)} °${unit}`;
  }

  private fmtG(sg: number): string {
    const unit = this.deps.units().gravity;
    const d = gravityDecimals(this.decimals(), unit);
    return unit === 'plato' ? `${fixedText(sgToPlato(sg), d)} °P` : fixedText(sg, d);
  }

  private decimals(): Decimals {
    return this.deps.decimals?.() ?? DEFAULT_DECIMALS;
  }

  private check(rule: AlertRule, pill: Pill, active: boolean): Check {
    const now = this.now();
    const { id: pillId, name } = pill;
    if (rule.kind === 'offline') {
      // Before the clock is set, "last heard" was stamped by a clock that's about to jump.
      if (this.deps.clockTrusted?.() === false) return { firing: null, value: null, message: '' };
      const heard = this.deps.pills.lastHeardAt(pillId);
      const silentMin = heard === null ? null : (now - heard) / 60_000;
      if (silentMin === null) return { firing: null, value: null, message: '' };
      return silentMin > rule.threshold
        ? { firing: true, value: Math.round(silentMin), message: `Nothing heard from ${name} for ${Math.round(silentMin)} minutes` }
        : { firing: false, value: Math.round(silentMin), message: `${name} is back` };
    }
    if (rule.kind === 'brew_day') {
      // A reminder: it goes by the clock, not the readings.
      const brew = this.deps.brews.activeFor(pillId);
      if (!brew || this.deps.clockTrusted?.() === false) return NOTHING;
      const days = (now - brew.startedAt) / DAY;
      return days >= rule.threshold
        ? { firing: true, value: round1(days), message: `${brew.name} has been going for ${dayText(rule.threshold)}` }
        : NOTHING;
    }
    const r = this.deps.pills.latest(pillId);
    if (!r || now - r.ts > 6 * 3_600_000) return { firing: null, value: null, message: '' };
    // A pill out of the beer (lying on a table) reports a nonsense gravity: gravity alerts wait for a real one.
    if (!r.plausible && GRAVITY_KINDS.has(rule.kind)) return { firing: null, value: null, message: '' };
    const th = rule.threshold;
    // Steps in a brew go off once and don't clear (see ONCE_PER_BREW).
    if (rule.kind === 'fermentation_started' || rule.kind === 'attenuation_reached') {
      const brew = this.deps.brews.activeFor(pillId);
      const g = r.gravity;
      if (!brew || g === null) return NOTHING;
      if (rule.kind === 'fermentation_started') {
        // From what the pill read at the start: a typed OG can be a few points off the pill.
        const start = brew.stats.startGravity ?? brew.stats.og;
        if (start === null) return NOTHING;
        const pts = (start - g) * 1000;
        return pts >= th
          ? {
              firing: true,
              value: round1(pts),
              message: `${brew.name} has started fermenting: ${name} has dropped ${pts.toFixed(1)} points, from ${this.fmtG(start)} to ${this.fmtG(g)}`,
            }
          : NOTHING;
      }
      const og = brew.stats.og;
      if (og === null || og <= 1) return NOTHING;
      const att = attenuation(og, g);
      return att >= th
        ? {
            firing: true,
            value: round1(att),
            message: `${brew.name} is ${Math.round(att)}% attenuated: ${name} is at ${this.fmtG(g)}, from an OG of ${this.fmtG(og)}`,
          }
        : NOTHING;
    }
    // The message when it clears is "Back to normal: …" (see record()), so it says only where things are.
    switch (rule.kind) {
      case 'temp_above': {
        const firing = r.temperature > th ? true : r.temperature < th - HYSTERESIS.temperature ? false : null;
        const at = `${name} is at ${this.fmtT(r.temperature)}`;
        return { firing, value: r.temperature, message: firing === false ? at : `${at}, above ${this.fmtT(th)}` };
      }
      case 'temp_below': {
        const firing = r.temperature < th ? true : r.temperature > th + HYSTERESIS.temperature ? false : null;
        const at = `${name} is at ${this.fmtT(r.temperature)}`;
        return { firing, value: r.temperature, message: firing === false ? at : `${at}, below ${this.fmtT(th)}` };
      }
      case 'gravity_below': {
        // A thermometer has no gravity (or battery): such rules don't apply to it.
        const g = r.gravity;
        if (g === null) return { firing: null, value: null, message: '' };
        const firing = g <= th ? true : g > th + HYSTERESIS.gravity ? false : null;
        return {
          firing,
          value: g,
          message: firing === false ? `${name} is at ${this.fmtG(g)}` : `${name} has reached ${this.fmtG(g)} (target ${this.fmtG(th)})`,
        };
      }
      case 'battery_below': {
        const b = r.battery;
        if (b === null) return { firing: null, value: null, message: '' };
        return {
          firing: b < th ? true : b >= th + HYSTERESIS.battery ? false : null,
          value: b,
          message: `${name}'s battery is at ${Math.round(b)}%`,
        };
      }
      case 'gravity_stable': {
        const g = r.gravity;
        if (g === null) return { firing: null, value: null, message: '' };
        const windowMs = Math.max(1, rule.hours) * 3_600_000;
        const range = this.gravityRange(pill, now - windowMs, now);
        const brew = this.deps.brews.activeFor(pillId);
        const spansWindow = range.firstTs !== null && range.firstTs <= now - windowMs * 0.9 && (!brew || brew.startedAt <= now - windowMs);
        if (range.n < 3 || range.min === null || range.max === null || !spansWindow)
          return { firing: active ? null : false, value: null, message: '' };
        const pts = (range.max - range.min) * 1000;
        const firing = pts < th ? true : pts > stableClearsAt(th) ? false : null;
        return {
          firing,
          value: Math.round(pts * 10) / 10,
          message:
            firing === false
              ? `${name}'s gravity has moved ${pts.toFixed(1)} points over the last ${rule.hours} hours`
              : `${name} has been steady at ${this.fmtG(g)} for ${rule.hours} hours (moved ${pts.toFixed(1)} points). Fermentation looks finished.`,
        };
      }
      case 'velocity_slow':
      case 'velocity_fast': {
        // The velocity the pill's page shows (the pill's or RaptHooker's): null until there's enough data, and for a
        // device without a gravity.
        const g = r.gravity;
        if (g === null) return { firing: null, value: null, message: '' };
        const v = r.velocity;
        const slow = rule.kind === 'velocity_slow';
        // Before fermentation gets going the gravity isn't dropping, but a velocity over a few hours of readings (or ones
        // from before the brew) can say it is: with a brew running, both wait until the gravity has dropped from where
        // the brew started (what the pill read then: a typed OG can be a few points off the pill). A fast one that went
        // off before then lets go while the gravity is still within a point of the start (a point short of where it can
        // fire, so it doesn't flap there).
        const stats = this.deps.brews.activeFor(pillId)?.stats;
        const og = stats ? (stats.startGravity ?? stats.og) : null;
        // Rounded off, so 1.0447 to 1.0427 is 2 points down rather than a float's hair under.
        const down = og === null ? null : Math.round((og - g) * 1e6) / 1e6;
        if (og !== null && down !== null && down < FERMENTATION_LIMITS.minDrop) {
          const waitingFor = Math.round((og - FERMENTATION_LIMITS.minDrop) * 1e6) / 1e6;
          if (slow || v === null || down >= FERMENTATION_LIMITS.minDrop / 2) return { firing: null, value: null, message: '', waitingFor };
          return {
            firing: false,
            value: Math.round(-v * 10) / 10,
            message: `${name} is at ${this.fmtG(g)}, near the brew's OG of ${this.fmtG(og)}`,
            waitingFor,
          };
        }
        if (v === null) return { firing: null, value: null, message: '', waitingFor: null };
        const drop = -v;
        // Past the threshold it fires; once it's back past where it clears (velocityClearsAt), it clears.
        const clearsAt = velocityClearsAt(rule.kind, th);
        const past = slow ? drop < th : drop > th;
        const back = slow ? drop > clearsAt : drop < clearsAt;
        const firing = past ? true : back ? false : null;
        const rate = `${name}'s gravity is ${
          Math.abs(drop) < 0.05 ? 'steady' : `${drop > 0 ? 'dropping' : 'rising'} ${Math.abs(drop).toFixed(1)} points a day`
        }`;
        const start = stats?.startGravity != null ? 'where the pill started' : "the brew's OG";
        return {
          firing,
          value: Math.round(drop * 10) / 10,
          message: firing === false ? rate : `${rate}, ${slow ? 'slower' : 'faster'} than ${th.toFixed(1)} points a day`,
          waitingFor: null,
          // Why it goes off now, at whatever the velocity has got to, rather than when it passed the threshold.
          afterWait:
            og === null
              ? undefined
              : `This alert waited until the gravity was ${WAIT_POINTS} points below ${start} (${this.fmtG(og)}); it's at ${this.fmtG(g)} now`,
        };
      }
      default:
        return { firing: null, value: null, message: '' };
    }
  }

  /**
   * Lowest and highest plausible gravity over a window, as the pill's model works it out. The stored gravity is the
   * pill's own, so a pill whose gravity comes from its tilt needs its readings worked through.
   */
  private gravityRange(
    pill: Pill,
    from: number,
    to: number,
  ): { n: number; min: number | null; max: number | null; firstTs: number | null } {
    if (pill.model.gravitySource !== 'tilt') return this.store.sgRange(pill.id, from, to);
    const offsets = this.deps.pills.offsets(pill.id);
    let n = 0;
    let min: number | null = null;
    let max: number | null = null;
    let firstTs: number | null = null;
    for (const r of this.store.iterateReadings(pill.id, from, to)) {
      if (r.flags & FLAG_IMPLAUSIBLE) continue;
      const g = modelGravity(r, offsets, pill.model);
      if (g === null || !plausibleGravity(g)) continue;
      n++;
      firstTs ??= r.ts;
      min = min === null ? g : Math.min(min, g);
      max = max === null ? g : Math.max(max, g);
    }
    return { n, min, max, firstTs };
  }

  private evaluate(rule: Watch, pillId: string): void {
    const pill = this.deps.pills.get(pillId);
    if (!pill) return;
    const key = `${rule.id}|${pillId}`;
    const once = ONCE_PER_BREW.has(rule.kind);
    let st = this.state.get(key) ?? { active: false, quiet: false, lastFiredAt: null };
    if (once && st.active) {
      // It went off for an earlier brew (ended, and this one started, between two of the minute's checks).
      const brew = this.deps.brews.activeFor(pillId);
      if (brew && (st.lastFiredAt ?? 0) < brew.startedAt) st = { active: false, quiet: false, lastFiredAt: st.lastFiredAt };
    }
    const c = this.check(rule, pill, st.active);
    const waited = this.waiting.has(key);
    if (!VELOCITY_KINDS.has(rule.kind) || c.waitingFor === null) this.waiting.delete(key);
    else if (c.waitingFor !== undefined) this.waiting.set(key, c.waitingFor);
    // Going off as the wait ends, it says so: the velocity may have passed the threshold long before.
    const fired = waited && c.afterWait ? { ...c, message: `${c.message}. ${c.afterWait}` } : c;
    const now = this.now();
    // Steps in a brew go off once in it, so there's nothing to hold back.
    const cooling = (lastFiredAt: number | null) => !once && lastFiredAt !== null && now - lastFiredAt < rule.cooldownMin * 60_000;
    if (c.firing === true && !st.active) {
      const quiet = cooling(st.lastFiredAt);
      const next = { active: true, quiet, lastFiredAt: quiet ? st.lastFiredAt : now };
      this.state.set(key, next);
      this.store.saveAlertState(rule.id, pillId, true, next.lastFiredAt, quiet);
      if (!quiet) this.record(rule, pillId, 'fired', fired, true);
    } else if (c.firing === true && st.quiet && !cooling(st.lastFiredAt)) {
      // Kept quiet by the cooldown and still going once it's over: it's news now.
      this.state.set(key, { active: true, quiet: false, lastFiredAt: now });
      this.store.saveAlertState(rule.id, pillId, true, now);
      this.record(rule, pillId, 'fired', c, true);
    } else if (c.firing === false && st.active) {
      this.state.set(key, { active: false, quiet: false, lastFiredAt: st.lastFiredAt });
      this.store.saveAlertState(rule.id, pillId, false, st.lastFiredAt);
      // Nobody was told it started, so nobody is told it ended.
      if (!st.quiet) this.record(rule, pillId, 'resolved', c, rule.kind === 'offline');
    }
  }

  private record(rule: Watch, pillId: string, kind: 'fired' | 'resolved', c: Check, notify: boolean): void {
    // What to do comes first ("Add the dry hops — Hazy IPA is at 1.0200"); it's not repeated when it clears.
    const todo = kind === 'fired' ? (rule.message ?? '').trim() : '';
    const message =
      kind === 'resolved' && rule.kind !== 'offline' ? `Back to normal: ${c.message}` : todo ? `${todo} — ${c.message}` : c.message;
    this.announce(
      {
        ruleId: rule.id,
        ruleName: rule.name,
        pillId,
        kind,
        message,
        value: c.value,
        brewId: rule.brewId ?? this.deps.brews.activeFor(pillId)?.id ?? null,
      },
      {
        notify,
        channelIds: rule.channelIds,
        tag: `${rule.id}-${pillId}`,
        url: rule.brewId ? `/#/brew/${rule.brewId}` : `/#/pill/${pillId}`,
      },
    );
    if (kind === 'fired' && rule.addToTimeline) this.noteOnTimeline(pillId, rule.id, `${rule.name}: ${message}`);
  }

  /** Records an alert event (the app shows it straight away) and, with `notify`, sends it where it goes. */
  private announce(
    e: Omit<AlertEvent, 'id' | 'at' | 'ackedAt'>,
    opts: { notify: boolean; channelIds: string[] | 'all'; tag: string; url: string },
  ): void {
    const at = this.now();
    const id = this.store.addAlertEvent({ ...e, at });
    const event: AlertEvent = { ...e, id, at, ackedAt: null };
    this.log.info({ rule: e.ruleName, pill: e.pillId, kind: e.kind }, 'alert');
    this.emit('event', event);
    if (!opts.notify) return;
    const targets = opts.channelIds;
    if (targets === 'all' || targets.includes(BROWSER_PUSH)) {
      this.notifier.send({ title: e.ruleName, body: e.message, tag: opts.tag, url: opts.url }).catch((err: Error) => {
        this.log.warn({ err: err.message }, 'could not send a notification');
      });
    }
    const channelIds = targets === 'all' ? 'all' : targets.filter((t) => t !== BROWSER_PUSH);
    if (this.channels && (channelIds === 'all' || channelIds.length > 0)) {
      this.channels
        .send(channelIds, { title: e.ruleName, message: e.message, priority: e.kind === 'fired' ? 'high' : 'normal', kind: e.kind })
        .catch((err: Error) => this.log.warn({ err: err.message }, 'could not send a notification'));
    }
  }

  /**
   * A note on the pill's running brew's timeline, now, as the alert's. It's left off the charts, where the alert itself
   * is marked.
   */
  private noteOnTimeline(pillId: string, alertId: string, text: string): void {
    const brew = this.deps.brews.activeFor(pillId);
    if (!brew || !this.deps.brews.addEvent) return;
    try {
      this.deps.brews.addEvent(brew.id, { at: this.now(), kind: 'note', text: text.slice(0, 500), hidden: true }, alertId);
    } catch (err) {
      this.log.warn({ err: (err as Error).message, brew: brew.id }, "couldn't note an alert on the brew's timeline");
    }
  }

  // Reminders

  /** Every minute: planned events of running brews whose start or end has come remind you, once for each time. */
  checkReminders(): void {
    // Before the clock is set, "now" is about to jump.
    if (this.deps.clockTrusted?.() === false) return;
    const now = this.now();
    for (const row of this.store.dueReminders(now, REMINDER_GRACE_MS)) {
      const ended = row.end_at !== null && row.end_at <= now && row.end_at > now - REMINDER_GRACE_MS && row.reminded_end !== row.end_at;
      const started = row.at <= now && row.at > now - REMINDER_GRACE_MS && row.reminded_at !== row.at;
      // One that has started and ended since (the hub was off) only needs the end.
      if (started) this.store.markReminded(row.id, 'start', row.at);
      if (ended) this.store.markReminded(row.id, 'end', row.end_at!);
      if (ended) this.remind(row, 'end');
      else if (started) this.remind(row, 'start');
    }
  }

  private remind(row: DueReminderRow, which: 'start' | 'end'): void {
    let brewName = 'Brew';
    try {
      brewName = (JSON.parse(row.brew_json) as { name?: string }).name || brewName;
    } catch {
      // The brew's name is only for the message.
    }
    const word = EVENT_WORDS[row.kind] ?? 'note';
    const what = row.text ? `: ${row.text}` : '';
    const message =
      which === 'end' ? `Time to finish the ${word}${what}` : row.kind === 'note' ? `Reminder${what}` : `Time for the ${word}${what}`;
    const title = `${brewName}: ${word.charAt(0).toUpperCase()}${word.slice(1)}`;
    this.announce(
      { ruleId: `reminder:${row.id}`, ruleName: title, pillId: row.pill_id, kind: 'fired', message, value: null, brewId: row.brew_id },
      { notify: true, channelIds: 'all', tag: `reminder-${row.id}`, url: `/#/brew/${row.brew_id}` },
    );
  }
}
