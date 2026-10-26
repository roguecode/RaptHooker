import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  BROWSER_PUSH,
  gravityIn,
  plausibleGravity,
  temperatureIn,
  type AlertEvent,
  type AlertRule,
  type AlertRuleInput,
  type Brew,
  type GravityUnit,
  type Pill,
  type Reading,
  type TemperatureUnit,
} from '@rapthooker/shared';
import { FLAG_IMPLAUSIBLE, type Store } from './db.js';
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
  brews: { activeFor(pillId: string): Brew | null };
  units: () => { temperature: TemperatureUnit; gravity: GravityUnit };
  /** False until the clock can be trusted after boot ("last heard" times can't be compared with now until then). */
  clockTrusted?: () => boolean;
  now?: () => number;
}

interface Check {
  /** true: should fire, false: has cleared, null: in between (hysteresis) or not enough data. */
  firing: boolean | null;
  value: number | null;
  message: string;
}

const HYSTERESIS = { temperature: 0.5, gravity: 0.003, battery: 5 };

/** What's saved for a rule: everything but what's worked out while running (fields a newer version added are kept). */
const ruleInput = ({ id: _id, createdAt: _c, active: _a, ...input }: AlertRule): AlertRuleInput => input;

/**
 * Watches readings against your alert rules and notifies (in the app, by browser push and through the rule's
 * notification channels) when one fires.
 */
export class AlertService extends EventEmitter {
  private rules = new Map<string, AlertRule>();
  /** `quiet`: active, but not announced because of the cooldown. */
  private state = new Map<string, { active: boolean; quiet: boolean; lastFiredAt: number | null }>();
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
        const rule: AlertRule = { ...saved, channelIds: channelIdsOf(saved.channelIds), id: row.id, createdAt: row.created_at, active: [] };
        this.rules.set(row.id, rule);
      } catch (err) {
        this.log.error({ id: row.id, err: (err as Error).message }, 'skipped an alert rule that could not be read');
      }
    }
    for (const s of this.store.alertStates())
      this.state.set(`${s.rule_id}|${s.pill_id}`, { active: s.active >= 1, quiet: s.active === 2, lastFiredAt: s.last_fired_at });
  }

  start(): void {
    this.timer = setInterval(() => {
      // Thrown from a timer it would stop the hub (and the recording with it).
      try {
        this.evaluateAll();
      } catch (err) {
        this.log.error({ err: (err as Error).stack ?? String(err) }, 'checking the alerts failed');
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
    const rule: AlertRule = { ...input, id: randomUUID(), createdAt: this.now(), active: [] };
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

  /** Takes a deleted notification channel out of the rules that send to it. */
  forgetChannel(channelId: string): void {
    for (const rule of this.rules.values()) {
      if (rule.channelIds === 'all' || !rule.channelIds.includes(channelId)) continue;
      const next: AlertRule = { ...rule, channelIds: rule.channelIds.filter((c) => c !== channelId) };
      this.rules.set(rule.id, next);
      this.store.saveAlertRule(rule.id, ruleInput(next), rule.createdAt);
    }
  }

  events(limit: number): AlertEvent[] {
    return this.store.listAlertEvents(limit).map((r) => ({
      id: Number(r.id),
      ruleId: String(r.rule_id),
      ruleName: String(r.rule_name),
      pillId: String(r.pill_id),
      at: Number(r.at),
      kind: r.kind === 'resolved' ? 'resolved' : 'fired',
      message: String(r.message),
      value: (r.value as number | null) ?? null,
    }));
  }

  private withActive(rule: AlertRule): AlertRule {
    const active = [...this.state.entries()].filter(([k, v]) => k.startsWith(`${rule.id}|`) && v.active).map(([k]) => k.split('|')[1]!);
    return { ...rule, active };
  }

  private appliesTo(rule: AlertRule, pillId: string): boolean {
    if (!rule.enabled) return false;
    if (rule.pillIds !== 'all' && !rule.pillIds.includes(pillId)) return false;
    if (!this.deps.pills.activeIds().includes(pillId)) return false;
    return !rule.onlyDuringBrew || this.deps.brews.activeFor(pillId) !== null;
  }

  /** After each reading. */
  evaluatePill(pillId: string): void {
    for (const rule of this.rules.values()) if (this.appliesTo(rule, pillId)) this.evaluate(rule, pillId);
  }

  /** Every minute, for time-based rules (and rules that just changed). */
  evaluateAll(): void {
    for (const pillId of this.deps.pills.activeIds()) this.evaluatePill(pillId);
    // A rule that no longer applies (switched off, the pill taken out of it or archived, the brew ended) lets go of what
    // it was firing for, without a word, so it fires afresh if it applies again.
    for (const [key, st] of this.state) {
      if (!st.active) continue;
      const [ruleId, pillId] = key.split('|') as [string, string];
      const rule = this.rules.get(ruleId);
      if (!rule || this.appliesTo(rule, pillId)) continue;
      // A removed pill's state went with it.
      if (!this.deps.pills.get(pillId)) {
        this.state.delete(key);
        continue;
      }
      this.state.set(key, { active: false, quiet: false, lastFiredAt: st.lastFiredAt });
      this.store.saveAlertState(ruleId, pillId, false, st.lastFiredAt);
    }
  }

  private fmtT(c: number): string {
    const unit = this.deps.units().temperature;
    return `${temperatureIn(c, unit).toFixed(1)} °${unit}`;
  }

  private fmtG(sg: number): string {
    const unit = this.deps.units().gravity;
    return unit === 'plato' ? `${gravityIn(sg, unit).toFixed(1)} °P` : gravityIn(sg, unit).toFixed(3);
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
    const r = this.deps.pills.latest(pillId);
    if (!r || now - r.ts > 6 * 3_600_000) return { firing: null, value: null, message: '' };
    // A pill out of the beer (lying on a table) reports a nonsense gravity: gravity alerts wait for a real one.
    if (!r.plausible && (rule.kind === 'gravity_below' || rule.kind === 'gravity_stable'))
      return { firing: null, value: null, message: '' };
    const th = rule.threshold;
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
        const firing = pts < th ? true : pts > th + 1 ? false : null;
        return {
          firing,
          value: Math.round(pts * 10) / 10,
          message:
            firing === false
              ? `${name}'s gravity has moved ${pts.toFixed(1)} points over the last ${rule.hours} hours`
              : `${name} has been steady at ${this.fmtG(g)} for ${rule.hours} hours (moved ${pts.toFixed(1)} points). Fermentation looks finished.`,
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

  private evaluate(rule: AlertRule, pillId: string): void {
    const pill = this.deps.pills.get(pillId);
    if (!pill) return;
    const key = `${rule.id}|${pillId}`;
    const st = this.state.get(key) ?? { active: false, quiet: false, lastFiredAt: null };
    const c = this.check(rule, pill, st.active);
    const now = this.now();
    const cooling = (lastFiredAt: number | null) => lastFiredAt !== null && now - lastFiredAt < rule.cooldownMin * 60_000;
    if (c.firing === true && !st.active) {
      const quiet = cooling(st.lastFiredAt);
      const next = { active: true, quiet, lastFiredAt: quiet ? st.lastFiredAt : now };
      this.state.set(key, next);
      this.store.saveAlertState(rule.id, pillId, true, next.lastFiredAt, quiet);
      if (!quiet) this.record(rule, pillId, 'fired', c, true);
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

  private record(rule: AlertRule, pillId: string, kind: 'fired' | 'resolved', c: Check, notify: boolean): void {
    const at = this.now();
    const message = kind === 'resolved' && rule.kind !== 'offline' ? `Back to normal: ${c.message}` : c.message;
    const id = this.store.addAlertEvent({ ruleId: rule.id, ruleName: rule.name, pillId, at, kind, message, value: c.value });
    const event: AlertEvent = { id, ruleId: rule.id, ruleName: rule.name, pillId, at, kind, message, value: c.value };
    this.log.info({ rule: rule.name, pill: pillId, kind }, 'alert');
    this.emit('event', event);
    if (!notify) return;
    const targets = rule.channelIds;
    if (targets === 'all' || targets.includes(BROWSER_PUSH)) {
      this.notifier.send({ title: rule.name, body: message, tag: `${rule.id}-${pillId}`, url: `/#/pill/${pillId}` }).catch((err: Error) => {
        this.log.warn({ err: err.message }, 'could not send a notification');
      });
    }
    const channelIds = targets === 'all' ? 'all' : targets.filter((t) => t !== BROWSER_PUSH);
    if (this.channels && (channelIds === 'all' || channelIds.length > 0)) {
      this.channels
        .send(channelIds, { title: rule.name, message, priority: kind === 'fired' ? 'high' : 'normal', kind })
        .catch((err: Error) => this.log.warn({ err: err.message }, 'could not send a notification'));
    }
  }
}
